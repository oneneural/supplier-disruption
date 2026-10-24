import {
  DOMAIN_CONTRACT_VERSION,
  canonicalJson,
  type ActionIntent,
  type ActorRole,
  type AmendScheduleReceipt,
  type CaseActorRole,
  type CaseState,
  type PlanPayload,
  type PriorCommitment,
  type ReservationReceipt,
  type TransferRequestReceipt,
} from "@supplier-disruption/contracts";
import { caseAction, caseDecision, caseEvent, supplierCase } from "@supplier-disruption/db";
import { SourceRejectedError } from "@supplier-disruption/db/inventory";
import { approvalRefusal, contentSha256, deriveEligibility } from "@supplier-disruption/domain";
import { and, count, eq, inArray } from "drizzle-orm";
import { CASE_FIXTURE } from "./fixture.js";
import {
  actionsOf,
  actorHoldsRole,
  appendEvent,
  CaseStateConflict,
  currentPlan,
  decisionsOf,
  lockCase,
  payloadOf,
  transition,
  type ActionRow,
  type CaseRow,
  type Executor,
  type PlanRow,
  type Tx,
} from "./store.js";
import type { CaseWorkflow } from "./workflow.js";

/** What one application job run left: the case state and whether the job should retry. */
export interface ApplyOutcome {
  state: CaseState | "missing";
  /** True when an outcome is uncertain or evidence was unavailable; a later run reconciles. */
  retry: boolean;
}

const organization = CASE_FIXTURE.label;
const APPLICABLE: readonly CaseState[] = ["applying", "partially_applied", "verifying"];
/** States in which an action may be claimed or settled. */
const CLAIMABLE: readonly CaseState[] = ["applying", "partially_applied"];
/** VERIFY-1@1: a verification bundle supports `plan_verified` for 4 hours. */
const VERIFICATION_VALIDITY_MS = 4 * 60 * 60 * 1000;

/**
 * Attempts and read-backs that may fail to prove an action's outcome before
 * it waits for a person (ADR 0016). With the job's backoff this is a few
 * minutes of retries, not an indefinite wait shown as progress.
 */
export const RECONCILE_ATTEMPT_LIMIT = 8;
/** An attempt that may have reached its source is read back, never resubmitted. */
export const RECONCILIATION_PENDING = "reconciliation_pending";
/** Automatic read-back stopped without proving the outcome; a person confirms it at the source. */
export const RECONCILIATION_UNRESOLVED = "reconciliation_unresolved";
/** A stored command whose digest no longer matches the one claimed earlier. */
export const REQUEST_DIGEST_MISMATCH = "request_digest_mismatch";
/** Reasons an `unknown` action is still in automatic reconciliation. */
const RECONCILING: readonly (string | null)[] = [null, "outcome_unknown", RECONCILIATION_PENDING];

/**
 * An action whose attempt may have reached its source and whose outcome is
 * not proven yet: claimed (`pending`) or `unknown` while still reconciling.
 * An `unknown` action from a verification read-back or after the read-back
 * bound is not in flight; it waits for a person.
 */
export function inFlight(action: { state: string; reason: string | null }): boolean {
  return (
    action.state === "pending" ||
    (action.state === "unknown" && RECONCILING.includes(action.reason))
  );
}

/**
 * Whether the case may submit a new attempt: it is applying, or reconciling
 * an unknown outcome under its current approval. A revoked, escalated or
 * otherwise settled case only reads back what it already submitted.
 */
function submittable(row: CaseRow): boolean {
  return (
    row.state === "applying" ||
    (row.state === "partially_applied" && row.reason === "outcome_unknown")
  );
}

/** The SHA-256 of a source command's canonical JSON, fixed by its first claim. */
function digestOf(command: SourceCommand): string {
  return contentSha256(command);
}

type Receipt = AmendScheduleReceipt | ReservationReceipt | TransferRequestReceipt;

/** The role that owns follow-up for an action's source. */
const ownerOf = (action: { kind: string }): CaseActorRole =>
  action.kind === "amend_schedule" ? "buyer" : "warehouse_planner";

function intentOf(payload: PlanPayload, action: ActionRow): ActionIntent {
  const intent = payload.actions.find((candidate) => candidate.actionId === action.actionId);
  if (intent === undefined) throw new Error(`plan has no action ${action.actionId}`);
  return intent;
}

/**
 * Runs one application job for a case, serialized per case by a session
 * advisory lock: ACT-1 to ACT-3 in order, each behind its own guarded claim,
 * then verification by read-back.
 */
export async function applyCase(workflow: CaseWorkflow, caseId: string): Promise<ApplyOutcome> {
  const client = await workflow.deps.sourcePool.connect();
  const lockKey = `case-apply:${caseId}`;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockKey],
    );
    if (rows[0]?.locked !== true) {
      const [row] = await workflow.deps.db
        .select({ state: supplierCase.state })
        .from(supplierCase)
        .where(eq(supplierCase.id, caseId));
      return { state: (row?.state as CaseState | undefined) ?? "missing", retry: true };
    }
    try {
      let outcome: ApplyOutcome;
      try {
        outcome = await runApplication(workflow, caseId);
      } catch (thrown) {
        // Someone else moved the case (an escalation, for example): stop here.
        if (!(thrown instanceof CaseStateConflict)) throw thrown;
        outcome = { state: thrown.state as CaseState, retry: false };
      }
      // A cancellation that waited on an attempt in flight settles once its
      // outcome is known (ADR 0016).
      return (await settleCancellation(workflow, caseId)) ?? outcome;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    }
  } finally {
    client.release();
  }
}

async function snapshot(workflow: CaseWorkflow, caseId: string) {
  const [row] = await workflow.deps.db
    .select()
    .from(supplierCase)
    .where(eq(supplierCase.id, caseId));
  if (row === undefined) return null;
  const plan = await currentPlan(workflow.deps.db, row);
  return { row, plan };
}

/** Runs `work` on the locked case in one transaction. */
function withCase<T>(
  workflow: CaseWorkflow,
  caseId: string,
  work: (tx: Tx, row: CaseRow) => Promise<T>,
): Promise<T> {
  return workflow.deps.db.transaction(async (tx) => {
    const row = await lockCase(tx, caseId);
    if (row === null) throw new Error(`case ${caseId} vanished`);
    return work(tx, row);
  });
}

async function runApplication(workflow: CaseWorkflow, caseId: string): Promise<ApplyOutcome> {
  const loaded = await snapshot(workflow, caseId);
  if (loaded === null) return { state: "missing", retry: false };
  const { row, plan } = loaded;
  const state = row.state as CaseState;
  if (plan === null) return { state, retry: false };
  if (state === "verifying") return verify(workflow, caseId, plan);
  // An escalated case may still have an attempt in flight: read it back only.
  if (!APPLICABLE.includes(state)) return reconcileOnly(workflow, caseId, plan);

  // Every claim runs the execution guard itself (`claimConflict`), so a
  // change between the decisions and any claim is seen at that claim.
  const payload = payloadOf(plan);
  for (const action of await actionsOf(workflow.deps.db, plan.id)) {
    const outcome = await runAction(workflow, caseId, plan, payload, action);
    if (outcome !== null) return outcome;
  }
  await withCase(workflow, caseId, async (tx, locked) => {
    if (locked.state === "verifying") return;
    await transition(
      tx,
      locked,
      await workflow.deps.clock.now(),
      { state: "verifying", owner: "buyer", from: ["applying"] },
      { kind: "application_complete" },
    );
  });
  return verify(workflow, caseId, plan);
}

type Conflict = { reason: string; owner: CaseActorRole };

/**
 * The execution guard of one claim (ADR 0013). It runs inside the claim
 * transaction while the case row is locked, after the case state and plan
 * check, in a fixed order:
 *
 * 1. a current, unexpired accepted approval whose approver still holds the role;
 * 2. AUTH-1 at its current version, which must be the plan's bound version
 *    with the same currency and limits;
 * 3. the current demand head and every bound PO and stock version, where this
 *    plan's own confirmed receipts name the expected successor;
 * 4. every unconfirmed transfer quote's validity and terms;
 * 5. for a successor, every prior commitment it counts (ADR 0015).
 *
 * Source reads are read-only snapshots, so the guard takes no source lock and
 * cannot wait on a source write. A change that commits after a check is
 * ordered after this claim: the next claim sees it, and the owning source
 * still refuses a write against a version it no longer holds.
 */
async function claimConflict(
  workflow: CaseWorkflow,
  tx: Tx,
  row: CaseRow,
  plan: PlanRow,
  now: string,
): Promise<Conflict | "unavailable" | null> {
  const { sources } = workflow;
  const payload = payloadOf(plan);
  const approval = (await decisionsOf(tx, plan.id)).find(
    (decision) =>
      decision.kind === "approval" &&
      decision.outcome === "accepted" &&
      decision.status === "current",
  );
  if (approval === undefined) return { reason: "approval_missing", owner: "buyer" };
  const binding = approval.binding as { expiresAt: string };
  if (Date.parse(now) >= Date.parse(binding.expiresAt)) {
    return { reason: "approval_expired", owner: "buyer" };
  }
  if (!(await actorHoldsRole(tx, row.organizationId, approval.actorId, approval.role))) {
    return { reason: "stale_authority", owner: "buyer" };
  }

  const policy = await sources.reference.readCurrentPolicy({ organization, policyId: "AUTH-1" });
  // A withdrawn AUTH-1 authorizes nothing; an unreadable one is retried.
  if (policy.status === "not_found") return { reason: "stale_policy", owner: "buyer" };
  if (policy.status !== "ok") return "unavailable";
  const refusal = approvalRefusal(payload.authorization, policy.data, approval.role as ActorRole);
  if (refusal !== null) return { reason: refusal.reason, owner: "buyer" };

  const actions = await actionsOf(tx, plan.id);
  const receipts = actions.filter((action) => action.state === "confirmed");
  const successor = (kind: ActionIntent["kind"], matches: (intent: ActionIntent) => boolean) => {
    const done = receipts.find((action) => {
      const intent = payload.actions.find((entry) => entry.actionId === action.actionId);
      return intent?.kind === kind && matches(intent);
    });
    return done?.receipt ?? null;
  };
  try {
    for (const bound of payload.bindings) {
      if (bound.kind === "purchase_order") {
        const own = successor(
          "amend_schedule",
          (intent) => intent.kind === "amend_schedule" && intent.poNumber === bound.key,
        ) as AmendScheduleReceipt | null;
        const read = await sources.purchasing.readPurchaseOrder({
          organization,
          poNumber: bound.key,
        });
        if (read.currentRevision !== (own?.successorRevision ?? bound.version)) {
          return { reason: "stale_base_revision", owner: "buyer" };
        }
      } else if (bound.kind === "stock") {
        const own = successor(
          "reserve",
          (intent) => intent.kind === "reserve" && intent.warehouse === bound.key,
        ) as ReservationReceipt | null;
        const sku = String(bound.scope.selectors.sku);
        const read = await sources.inventory.readStock({ organization, sku, warehouse: bound.key });
        if (read.currentVersion !== (own?.successorVersion ?? bound.version)) {
          return { reason: "stale_source_stock", owner: "warehouse_planner" };
        }
      } else if (bound.kind === "demand") {
        const read = await sources.demand.readDemand({ organization });
        if (read.currentVersion !== bound.version) {
          return { reason: "stale_source_demand", owner: "buyer" };
        }
      }
    }
    for (const intent of payload.actions) {
      if (intent.kind !== "create_transfer_request") continue;
      if (receipts.some((action) => action.actionId === intent.actionId)) continue;
      if (Date.parse(now) >= Date.parse(intent.preconditions.validUntil)) {
        return { reason: "transfer_quote_expired", owner: "warehouse_planner" };
      }
      const option = await sources.inventory.readTransferOption({
        organization,
        optionId: intent.optionId,
      });
      if (contentSha256(option.record) !== intent.preconditions.optionTermsSha256) {
        return { reason: "stale_transfer_option", owner: "warehouse_planner" };
      }
    }
    if (payload.bindings.some((bound) => bound.kind === "prior_commitments")) {
      const commitments = await currentCommitments(workflow, tx, row, now);
      if (commitments === "unavailable") return "unavailable";
      const counted = payload.allocations.flatMap((allocation) =>
        allocation.supply.kind === "prior_commitment" ? [allocation.supply] : [],
      );
      if (
        commitments === null ||
        !commitments.every(commitmentHolds) ||
        !counted.every((supply) => heldCommitment(commitments, supply) !== null)
      ) {
        return { reason: "stale_prior_commitment", owner: "warehouse_planner" };
      }
    }
  } catch {
    return "unavailable";
  }
  return null;
}

/**
 * A refused claim before any action of the plan was attempted: marks the
 * plan's current decisions stale (or expired) so they can never be reused,
 * fails its unclaimed actions without any source write, records
 * `needs_clarification` with the reason and owner, and reassesses under a
 * new plan version, all in the claim transaction.
 */
async function invalidate(
  workflow: CaseWorkflow,
  tx: Tx,
  row: CaseRow,
  plan: PlanRow,
  at: string,
  stale: Conflict,
): Promise<void> {
  await staleDecisions(tx, plan, at, stale.reason);
  await tx
    .update(caseAction)
    .set({ state: "failed", reason: stale.reason, updatedAt: at })
    .where(
      and(eq(caseAction.planRowId, plan.id), inArray(caseAction.state, ["planned", "authorized"])),
    );
  await transition(
    tx,
    row,
    at,
    {
      state: "needs_clarification",
      reason: stale.reason,
      owner: stale.owner,
      from: CLAIMABLE,
    },
    { kind: "approval_invalidated", detail: { planSha256: plan.sha256 } },
  );
  await workflow.reassess(tx, row);
}

/** The plan's current decisions can never authorize anything again. */
async function staleDecisions(tx: Tx, plan: PlanRow, at: string, reason: string) {
  await tx
    .update(caseDecision)
    .set({
      status: reason === "approval_expired" ? "expired" : "stale",
      invalidatedAt: at,
      invalidatedReason: reason,
    })
    .where(and(eq(caseDecision.planRowId, plan.id), eq(caseDecision.status, "current")));
}

/**
 * Advances one journal entry. Returns null to continue with the next action,
 * or the outcome that ends this run.
 */
async function runAction(
  workflow: CaseWorkflow,
  caseId: string,
  plan: PlanRow,
  payload: PlanPayload,
  action: ActionRow,
): Promise<ApplyOutcome | null> {
  if (action.state === "confirmed") return null;
  if (action.state === "failed" || (action.state === "unknown" && !inFlight(action))) {
    // A failed action, or an uncertain one that waits for a person, ends the
    // run. A case still `applying` behind an uncertain one is moved to the
    // person who must confirm it, so it never looks in progress.
    return withCase(workflow, caseId, async (tx, row) => {
      if (action.state === "unknown" && row.state === "applying") {
        const at = await workflow.deps.clock.now();
        await transition(
          tx,
          row,
          at,
          {
            state: "partially_applied",
            reason: action.reason ?? RECONCILIATION_UNRESOLVED,
            owner: ownerOf(intentOf(payload, action)),
          },
          { kind: "reconciliation_unresolved", detail: { actionId: action.actionId } },
        );
      }
      return { state: row.state as CaseState, retry: false };
    });
  }
  const intent = intentOf(payload, action);

  if (inFlight(action)) {
    // Reconcile by operation ID and read-back before any retry.
    const found = await reconcile(workflow, caseId, action);
    if (found === "confirmed") return null;
    if (found === "unreachable") return recordUnproven(workflow, caseId, plan, action, found);
    const [row] = await workflow.deps.db
      .select()
      .from(supplierCase)
      .where(eq(supplierCase.id, caseId));
    // Absence alone never proves no effect: without a current approval to
    // submit under, the attempt stays unknown and is read back again.
    if (row === undefined || !submittable(row)) {
      return recordUnproven(workflow, caseId, plan, action, found);
    }
    // No committed operation has this ID. Resubmitting the identical command
    // under the same operation ID is safe: the source applies an operation ID
    // at most once and replays its receipt to a later identical request.
  }

  // The first claim fixes the command; every later attempt reuses it unchanged.
  const command =
    (action.command as SourceCommand | null) ??
    commandFor(intent, payload, action, await predecessorReceipt(workflow, plan, intent));
  const requestDigest = digestOf(command);
  if (action.requestDigest !== null && action.requestDigest !== requestDigest) {
    // The stored command is not the one claimed earlier under this operation
    // ID. Nothing is sent: the action waits for a person, who confirms at the
    // source what the earlier attempts did.
    return markUnresolved(workflow, caseId, action, REQUEST_DIGEST_MISMATCH, ownerOf(intent), {
      kind: REQUEST_DIGEST_MISMATCH,
      detail: {
        actionId: action.actionId,
        operationId: action.operationId,
        attemptKey: action.attemptKey,
        recorded: action.requestDigest,
        computed: requestDigest,
      },
    });
  }
  await workflow.deps.faults?.beforeClaim?.({ caseId, actionId: action.actionId });
  const claimed = await withCase(workflow, caseId, async (tx, row) => {
    // The submission boundary: in the same transaction that records the
    // attempt as pending (submitting), the case must still be applying this
    // plan, the action must be as this run read it, and the execution guard
    // must hold. A revocation or escalation committed first is seen here; one
    // committed later finds the attempt possibly in flight (N-08).
    if (
      !CLAIMABLE.includes(row.state as CaseState) ||
      row.currentPlanId !== plan.id ||
      !submittable(row)
    ) {
      throw new CaseStateConflict(row.state);
    }
    const [current] = await tx.select().from(caseAction).where(eq(caseAction.id, action.id));
    if (current?.state !== action.state) throw new CaseStateConflict(row.state);
    const at = await workflow.deps.clock.now();
    const failure = await claimConflict(workflow, tx, row, plan, at);
    if (failure === "unavailable") return "unavailable";
    if (failure !== null) {
      const journal = await actionsOf(tx, plan.id);
      const attempted = journal.some(
        (entry) => entry.state !== "planned" && entry.state !== "authorized",
      );
      if (!attempted) {
        // Nothing of this plan reached a source: reassess before any effect.
        await invalidate(workflow, tx, row, plan, at, failure);
        return "settled";
      }
      // Effects may exist: no write, and every unclaimed action fails. An
      // attempt that may already have reached its source is never failed on
      // a refused retry; it stays unknown and is read back again.
      await staleDecisions(tx, plan, at, failure.reason);
      await tx
        .update(caseAction)
        .set({ state: "failed", reason: failure.reason, updatedAt: at })
        .where(
          and(
            eq(caseAction.planRowId, plan.id),
            inArray(caseAction.state, ["planned", "authorized"]),
          ),
        );
      const uncertain = inFlight(action);
      if (uncertain) {
        await tx
          .update(caseAction)
          .set({ state: "unknown", reason: RECONCILIATION_PENDING, updatedAt: at })
          .where(eq(caseAction.id, action.id));
      }
      await settleFailure(tx, row, plan, at, failure, action);
      return uncertain ? "uncertain" : "settled";
    }
    const attempts = action.attempts + 1;
    const attemptKey = `${action.operationId}#${String(attempts)}`;
    await tx
      .update(caseAction)
      .set({
        state: "pending",
        reason: null,
        command,
        requestDigest,
        attemptKey,
        attempts,
        updatedAt: at,
      })
      .where(eq(caseAction.id, action.id));
    await appendEvent(tx, row, at, {
      kind: "action_submitted",
      detail: {
        actionId: action.actionId,
        operationId: action.operationId,
        attempt: attempts,
        attemptKey,
        requestDigest,
      },
    });
    await workflow.deps.faults?.beforeClaimCommit?.({ caseId, actionId: action.actionId });
    Object.assign(action, { state: "pending", reason: null, attempts, attemptKey, requestDigest });
    return "claimed";
  });
  if (claimed !== "claimed") {
    const after = await snapshot(workflow, caseId);
    return {
      state: (after?.row.state as CaseState | undefined) ?? "missing",
      retry: claimed === "unavailable" || claimed === "uncertain",
    };
  }
  await workflow.deps.faults?.beforeSubmit?.({ caseId, actionId: action.actionId });

  try {
    const result = await submit(workflow, command);
    await workflow.deps.faults?.afterSourceWrite?.({
      caseId,
      actionId: action.actionId,
      attempt: action.attempts,
    });
    await confirm(
      workflow,
      caseId,
      action,
      result.receipt,
      result.replayed ? "replayed" : "applied",
    );
    return null;
  } catch (thrown) {
    if (thrown instanceof SourceRejectedError) {
      // A definitive refusal inside the source transaction: no effect exists.
      await withCase(workflow, caseId, async (tx, row) => {
        const at = await workflow.deps.clock.now();
        await tx
          .update(caseAction)
          .set({ state: "failed", reason: thrown.reason, updatedAt: at })
          .where(eq(caseAction.id, action.id));
        const failure = { reason: thrown.reason, owner: ownerOf(intent) };
        if (submittable(row)) {
          await settleFailure(tx, row, plan, at, failure, action);
        } else {
          // A cancellation is waiting on this attempt; it settles the case.
          await appendEvent(tx, row, at, {
            kind: "action_failed",
            reason: thrown.reason,
            detail: { actionId: action.actionId, attemptKey: action.attemptKey },
          });
        }
      });
      const after = await snapshot(workflow, caseId);
      return { state: (after?.row.state as CaseState | undefined) ?? "missing", retry: false };
    }
    // Submitted, outcome unknown: never resubmit before reading back by
    // operation ID. Each such attempt counts toward the read-back bound.
    const exhausted = await withCase(workflow, caseId, async (tx, row) => {
      const at = await workflow.deps.clock.now();
      const [current] = await tx.select().from(caseAction).where(eq(caseAction.id, action.id));
      const unproven = (current?.reconcileAttempts ?? action.reconcileAttempts) + 1;
      const done = unproven >= RECONCILE_ATTEMPT_LIMIT;
      await tx
        .update(caseAction)
        .set({
          state: "unknown",
          reason: done ? RECONCILIATION_UNRESOLVED : "outcome_unknown",
          reconcileAttempts: unproven,
          updatedAt: at,
        })
        .where(eq(caseAction.id, action.id));
      const detail = {
        actionId: action.actionId,
        operationId: action.operationId,
        attemptKey: action.attemptKey,
        error: thrown instanceof Error ? thrown.message : String(thrown),
        unproven,
        limit: RECONCILE_ATTEMPT_LIMIT,
      };
      if (done && CLAIMABLE.includes(row.state as CaseState)) {
        // Applying, or waiting on this attempt for a revocation: either way
        // the job stops and a person confirms the outcome.
        await transition(
          tx,
          row,
          at,
          { state: "partially_applied", reason: RECONCILIATION_UNRESOLVED, owner: ownerOf(intent) },
          { kind: "reconciliation_unresolved", detail },
        );
      } else if (submittable(row)) {
        await transition(
          tx,
          row,
          at,
          { state: "partially_applied", reason: "outcome_unknown", owner: ownerOf(intent) },
          { kind: "action_outcome_unknown", detail },
        );
      } else {
        // Escalated meanwhile: the case keeps its state, and the attempt is
        // read back by the next run or, at the bound, waits for a person.
        await appendEvent(tx, row, at, {
          kind: done ? "reconciliation_unresolved" : "action_outcome_unknown",
          detail,
        });
      }
      return done;
    });
    const after = await snapshot(workflow, caseId);
    return {
      state: (after?.row.state as CaseState | undefined) ?? "missing",
      retry: !exhausted,
    };
  }
}

/**
 * Reads an attempt back by its operation ID and records a found effect as
 * confirmed. `absent` is not a final outcome: without a fence the attempt may
 * still land, so it never makes the action failed.
 */
async function reconcile(
  workflow: CaseWorkflow,
  caseId: string,
  action: ActionRow,
): Promise<"confirmed" | "absent" | "unreachable"> {
  let receipt: Receipt | null;
  try {
    receipt = await lookup(workflow, action);
  } catch {
    return "unreachable";
  }
  if (receipt === null) return "absent";
  await confirm(workflow, caseId, action, receipt, "reconciled");
  return "confirmed";
}

/**
 * A read-back that could not prove an attempt's outcome: the source was
 * unreachable, or it found nothing while no new attempt may be submitted.
 * The action is `unknown`; after RECONCILE_ATTEMPT_LIMIT such read-backs it
 * is `reconciliation_unresolved`, the job stops retrying and the owner
 * confirms the outcome at the source. It is never shown as resolved.
 */
async function recordUnproven(
  workflow: CaseWorkflow,
  caseId: string,
  plan: PlanRow,
  action: ActionRow,
  cause: "absent" | "unreachable",
): Promise<ApplyOutcome> {
  const intent = intentOf(payloadOf(plan), action);
  return withCase(workflow, caseId, async (tx, row) => {
    const at = await workflow.deps.clock.now();
    const [current] = await tx.select().from(caseAction).where(eq(caseAction.id, action.id));
    const attempts = (current?.reconcileAttempts ?? action.reconcileAttempts) + 1;
    const exhausted = attempts >= RECONCILE_ATTEMPT_LIMIT;
    const reason = exhausted
      ? RECONCILIATION_UNRESOLVED
      : submittable(row)
        ? "outcome_unknown"
        : RECONCILIATION_PENDING;
    await tx
      .update(caseAction)
      .set({ state: "unknown", reason, reconcileAttempts: attempts, updatedAt: at })
      .where(eq(caseAction.id, action.id));
    Object.assign(action, { state: "unknown", reason, reconcileAttempts: attempts });
    const kind = exhausted ? "reconciliation_unresolved" : "reconciliation_unproven";
    const detail = {
      actionId: action.actionId,
      operationId: action.operationId,
      attemptKey: action.attemptKey,
      cause,
      readBack: attempts,
      limit: RECONCILE_ATTEMPT_LIMIT,
    };
    const owner = ownerOf(intent);
    if (exhausted && CLAIMABLE.includes(row.state as CaseState)) {
      await transition(
        tx,
        row,
        at,
        { state: "partially_applied", reason: RECONCILIATION_UNRESOLVED, owner },
        { kind, detail },
      );
    } else if (row.state === "applying") {
      await transition(
        tx,
        row,
        at,
        { state: "partially_applied", reason: "outcome_unknown", owner },
        { kind, detail },
      );
    } else {
      await appendEvent(tx, row, at, { kind, detail });
    }
    return { state: row.state as CaseState, retry: !exhausted };
  });
}

/**
 * A run on a case that may submit nothing (escalated, for example): reads
 * back every attempt still in flight, in order, and stops at the first one
 * it cannot prove.
 */
async function reconcileOnly(
  workflow: CaseWorkflow,
  caseId: string,
  plan: PlanRow,
): Promise<ApplyOutcome> {
  for (const action of await actionsOf(workflow.deps.db, plan.id)) {
    if (!inFlight(action)) continue;
    const found = await reconcile(workflow, caseId, action);
    if (found !== "confirmed") return recordUnproven(workflow, caseId, plan, action, found);
  }
  const after = await snapshot(workflow, caseId);
  return { state: (after?.row.state as CaseState | undefined) ?? "missing", retry: false };
}

/**
 * Marks an action `unknown` with a reason no run advances, and moves a
 * claimable case to the person who confirms the outcome at the source; an
 * escalated case only records it. The job stops retrying.
 */
async function markUnresolved(
  workflow: CaseWorkflow,
  caseId: string,
  action: ActionRow,
  reason: string,
  owner: CaseActorRole,
  event: { kind: string; detail: Record<string, unknown> },
): Promise<ApplyOutcome> {
  return withCase(workflow, caseId, async (tx, row) => {
    const at = await workflow.deps.clock.now();
    await tx
      .update(caseAction)
      .set({ state: "unknown", reason, updatedAt: at })
      .where(eq(caseAction.id, action.id));
    Object.assign(action, { state: "unknown", reason });
    if (CLAIMABLE.includes(row.state as CaseState)) {
      await transition(tx, row, at, { state: "partially_applied", reason, owner }, event);
    } else {
      await appendEvent(tx, row, at, event);
    }
    return { state: row.state as CaseState, retry: false };
  });
}

/** Case events that open and close a cancellation waiting on attempts in flight. */
const CANCELLATION_PENDING = "cancellation_pending";
const CANCELLATION_SETTLED = "cancellation_settled";

/**
 * Settles an escalation or revocation that found attempts in flight, once
 * none is left in flight or unresolved (ADR 0016). An escalated case keeps
 * its state and records the known effects. A revoked plan with effects is
 * `partially_applied`, `canceled_after_effect`, with a compensating proposal
 * for an authorized person and nothing reversed; without effects (the
 * attempt was refused) it may be approved again.
 */
async function settleCancellation(
  workflow: CaseWorkflow,
  caseId: string,
): Promise<ApplyOutcome | null> {
  return withCase(workflow, caseId, async (tx, row) => {
    const waiting =
      row.state === "escalated" ||
      (row.state === "partially_applied" && row.reason === RECONCILIATION_PENDING);
    if (!waiting) return null;
    const plan = await currentPlan(tx, row);
    if (plan === null) return null;
    const journal = await actionsOf(tx, plan.id);
    if (journal.some((entry) => entry.state === "pending" || entry.state === "unknown")) {
      return null;
    }
    const marks = await tx
      .select({ kind: caseEvent.kind, n: count() })
      .from(caseEvent)
      .where(
        and(
          eq(caseEvent.caseId, row.id),
          inArray(caseEvent.kind, [CANCELLATION_PENDING, CANCELLATION_SETTLED]),
        ),
      )
      .groupBy(caseEvent.kind);
    const marked = (kind: string) => marks.find((mark) => mark.kind === kind)?.n ?? 0;
    if (marked(CANCELLATION_PENDING) <= marked(CANCELLATION_SETTLED)) return null;

    const at = await workflow.deps.clock.now();
    const confirmed = journal.filter((entry) => entry.state === "confirmed");
    const knownEffects = confirmed.map((entry) => ({
      actionId: entry.actionId,
      operationId: entry.operationId,
      receipt: entry.receipt,
    }));
    const detail = {
      planSha256: plan.sha256,
      knownEffects,
      failed: journal
        .filter((entry) => entry.state === "failed")
        .map((entry) => ({ actionId: entry.actionId, reason: entry.reason })),
    };
    if (row.state === "escalated") {
      await appendEvent(tx, row, at, { kind: CANCELLATION_SETTLED, detail });
    } else if (confirmed.length > 0) {
      await transition(
        tx,
        row,
        at,
        { state: "partially_applied", reason: "canceled_after_effect", owner: "buyer" },
        { kind: CANCELLATION_SETTLED, detail },
      );
      await proposeCompensation(tx, row, at, plan, knownEffects);
    } else {
      // The attempt was definitively refused, so nothing exists: the plan
      // waits for a fresh approval of the same hash (N-08 R4b). The refused
      // action keeps its failure and source reason; only the actions the
      // revocation failed unclaimed return to `planned`.
      await tx
        .update(caseAction)
        .set({ state: "planned", reason: null, updatedAt: at })
        .where(
          and(
            eq(caseAction.planRowId, plan.id),
            eq(caseAction.state, "failed"),
            eq(caseAction.reason, "approval_revoked"),
          ),
        );
      await transition(
        tx,
        row,
        at,
        { state: "awaiting_approval", reason: "approval_revoked", owner: "buyer" },
        { kind: CANCELLATION_SETTLED, detail },
      );
    }
    return { state: row.state as CaseState, retry: false };
  });
}

/**
 * Records a compensating proposal for an authorized person after a revoked
 * plan already has effects. It is a proposal only: nothing is reversed and
 * no source is written.
 */
export async function proposeCompensation(
  tx: Tx,
  row: CaseRow,
  at: string,
  plan: PlanRow,
  knownEffects: unknown[],
): Promise<void> {
  await appendEvent(tx, row, at, {
    kind: "compensation_proposed",
    owner: "buyer",
    detail: {
      planSha256: plan.sha256,
      knownEffects,
      proposal:
        "Review the confirmed effects with the procurement manager; any reversal is a new, separately approved change.",
      reversed: false,
    },
  });
}

/**
 * After a refused or expired claim: `partially_applied` when an action of
 * this plan has or may have an effect, otherwise `needs_clarification`. The
 * remaining actions are never claimed, and nothing is reversed.
 */
async function settleFailure(
  tx: Tx,
  row: CaseRow,
  plan: PlanRow,
  at: string,
  failure: { reason: string; owner: CaseActorRole },
  action: ActionRow,
) {
  const journal = await actionsOf(tx, plan.id);
  const confirmed = journal.filter((entry) => entry.state === "confirmed");
  // An attempt that may have reached its source counts as a possible effect.
  const uncertain = journal.some((entry) => entry.state === "unknown" || entry.state === "pending");
  await transition(
    tx,
    row,
    at,
    {
      state: confirmed.length > 0 || uncertain ? "partially_applied" : "needs_clarification",
      reason: failure.reason,
      owner: failure.owner,
      from: CLAIMABLE,
    },
    {
      kind: "action_failed",
      detail: {
        actionId: action.actionId,
        operationId: action.operationId,
        knownEffects: confirmed.map((entry) => ({
          actionId: entry.actionId,
          receipt: entry.receipt,
        })),
      },
    },
  );
}

async function confirm(
  workflow: CaseWorkflow,
  caseId: string,
  action: ActionRow,
  receipt: Receipt,
  how: "applied" | "replayed" | "reconciled",
) {
  await withCase(workflow, caseId, async (tx, row) => {
    const at = await workflow.deps.clock.now();
    await tx
      .update(caseAction)
      .set({ state: "confirmed", reason: null, receipt, updatedAt: at })
      .where(eq(caseAction.id, action.id));
    action.state = "confirmed";
    action.receipt = receipt;
    await appendEvent(tx, row, at, {
      kind: `action_${how}`,
      detail: { actionId: action.actionId, operationId: action.operationId, receipt },
    });
    if (row.state === "partially_applied" && row.reason === "outcome_unknown") {
      await transition(
        tx,
        row,
        at,
        { state: "applying", owner: "buyer" },
        { kind: "reconciliation_complete", detail: { actionId: action.actionId } },
      );
    }
  });
}

async function lookup(workflow: CaseWorkflow, action: ActionRow): Promise<Receipt | null> {
  const query = { organization, operationId: action.operationId };
  if (action.kind === "amend_schedule") {
    return (await workflow.sources.purchasing.lookupOperation(query))?.receipt ?? null;
  }
  return (await workflow.sources.inventory.lookupOperation(query))?.receipt ?? null;
}

/** ACT-3 draws on the reservation ACT-2's receipt created, in the version it produced. */
async function predecessorReceipt(
  workflow: CaseWorkflow,
  plan: PlanRow,
  intent: ActionIntent,
): Promise<ReservationReceipt | null> {
  if (intent.kind !== "create_transfer_request") return null;
  const source = (await actionsOf(workflow.deps.db, plan.id)).find(
    (entry) => entry.actionId === intent.preconditions.reservationFromAction,
  );
  if (source?.state !== "confirmed" || source.receipt === null) {
    throw new Error(
      `${intent.actionId} needs a confirmed ${intent.preconditions.reservationFromAction}`,
    );
  }
  return source.receipt as ReservationReceipt;
}

type SourceCommand = Record<string, unknown> & { kind: ActionIntent["kind"] };

/** The exact source command for an approved action intent, with its stable operation ID. */
function commandFor(
  intent: ActionIntent,
  payload: PlanPayload,
  action: ActionRow,
  predecessor: ReservationReceipt | null,
): SourceCommand {
  const base = {
    contractVersion: DOMAIN_CONTRACT_VERSION,
    organization,
    operationId: action.operationId,
    planId: payload.planId,
    actionId: intent.actionId,
  };
  switch (intent.kind) {
    case "amend_schedule":
      return {
        ...base,
        kind: intent.kind,
        poNumber: intent.poNumber,
        poLine: intent.poLine,
        uom: intent.uom,
        expectedRevision: intent.preconditions.expectedRevision,
        segments: intent.segments,
      };
    case "reserve":
      return {
        ...base,
        kind: intent.kind,
        sku: intent.sku,
        warehouse: intent.warehouse,
        uom: intent.uom,
        quantity: intent.quantity,
        expectedVersion: intent.preconditions.expectedVersion,
      };
    case "create_transfer_request":
      if (predecessor === null) throw new Error("a transfer request needs its reservation receipt");
      return {
        ...base,
        kind: intent.kind,
        optionId: intent.optionId,
        sku: intent.sku,
        uom: intent.uom,
        from: intent.from,
        to: intent.to,
        quantity: intent.quantity,
        dispatchDate: intent.dispatchDate,
        arrivalDate: intent.arrivalDate,
        expectedStockVersion: predecessor.successorVersion,
        reservationId: predecessor.reservationId,
        predecessorReceiptId: predecessor.receiptId,
      };
  }
}

async function submit(
  workflow: CaseWorkflow,
  command: SourceCommand,
): Promise<{ replayed: boolean; receipt: Receipt }> {
  const { purchasing, inventory } = workflow.sources;
  switch (command.kind) {
    case "amend_schedule":
      return purchasing.amendSchedule(command as Parameters<typeof purchasing.amendSchedule>[0]);
    case "reserve":
      return inventory.reserve(command as Parameters<typeof inventory.reserve>[0]);
    case "create_transfer_request":
      return inventory.createTransferRequest(
        command as Parameters<typeof inventory.createTransferRequest>[0],
      );
  }
}

interface Check {
  check: string;
  ok: boolean;
  expected: unknown;
  observed: unknown;
}

type Verdict = { state: CaseState; reason: string | null; owner: CaseActorRole };

/** One read-back of a plan's records, or why the sources could not be read. */
type ReadBack =
  | { status: "unavailable"; error: string }
  | {
      status: "read";
      actions: ActionRow[];
      missing: string[];
      readbacks: Map<string, unknown>;
      detail: Record<string, unknown> & { validUntil: string };
      verdict: Verdict;
    };

/**
 * Reads back every required source record and planning reference and compares
 * them with the approved outcome. Only a fully matching bundle makes the case
 * `plan_verified`; a verified plan is never evidence of physical receipt.
 */
async function verify(
  workflow: CaseWorkflow,
  caseId: string,
  plan: PlanRow,
): Promise<ApplyOutcome> {
  const result = await readBack(workflow, plan);
  if (result.status === "unavailable") {
    // Read-back failed: the case stays `verifying`, never `plan_verified`.
    await withCase(workflow, caseId, async (tx, row) => {
      await appendEvent(tx, row, await workflow.deps.clock.now(), {
        kind: "verification_unavailable",
        detail: { error: result.error },
      });
    });
    return { state: "verifying", retry: true };
  }
  const { actions, missing, readbacks, detail, verdict: outcome } = result;
  await withCase(workflow, caseId, async (tx, row) => {
    const at = await workflow.deps.clock.now();
    for (const action of actions) {
      const readback = readbacks.get(action.actionId);
      if (readback !== undefined) {
        await tx
          .update(caseAction)
          .set({ readback, updatedAt: at })
          .where(eq(caseAction.id, action.id));
      }
    }
    await markMissing(tx, plan, missing, at);
    await transition(
      tx,
      row,
      at,
      { ...outcome, from: ["verifying"] },
      { kind: "verification", detail },
    );
    await setVerifiedUntil(tx, row, outcome.state === "plan_verified" ? detail.validUntil : null);
  });
  return { state: outcome.state, retry: false };
}

/** A confirmed receipt without a matching record is an uncertain effect. */
async function markMissing(tx: Tx, plan: PlanRow, missing: readonly string[], at: string) {
  for (const actionId of missing) {
    await tx
      .update(caseAction)
      .set({ state: "unknown", reason: "verification_missing_record", updatedAt: at })
      .where(and(eq(caseAction.planRowId, plan.id), eq(caseAction.actionId, actionId)));
  }
}

/**
 * A successor's prior commitments as the inventory shows them now, read
 * through its whole lineage (ADR 0015); null for a case without a
 * predecessor or a lineage without commitments.
 */
async function currentCommitments(
  workflow: CaseWorkflow,
  db: Executor,
  row: CaseRow,
  at: string,
): Promise<PriorCommitment[] | null | "unavailable"> {
  if (row.predecessorCaseId === null) return null;
  const [predecessor] = await db
    .select()
    .from(supplierCase)
    .where(eq(supplierCase.id, row.predecessorCaseId));
  if (predecessor === undefined) return null;
  const read = await workflow.priorCommitmentsOf(db, predecessor, at);
  if (read === undefined) return null;
  if (read.status !== "ok") return "unavailable";
  return (read.data as { records: PriorCommitment[] }).records;
}

/** Only a requested commitment whose reservation is still held, or a dispatched one, holds. */
function commitmentHolds(commitment: PriorCommitment): boolean {
  return commitment.status === "requested" || commitment.status === "dispatched";
}

/** The holding commitment a plan's allocation counts, for the same request, or null. */
function heldCommitment(
  commitments: readonly PriorCommitment[],
  supply: { planId: string; commitmentId: string; requestId: string | null },
): PriorCommitment | null {
  return (
    commitments.find(
      (commitment) =>
        commitment.planId === supply.planId &&
        commitment.commitmentId === supply.commitmentId &&
        commitment.requestId === supply.requestId &&
        commitmentHolds(commitment),
    ) ?? null
  );
}

async function setVerifiedUntil(tx: Tx, row: CaseRow, until: string | null) {
  await tx.update(supplierCase).set({ verifiedUntil: until }).where(eq(supplierCase.id, row.id));
  row.verifiedUntil = until;
}

/** Reasons of an earlier read-back that a later matching recheck may clear. */
const RECHECKABLE_REASONS: readonly string[] = [
  "verification_mismatch",
  "verification_missing_record",
  "planning_reference_mismatch",
];

/**
 * Whether a case may have its verification rechecked (ADR 0015): a verified
 * plan, or a plan whose read-back stopped matching while every one of its
 * actions is still confirmed, so a recheck can never stand in for a write.
 */
export async function recheckable(db: Executor, row: CaseRow, plan: PlanRow | null) {
  if (plan === null) return false;
  if (row.state === "plan_verified") return true;
  if (row.state !== "partially_applied" || !RECHECKABLE_REASONS.includes(row.reason ?? "")) {
    return false;
  }
  return (await actionsOf(db, plan.id)).every((action) => action.state === "confirmed");
}

/**
 * Reads the verified plan's records back again outside any transaction, then
 * records the outcome on the locked case if it is still in the state and plan
 * the caller checked. A match renews `verifiedUntil`; a mismatch or missing
 * record leaves `plan_verified` for `partially_applied` and clears it; an
 * unreadable source changes nothing but is recorded as its own event. Earlier
 * verification events stay as they were.
 */
export async function recheckVerification(
  workflow: CaseWorkflow,
  expected: { caseId: string; state: string; planRowId: string },
  plan: PlanRow,
  actorId: string,
): Promise<{ outcome: string; state: string; validUntil: string | null } | "changed"> {
  const result = await readBack(workflow, plan);
  return withCase(workflow, expected.caseId, async (tx, row) => {
    if (row.state !== expected.state || row.currentPlanId !== expected.planRowId) {
      return "changed" as const;
    }
    const at = await workflow.deps.clock.now();
    if (result.status === "unavailable") {
      await appendEvent(tx, row, at, {
        kind: "verification_unavailable",
        actorId,
        detail: { recheck: true, planSha256: plan.sha256, error: result.error },
      });
      return { outcome: "unavailable", state: row.state, validUntil: row.verifiedUntil };
    }
    const { verdict } = result;
    const outcome = verdict.reason ?? "verified";
    const detail = { ...result.detail, recheck: true, outcome };
    if (verdict.state === "plan_verified" && row.state === "plan_verified") {
      await appendEvent(tx, row, at, { kind: "verification", actorId, detail });
    } else {
      await transition(
        tx,
        row,
        at,
        { ...verdict, from: ["plan_verified", "partially_applied"] },
        { kind: "verification", actorId, detail },
      );
    }
    // As after the first read-back: a confirmed receipt without its record is
    // an uncertain effect, so no later matching read can restore the plan
    // until it is reconciled.
    await markMissing(tx, plan, result.missing, at);
    const until = verdict.state === "plan_verified" ? result.detail.validUntil : null;
    await setVerifiedUntil(tx, row, until);
    return { outcome, state: row.state, validUntil: until };
  });
}

async function readBack(workflow: CaseWorkflow, plan: PlanRow): Promise<ReadBack> {
  const payload = payloadOf(plan);
  const actions = await actionsOf(workflow.deps.db, plan.id);
  const byAction = new Map(actions.map((action) => [action.actionId, action]));
  const { purchasing, inventory, demand } = workflow.sources;
  const checks: Check[] = [];
  const add = (check: string, expected: unknown, observed: unknown) =>
    checks.push({
      check,
      ok: canonicalJson(expected) === canonicalJson(observed),
      expected,
      observed,
    });
  const missing: string[] = [];
  const readTimes: string[] = [];
  const references: Array<Record<string, unknown>> = [];
  const readbacks = new Map<string, unknown>();

  try {
    for (const intent of payload.actions) {
      const action = byAction.get(intent.actionId);
      const query = { organization, operationId: action?.operationId ?? "" };
      if (intent.kind === "amend_schedule") {
        const found = await purchasing.lookupOperation(query);
        if (found === null) {
          missing.push(intent.actionId);
          continue;
        }
        readTimes.push(found.readAt);
        const current = await purchasing.readPurchaseOrder({
          organization,
          poNumber: intent.poNumber,
        });
        readTimes.push(current.readAt);
        const prior = await purchasing.readPurchaseOrder({
          organization,
          poNumber: intent.poNumber,
          revision: found.receipt.priorRevision,
        });
        const line = current.record.lines.find((entry) => entry.lineNumber === intent.poLine);
        const before = prior.record.lines.find((entry) => entry.lineNumber === intent.poLine);
        add(
          `${intent.actionId}.current_revision`,
          found.receipt.successorRevision,
          current.currentRevision,
        );
        add(`${intent.actionId}.segments`, intent.segments, line?.acceptedSegments ?? null);
        add(
          `${intent.actionId}.received_and_canceled_unchanged`,
          { received: before?.received, canceled: before?.canceled },
          { received: line?.received, canceled: line?.canceled },
        );
        readbacks.set(intent.actionId, {
          poNumber: intent.poNumber,
          revision: current.currentRevision,
          line,
        });
      } else if (intent.kind === "reserve") {
        const found = await inventory.lookupOperation(query);
        if (found === null || !("reservation" in found) || found.reservation === null) {
          missing.push(intent.actionId);
          continue;
        }
        readTimes.push(found.readAt);
        const stock = await inventory.readStock({
          organization,
          sku: intent.sku,
          warehouse: intent.warehouse,
        });
        readTimes.push(stock.readAt);
        add(
          `${intent.actionId}.stock_version`,
          found.receipt.successorVersion,
          stock.currentVersion,
        );
        add(
          `${intent.actionId}.reservation`,
          { quantity: intent.quantity, plan: payload.planId },
          {
            quantity: found.reservation.quantity,
            plan:
              found.reservation.binding.kind === "plan" ? found.reservation.binding.planId : null,
          },
        );
        const bound = await inventory.readStock({
          organization,
          sku: intent.sku,
          warehouse: intent.warehouse,
          version: intent.preconditions.expectedVersion,
        });
        const unrelated = (records: typeof bound.record.reservations) =>
          records.filter((entry) => entry.binding.kind === "unrelated");
        add(
          `${intent.actionId}.unrelated_reservations_unchanged`,
          unrelated(bound.record.reservations),
          unrelated(stock.record.reservations),
        );
        add(`${intent.actionId}.physical_unchanged`, bound.record.physical, stock.record.physical);
        readbacks.set(intent.actionId, {
          stockVersion: stock.currentVersion,
          reservation: found.reservation,
          physical: stock.record.physical,
        });
      } else {
        const found = await inventory.lookupOperation(query);
        if (found === null || !("request" in found) || found.request === null) {
          missing.push(intent.actionId);
          continue;
        }
        readTimes.push(found.readAt);
        const reservation = byAction.get(intent.preconditions.reservationFromAction)
          ?.receipt as ReservationReceipt | null;
        const request = found.request;
        add(
          `${intent.actionId}.request`,
          {
            from: intent.from,
            to: intent.to,
            quantity: intent.quantity,
            arrivalDate: intent.arrivalDate,
            status: "requested",
            reservationId: reservation?.reservationId ?? null,
          },
          {
            from: request.from,
            to: request.to,
            quantity: request.quantity,
            arrivalDate: request.arrivalDate,
            status: request.status,
            reservationId: request.reservation.reservationId,
          },
        );
        readbacks.set(intent.actionId, { request });
      }
    }

    // Planning references: each allocation names its supply by source identity.
    const amend = payload.actions.find((intent) => intent.kind === "amend_schedule");
    const transfer = payload.actions.find((intent) => intent.kind === "create_transfer_request");
    const amendRead =
      amend === undefined
        ? undefined
        : (readbacks.get(amend.actionId) as
            | {
                poNumber: string;
                revision: string;
                line?: { acceptedSegments: Array<{ sequence: number; quantity: string }> };
              }
            | undefined);
    const transferRead =
      transfer === undefined
        ? undefined
        : (readbacks.get(transfer.actionId) as
            | {
                request: {
                  requestId: string;
                  quantity: string;
                  reservation: { reservationId: string };
                };
              }
            | undefined);
    const destinations = new Map<string, { quantity: bigint }>();
    let commitments: PriorCommitment[] | undefined;
    for (const allocation of payload.allocations) {
      const line = `${allocation.demandLine.salesOrder}/${allocation.demandLine.line}`;
      const supply = allocation.supply;
      if (supply.kind === "stock") {
        const total = destinations.get(`${supply.warehouse}`)?.quantity ?? 0n;
        destinations.set(supply.warehouse, { quantity: total + BigInt(allocation.quantity) });
        references.push({
          demandLine: line,
          supply: { kind: "stock", warehouse: supply.warehouse },
          quantity: allocation.quantity,
        });
      } else if (supply.kind === "po_segment") {
        const segment = amendRead?.line?.acceptedSegments.find(
          (entry) => entry.sequence === supply.sequence,
        );
        const reference = {
          demandLine: line,
          supply: {
            kind: "po_segment",
            poNumber: supply.poNumber,
            revision: amendRead?.revision ?? null,
            poLine: supply.poLine,
            sequence: supply.sequence,
          },
          quantity: allocation.quantity,
        };
        references.push(reference);
        add(
          `reference.${line}.po_segment.${String(supply.sequence)}`,
          true,
          segment !== undefined && BigInt(segment.quantity) >= BigInt(allocation.quantity),
        );
      } else if (supply.kind === "transfer_option") {
        const request = transferRead?.request;
        references.push({
          demandLine: line,
          supply: {
            kind: "transfer_request",
            transferRequestId: request?.requestId ?? null,
            reservationId: request?.reservation.reservationId ?? null,
          },
          quantity: allocation.quantity,
        });
        add(
          `reference.${line}.transfer_request`,
          true,
          request !== undefined && BigInt(request.quantity) >= BigInt(allocation.quantity),
        );
      } else if (supply.kind === "prior_commitment") {
        // A predecessor's commitment this plan relies on (ADR 0015) must still
        // hold: its request, its reservation unless dispatched, and no partial
        // or receipt observation.
        if (commitments === undefined) {
          const [row] = await workflow.deps.db
            .select()
            .from(supplierCase)
            .where(eq(supplierCase.id, plan.caseId));
          const read =
            row === undefined
              ? null
              : await currentCommitments(
                  workflow,
                  workflow.deps.db,
                  row,
                  await workflow.deps.clock.now(),
                );
          if (read === "unavailable") throw new Error("prior commitments are unavailable");
          commitments = read ?? [];
        }
        const held = heldCommitment(commitments, supply);
        const observed =
          commitments.find(
            (commitment) =>
              commitment.planId === supply.planId &&
              commitment.commitmentId === supply.commitmentId,
          ) ?? null;
        references.push({
          demandLine: line,
          supply: {
            kind: "prior_commitment",
            planId: supply.planId,
            commitmentId: supply.commitmentId,
            transferRequestId: observed?.requestId ?? null,
            status: observed?.status ?? null,
          },
          quantity: allocation.quantity,
        });
        add(
          `reference.${line}.prior_commitment.${supply.commitmentId}`,
          true,
          held !== null && BigInt(held.quantity) >= BigInt(allocation.quantity),
        );
      }
    }
    for (const [warehouse, need] of destinations) {
      const stock = await inventory.readStock({
        organization,
        sku: payload.demand[0]?.sku ?? "",
        warehouse,
      });
      readTimes.push(stock.readAt);
      const eligibility = deriveEligibility(stock.record);
      add(
        `reference.stock.${warehouse}.eligible`,
        true,
        eligibility.ok && BigInt(eligibility.value.eligible) >= need.quantity,
      );
      readbacks.set(`stock.${warehouse}`, {
        stockVersion: stock.currentVersion,
        physical: stock.record.physical,
        reservations: stock.record.reservations,
      });
    }
    const demandRead = await demand.readDemand({ organization });
    readTimes.push(demandRead.readAt);
    for (const line of payload.demand) {
      const current = demandRead.record.lines.find(
        (entry) => entry.salesOrder === line.salesOrder && entry.line === line.line,
      );
      add(
        `demand.${line.salesOrder}/${line.line}.supply_links`,
        line.supplyLinks,
        current?.supplyLinks ?? null,
      );
    }
  } catch (thrown) {
    return {
      status: "unavailable",
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }

  const bundleTime = readTimes.reduce((earliest, time) =>
    Date.parse(time) < Date.parse(earliest) ? time : earliest,
  );
  const mismatches = checks.filter((check) => !check.ok);
  const detail = {
    planSha256: plan.sha256,
    bundleTime,
    validUntil: new Date(Date.parse(bundleTime) + VERIFICATION_VALIDITY_MS).toISOString(),
    missing,
    checks,
    planningReferences: references,
    readbacks: Object.fromEntries(readbacks),
    physicalDelivery: {
      supplierReceipt: "not_recorded",
      transferReceipt: "not_recorded",
      note: "A verified plan is not evidence of physical delivery or customer impact.",
    },
  };
  const verdict: Verdict =
    missing.length > 0
      ? {
          state: "partially_applied",
          reason: "verification_missing_record",
          owner: "warehouse_planner",
        }
      : mismatches.some((check) => check.check.startsWith("reference."))
        ? { state: "partially_applied", reason: "planning_reference_mismatch", owner: "buyer" }
        : mismatches.length > 0
          ? {
              state: "partially_applied",
              reason: "verification_mismatch",
              owner: "warehouse_planner",
            }
          : { state: "plan_verified", reason: null, owner: "buyer" };
  return { status: "read", actions, missing, readbacks, detail, verdict };
}
