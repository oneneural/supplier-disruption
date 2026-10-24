import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  type AcknowledgementCommand,
  type ActionIntent,
  type CaseActorRole,
  type CaseNoteCommand,
  type CaseState,
  type Clock,
  type CoverageAssessment,
  type EscalationCommand,
  type IngestMessageCommand,
  type IntakeDecision,
  type IntakeReceipt,
  type PlanDecisionCommand,
  type PlanPayload,
  type PriorAcceptance,
  type ProposedPlan,
  type ReadEvidence,
  type ReservationReceipt,
  type RevocationCommand,
  type VerificationCheckCommand,
} from "@supplier-disruption/contracts";
import {
  agentRun,
  CASE_JOB_OPTIONS,
  CASE_QUEUE,
  caseAction,
  caseAssessment,
  caseClarification,
  caseDecision,
  casePlan,
  supplierCase,
  supplierMessage,
  type CaseJobData,
} from "@supplier-disruption/db";
import { approvalRefusal, assessCoverage, intakeAndAssess } from "@supplier-disruption/domain";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type pg from "pg";
import { CASE_FIXTURE } from "./fixture.js";
import { createCaseSources, type CaseSources } from "./sources.js";
import {
  composeIntake,
  composeReassessment,
  deliveryOf,
  readPriorCommitments,
  readStoredInput,
  type PredecessorTransfers,
} from "./sources.js";
import {
  actionsOf,
  actorFor,
  appendEvent,
  currentPlan,
  decisionsOf,
  lockCase,
  payloadOf,
  transition,
  type ActionRow,
  type CaseRow,
  type Db,
  type DecisionRow,
  type Executor,
  type PlanRow,
  type Tx,
} from "./store.js";
import {
  applyCase,
  inFlight,
  proposeCompensation,
  recheckable,
  recheckVerification,
  RECONCILIATION_PENDING,
  RECONCILIATION_UNRESOLVED,
  type ApplyOutcome,
} from "./apply.js";
import { EmailExtraction, type AgentSettings } from "./extraction.js";
import { CaseClarifications } from "./clarification.js";

/** Test-only fault hooks. Production wiring never supplies them. */
export interface CaseFaultHooks {
  /**
   * Transaction barriers (ADR 0013). `beforeClaim` runs after the run's own
   * checks and before the claim transaction; `beforeClaimCommit` inside that
   * transaction, with the case row locked and the guard passed;
   * `beforeSubmit` after the claim committed, before the source write.
   */
  beforeClaim?: (context: { caseId: string; actionId: string }) => Promise<void>;
  beforeClaimCommit?: (context: { caseId: string; actionId: string }) => Promise<void>;
  beforeSubmit?: (context: { caseId: string; actionId: string }) => Promise<void>;
  /**
   * Runs after a source write returned, before the API records it. Throwing
   * simulates a response lost after the source committed (a timeout).
   */
  afterSourceWrite?: (context: {
    caseId: string;
    actionId: string;
    attempt: number;
  }) => Promise<void>;
}

export interface CaseWorkflowDependencies {
  db: Db;
  /** Pool for the fixture source modules; a database-backed clock must not share it. */
  sourcePool: pg.Pool;
  clock: Clock;
  boss: PgBoss;
  faults?: CaseFaultHooks;
  /** Extraction agent settings; without them an email case pauses for want of a provider. */
  agent?: AgentSettings;
}

/** A command outcome: the HTTP status and body the route returns. */
export interface CaseResult {
  status: number;
  body: Record<string, unknown>;
}

const error = (status: number, code: string, extra: Record<string, unknown> = {}): CaseResult => ({
  status,
  body: { error: code, ...extra },
});

export const CASE_ERRORS = {
  caseNotFound: "case_not_found",
  organizationNotServed: "organization_not_served",
  messageNotFound: "message_not_found",
  deliveryConflict: "delivery_conflict",
  sourceUnavailable: "source_unavailable",
  actorNotPermitted: "actor_not_permitted",
  planMismatch: "plan_mismatch",
  invalidState: "invalid_case_state",
  revisionConflict: "revision_conflict",
  approvalNotCurrent: "approval_not_current",
} as const;

/**
 * Where a newly accepted supplier input stands against earlier cases of its
 * PO line (ADR 0015): a plain case, the successor of a verified case, or a
 * conflict with a successor that is still open.
 */
export type RevisionLineage =
  | { kind: "none" }
  | { kind: "successor"; predecessor: CaseRow; plan: PlanRow }
  | { kind: "conflict"; open: CaseRow };

const TERMINAL: readonly CaseState[] = ["plan_verified", "escalated", "superseded"];

/** The journal identity of an action's latest attempt, for cancellation events. */
const attemptOf = (action: ActionRow) => ({
  actionId: action.actionId,
  operationId: action.operationId,
  attemptKey: action.attemptKey,
  state: action.state,
  reason: action.reason,
});

/** States in which a current approval may be revoked (ADR 0016). */
const REVOCABLE: readonly CaseState[] = [
  "awaiting_acknowledgement",
  "applying",
  "partially_applied",
];

/** Roles that can approve or reject a plan under AUTH-1; others are refused outright. */
const APPROVER_ROLES: readonly CaseActorRole[] = ["buyer", "procurement_manager"];

/** Roles that may ask for a verification recheck; it reads sources and writes none. */
const VERIFIER_ROLES: readonly CaseActorRole[] = [
  "buyer",
  "procurement_manager",
  "warehouse_planner",
];

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The UTC offset of Europe/Copenhagen at an instant, in minutes. */
function copenhagenOffsetMinutes(ms: number): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Copenhagen", timeZoneName: "longOffset" })
      .formatToParts(new Date(ms))
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (match === null) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/**
 * Approvals expire at 18:00 Europe/Copenhagen on the business date they are
 * given, the C-01 fixture expiry (ADR 0009).
 */
export function approvalExpiry(at: string): string {
  const local = new Date(Date.parse(at) + copenhagenOffsetMinutes(Date.parse(at)) * 60_000);
  const date = local.toISOString().slice(0, 10);
  const guess = Date.parse(`${date}T18:00:00Z`);
  return new Date(guess - copenhagenOffsetMinutes(guess) * 60_000).toISOString();
}

const segmentsOf = (intent: ActionIntent | undefined) =>
  intent?.kind === "amend_schedule" ? intent.segments : null;

/** One plan's transfer request actions with the reservation each relies on (ADR 0015). */
function transfersOf(plan: PlanRow, journal: ActionRow[]): PredecessorTransfers["transfers"] {
  const payload = payloadOf(plan);
  const transfers: PredecessorTransfers["transfers"] = [];
  for (const intent of payload.actions) {
    if (intent.kind !== "create_transfer_request") continue;
    const action = journal.find((entry) => entry.actionId === intent.actionId);
    const reservation = journal.find(
      (entry) => entry.actionId === intent.preconditions.reservationFromAction,
    )?.receipt as ReservationReceipt | null | undefined;
    if (action === undefined) continue;
    transfers.push({
      planId: payload.planId,
      commitmentId: intent.actionId,
      operationId: action.operationId,
      // Without a reservation receipt the request cannot match: it reads as unknown.
      reservationId: reservation?.reservationId ?? intent.preconditions.reservationFromAction,
      sku: intent.sku,
      uom: intent.uom,
      from: intent.from,
      to: intent.to,
      quantity: intent.quantity,
      arrivalDate: intent.arrivalDate,
    });
  }
  return transfers;
}

export class CaseWorkflow {
  readonly sources: CaseSources;
  readonly extraction: EmailExtraction;
  readonly clarifications: CaseClarifications;

  constructor(readonly deps: CaseWorkflowDependencies) {
    this.sources = createCaseSources(deps.sourcePool, deps.clock);
    this.extraction = new EmailExtraction(
      this,
      deps.agent ?? { provider: null, costCapMicroUsd: 0 },
    );
    this.clarifications = new CaseClarifications(this);
  }

  now(): Promise<string> {
    return this.deps.clock.now();
  }

  // Intake -----------------------------------------------------------------

  /**
   * Stores one delivery's exact bytes and runs intake and assessment. A
   * repeated delivery ID returns the recorded outcome; a new delivery of an
   * accepted message is a duplicate observation with no new case, proposal,
   * plan or effect. Ingests of one organization are serialized.
   */
  async ingest(command: IngestMessageCommand): Promise<CaseResult> {
    const organizationId = command.organizationId;
    if (organizationId !== CASE_FIXTURE.organization.id) {
      return error(404, CASE_ERRORS.organizationNotServed);
    }
    const key = {
      sourceSystem: command.sourceSystem,
      messageId: command.messageId,
      inputVersion: command.inputVersion,
    };
    const replay = await this.recordedDelivery(this.deps.db, organizationId, command);
    if (replay !== null) return replay;

    const stored = await readStoredInput(this.sources, key);
    if (stored.status !== "ok") {
      return stored.status === "not_found"
        ? error(404, CASE_ERRORS.messageNotFound)
        : error(503, CASE_ERRORS.sourceUnavailable);
    }
    const delivery = deliveryOf(stored.identity, stored.terms, command.supplierText);
    const content = Buffer.from(canonicalJson(delivery), "utf8");

    return this.deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`case-ingest:${organizationId}`}))`,
      );
      const again = await this.recordedDelivery(tx, organizationId, command);
      if (again !== null) return again;

      const [existing] = await tx
        .select()
        .from(supplierCase)
        .where(
          and(
            eq(supplierCase.organizationId, organizationId),
            eq(supplierCase.sourceSystem, key.sourceSystem),
            eq(supplierCase.messageId, key.messageId),
          ),
        )
        .for("update");
      const at = await this.now();
      const caseNumber = existing?.caseNumber ?? (await this.nextCaseNumber(tx, organizationId));
      const caseId = existing?.id ?? randomUUID();
      const planVersion = (existing?.planVersion ?? 0) + 1;
      // A message already accepted is a duplicate; it never links or supersedes anything.
      const lineage: RevisionLineage =
        existing?.intakeReceipt == null
          ? await this.revisionLineage(tx, organizationId, stored.terms, existing)
          : { kind: "none" };
      if (lineage.kind === "conflict") {
        return this.conflictingRevision(tx, command, existing, lineage.open, {
          caseId,
          caseNumber,
          key,
          content,
          at,
        });
      }
      const input = await composeIntake(this.sources, stored, delivery, {
        receiptId: `RCPT-${String(caseNumber)}`,
        caseId,
        planId: `PLAN-${String(caseNumber)}`,
        planVersion,
        assessedAt: at,
        priorAcceptance: await this.priorAcceptance(tx, organizationId, stored.identity, existing),
        ...(lineage.kind === "successor"
          ? { priorCommitments: await this.priorCommitmentsOf(tx, lineage.predecessor, at) }
          : {}),
      });
      const outcome = intakeAndAssess(input);
      const intake = outcome.intake;

      const message = {
        id: randomUUID(),
        organizationId,
        deliveryId: command.deliveryId,
        ...key,
        content,
        contentSha256: sha256Hex(content),
        disposition: intake.disposition,
        reason: intake.disposition === "blocked" ? intake.decision.reason : null,
        receivedAt: at,
      };
      const messageDetail = {
        deliveryId: command.deliveryId,
        messageSha256: message.contentSha256,
        byteLength: content.length,
      };

      // An email case waiting in `received` gets its first intake decision here.
      const decided = existing !== undefined && existing.state !== "received";
      if (intake.disposition === "duplicate" || (intake.disposition === "blocked" && decided)) {
        // An observation of a message this case already holds: no new case or plan.
        if (existing === undefined) throw new Error("a duplicate needs the accepted case");
        await tx.insert(supplierMessage).values({ ...message, caseId: existing.id });
        await appendEvent(tx, existing, at, {
          kind: intake.disposition === "duplicate" ? "duplicate_delivery" : "blocked_delivery",
          reason: message.reason,
          detail: messageDetail,
        });
        return {
          status: 200,
          body: this.ingestBody(existing, intake.disposition, message.reason),
        };
      }

      const row =
        existing ??
        (await this.openCase(tx, {
          id: caseId,
          organizationId,
          caseNumber,
          key,
          at,
        }));
      await tx.insert(supplierMessage).values({ ...message, caseId: row.id });
      await appendEvent(tx, row, at, { kind: "delivery_stored", detail: messageDetail });

      if (intake.disposition === "blocked") {
        await this.storeAssessment(tx, row, at, intake, null);
        await transition(
          tx,
          row,
          at,
          { state: "needs_clarification", reason: intake.decision.reason, owner: "buyer" },
          {
            kind: "intake_blocked",
            detail: { subject: intake.subject, diagnostics: intake.diagnostics },
          },
        );
        return { status: 201, body: this.ingestBody(row, "blocked", intake.decision.reason) };
      }

      const receipt: IntakeReceipt = intake.proposedReceipt;
      await tx
        .update(supplierCase)
        .set({
          intakeReceipt: receipt,
          contentSha256: intake.contentSha256,
          proposalId: intake.proposal.proposalId,
          vendorId: intake.vendorId,
        })
        .where(eq(supplierCase.id, row.id));
      Object.assign(row, {
        intakeReceipt: receipt,
        contentSha256: intake.contentSha256,
        proposalId: intake.proposal.proposalId,
        vendorId: intake.vendorId,
      });
      // A case escalated while its email extraction ran (or otherwise closed)
      // is never assessed: the conflict rolls this ingest back (see
      // ADR 0019). A blocked case may still be reassessed by a new delivery.
      await transition(
        tx,
        row,
        at,
        { state: "assessing", from: ["received", "needs_clarification"] },
        { kind: "intake_accepted", detail: { association: intake.association } },
      );
      if (lineage.kind === "successor") await this.linkSuccessor(tx, row, lineage, at);
      if (outcome.assessment === null) throw new Error("an accepted input is always assessed");
      await this.recordAssessment(tx, row, at, intake, outcome.assessment);
      return { status: 201, body: this.ingestBody(row, "accept", null) };
    });
  }

  private ingestBody(row: CaseRow, disposition: string, reason: string | null) {
    return {
      disposition,
      reason,
      caseId: row.id,
      caseRef: `CASE-${String(row.caseNumber)}`,
      state: row.state,
    };
  }

  /**
   * A second revision of a PO line while an earlier successor case is still
   * open: the bytes are kept as a blocked delivery and nothing is assessed,
   * linked or superseded. The buyer settles the open successor first.
   */
  private async conflictingRevision(
    tx: Tx,
    command: IngestMessageCommand,
    existing: CaseRow | undefined,
    open: CaseRow,
    init: {
      caseId: string;
      caseNumber: number;
      key: { sourceSystem: string; messageId: string; inputVersion: number };
      content: Buffer;
      at: string;
    },
  ): Promise<CaseResult> {
    const { organizationId } = command;
    const reason = CASE_ERRORS.revisionConflict;
    const row =
      existing ??
      (await this.openCase(tx, {
        id: init.caseId,
        organizationId,
        caseNumber: init.caseNumber,
        key: init.key,
        at: init.at,
      }));
    await tx.insert(supplierMessage).values({
      id: randomUUID(),
      organizationId,
      deliveryId: command.deliveryId,
      ...init.key,
      content: init.content,
      contentSha256: sha256Hex(init.content),
      disposition: "blocked",
      reason,
      caseId: row.id,
      receivedAt: init.at,
    });
    const detail = { openCaseId: open.id, openCaseRef: `CASE-${String(open.caseNumber)}` };
    if (row.state === "needs_clarification" && row.reason === reason) {
      await appendEvent(tx, row, init.at, { kind: "blocked_delivery", reason, detail });
      return { status: 200, body: this.ingestBody(row, "blocked", reason) };
    }
    // A terminal case without an intake receipt (an escalated email case) is
    // never reopened by a late hand-off (ADR 0019).
    await transition(
      tx,
      row,
      init.at,
      {
        state: "needs_clarification",
        reason,
        owner: "buyer",
        from: ["received", "needs_clarification"],
      },
      { kind: "revision_conflict", detail },
    );
    return { status: 201, body: this.ingestBody(row, "blocked", reason) };
  }

  /**
   * The lineage of a supplier input for a PO line. A case that is already a
   * successor keeps its predecessor. Otherwise the verified, not yet
   * superseded case of the same PO line is the predecessor, and any open
   * successor of that line is a conflict. Only candidate rows of the same PO
   * line are locked, so a concurrent recheck or link of that line waits.
   */
  async revisionLineage(
    tx: Tx,
    organizationId: string,
    terms: { poNumber: string; poLine: string },
    row: CaseRow | undefined,
  ): Promise<RevisionLineage> {
    const others = (condition: ReturnType<typeof and>) =>
      tx
        .select()
        .from(supplierCase)
        .where(
          and(
            eq(supplierCase.organizationId, organizationId),
            sql`${supplierCase.intakeReceipt}->>'poNumber' = ${terms.poNumber}`,
            sql`${supplierCase.intakeReceipt}->>'poLine' = ${terms.poLine}`,
            condition,
            ...(row === undefined ? [] : [ne(supplierCase.id, row.id)]),
          ),
        )
        .orderBy(desc(supplierCase.caseNumber))
        .for("update");
    if (row?.predecessorCaseId != null) {
      const predecessor = await lockCase(tx, row.predecessorCaseId);
      const plan = predecessor === null ? null : await currentPlan(tx, predecessor);
      if (predecessor === null || plan === null)
        throw new Error("a successor's predecessor has a plan");
      return { kind: "successor", predecessor, plan };
    }
    const [verified] = await others(
      and(eq(supplierCase.state, "plan_verified"), isNull(supplierCase.successorCaseId)),
    );
    if (verified !== undefined) {
      const plan = await currentPlan(tx, verified);
      if (plan !== null) return { kind: "successor", predecessor: verified, plan };
    }
    const [open] = await others(
      and(isNotNull(supplierCase.predecessorCaseId), notInArray(supplierCase.state, [...TERMINAL])),
    );
    return open === undefined ? { kind: "none" } : { kind: "conflict", open };
  }

  /**
   * Links an accepted successor to its verified predecessor both ways and
   * supersedes the predecessor. Its plan, decisions, actions and effects stay
   * exactly as they were; only the case state and the link change.
   */
  async linkSuccessor(
    tx: Tx,
    row: CaseRow,
    lineage: Extract<RevisionLineage, { kind: "successor" }>,
    at: string,
  ): Promise<void> {
    if (row.predecessorCaseId !== null) return;
    const { predecessor, plan } = lineage;
    await tx
      .update(supplierCase)
      .set({ predecessorCaseId: predecessor.id })
      .where(eq(supplierCase.id, row.id));
    row.predecessorCaseId = predecessor.id;
    await tx
      .update(supplierCase)
      .set({ successorCaseId: row.id })
      .where(eq(supplierCase.id, predecessor.id));
    predecessor.successorCaseId = row.id;
    await transition(
      tx,
      predecessor,
      at,
      {
        state: "superseded",
        reason: "later_supplier_revision",
        owner: "buyer",
        from: ["plan_verified"],
      },
      {
        kind: "superseded",
        detail: {
          successorCaseId: row.id,
          successorRef: `CASE-${String(row.caseNumber)}`,
          messageId: row.messageId,
        },
      },
    );
    await appendEvent(tx, row, at, {
      kind: "revision_linked",
      detail: {
        predecessorCaseId: predecessor.id,
        predecessorRef: `CASE-${String(predecessor.caseNumber)}`,
        predecessorPlanId: plan.planId,
        predecessorPlanSha256: plan.sha256,
      },
    });
  }

  /**
   * The transfer commitments a successor relies on, as the inventory shows
   * them now: the predecessor plan's own and those of every earlier plan in
   * its lineage, which it carried forward (ADR 0015). Undefined when no plan
   * in the lineage made a transfer commitment. Reads take no lock.
   */
  async priorCommitmentsOf(
    db: Executor,
    predecessor: CaseRow,
    at: string,
  ): Promise<ReadEvidence<unknown> | undefined> {
    const transfers: PredecessorTransfers["transfers"] = [];
    const planIds: string[] = [];
    let current: CaseRow | null = predecessor;
    while (current !== null) {
      // The contract bounds the lineage; a longer one is never read partly.
      if (planIds.length > 20) throw new Error("a case lineage is longer than 21 plans");
      const plan = await currentPlan(db, current);
      if (plan === null) throw new Error("every case in a lineage has a plan");
      planIds.push(plan.planId);
      transfers.push(...transfersOf(plan, await actionsOf(db, plan.id)));
      const earlier: string | null = current.predecessorCaseId;
      [current = null] =
        earlier === null
          ? []
          : await db.select().from(supplierCase).where(eq(supplierCase.id, earlier));
    }
    if (transfers.length === 0) return undefined;
    const [planId = "", ...inheritedPlanIds] = planIds;
    return readPriorCommitments(this.sources, { planId, inheritedPlanIds, transfers }, at);
  }

  async recordedDelivery(
    db: Db | Tx,
    organizationId: string,
    command: IngestMessageCommand,
  ): Promise<CaseResult | null> {
    const [delivery] = await db
      .select()
      .from(supplierMessage)
      .where(
        and(
          eq(supplierMessage.organizationId, organizationId),
          eq(supplierMessage.deliveryId, command.deliveryId),
        ),
      );
    if (delivery === undefined) return null;
    if (
      delivery.sourceSystem !== command.sourceSystem ||
      delivery.messageId !== command.messageId ||
      delivery.inputVersion !== command.inputVersion
    ) {
      return error(409, CASE_ERRORS.deliveryConflict);
    }
    const [row] =
      delivery.caseId === null
        ? []
        : await db.select().from(supplierCase).where(eq(supplierCase.id, delivery.caseId));
    if (row === undefined) return error(409, CASE_ERRORS.deliveryConflict);
    return {
      status: 200,
      body: { ...this.ingestBody(row, delivery.disposition, delivery.reason), replayed: true },
    };
  }

  async nextCaseNumber(tx: Tx, organizationId: string): Promise<number> {
    const [row] = await tx
      .select({ last: max(supplierCase.caseNumber) })
      .from(supplierCase)
      .where(eq(supplierCase.organizationId, organizationId));
    return (row?.last ?? 0) + 1;
  }

  /** The trusted prior acceptance: this message's receipt, a same-terms candidate, or none. */
  async priorAcceptance(
    tx: Tx,
    organizationId: string,
    identity: { sourceSystem: string; messageId: string; contentSha256: string },
    existing: CaseRow | undefined,
  ): Promise<PriorAcceptance> {
    const query = {
      organization: CASE_FIXTURE.label,
      sourceSystem: identity.sourceSystem,
      messageId: identity.messageId,
      contentSha256: identity.contentSha256,
    };
    if (existing?.intakeReceipt != null) {
      return { status: "receipt", query, receipt: existing.intakeReceipt as IntakeReceipt };
    }
    const [candidate] = await tx
      .select({ receipt: supplierCase.intakeReceipt })
      .from(supplierCase)
      .where(
        and(
          eq(supplierCase.organizationId, organizationId),
          eq(supplierCase.contentSha256, identity.contentSha256),
          ne(supplierCase.messageId, identity.messageId),
          isNotNull(supplierCase.intakeReceipt),
        ),
      )
      .limit(1);
    return candidate === undefined
      ? { status: "none", query }
      : { status: "candidate", query, receipt: candidate.receipt as IntakeReceipt };
  }

  async openCase(
    tx: Tx,
    init: {
      id: string;
      organizationId: string;
      caseNumber: number;
      key: { sourceSystem: string; messageId: string; inputVersion: number };
      at: string;
    },
  ): Promise<CaseRow> {
    const [row] = await tx
      .insert(supplierCase)
      .values({
        id: init.id,
        organizationId: init.organizationId,
        caseNumber: init.caseNumber,
        ...init.key,
        state: "received",
        nextAction: "Validate identity and base revision",
        openedAt: init.at,
        updatedAt: init.at,
      })
      .returning();
    if (row === undefined) throw new Error("case insert returned nothing");
    await appendEvent(tx, row, init.at, {
      kind: "received",
      toState: "received",
      detail: { messageId: init.key.messageId },
    });
    return row;
  }

  /** Stores an assessment run and, when it proposes one, the immutable plan and its journal. */
  async storeAssessment(
    tx: Tx,
    row: CaseRow,
    at: string,
    intake: IntakeDecision | null,
    assessment: CoverageAssessment | null,
  ): Promise<PlanRow | null> {
    const assessmentId = randomUUID();
    const [previous] = await tx
      .select({ last: max(caseAssessment.sequence) })
      .from(caseAssessment)
      .where(eq(caseAssessment.caseId, row.id));
    await tx.insert(caseAssessment).values({
      id: assessmentId,
      caseId: row.id,
      sequence: (previous?.last ?? 0) + 1,
      intake: intake ?? { disposition: "reassessment" },
      assessment,
      assessedAt: at,
    });
    const plan: ProposedPlan | null = assessment?.plan ?? null;
    if (plan === null) {
      // No feasible plan: an earlier plan stays in history but is no longer current.
      if (row.currentPlanId !== null) {
        await tx
          .update(supplierCase)
          .set({ currentPlanId: null })
          .where(eq(supplierCase.id, row.id));
        row.currentPlanId = null;
      }
      return null;
    }
    const payload = plan.payload;
    const [stored] = await tx
      .insert(casePlan)
      .values({
        id: randomUUID(),
        caseId: row.id,
        assessmentId,
        planId: payload.planId,
        planVersion: payload.planVersion,
        sha256: plan.sha256,
        payload,
        createdAt: at,
      })
      .returning();
    if (stored === undefined) throw new Error("plan insert returned nothing");
    await tx.insert(caseAction).values(
      payload.actions.map((action, index) => ({
        id: randomUUID(),
        caseId: row.id,
        planRowId: stored.id,
        actionId: action.actionId,
        sequence: index + 1,
        kind: action.kind,
        // Stable per plan version: a retry reuses it, so the source applies it at most once.
        operationId: `${payload.planId}.v${String(payload.planVersion)}.${action.actionId}`,
        state: "planned",
        updatedAt: at,
      })),
    );
    await tx
      .update(supplierCase)
      .set({ currentPlanId: stored.id, planVersion: payload.planVersion })
      .where(eq(supplierCase.id, row.id));
    Object.assign(row, { currentPlanId: stored.id, planVersion: payload.planVersion });
    return stored;
  }

  /** Records an assessment and moves the case to the state it recommends. */
  async recordAssessment(
    tx: Tx,
    row: CaseRow,
    at: string,
    intake: IntakeDecision | null,
    assessment: CoverageAssessment,
  ): Promise<void> {
    const plan = await this.storeAssessment(tx, row, at, intake, assessment);
    const { decision } = assessment;
    await transition(
      tx,
      row,
      at,
      { state: decision.recommendedState, reason: decision.reason, owner: decision.owner },
      {
        kind: "assessed",
        detail: {
          planId: plan?.planId ?? null,
          planVersion: plan?.planVersion ?? null,
          planSha256: plan?.sha256 ?? null,
          totals: assessment.totals,
          shortfalls: assessment.shortfalls,
          issues: assessment.issues,
        },
      },
    );
  }

  /**
   * Reassesses an accepted proposal from fresh reads under the next plan
   * version. The earlier plan, approvals and history stay as they were.
   */
  async reassess(tx: Tx, row: CaseRow): Promise<void> {
    const receipt = row.intakeReceipt as IntakeReceipt | null;
    const previous = await currentPlan(tx, row);
    if (receipt === null || previous === null || row.vendorId === null) {
      throw new Error("only an accepted, planned case is reassessed");
    }
    const at = await this.now();
    await transition(tx, row, at, { state: "assessing" }, { kind: "reassessment_started" });
    // The accepted input's own key: after a correction (ADR 0014) it is the
    // corrected input, not the message that opened the case.
    const input = await composeReassessment(
      this.sources,
      {
        sourceSystem: receipt.sourceSystem,
        messageId: receipt.messageId,
        inputVersion: receipt.inputVersion,
        vendorId: row.vendorId,
        proposalId: receipt.proposalId,
        terms: payloadOf(previous).proposal.terms,
      },
      { planId: previous.planId, planVersion: row.planVersion + 1, assessedAt: at },
      await this.successorCommitments(tx, row, at),
    );
    await this.recordAssessment(tx, row, at, null, assessCoverage(input));
  }

  /** A linked successor's predecessor commitments, read fresh for every assessment. */
  async successorCommitments(
    tx: Tx,
    row: CaseRow,
    at: string,
  ): Promise<ReadEvidence<unknown> | undefined> {
    if (row.predecessorCaseId === null) return undefined;
    const predecessor = await lockCase(tx, row.predecessorCaseId);
    if (predecessor === null) throw new Error("a successor's predecessor exists");
    return this.priorCommitmentsOf(tx, predecessor, at);
  }

  // Role decisions ---------------------------------------------------------

  private async loadForDecision(tx: Tx, caseId: string, userId: string, actorId: string) {
    const row = await lockCase(tx, caseId);
    if (row === null) return { failure: error(404, CASE_ERRORS.caseNotFound) };
    const actor = await actorFor(tx, row.organizationId, actorId, userId);
    if (actor === null) return { failure: error(403, CASE_ERRORS.actorNotPermitted) };
    return { failure: null, row, actor, plan: await currentPlan(tx, row) };
  }

  /**
   * Approves or rejects the exact current plan hash. AUTH-1 is checked before
   * anything is authorized: a rejected approval is recorded but grants nothing.
   */
  async decide(userId: string, caseId: string, command: PlanDecisionCommand): Promise<CaseResult> {
    return this.deps.db.transaction(async (tx) => {
      const loaded = await this.loadForDecision(tx, caseId, userId, command.actorId);
      if (loaded.failure !== null) return loaded.failure;
      const { row, actor, plan } = loaded;
      if (plan === null || plan.sha256 !== command.planSha256) {
        return error(409, CASE_ERRORS.planMismatch);
      }
      if (row.state !== "awaiting_approval") return error(409, CASE_ERRORS.invalidState);
      const role = actor.role as CaseActorRole;
      const at = await this.now();
      const payload = payloadOf(plan);
      const base = {
        caseId: row.id,
        planRowId: plan.id,
        actorId: actor.actorId,
        role,
        userId,
        submitted: command,
        simulated: actor.simulated,
        occurredAt: at,
      };

      if (!APPROVER_ROLES.includes(role)) {
        return error(403, CASE_ERRORS.actorNotPermitted);
      }
      if (command.decision === "reject") {
        await tx.insert(caseDecision).values({
          ...base,
          id: randomUUID(),
          kind: "rejection",
          outcome: "accepted",
          status: "current",
          binding: { planSha256: plan.sha256 },
        });
        await transition(
          tx,
          row,
          at,
          { state: "escalated", reason: "plan_rejected", owner: "buyer" },
          { kind: "plan_rejected", actorId: actor.actorId, detail: { planSha256: plan.sha256 } },
        );
        return { status: 201, body: { outcome: "accepted", kind: "rejection", state: row.state } };
      }

      const authorization = payload.authorization;
      // AUTH-1 at its current version, never only as the plan recorded it.
      const policy = await this.sources.reference.readCurrentPolicy({
        organization: CASE_FIXTURE.label,
        policyId: "AUTH-1",
      });
      if (policy.status === "unavailable" || policy.status === "ambiguous") {
        return error(503, CASE_ERRORS.sourceUnavailable);
      }
      const refused =
        policy.status === "ok"
          ? approvalRefusal(authorization, policy.data, role)
          : { reason: "stale_policy" as const, limit: null };
      const refusal = refused?.reason ?? null;
      const limit =
        refused === null
          ? authorization.limits.find((entry) => entry.role === role)
          : refused.limit;
      const binding = {
        planId: payload.planId,
        planVersion: payload.planVersion,
        planSha256: plan.sha256,
        policy: authorization.policy,
        amount: authorization.cost,
        limit: limit ?? null,
        allowedActions: payload.actions.map((action) => action.actionId),
        sources: payload.bindings.map((entry) => ({
          kind: entry.kind,
          key: entry.key,
          version: entry.version,
          currentVersion: entry.currentVersion,
          contentSha256: entry.contentSha256,
        })),
        expiresAt: approvalExpiry(at),
      };
      const decisionId = randomUUID();
      await tx.insert(caseDecision).values({
        ...base,
        id: decisionId,
        kind: "approval",
        outcome: refusal === null ? "accepted" : "rejected",
        reason: refusal,
        // A refused approval is void: it can never authorize anything.
        status: refusal === null ? "current" : "void",
        binding,
      });
      if (refusal !== null) {
        await appendEvent(tx, row, at, {
          kind: "approval_refused",
          reason: refusal,
          actorId: actor.actorId,
          detail: { planSha256: plan.sha256, amount: authorization.cost, limit: limit ?? null },
        });
        if (refusal === "stale_policy") {
          // A newer AUTH-1 version: the plan can never be approved, so its
          // decisions are stale and the proposal is reassessed under it.
          await tx
            .update(caseDecision)
            .set({ status: "stale", invalidatedAt: at, invalidatedReason: refusal })
            .where(and(eq(caseDecision.planRowId, plan.id), eq(caseDecision.status, "current")));
          await transition(
            tx,
            row,
            at,
            { state: "needs_clarification", reason: refusal, owner: "buyer" },
            { kind: "approval_invalidated", detail: { planSha256: plan.sha256 } },
          );
          await this.reassess(tx, row);
          return error(409, refusal, { decisionId, state: row.state });
        }
        return error(422, refusal, { decisionId, state: row.state });
      }
      // After a revocation whose attempt the source refused (N-08 R4b), the
      // refused action stays failed until this fresh approval, which
      // authorizes a new attempt under a new attempt key.
      const reopened = row.reason === "approval_revoked" ? ["planned", "failed"] : ["planned"];
      await tx
        .update(caseAction)
        .set({ state: "authorized", reason: null, updatedAt: at })
        .where(and(eq(caseAction.planRowId, plan.id), inArray(caseAction.state, reopened)));
      await appendEvent(tx, row, at, {
        kind: "approved",
        actorId: actor.actorId,
        detail: { decisionId, ...binding, simulated: actor.simulated },
      });
      await this.advanceAfterDecision(tx, row, plan, at);
      return {
        status: 201,
        body: { outcome: "accepted", kind: "approval", decisionId, state: row.state },
      };
    });
  }

  /**
   * Records a structured simulated acknowledgement or confirmation. Only one
   * that references the current plan exactly can satisfy a wait; anything
   * else is recorded as non-matching and changes nothing.
   */
  async acknowledge(
    userId: string,
    caseId: string,
    command: AcknowledgementCommand,
  ): Promise<CaseResult> {
    return this.deps.db.transaction(async (tx) => {
      const loaded = await this.loadForDecision(tx, caseId, userId, command.actorId);
      if (loaded.failure !== null) return loaded.failure;
      const { row, actor, plan } = loaded;
      if (plan === null) return error(409, CASE_ERRORS.planMismatch);
      if (row.state !== "awaiting_approval" && row.state !== "awaiting_acknowledgement") {
        return error(409, CASE_ERRORS.invalidState);
      }
      const expectedRole: CaseActorRole =
        command.kind === "supplier_acknowledgement" ? "supplier_contact" : "warehouse_planner";
      if (actor.role !== expectedRole) return error(403, CASE_ERRORS.actorNotPermitted);
      const payload = payloadOf(plan);
      const amend = payload.actions.find((action) => action.kind === "amend_schedule");
      const transfer = payload.actions.find((action) => action.kind === "create_transfer_request");
      let reason: string | null = null;
      if (command.kind === "supplier_acknowledgement") {
        if (actor.vendorId !== row.vendorId) reason = "vendor_mismatch";
        else if (
          command.proposalId !== payload.proposal.proposalId ||
          amend?.kind !== "amend_schedule" ||
          command.poNumber !== amend.poNumber ||
          command.poLine !== amend.poLine ||
          canonicalJson(command.segments) !== canonicalJson(segmentsOf(amend))
        ) {
          reason = "acknowledgement_not_matching";
        }
      } else if (
        transfer?.kind !== "create_transfer_request" ||
        command.planSha256 !== plan.sha256 ||
        command.optionId !== transfer.optionId ||
        command.quantity !== transfer.quantity ||
        command.arrivalDate !== transfer.arrivalDate
      ) {
        reason = "confirmation_not_matching";
      }
      const at = await this.now();
      const decisionId = randomUUID();
      await tx.insert(caseDecision).values({
        id: decisionId,
        caseId: row.id,
        planRowId: plan.id,
        kind: command.kind,
        actorId: actor.actorId,
        role: actor.role,
        userId,
        outcome: reason === null ? "accepted" : "non_matching",
        reason,
        status: reason === null ? "current" : "void",
        binding: { planSha256: plan.sha256, planId: payload.planId },
        submitted: command,
        simulated: actor.simulated,
        occurredAt: at,
      });
      await appendEvent(tx, row, at, {
        kind: reason === null ? command.kind : `${command.kind}_not_matching`,
        reason,
        actorId: actor.actorId,
        detail: { decisionId, simulated: actor.simulated, submitted: command },
      });
      if (reason === null) await this.advanceAfterDecision(tx, row, plan, at);
      return {
        status: 201,
        body: {
          outcome: reason === null ? "accepted" : "non_matching",
          reason,
          decisionId,
          state: row.state,
        },
      };
    });
  }

  /**
   * After an accepted decision: wait for the remaining acknowledgements, or
   * enter `applying` and enqueue the application job in the same transaction.
   */
  private async advanceAfterDecision(tx: Tx, row: CaseRow, plan: PlanRow, at: string) {
    const missing = missingDecisions(payloadOf(plan), await decisionsOf(tx, plan.id));
    if (missing.includes("approval")) return;
    if (missing.length > 0) {
      if (row.state !== "awaiting_acknowledgement") {
        await transition(
          tx,
          row,
          at,
          { state: "awaiting_acknowledgement", owner: "buyer" },
          { kind: "awaiting_acknowledgement", detail: { missing } },
        );
      }
      return;
    }
    await transition(
      tx,
      row,
      at,
      { state: "applying", owner: "buyer" },
      { kind: "application_authorized", detail: { planSha256: plan.sha256 } },
    );
    await this.enqueue(tx, row.id);
  }

  async enqueue(tx: Tx, caseId: string): Promise<void> {
    const data: CaseJobData = { caseId };
    // With the exclusive policy a case has at most one queued or active job;
    // a null result means one is already pending and will see this state.
    await this.deps.boss.send(CASE_QUEUE, data, {
      ...CASE_JOB_OPTIONS,
      singletonKey: caseId,
      db: fromDrizzle(tx, sql),
    });
  }

  /**
   * Escalates a case that is not terminal, voiding its current decisions and
   * closing an open question, so no later reply can resume it (ADR 0014).
   * Its unclaimed actions fail, so nothing of the plan stays authorized. An
   * attempt already in flight is left to its read-back: the escalation
   * records the cancellation as pending and queues a job that reconciles it,
   * never resubmits it (ADR 0016). An effect already confirmed stays recorded
   * and is never reversed.
   */
  async escalate(userId: string, caseId: string, command: EscalationCommand): Promise<CaseResult> {
    return this.deps.db.transaction(async (tx) => {
      const row = await lockCase(tx, caseId);
      if (row === null) return error(404, CASE_ERRORS.caseNotFound);
      const actor = await actorFor(tx, row.organizationId, command.actorId, userId);
      if (actor === null || !APPROVER_ROLES.includes(actor.role as CaseActorRole)) {
        return error(403, CASE_ERRORS.actorNotPermitted);
      }
      if (TERMINAL.includes(row.state as CaseState)) {
        return error(409, CASE_ERRORS.invalidState);
      }
      const at = await this.now();
      let flying: ActionRow[] = [];
      if (row.currentPlanId !== null) {
        await tx
          .update(caseDecision)
          .set({ status: "superseded", invalidatedAt: at, invalidatedReason: "manual_escalation" })
          .where(
            and(eq(caseDecision.planRowId, row.currentPlanId), eq(caseDecision.status, "current")),
          );
        flying = (await actionsOf(tx, row.currentPlanId)).filter(inFlight);
        await this.failUnclaimed(tx, row.currentPlanId, at, "manual_escalation");
      }
      await tx
        .update(caseClarification)
        .set({ status: "superseded", closedAt: at, closedReason: "manual_escalation" })
        .where(
          and(eq(caseClarification.caseId, row.id), eq(caseClarification.status, "awaiting_reply")),
        );
      await transition(
        tx,
        row,
        at,
        { state: "escalated", reason: "manual_escalation", owner: "buyer" },
        { kind: "escalated", actorId: actor.actorId, detail: { note: command.note } },
      );
      if (flying.length > 0) await this.awaitInFlight(tx, row, at, flying, "manual_escalation");
      return { status: 201, body: { state: row.state } };
    });
  }

  /**
   * Revokes the current approval of the exact plan (N-08, ADR 0016). The
   * approver who gave it or a procurement manager may revoke it while the
   * plan waits for acknowledgements or is being applied. The claim
   * transaction is the submission boundary: a revocation committed before an
   * action's claim keeps it from being submitted, and one committed after it
   * finds the attempt possibly in flight. Then:
   *
   * - nothing claimed yet: the actions return to `planned` and the case waits
   *   for a fresh approval of the same hash;
   * - an attempt in flight: unclaimed actions fail, the cancellation is
   *   pending and a job reads the attempt back, never resubmitting it;
   * - effects and nothing in flight: unclaimed actions fail and the case is
   *   `partially_applied`, `canceled_after_effect`, with a compensating
   *   proposal for an authorized person. Nothing is reversed;
   * - an action whose outcome waits for a person (`unknown`, not read back
   *   any more): unclaimed actions fail, the case stays `partially_applied`
   *   with `reconciliation_unresolved` and the cancellation stays pending.
   */
  async revoke(userId: string, caseId: string, command: RevocationCommand): Promise<CaseResult> {
    return this.deps.db.transaction(async (tx) => {
      const row = await lockCase(tx, caseId);
      if (row === null) return error(404, CASE_ERRORS.caseNotFound);
      const actor = await actorFor(tx, row.organizationId, command.actorId, userId);
      if (actor === null) return error(403, CASE_ERRORS.actorNotPermitted);
      const plan = await currentPlan(tx, row);
      if (plan === null || plan.sha256 !== command.planSha256) {
        return error(409, CASE_ERRORS.planMismatch);
      }
      const approval = (await decisionsOf(tx, plan.id)).find(
        (decision) =>
          decision.kind === "approval" &&
          decision.outcome === "accepted" &&
          decision.status === "current",
      );
      if (approval === undefined) return error(409, CASE_ERRORS.approvalNotCurrent);
      if (actor.role !== "procurement_manager" && actor.actorId !== approval.actorId) {
        return error(403, CASE_ERRORS.actorNotPermitted);
      }
      if (!REVOCABLE.includes(row.state as CaseState)) {
        return error(409, CASE_ERRORS.invalidState);
      }
      const at = await this.now();
      await tx
        .update(caseDecision)
        .set({ status: "revoked", invalidatedAt: at, invalidatedReason: "approval_revoked" })
        .where(eq(caseDecision.id, approval.id));
      const journal = await actionsOf(tx, plan.id);
      const flying = journal.filter(inFlight);
      const confirmed = journal.filter((action) => action.state === "confirmed");
      // An unknown action that no run reads back any more may still have an
      // effect at its source: never treat it as nothing having reached one.
      const unresolved = journal.filter(
        (action) => action.state === "unknown" && !inFlight(action),
      );
      const event = {
        kind: "approval_revoked",
        actorId: actor.actorId,
        detail: {
          decisionId: approval.id,
          planSha256: plan.sha256,
          note: command.note,
          simulated: actor.simulated,
          inFlight: flying.map((action) => action.actionId),
          unresolved: unresolved.map((action) => action.actionId),
        },
      };
      if (unresolved.length > 0) {
        // The outcome waits for a person at the source. The cancellation is
        // recorded and stays pending; nothing more of the plan is authorized.
        await this.failUnclaimed(tx, plan.id, at, "approval_revoked");
        await transition(
          tx,
          row,
          at,
          { state: "partially_applied", reason: RECONCILIATION_UNRESOLVED, owner: "buyer" },
          event,
        );
        await appendEvent(tx, row, at, {
          kind: "cancellation_pending",
          reason: "approval_revoked",
          detail: { inFlight: [], unresolved: unresolved.map(attemptOf) },
        });
      } else if (flying.length === 0 && confirmed.length === 0) {
        // Nothing reached a source: the plan waits for a fresh approval.
        await tx
          .update(caseAction)
          .set({ state: "planned", reason: null, updatedAt: at })
          .where(
            and(
              eq(caseAction.planRowId, plan.id),
              inArray(caseAction.state, ["planned", "authorized"]),
            ),
          );
        await transition(
          tx,
          row,
          at,
          { state: "awaiting_approval", reason: "approval_revoked", owner: "buyer" },
          event,
        );
      } else if (flying.length > 0) {
        await this.failUnclaimed(tx, plan.id, at, "approval_revoked");
        await transition(
          tx,
          row,
          at,
          { state: "partially_applied", reason: RECONCILIATION_PENDING, owner: "buyer" },
          event,
        );
        await this.awaitInFlight(tx, row, at, flying, "approval_revoked");
      } else {
        await this.failUnclaimed(tx, plan.id, at, "approval_revoked");
        await transition(
          tx,
          row,
          at,
          { state: "partially_applied", reason: "canceled_after_effect", owner: "buyer" },
          event,
        );
        await proposeCompensation(
          tx,
          row,
          at,
          plan,
          confirmed.map((action) => ({
            actionId: action.actionId,
            operationId: action.operationId,
            receipt: action.receipt,
          })),
        );
      }
      return {
        status: 201,
        body: {
          state: row.state,
          inFlight: flying.map((action) => action.actionId),
          unresolved: unresolved.map((action) => action.actionId),
        },
      };
    });
  }

  /** Fails every action of a plan that was never claimed, so none can run under it. */
  private async failUnclaimed(tx: Tx, planRowId: string, at: string, reason: string) {
    await tx
      .update(caseAction)
      .set({ state: "failed", reason, updatedAt: at })
      .where(
        and(
          eq(caseAction.planRowId, planRowId),
          inArray(caseAction.state, ["planned", "authorized"]),
        ),
      );
  }

  /**
   * A cancellation that found attempts in flight: records it as pending and
   * queues the case job, in the same transaction, to read them back. An
   * active job for the case is already that run.
   */
  private async awaitInFlight(
    tx: Tx,
    row: CaseRow,
    at: string,
    flying: readonly ActionRow[],
    cause: string,
  ) {
    await appendEvent(tx, row, at, {
      kind: "cancellation_pending",
      reason: cause,
      detail: { inFlight: flying.map(attemptOf) },
    });
    await this.enqueue(tx, row.id);
  }

  /**
   * Records a note as a case event. Any simulated actor the user may act as
   * can record one; it is not evidence and changes no field, state, decision
   * or plan, so it grants nothing. Corrections and questions are their own
   * commands (ADR 0014).
   */
  async note(userId: string, caseId: string, command: CaseNoteCommand): Promise<CaseResult> {
    return this.deps.db.transaction(async (tx) => {
      const row = await lockCase(tx, caseId);
      if (row === null) return error(404, CASE_ERRORS.caseNotFound);
      const actor = await actorFor(tx, row.organizationId, command.actorId, userId);
      if (actor === null) return error(403, CASE_ERRORS.actorNotPermitted);
      const at = await this.now();
      await appendEvent(tx, row, at, {
        kind: "note",
        actorId: actor.actorId,
        detail: {
          simulated: actor.simulated,
          role: actor.role,
          note: command.note,
          ...(command.field === undefined ? {} : { field: command.field }),
        },
      });
      return { status: 201, body: { recorded: "note", state: row.state } };
    });
  }

  /**
   * Rechecks a verified plan against its source records (ADR 0015). Any role
   * that owns verification follow-up may ask; the read-back runs outside the
   * case lock and is recorded only if the case did not move meanwhile.
   */
  async recheckVerification(
    userId: string,
    caseId: string,
    command: VerificationCheckCommand,
  ): Promise<CaseResult> {
    const [row] = await this.deps.db.select().from(supplierCase).where(eq(supplierCase.id, caseId));
    if (row === undefined) return error(404, CASE_ERRORS.caseNotFound);
    const actor = await actorFor(this.deps.db, row.organizationId, command.actorId, userId);
    if (actor === null || !VERIFIER_ROLES.includes(actor.role as CaseActorRole)) {
      return error(403, CASE_ERRORS.actorNotPermitted);
    }
    const plan = await currentPlan(this.deps.db, row);
    if (plan === null || !(await recheckable(this.deps.db, row, plan))) {
      return error(409, CASE_ERRORS.invalidState, { state: row.state });
    }
    const outcome = await recheckVerification(
      this,
      { caseId, state: row.state, planRowId: plan.id },
      plan,
      actor.actorId,
    );
    if (outcome === "changed") return error(409, CASE_ERRORS.invalidState);
    return { status: 200, body: outcome };
  }

  // Application ------------------------------------------------------------

  /** Runs the application job for a case; see apply.ts. */
  apply(caseId: string): Promise<ApplyOutcome> {
    return applyCase(this, caseId);
  }

  /** Runs a case job: the pending extraction of an email case, otherwise application. */
  async advance(caseId: string): Promise<{ state: string; retry: boolean }> {
    if (await this.extraction.pending(caseId)) return this.extraction.extract(caseId);
    return this.apply(caseId);
  }
}

/** Which of the plan's required decisions have no current accepted record yet. */
export function missingDecisions(payload: PlanPayload, decisions: readonly DecisionRow[]) {
  const current = (kind: string) =>
    decisions.some(
      (decision) =>
        decision.kind === kind && decision.outcome === "accepted" && decision.status === "current",
    );
  return payload.decisions.map((required) => required.kind).filter((kind) => !current(kind));
}

export type { ActionRow, CaseRow, DecisionRow, PlanRow };
export { actionsOf, decisionsOf };

/**
 * Queues a case job for every case an earlier process left mid-way:
 * `applying`, `verifying`, `partially_applied` with an unknown outcome or a
 * pending reconciliation, any case whose current plan has an attempt still
 * in flight (an escalated one included, ADR 0016), or an email case still
 * `received` with its agent run.
 * The exclusive queue's singleton key makes this a no-op for a case that
 * already has a queued or active job. Run once the API's queue client starts.
 */
export async function resumeInterruptedCases(db: Db, boss: PgBoss): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: supplierCase.id })
    .from(supplierCase)
    .leftJoin(agentRun, eq(agentRun.caseId, supplierCase.id))
    .where(
      or(
        inArray(supplierCase.state, ["applying", "verifying"]),
        and(
          eq(supplierCase.state, "partially_applied"),
          inArray(supplierCase.reason, ["outcome_unknown", RECONCILIATION_PENDING]),
        ),
        exists(
          db
            .select({ id: caseAction.id })
            .from(caseAction)
            .where(
              and(
                eq(caseAction.planRowId, supplierCase.currentPlanId),
                or(
                  eq(caseAction.state, "pending"),
                  and(
                    eq(caseAction.state, "unknown"),
                    inArray(caseAction.reason, ["outcome_unknown", RECONCILIATION_PENDING]),
                  ),
                ),
              ),
            ),
        ),
        // An email case whose extraction or hand-off to intake did not finish.
        and(eq(supplierCase.state, "received"), isNotNull(agentRun.id)),
      ),
    );
  const queued: string[] = [];
  for (const { id } of rows) {
    const data: CaseJobData = { caseId: id };
    const jobId = await boss.send(CASE_QUEUE, data, { ...CASE_JOB_OPTIONS, singletonKey: id });
    if (jobId !== null) queued.push(id);
  }
  return queued;
}
