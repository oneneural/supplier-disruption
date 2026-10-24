import type { CaseActorRole, CaseState, PlanPayload } from "@supplier-disruption/contracts";
import {
  caseAction,
  caseActor,
  caseDecision,
  caseEvent,
  casePlan,
  supplierCase,
} from "@supplier-disruption/db";
import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type Db = NodePgDatabase;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export type CaseRow = typeof supplierCase.$inferSelect;
export type PlanRow = typeof casePlan.$inferSelect;
export type ActionRow = typeof caseAction.$inferSelect;
export type DecisionRow = typeof caseDecision.$inferSelect;
export type EventRow = typeof caseEvent.$inferSelect;

/** PostgreSQL timestamptz text, such as `2026-10-21 07:00:00+00`, as an ISO instant. */
export function isoInstant(text: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(text);
  const value = match === null ? text : `${match[1]}T${match[2]}${match[3]}:${match[4] ?? "00"}`;
  return new Date(value).toISOString();
}

/** The next step an operator sees for each state. */
export function nextActionFor(state: CaseState, reason: string | null): string {
  switch (state) {
    case "received":
      return "Validate identity and base revision";
    case "needs_clarification":
      // The clarification pauses of ADR 0014 name their own next step.
      if (reason === "awaiting_supplier_reply") {
        return "Record the supplier's reply to the open question; its draft was not sent";
      }
      if (reason === "correction_required") {
        return "Propose a correction that cites the supplier's own words";
      }
      return `Resolve ${reason ?? "the open question"} and reassess`;
    case "assessing":
      return "Compute demand impact and recovery options";
    case "awaiting_approval":
      return "Approve or reject the exact plan within the approval limit";
    case "awaiting_acknowledgement":
      return "Record the supplier acknowledgement and warehouse planner confirmation";
    case "applying":
      return "Apply the approved actions in order";
    case "partially_applied":
      // Revocation and bounded read-back outcomes of ADR 0016.
      if (reason === "reconciliation_pending") {
        return "Read back the attempt still in flight; it is never resubmitted";
      }
      if (reason === "reconciliation_unresolved") {
        return "Confirm the outcome at the source; automatic read-back stopped without proof";
      }
      if (reason === "request_digest_mismatch") {
        return "Confirm earlier attempts at the source; the stored command no longer matches its digest";
      }
      if (reason === "canceled_after_effect") {
        return "Review the compensating proposal; confirmed effects were not reversed";
      }
      return `Reconcile known effects (${reason ?? "partial application"}) before any retry`;
    case "verifying":
      return "Read back the source records and planning references";
    case "plan_verified":
      return "Plan verified in the records; physical receipt has not happened";
    case "escalated":
      return `Owner decides the next step for ${reason ?? "the escalation"}`;
    case "superseded":
      return "Follow the successor case";
  }
}

/** Locks a case row for the rest of the transaction. */
export async function lockCase(tx: Tx, caseId: string): Promise<CaseRow | null> {
  const [row] = await tx
    .select()
    .from(supplierCase)
    .where(eq(supplierCase.id, caseId))
    .for("update");
  return row ?? null;
}

export interface EventInput {
  kind: string;
  reason?: string | null;
  owner?: CaseActorRole | null;
  actorId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Appends one event to a locked case. Events are never updated or deleted, so
 * terminal and superseded history stays visible.
 */
export async function appendEvent(
  tx: Tx,
  row: CaseRow,
  at: string,
  event: EventInput & { fromState?: string | null; toState?: string | null },
): Promise<void> {
  row.eventCount += 1;
  await tx.insert(caseEvent).values({
    caseId: row.id,
    sequence: row.eventCount,
    kind: event.kind,
    fromState: event.fromState ?? null,
    toState: event.toState ?? null,
    reason: event.reason ?? null,
    owner: event.owner ?? null,
    actorId: event.actorId ?? null,
    detail: event.detail ?? {},
    occurredAt: at,
  });
  await tx
    .update(supplierCase)
    .set({ eventCount: row.eventCount, updatedAt: at })
    .where(eq(supplierCase.id, row.id));
  row.updatedAt = at;
}

/** A locked case is no longer in a state the caller may move it from. */
export class CaseStateConflict extends Error {
  constructor(readonly state: string) {
    super(`case is ${state}`);
  }
}

/**
 * Moves a locked case to a new state and records the transition as an event.
 * With `from`, the locked state must be one of those states, so a concurrent
 * change (an escalation, for example) is never overwritten; the throw rolls
 * back the caller's transaction.
 */
export async function transition(
  tx: Tx,
  row: CaseRow,
  at: string,
  to: {
    state: CaseState;
    reason?: string | null;
    owner?: CaseActorRole | null;
    from?: readonly CaseState[];
  },
  event: EventInput,
): Promise<void> {
  const fromState = row.state;
  if (to.from !== undefined && !to.from.includes(fromState as CaseState)) {
    throw new CaseStateConflict(fromState);
  }
  const reason = to.reason ?? null;
  const owner = to.owner ?? null;
  const nextAction = nextActionFor(to.state, reason);
  await tx
    .update(supplierCase)
    .set({ state: to.state, reason, owner, nextAction })
    .where(eq(supplierCase.id, row.id));
  Object.assign(row, { state: to.state, reason, owner, nextAction });
  await appendEvent(tx, row, at, {
    ...event,
    reason: event.reason ?? reason,
    owner: event.owner ?? owner,
    fromState,
    toState: to.state,
  });
}

export async function currentPlan(db: Executor, row: CaseRow): Promise<PlanRow | null> {
  if (row.currentPlanId === null) return null;
  const [plan] = await db.select().from(casePlan).where(eq(casePlan.id, row.currentPlanId));
  return plan ?? null;
}

export function payloadOf(plan: PlanRow): PlanPayload {
  return plan.payload as PlanPayload;
}

export async function actionsOf(db: Executor, planRowId: string): Promise<ActionRow[]> {
  return db
    .select()
    .from(caseAction)
    .where(eq(caseAction.planRowId, planRowId))
    .orderBy(asc(caseAction.sequence));
}

export async function decisionsOf(db: Executor, planRowId: string): Promise<DecisionRow[]> {
  return db
    .select()
    .from(caseDecision)
    .where(eq(caseDecision.planRowId, planRowId))
    .orderBy(asc(caseDecision.occurredAt));
}

/** The active simulated actor this user may act as in the organization, or null. */
export async function actorFor(
  db: Executor,
  organizationId: string,
  actorId: string,
  userId: string,
) {
  const [actor] = await db
    .select()
    .from(caseActor)
    .where(
      and(
        eq(caseActor.organizationId, organizationId),
        eq(caseActor.actorId, actorId),
        eq(caseActor.userId, userId),
        eq(caseActor.active, true),
      ),
    );
  return actor ?? null;
}

/**
 * Whether a simulated actor still holds a role, whichever user acts as it.
 * Inside a claim transaction the actor row is locked FOR SHARE, so a change
 * to it waits until the claim commits or rolls back (ADR 0013).
 */
export async function actorHoldsRole(
  tx: Tx,
  organizationId: string,
  actorId: string,
  role: string,
): Promise<boolean> {
  const [actor] = await tx
    .select({ role: caseActor.role, active: caseActor.active })
    .from(caseActor)
    .where(and(eq(caseActor.organizationId, organizationId), eq(caseActor.actorId, actorId)))
    .for("share");
  return actor?.active === true && actor.role === role;
}
