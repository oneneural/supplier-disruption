// Procurement interruption and queue recovery (ADR 0016), each gate
// on its own disposable database, with application runs driven directly so
// the test controls each run. Process and queue terminations are in
// termination.test.ts.
//
// - E1: a real enqueue failure rolls the final acknowledgement back with the
//   job: no case transition, decision or job is left behind;
// - R1 (N-08): a revocation committed before ACT-1's claim prevents every
//   write; a fresh approval of the same plan then applies it once;
// - R4a (N-08): a revocation committed after ACT-1's claim finds the attempt
//   in flight; the write lands once, nothing later is claimed and the case
//   is canceled after the effect with a compensating proposal;
// - R4b (N-08): purchasing definitively refuses ACT-1's attempt in flight:
//   ACT-1 stays failed, no effect, and a fresh approval tries it again;
// - R4c (N-08): a revocation while ACT-1's attempt never reached purchasing:
//   read back, never resubmitted, then unresolved after the read-back bound;
// - U1: the bound reached on a lost response while a revocation waits moves
//   the case to `reconciliation_unresolved`, not a pending read-back;
// - U2: a revocation after the bound never claims nothing reached a source
//   and leaves no case `applying`;
// - U3: a stored command that no longer matches its request digest is not
//   sent; the action waits for a person;
// - X1: an escalation while ACT-2's outcome is unknown reconciles ACT-2 by
//   operation ID without a duplicate reservation and claims no transfer;
// - J1: duplicate and late application runs converge on one effect each,
//   with stable operation IDs, attempt keys and request digests.
//
// Expected values are frozen-oracle literals where the oracle states them
// (N-08 orderings, C-01 effects); the rest is ADR 0016's decided behavior,
// written by hand.
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@supplier-disruption/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECONCILE_ATTEMPT_LIMIT } from "../src/cases/apply.js";
import { CaseWorkflow, resumeInterruptedCases } from "../src/cases/workflow.js";
import type { CaseFaultHooks } from "../src/cases/workflow.js";
import {
  MSG_0001,
  ORG_NDL,
  call,
  rows,
  sourceEffects,
  startCaseStack,
  type CaseStack,
} from "./case-support.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";

const SETUP_TIMEOUT_MS = START_TIMEOUT_MS + 3 * COMPOSE_TIMEOUT_MS;
const SCHEDULE = [
  { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
  { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
];
const SUPPLIER_ACK = {
  kind: "supplier_acknowledgement",
  actorId: "supplier-1",
  proposalId: "PROP-1",
  poNumber: "PO-120",
  poLine: "10",
  segments: SCHEDULE,
};
const NO_EFFECTS = { purchasing: 0, inventory: 0, requests: 0, po_revision: 3, wh_b: "INV-B@1" };
const ACT_1_ONLY = { purchasing: 1, inventory: 0, requests: 0, po_revision: 4, wh_b: "INV-B@1" };
const ACT_1_2 = {
  purchasing: 1,
  inventory: 1,
  requests: 0,
  po_revision: 4,
  wh_b: "INV-B@1.ACT-2",
};
const C_01_EFFECTS = {
  purchasing: 1,
  inventory: 2,
  requests: 1,
  po_revision: 4,
  wh_b: "INV-B@1.ACT-2",
};

type Barrier = keyof CaseFaultHooks;

/** A disposable stack whose fault hooks run the handler registered for `<hook>:<action>`. */
function recoveryStack(gateName: string) {
  const db = new DisposableDatabase(gateName);
  const handlers = new Map<string, () => Promise<void>>();
  const context = { db, stack: undefined as unknown as CaseStack, handlers };
  const at =
    (barrier: Barrier) =>
    ({ actionId }: { actionId: string }) => {
      const handler = handlers.get(`${barrier}:${actionId}`);
      handlers.delete(`${barrier}:${actionId}`);
      return handler === undefined ? Promise.resolve() : handler();
    };
  beforeAll(async () => {
    await db.start();
    context.stack = await startCaseStack(db, {
      faults: {
        beforeClaim: at("beforeClaim"),
        beforeClaimCommit: at("beforeClaimCommit"),
        beforeSubmit: at("beforeSubmit"),
        afterSourceWrite: at("afterSourceWrite"),
      },
    });
  }, SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await context.stack?.close();
    await db.remove();
    expect(await db.leftovers()).toBe("");
  }, COMPOSE_TIMEOUT_MS + MARGIN_MS);
  return context;
}

async function ingest(stack: CaseStack) {
  const created = await call(stack, stack.buyer, "POST", "/api/cases/ingest", {
    organizationId: ORG_NDL,
    deliveryId: randomUUID(),
    ...MSG_0001,
  });
  expect(created.body).toMatchObject({ disposition: "accept", state: "awaiting_approval" });
  const caseId = created.body.caseId as string;
  const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
  return { caseId, planSha256: (detail.plan as { sha256: string }).sha256 };
}

async function approve(stack: CaseStack, caseId: string, planSha256: string) {
  return call(stack, stack.manager, "POST", `/api/cases/${caseId}/decisions`, {
    actorId: "manager-1",
    decision: "approve",
    planSha256,
  });
}

function confirmTransfer(stack: CaseStack, caseId: string, planSha256: string) {
  return call(stack, stack.manager, "POST", `/api/cases/${caseId}/acknowledgements`, {
    kind: "warehouse_planner_confirmation",
    actorId: "planner-1",
    planSha256,
    optionId: "TRO-1",
    quantity: "50",
    arrivalDate: "2026-10-23",
  });
}

function acknowledge(stack: CaseStack, caseId: string) {
  return call(stack, stack.buyer, "POST", `/api/cases/${caseId}/acknowledgements`, SUPPLIER_ACK);
}

/** C-01 through the supplier acknowledgement: the case is `applying` with its job queued. */
async function applyingCase(stack: CaseStack) {
  const { caseId, planSha256 } = await ingest(stack);
  expect((await approve(stack, caseId, planSha256)).status).toBe(201);
  expect((await confirmTransfer(stack, caseId, planSha256)).body).toMatchObject({
    outcome: "accepted",
  });
  expect((await acknowledge(stack, caseId)).body).toMatchObject({
    outcome: "accepted",
    state: "applying",
  });
  return { caseId, planSha256 };
}

function revoke(stack: CaseStack, caseId: string, planSha256: string, cookie = stack.manager) {
  return call(stack, cookie, "POST", `/api/cases/${caseId}/revocations`, {
    actorId: "manager-1",
    planSha256,
    note: "Approval withdrawn before the warehouse dispatch window",
  });
}

const actionRows = (stack: CaseStack) =>
  rows(
    stack.observer,
    "SELECT action_id, state, reason, attempts FROM app.case_action ORDER BY sequence",
  );
const caseRow = (stack: CaseStack) =>
  rows(stack.observer, "SELECT state, reason, owner FROM app.supplier_case");
const caseJobs = (stack: CaseStack) =>
  rows<{ state: string }>(
    stack.observer,
    "SELECT state::text AS state FROM pgboss.job WHERE name = 'case-application' ORDER BY created_on",
  );
const eventKinds = async (stack: CaseStack, kinds: readonly string[]) =>
  (
    await rows<{ kind: string }>(
      stack.observer,
      "SELECT kind FROM app.case_event WHERE kind = ANY($1) ORDER BY sequence",
      [kinds],
    )
  ).map((event) => event.kind);

describe("E1: an enqueue failure rolls back the procurement transition with the job", () => {
  const context = recoveryStack("e1");

  it("leaves no case transition, decision or job, then applies once after the fault clears", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await ingest(stack);
    expect((await approve(stack, caseId, planSha256)).status).toBe(201);
    expect((await confirmTransfer(stack, caseId, planSha256)).status).toBe(201);
    const before = await rows(stack.observer, "SELECT count(*)::int AS n FROM app.case_event");

    // The queue itself refuses case jobs: the insert pg-boss makes inside the
    // acknowledgement's transaction fails, not a flag the API returns.
    await stack.observer.query(`
      CREATE FUNCTION pgboss.refuse_case_job() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'case job refused'; END $$;
      CREATE TRIGGER refuse_case_job BEFORE INSERT ON pgboss.job
        FOR EACH ROW WHEN (NEW.name = 'case-application')
        EXECUTE FUNCTION pgboss.refuse_case_job();`);
    const refused = await acknowledge(stack, caseId);
    expect(refused.status).toBe(500);

    expect(await caseRow(stack)).toEqual([
      { state: "awaiting_acknowledgement", reason: null, owner: "buyer" },
    ]);
    expect(
      await rows(
        stack.observer,
        "SELECT count(*)::int AS n FROM app.case_decision WHERE kind = 'supplier_acknowledgement'",
      ),
    ).toEqual([{ n: 0 }]);
    expect(await rows(stack.observer, "SELECT count(*)::int AS n FROM app.case_event")).toEqual(
      before,
    );
    expect(await caseJobs(stack)).toEqual([]);
    expect((await actionRows(stack)).map((action) => (action as { state: string }).state)).toEqual([
      "authorized",
      "authorized",
      "authorized",
    ]);
    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);

    await stack.observer.query(`
      DROP TRIGGER refuse_case_job ON pgboss.job;
      DROP FUNCTION pgboss.refuse_case_job();`);
    expect((await acknowledge(stack, caseId)).body).toMatchObject({
      outcome: "accepted",
      state: "applying",
    });
    expect(await caseJobs(stack)).toEqual([{ state: "created" }]);
    expect(await stack.workflow.apply(caseId)).toEqual({ state: "plan_verified", retry: false });
    expect(await sourceEffects(stack.observer)).toEqual(C_01_EFFECTS);
  });
});

describe("R1 (N-08): a revocation committed before ACT-1's claim", () => {
  const context = recoveryStack("r1");

  it("prevents every write and returns the plan for a fresh approval", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await applyingCase(stack);
    context.handlers.set("beforeClaim:ACT-1", async () => {
      // Only the approver who gave it, or a procurement manager, may revoke it.
      const refused = await call(stack, stack.buyer, "POST", `/api/cases/${caseId}/revocations`, {
        actorId: "buyer-1",
        planSha256,
        note: "Not my approval",
      });
      expect(refused).toEqual({ status: 403, body: { error: "actor_not_permitted" } });
      const revoked = await revoke(stack, caseId, planSha256);
      expect(revoked).toEqual({
        status: 201,
        body: { state: "awaiting_approval", inFlight: [], unresolved: [] },
      });
    });
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "awaiting_approval",
      retry: false,
    });

    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "planned", reason: null, attempts: 0 },
      { action_id: "ACT-2", state: "planned", reason: null, attempts: 0 },
      { action_id: "ACT-3", state: "planned", reason: null, attempts: 0 },
    ]);
    expect(await caseRow(stack)).toEqual([
      { state: "awaiting_approval", reason: "approval_revoked", owner: "buyer" },
    ]);
    expect(
      await rows(
        stack.observer,
        `SELECT status, invalidated_reason FROM app.case_decision
          WHERE kind = 'approval' AND outcome = 'accepted'`,
      ),
    ).toEqual([{ status: "revoked", invalidated_reason: "approval_revoked" }]);
    expect(await eventKinds(stack, ["action_submitted"])).toEqual([]);
    // A second revocation finds no current approval.
    expect(await revoke(stack, caseId, planSha256)).toEqual({
      status: 409,
      body: { error: "approval_not_current" },
    });

    // The acknowledgements still match the plan; a fresh approval applies it once.
    expect((await approve(stack, caseId, planSha256)).body).toMatchObject({ state: "applying" });
    expect(await stack.workflow.apply(caseId)).toEqual({ state: "plan_verified", retry: false });
    expect(await sourceEffects(stack.observer)).toEqual(C_01_EFFECTS);
  });
});

describe("R4a (N-08): a revocation committed after ACT-1's claim, with the write in flight", () => {
  const context = recoveryStack("r4a");

  it("lands the write once, claims nothing later and proposes compensation without reversal", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await applyingCase(stack);
    context.handlers.set("beforeSubmit:ACT-1", async () => {
      const revoked = await revoke(stack, caseId, planSha256);
      expect(revoked).toEqual({
        status: 201,
        body: { state: "partially_applied", inFlight: ["ACT-1"], unresolved: [] },
      });
    });
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });

    expect(await sourceEffects(stack.observer)).toEqual(ACT_1_ONLY);
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "confirmed", reason: null, attempts: 1 },
      { action_id: "ACT-2", state: "failed", reason: "approval_revoked", attempts: 0 },
      { action_id: "ACT-3", state: "failed", reason: "approval_revoked", attempts: 0 },
    ]);
    expect(await caseRow(stack)).toEqual([
      { state: "partially_applied", reason: "canceled_after_effect", owner: "buyer" },
    ]);
    expect(
      await eventKinds(stack, [
        "approval_revoked",
        "cancellation_pending",
        "action_applied",
        "cancellation_settled",
        "compensation_proposed",
      ]),
    ).toEqual([
      "approval_revoked",
      "cancellation_pending",
      "action_applied",
      "cancellation_settled",
      "compensation_proposed",
    ]);
    const [proposal] = await rows<{ detail: { reversed: boolean; knownEffects: unknown[] } }>(
      stack.observer,
      "SELECT detail FROM app.case_event WHERE kind = 'compensation_proposed'",
    );
    expect(proposal?.detail.reversed).toBe(false);
    expect(proposal?.detail.knownEffects).toHaveLength(1);

    // A later run of the queued job changes nothing.
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });
    expect(await sourceEffects(stack.observer)).toEqual(ACT_1_ONLY);
  });
});

describe("R4b (N-08): a revocation while ACT-1's attempt is in flight and purchasing refuses it", () => {
  const context = recoveryStack("r4b");

  it("keeps the refused action failed with no effect, then a fresh approval tries again", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await applyingCase(stack);
    const line = "po_number = 'PO-120' AND revision = 3 AND line_number = '10'";
    const [original] = await rows<{ uom: string }>(
      stack.observer,
      `SELECT uom FROM fixture_purchasing.po_line WHERE ${line}`,
    );
    context.handlers.set("beforeSubmit:ACT-1", async () => {
      expect(await revoke(stack, caseId, planSha256)).toEqual({
        status: 201,
        body: { state: "partially_applied", inFlight: ["ACT-1"], unresolved: [] },
      });
      // Purchasing refuses the amendment inside its own transaction: the
      // line's unit no longer matches the command.
      await stack.observer.query(`UPDATE fixture_purchasing.po_line SET uom = 'BOX' WHERE ${line}`);
    });
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "awaiting_approval",
      retry: false,
    });

    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "failed", reason: "source.uom_mismatch", attempts: 1 },
      { action_id: "ACT-2", state: "planned", reason: null, attempts: 0 },
      { action_id: "ACT-3", state: "planned", reason: null, attempts: 0 },
    ]);
    expect(await caseRow(stack)).toEqual([
      { state: "awaiting_approval", reason: "approval_revoked", owner: "buyer" },
    ]);
    expect(
      await eventKinds(stack, [
        "approval_revoked",
        "cancellation_pending",
        "action_failed",
        "cancellation_settled",
        "compensation_proposed",
      ]),
    ).toEqual([
      "approval_revoked",
      "cancellation_pending",
      "action_failed",
      "cancellation_settled",
    ]);

    // With the line restored, a fresh approval authorizes a new attempt of
    // the same stored command under a new attempt key.
    await stack.observer.query(`UPDATE fixture_purchasing.po_line SET uom = $1 WHERE ${line}`, [
      original?.uom,
    ]);
    expect((await approve(stack, caseId, planSha256)).body).toMatchObject({ state: "applying" });
    expect(await stack.workflow.apply(caseId)).toEqual({ state: "plan_verified", retry: false });
    expect(await sourceEffects(stack.observer)).toEqual(C_01_EFFECTS);
    expect(
      await rows(
        stack.observer,
        "SELECT state, attempts, attempt_key FROM app.case_action WHERE action_id = 'ACT-1'",
      ),
    ).toEqual([{ state: "confirmed", attempts: 2, attempt_key: "PLAN-1.v1.ACT-1#2" }]);
  });
});

describe("R4c (N-08): a revocation while ACT-1's attempt is in flight and never lands", () => {
  const context = recoveryStack("r4c");

  it("reads the attempt back without resubmitting it, then stops at the bound as unresolved", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await applyingCase(stack);
    // The claim committed `pending`, then the run died before the write.
    context.handlers.set("beforeSubmit:ACT-1", () =>
      Promise.reject(new Error("simulated crash after the claim")),
    );
    await expect(stack.workflow.apply(caseId)).rejects.toThrow("simulated crash after the claim");
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "pending", reason: null, attempts: 1 },
      { action_id: "ACT-2", state: "authorized", reason: null, attempts: 0 },
      { action_id: "ACT-3", state: "authorized", reason: null, attempts: 0 },
    ]);

    expect(await revoke(stack, caseId, planSha256)).toEqual({
      status: 201,
      body: { state: "partially_applied", inFlight: ["ACT-1"], unresolved: [] },
    });
    expect(await caseRow(stack)).toEqual([
      { state: "partially_applied", reason: "reconciliation_pending", owner: "buyer" },
    ]);
    // The case keeps one queued job: the singleton key makes the revocation's
    // and the restart sweep's requeue no-ops while it waits.
    expect(await resumeInterruptedCases(stack.db, stack.boss)).toEqual([]);
    expect(await caseJobs(stack)).toEqual([{ state: "created" }]);

    for (let run = 1; run < RECONCILE_ATTEMPT_LIMIT; run += 1) {
      expect(await stack.workflow.apply(caseId)).toEqual({
        state: "partially_applied",
        retry: true,
      });
    }
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "unknown", reason: "reconciliation_pending", attempts: 1 },
      { action_id: "ACT-2", state: "failed", reason: "approval_revoked", attempts: 0 },
      { action_id: "ACT-3", state: "failed", reason: "approval_revoked", attempts: 0 },
    ]);
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });

    // Never resubmitted, never shown as resolved: a person confirms it at purchasing.
    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
    expect(
      await rows(
        stack.observer,
        "SELECT state, reason, attempts, reconcile_attempts FROM app.case_action WHERE action_id = 'ACT-1'",
      ),
    ).toEqual([
      {
        state: "unknown",
        reason: "reconciliation_unresolved",
        attempts: 1,
        reconcile_attempts: RECONCILE_ATTEMPT_LIMIT,
      },
    ]);
    expect(await caseRow(stack)).toEqual([
      { state: "partially_applied", reason: "reconciliation_unresolved", owner: "buyer" },
    ]);
    expect(await eventKinds(stack, ["cancellation_settled", "action_submitted"])).toEqual([
      "action_submitted",
    ]);
    const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
    expect((detail.case as { nextAction: string }).nextAction).toBe(
      "Confirm the outcome at the source; automatic read-back stopped without proof",
    );
    // No job retries it and the restart sweep leaves it to its owner.
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });
    await stack.observer.query("DELETE FROM pgboss.job WHERE name = 'case-application'");
    expect(await resumeInterruptedCases(stack.db, stack.boss)).toEqual([]);
  });
});

describe("U1: the read-back bound reached on a lost response while a revocation waits", () => {
  const context = recoveryStack("u1");

  it("moves the case to an unresolved outcome a person confirms, not a pending read-back", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await applyingCase(stack);
    context.handlers.set("beforeSubmit:ACT-1", async () => {
      expect((await revoke(stack, caseId, planSha256)).status).toBe(201);
      // Stands in for seven earlier unproven attempts of ACT-1, which R4c
      // drives one run at a time.
      await stack.observer.query(
        "UPDATE app.case_action SET reconcile_attempts = $1 WHERE action_id = 'ACT-1'",
        [RECONCILE_ATTEMPT_LIMIT - 1],
      );
    });
    context.handlers.set("afterSourceWrite:ACT-1", () =>
      Promise.reject(new Error("simulated timeout after purchasing committed the amendment")),
    );
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });

    expect(await sourceEffects(stack.observer)).toEqual(ACT_1_ONLY);
    expect(
      await rows(
        stack.observer,
        "SELECT state, reason, reconcile_attempts FROM app.case_action WHERE action_id = 'ACT-1'",
      ),
    ).toEqual([
      {
        state: "unknown",
        reason: "reconciliation_unresolved",
        reconcile_attempts: RECONCILE_ATTEMPT_LIMIT,
      },
    ]);
    expect(await caseRow(stack)).toEqual([
      { state: "partially_applied", reason: "reconciliation_unresolved", owner: "buyer" },
    ]);
    expect(await eventKinds(stack, ["cancellation_pending", "cancellation_settled"])).toEqual([
      "cancellation_pending",
    ]);
    const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
    expect((detail.case as { nextAction: string }).nextAction).toBe(
      "Confirm the outcome at the source; automatic read-back stopped without proof",
    );
    await stack.observer.query("DELETE FROM pgboss.job WHERE name = 'case-application'");
    expect(await resumeInterruptedCases(stack.db, stack.boss)).toEqual([]);
  });
});

describe("U2: a revocation after the read-back bound", () => {
  const context = recoveryStack("u2");

  it("records the cancellation as unresolved and never returns the plan for approval", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await applyingCase(stack);
    context.handlers.set("beforeSubmit:ACT-1", () =>
      Promise.reject(new Error("simulated crash after the claim")),
    );
    await expect(stack.workflow.apply(caseId)).rejects.toThrow("simulated crash after the claim");
    // Seven earlier unproven read-backs (as in R4c), then purchasing cannot be read.
    await stack.observer.query(
      "UPDATE app.case_action SET reconcile_attempts = $1 WHERE action_id = 'ACT-1'",
      [RECONCILE_ATTEMPT_LIMIT - 1],
    );
    await stack.observer.query("REVOKE SELECT ON fixture_purchasing.operation_receipt FROM sd_api");
    try {
      expect(await stack.workflow.apply(caseId)).toEqual({
        state: "partially_applied",
        retry: false,
      });
    } finally {
      await stack.observer.query("GRANT SELECT ON fixture_purchasing.operation_receipt TO sd_api");
    }
    expect(await caseRow(stack)).toEqual([
      { state: "partially_applied", reason: "reconciliation_unresolved", owner: "buyer" },
    ]);

    expect(await revoke(stack, caseId, planSha256)).toEqual({
      status: 201,
      body: { state: "partially_applied", inFlight: [], unresolved: ["ACT-1"] },
    });
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "unknown", reason: "reconciliation_unresolved", attempts: 1 },
      { action_id: "ACT-2", state: "failed", reason: "approval_revoked", attempts: 0 },
      { action_id: "ACT-3", state: "failed", reason: "approval_revoked", attempts: 0 },
    ]);
    expect(await caseRow(stack)).toEqual([
      { state: "partially_applied", reason: "reconciliation_unresolved", owner: "buyer" },
    ]);
    expect(
      await rows(
        stack.observer,
        `SELECT status FROM app.case_decision WHERE kind = 'approval' AND outcome = 'accepted'`,
      ),
    ).toEqual([{ status: "revoked" }]);
    const [pending] = await rows<{ detail: { unresolved: Array<{ actionId: string }> } }>(
      stack.observer,
      "SELECT detail FROM app.case_event WHERE kind = 'cancellation_pending'",
    );
    expect(pending?.detail.unresolved.map((entry) => entry.actionId)).toEqual(["ACT-1"]);
    expect(await eventKinds(stack, ["cancellation_settled"])).toEqual([]);

    // The plan cannot be approved again while ACT-1's outcome is open, and no
    // run or restart leaves a case looking in progress.
    expect((await approve(stack, caseId, planSha256)).status).toBe(409);
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });
    expect(
      await rows(
        stack.observer,
        "SELECT count(*)::int AS n FROM app.supplier_case WHERE state = 'applying'",
      ),
    ).toEqual([{ n: 0 }]);
    await stack.observer.query("DELETE FROM pgboss.job WHERE name = 'case-application'");
    expect(await resumeInterruptedCases(stack.db, stack.boss)).toEqual([]);
    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
  });
});

describe("U3: a stored command that no longer matches its request digest", () => {
  const context = recoveryStack("u3");

  it("sends nothing and leaves the action to a person instead of retrying", async () => {
    const { stack } = context;
    const { caseId } = await applyingCase(stack);
    context.handlers.set("beforeSubmit:ACT-1", () =>
      Promise.reject(new Error("simulated crash after the claim")),
    );
    await expect(stack.workflow.apply(caseId)).rejects.toThrow("simulated crash after the claim");
    await stack.observer.query(
      `UPDATE app.case_action SET command = command || '{"note": "changed"}'::jsonb
        WHERE action_id = 'ACT-1'`,
    );

    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });
    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "unknown", reason: "request_digest_mismatch", attempts: 1 },
      { action_id: "ACT-2", state: "authorized", reason: null, attempts: 0 },
      { action_id: "ACT-3", state: "authorized", reason: null, attempts: 0 },
    ]);
    expect(await caseRow(stack)).toEqual([
      { state: "partially_applied", reason: "request_digest_mismatch", owner: "buyer" },
    ]);
    expect(await eventKinds(stack, ["request_digest_mismatch"])).toEqual([
      "request_digest_mismatch",
    ]);
    const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
    expect((detail.case as { nextAction: string }).nextAction).toBe(
      "Confirm earlier attempts at the source; the stored command no longer matches its digest",
    );
    // A later run or restart does not retry it.
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });
    await stack.observer.query("DELETE FROM pgboss.job WHERE name = 'case-application'");
    expect(await resumeInterruptedCases(stack.db, stack.boss)).toEqual([]);
  });
});

describe("X1: an escalation while ACT-2's outcome is unknown (SD-11)", () => {
  const context = recoveryStack("x1");

  it("reconciles ACT-2 by operation ID without a duplicate reservation and claims no transfer", async () => {
    const { stack } = context;
    const { caseId } = await applyingCase(stack);
    context.handlers.set("afterSourceWrite:ACT-2", () =>
      Promise.reject(new Error("simulated timeout after inventory committed the reservation")),
    );
    expect(await stack.workflow.apply(caseId)).toEqual({ state: "partially_applied", retry: true });
    expect(await sourceEffects(stack.observer)).toEqual(ACT_1_2);

    // With no job left for the case, the escalation must queue the read-back itself.
    await stack.observer.query("DELETE FROM pgboss.job WHERE name = 'case-application'");
    const escalated = await call(stack, stack.manager, "POST", `/api/cases/${caseId}/escalations`, {
      actorId: "manager-1",
      note: "Stop the transfer",
    });
    expect(escalated).toEqual({ status: 201, body: { state: "escalated" } });
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "confirmed", reason: null, attempts: 1 },
      { action_id: "ACT-2", state: "unknown", reason: "outcome_unknown", attempts: 1 },
      { action_id: "ACT-3", state: "failed", reason: "manual_escalation", attempts: 0 },
    ]);
    // The escalation queued the read-back with the cancellation, in one transaction.
    expect(await caseJobs(stack)).toEqual([{ state: "created" }]);

    // A restarted API: a new workflow on the same records reads ACT-2 back.
    const restarted = new CaseWorkflow({ ...stack.workflow.deps, faults: {} });
    expect(await restarted.apply(caseId)).toEqual({ state: "escalated", retry: false });
    expect(await sourceEffects(stack.observer)).toEqual(ACT_1_2);
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "confirmed", reason: null, attempts: 1 },
      { action_id: "ACT-2", state: "confirmed", reason: null, attempts: 1 },
      { action_id: "ACT-3", state: "failed", reason: "manual_escalation", attempts: 0 },
    ]);
    expect(await caseRow(stack)).toEqual([
      { state: "escalated", reason: "manual_escalation", owner: "buyer" },
    ]);
    expect(
      await eventKinds(stack, [
        "cancellation_pending",
        "action_reconciled",
        "cancellation_settled",
      ]),
    ).toEqual(["cancellation_pending", "action_reconciled", "cancellation_settled"]);
    expect(
      await rows(
        stack.observer,
        `SELECT count(DISTINCT reservation_id)::int AS n FROM fixture_inventory.reservation
          WHERE plan_id = 'PLAN-1'`,
      ),
    ).toEqual([{ n: 1 }]);
    // Settled once: a duplicate run records nothing more.
    expect(await restarted.apply(caseId)).toEqual({ state: "escalated", retry: false });
    expect(await eventKinds(stack, ["cancellation_settled"])).toHaveLength(1);
  });
});

describe("J1: duplicate and late application runs converge", () => {
  const context = recoveryStack("j1");

  it("applies each action once with a stable operation ID, attempt key and request digest", async () => {
    const { stack } = context;
    const { caseId } = await applyingCase(stack);
    const other = new CaseWorkflow({ ...stack.workflow.deps, faults: {} });
    // Two runs of the same case at once: one holds the case run lock, the
    // other retries later or finds nothing left to do.
    const outcomes = await Promise.all([stack.workflow.apply(caseId), other.apply(caseId)]);
    for (const outcome of outcomes) {
      expect(["applying", "verifying", "plan_verified"]).toContain(outcome.state);
    }
    // A late or reordered duplicate run then finishes the case or changes nothing.
    expect(await other.apply(caseId)).toEqual({ state: "plan_verified", retry: false });
    expect(await stack.workflow.apply(caseId)).toEqual({ state: "plan_verified", retry: false });
    expect(await sourceEffects(stack.observer)).toEqual(C_01_EFFECTS);

    const journal = await rows<{
      action_id: string;
      operation_id: string;
      attempts: number;
      attempt_key: string;
      request_digest: string;
      command: unknown;
    }>(
      stack.observer,
      `SELECT action_id, operation_id, attempts, attempt_key, request_digest, command
         FROM app.case_action ORDER BY sequence`,
    );
    expect(
      journal.map(({ action_id, operation_id, attempts, attempt_key }) => ({
        action_id,
        operation_id,
        attempts,
        attempt_key,
      })),
    ).toEqual([
      {
        action_id: "ACT-1",
        operation_id: "PLAN-1.v1.ACT-1",
        attempts: 1,
        attempt_key: "PLAN-1.v1.ACT-1#1",
      },
      {
        action_id: "ACT-2",
        operation_id: "PLAN-1.v1.ACT-2",
        attempts: 1,
        attempt_key: "PLAN-1.v1.ACT-2#1",
      },
      {
        action_id: "ACT-3",
        operation_id: "PLAN-1.v1.ACT-3",
        attempts: 1,
        attempt_key: "PLAN-1.v1.ACT-3#1",
      },
    ]);
    for (const entry of journal) {
      // The digest is the SHA-256 of the stored command's canonical JSON.
      expect(entry.request_digest).toBe(
        createHash("sha256").update(canonicalJson(entry.command), "utf8").digest("hex"),
      );
    }
    expect(await eventKinds(stack, ["action_submitted"])).toHaveLength(3);
  });
});
