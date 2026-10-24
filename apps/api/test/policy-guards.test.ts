// Execution guards (ADR 0013), each on its own disposable database.
// Barriers in the application run pause it at a named point while the test
// commits a change through an independent migrator connection, then the
// authoritative rows are read back through that connection.
//
// Oracle variants, asserted with frozen-oracle literals:
//
// - G1: two simultaneous manager approvals, mismatched and transport-only
//   acknowledgements (N-10 a to c), then AUTH-1 version 2 committed between
//   the decisions and the first claim (N-06 c);
// - N-06 b: a demand change committed before ACT-1's claim;
// - N-06 e: the clock passing the approval expiry before ACT-1's claim;
// - BA-06: an escalation committed before ACT-1's claim prevents any effect.
//
// Project extensions (ADR 0013), not oracle variants. Their expectations are
// the implementation's decided behavior, written by hand:
//
// - G2: a demand change after ACT-1's claim, before its source write;
// - G3: an escalation waiting on ACT-1's open claim transaction; since
//   ADR 0016, it also fails the unclaimed actions and settles once
//   ACT-1's outcome is recorded;
// - G4: an approval refused as stale once AUTH-1 version 2 is current;
// - W1 and W2: AUTH-1 version 2, and separately a revocation of the
//   approver's role, between the claim guard and the claim commit.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const planner = (planSha256: string) => ({
  kind: "warehouse_planner_confirmation",
  actorId: "planner-1",
  planSha256,
  optionId: "TRO-1",
  quantity: "50",
  arrivalDate: "2026-10-23",
});

/** DEM@2: SO-202/10's open quantity becomes 60; everything else is copied from DEM@1. */
const DEMAND_V2 = `
        INSERT INTO fixture_demand.demand_snapshot (version, organization, observed_at)
        SELECT 'DEM@2', organization, observed_at FROM fixture_demand.demand_snapshot
         WHERE version = 'DEM@1';
        INSERT INTO fixture_demand.demand_line
          (version, sales_order, line, sku, uom, open_quantity, delivered_quantity, destination,
           receipt_cutoff, calendar_policy_id, calendar_policy_version, priority)
        SELECT 'DEM@2', sales_order, line, sku, uom,
               CASE WHEN sales_order = 'SO-202' AND line = '10' THEN 60 ELSE open_quantity END,
               delivered_quantity, destination, receipt_cutoff, calendar_policy_id,
               calendar_policy_version, priority
          FROM fixture_demand.demand_line WHERE version = 'DEM@1';
        INSERT INTO fixture_demand.supply_link (version, sales_order, line, po_number, po_line)
        SELECT 'DEM@2', sales_order, line, po_number, po_line
          FROM fixture_demand.supply_link WHERE version = 'DEM@1';
        UPDATE fixture_demand.demand_head SET version = 'DEM@2' WHERE version = 'DEM@1';`;

/** AUTH-1 version 2 lowers the manager limit to EUR 150.00 (N-06 c). */
const AUTH_1_V2 = `
  INSERT INTO fixture_reference.policy (policy_id, version, parameters) VALUES
    ('AUTH-1', 2, '{"currency": "EUR",
                    "limits": [{"role": "buyer", "maxMinorUnits": 10000},
                               {"role": "procurement_manager", "maxMinorUnits": 15000}],
                    "transferRequires": ["supplier_acknowledgement", "warehouse_planner_confirmation"]}')`;

/** A promise and the function that settles it: a test barrier. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
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

/** The manager's approval, the planner's confirmation and the supplier's acknowledgement. */
async function authorize(stack: CaseStack, caseId: string, planSha256: string) {
  const approved = await call(stack, stack.manager, "POST", `/api/cases/${caseId}/decisions`, {
    actorId: "manager-1",
    decision: "approve",
    planSha256,
  });
  expect(approved.status).toBe(201);
  await acknowledgeAll(stack, caseId, planSha256);
}

async function acknowledgeAll(stack: CaseStack, caseId: string, planSha256: string) {
  const path = `/api/cases/${caseId}/acknowledgements`;
  const confirmed = await call(stack, stack.manager, "POST", path, planner(planSha256));
  expect(confirmed.body).toMatchObject({ outcome: "accepted" });
  const acknowledged = await call(stack, stack.buyer, "POST", path, SUPPLIER_ACK);
  expect(acknowledged.body).toMatchObject({ outcome: "accepted", state: "applying" });
}

/** Backends other than the observer waiting for a lock, seen through pg_locks. */
async function lockWaiters(stack: CaseStack): Promise<number> {
  const [row] = await rows<{ waiting: number }>(
    stack.observer,
    "SELECT count(DISTINCT pid)::int AS waiting FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()",
  );
  return row?.waiting ?? 0;
}

async function untilWaiters(stack: CaseStack, count: number) {
  const deadline = Date.now() + 20_000;
  while ((await lockWaiters(stack)) < count) {
    if (Date.now() > deadline) throw new Error(`fewer than ${String(count)} lock waiters`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function transitions(stack: CaseStack, caseId: string) {
  const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
  return (
    detail.timeline as Array<{
      toState: string | null;
      reason: string | null;
      owner: string | null;
    }>
  )
    .filter((event) => event.toState !== null)
    .map(({ toState, reason, owner }) => ({ toState, reason, owner }));
}

describe("G1: concurrent approvals, mismatched acknowledgements and a newer AUTH-1 before the claim", () => {
  const db = new DisposableDatabase("g26a");
  let stack: CaseStack;
  let beforeClaim: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    await db.start();
    stack = await startCaseStack(db, {
      faults: {
        beforeClaim: ({ actionId }) =>
          actionId === "ACT-1" && beforeClaim !== null ? beforeClaim() : Promise.resolve(),
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.close();
    await db.remove();
    expect(await db.leftovers()).toBe("");
  }, COMPOSE_TIMEOUT_MS + MARGIN_MS);

  it("serializes two simultaneous approvals into exactly one accepted decision", async () => {
    const { caseId, planSha256 } = await ingest(stack);
    // The observer holds the case row so both requests are queued behind it.
    await stack.observer.query("BEGIN");
    await stack.observer.query("SELECT 1 FROM app.supplier_case WHERE id = $1 FOR UPDATE", [
      caseId,
    ]);
    const approve = () =>
      call(stack, stack.manager, "POST", `/api/cases/${caseId}/decisions`, {
        actorId: "manager-1",
        decision: "approve",
        planSha256,
      });
    const both = Promise.all([approve(), approve()]);
    await untilWaiters(stack, 2);
    await stack.observer.query("COMMIT");
    const results = (await both).sort((a, b) => a.status - b.status);

    expect(results.map((result) => result.status)).toEqual([201, 409]);
    expect(results[0]?.body).toMatchObject({
      outcome: "accepted",
      kind: "approval",
      state: "awaiting_acknowledgement",
    });
    expect(results[1]?.body).toEqual({ error: "invalid_case_state" });
    expect(
      await rows(
        stack.observer,
        "SELECT actor_id, outcome, status FROM app.case_decision WHERE kind = 'approval'",
      ),
    ).toEqual([{ actor_id: "manager-1", outcome: "accepted", status: "current" }]);
  });

  it("records a transport-only reply and mismatched acknowledgements without satisfying the wait", async () => {
    const [row] = await rows<{ id: string }>(stack.observer, "SELECT id FROM app.supplier_case");
    const caseId = row?.id ?? "";
    const path = `/api/cases/${caseId}/acknowledgements`;
    // N-10 a: "Thanks, noted" names no proposal, PO line or schedule.
    const noted = await call(stack, stack.buyer, "POST", path, {
      kind: "supplier_acknowledgement",
      actorId: "supplier-1",
      proposalId: null,
      poNumber: null,
      poLine: null,
      segments: [],
    });
    // N-10 b: a different proposal.
    const other = await call(stack, stack.buyer, "POST", path, {
      ...SUPPLIER_ACK,
      proposalId: "PROP-9",
    });
    // N-10 c: the planner confirms TRO-1 against another plan hash.
    const wrongHash = await call(stack, stack.manager, "POST", path, planner("0".repeat(64)));
    for (const [result, reason] of [
      [noted, "acknowledgement_not_matching"],
      [other, "acknowledgement_not_matching"],
      [wrongHash, "confirmation_not_matching"],
    ] as const) {
      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        outcome: "non_matching",
        reason,
        state: "awaiting_acknowledgement",
      });
    }
    expect(
      await rows(
        stack.observer,
        `SELECT kind, outcome, reason, status FROM app.case_decision
          WHERE kind <> 'approval' ORDER BY occurred_at, kind`,
      ),
    ).toEqual([
      {
        kind: "supplier_acknowledgement",
        outcome: "non_matching",
        reason: "acknowledgement_not_matching",
        status: "void",
      },
      {
        kind: "supplier_acknowledgement",
        outcome: "non_matching",
        reason: "acknowledgement_not_matching",
        status: "void",
      },
      {
        kind: "warehouse_planner_confirmation",
        outcome: "non_matching",
        reason: "confirmation_not_matching",
        status: "void",
      },
    ]);
    expect(
      await rows(
        stack.observer,
        `SELECT kind FROM app.case_event
          WHERE kind LIKE '%not_matching' OR kind = 'application_authorized' ORDER BY sequence`,
      ),
    ).toEqual([
      { kind: "supplier_acknowledgement_not_matching" },
      { kind: "supplier_acknowledgement_not_matching" },
      { kind: "warehouse_planner_confirmation_not_matching" },
    ]);
    expect(await rows(stack.observer, "SELECT state FROM app.supplier_case")).toEqual([
      { state: "awaiting_acknowledgement" },
    ]);
  });

  it("rejects ACT-1's claim after AUTH-1 version 2 is published, writes nothing and reassesses", async () => {
    const [row] = await rows<{ id: string; sha256: string }>(
      stack.observer,
      "SELECT c.id, p.sha256 FROM app.supplier_case c JOIN app.case_plan p ON p.id = c.current_plan_id",
    );
    const caseId = row?.id ?? "";
    const planSha256 = row?.sha256 ?? "";
    await acknowledgeAll(stack, caseId, planSha256);

    // Between the decisions and ACT-1's claim, AUTH-1 version 2 lowers the
    // manager limit to EUR 150.00. Version 1's row stays in the store.
    beforeClaim = async () => {
      beforeClaim = null;
      await stack.observer.query(AUTH_1_V2);
    };
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "needs_clarification",
      retry: false,
    });

    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 0,
      inventory: 0,
      requests: 0,
      po_revision: 3,
      wh_b: "INV-B@1",
    });
    expect(
      await rows(
        stack.observer,
        `SELECT kind, status, invalidated_reason FROM app.case_decision
          WHERE outcome = 'accepted' ORDER BY kind`,
      ),
    ).toEqual([
      { kind: "approval", status: "stale", invalidated_reason: "stale_policy" },
      { kind: "supplier_acknowledgement", status: "stale", invalidated_reason: "stale_policy" },
      {
        kind: "warehouse_planner_confirmation",
        status: "stale",
        invalidated_reason: "stale_policy",
      },
    ]);
    expect(
      await rows(
        stack.observer,
        "SELECT action_id, state, reason, attempts FROM app.case_action ORDER BY sequence",
      ),
    ).toEqual([
      { action_id: "ACT-1", state: "failed", reason: "stale_policy", attempts: 0 },
      { action_id: "ACT-2", state: "failed", reason: "stale_policy", attempts: 0 },
      { action_id: "ACT-3", state: "failed", reason: "stale_policy", attempts: 0 },
    ]);
    // The reassessment reads AUTH-1 at its current version 2, which the
    // first-slice policy does not implement, so it pauses for the buyer.
    expect((await transitions(stack, caseId)).slice(-3)).toEqual([
      { toState: "needs_clarification", reason: "stale_policy", owner: "buyer" },
      { toState: "assessing", reason: null, owner: null },
      {
        toState: "needs_clarification",
        reason: "policy_unsupported_policy_version",
        owner: "buyer",
      },
    ]);
    expect(
      await rows(
        stack.observer,
        "SELECT version FROM fixture_reference.policy WHERE policy_id = 'AUTH-1' ORDER BY version",
      ),
    ).toEqual([{ version: 1 }, { version: 2 }]);

    // The old plan's hash can never be approved again.
    const again = await call(stack, stack.manager, "POST", `/api/cases/${caseId}/decisions`, {
      actorId: "manager-1",
      decision: "approve",
      planSha256,
    });
    expect(again).toEqual({ status: 409, body: { error: "plan_mismatch" } });
    expect((await sourceEffects(stack.observer))?.purchasing).toBe(0);
  });
});

describe("G2 (extension): a demand change after ACT-1's claim, before its source write", () => {
  const db = new DisposableDatabase("g26b");
  let stack: CaseStack;
  let beforeSubmit: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    await db.start();
    stack = await startCaseStack(db, {
      faults: {
        beforeSubmit: ({ actionId }) =>
          actionId === "ACT-1" && beforeSubmit !== null ? beforeSubmit() : Promise.resolve(),
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.close();
    await db.remove();
    expect(await db.leftovers()).toBe("");
  }, COMPOSE_TIMEOUT_MS + MARGIN_MS);

  it("keeps the granted PO amendment, claims no reservation and settles partially applied", async () => {
    const { caseId, planSha256 } = await ingest(stack);
    await authorize(stack, caseId, planSha256);

    // SO-202/10's open quantity becomes 60 in DEM@2 once ACT-1 is claimed.
    beforeSubmit = async () => {
      beforeSubmit = null;
      await stack.observer.query(DEMAND_V2);
    };
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });

    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 1,
      inventory: 0,
      requests: 0,
      po_revision: 4,
      wh_b: "INV-B@1",
    });
    expect(
      await rows(
        stack.observer,
        "SELECT action_id, state, reason, attempts FROM app.case_action ORDER BY sequence",
      ),
    ).toEqual([
      { action_id: "ACT-1", state: "confirmed", reason: null, attempts: 1 },
      { action_id: "ACT-2", state: "failed", reason: "stale_source_demand", attempts: 0 },
      { action_id: "ACT-3", state: "failed", reason: "stale_source_demand", attempts: 0 },
    ]);
    expect(
      await rows(stack.observer, "SELECT state, reason, owner FROM app.supplier_case"),
    ).toEqual([{ state: "partially_applied", reason: "stale_source_demand", owner: "buyer" }]);
    expect(
      await rows(
        stack.observer,
        "SELECT status, invalidated_reason FROM app.case_decision WHERE kind = 'approval' AND outcome = 'accepted'",
      ),
    ).toEqual([{ status: "stale", invalidated_reason: "stale_source_demand" }]);
    // The known effect stays recorded with its receipt and is never reversed.
    const [failed] = await rows<{ detail: { knownEffects: Array<{ actionId: string }> } }>(
      stack.observer,
      "SELECT detail FROM app.case_event WHERE kind = 'action_failed'",
    );
    expect(failed?.detail.knownEffects.map((effect) => effect.actionId)).toEqual(["ACT-1"]);
    expect(
      await rows(
        stack.observer,
        "SELECT sales_order, open_quantity::text AS open FROM fixture_demand.demand_line WHERE version = 'DEM@1' ORDER BY 1",
      ),
    ).toEqual([
      { sales_order: "SO-201", open: "70" },
      { sales_order: "SO-202", open: "50" },
    ]);

    // A later run changes nothing.
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });
    expect((await sourceEffects(stack.observer))?.inventory).toBe(0);
  });
});

describe("G3 (extension): an escalation waiting on ACT-1's claim transaction", () => {
  const db = new DisposableDatabase("g26c");
  let stack: CaseStack;
  const entered = gate();
  const release = gate();

  beforeAll(async () => {
    await db.start();
    stack = await startCaseStack(db, {
      faults: {
        async beforeClaimCommit({ actionId }) {
          if (actionId !== "ACT-1") return;
          entered.open();
          await release.opened;
        },
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.close();
    await db.remove();
    expect(await db.leftovers()).toBe("");
  }, COMPOSE_TIMEOUT_MS + MARGIN_MS);

  it("orders the escalation after the committed claim: ACT-1 lands once, nothing later is claimed", async () => {
    const { caseId, planSha256 } = await ingest(stack);
    await authorize(stack, caseId, planSha256);

    const run = stack.workflow.apply(caseId);
    await entered.opened;
    // The claim transaction holds the case row; the escalation queues behind it.
    const escalation = call(stack, stack.manager, "POST", `/api/cases/${caseId}/escalations`, {
      actorId: "manager-1",
      note: "Stop this plan",
    });
    await untilWaiters(stack, 1);
    release.open();
    const [applied, escalated] = await Promise.all([run, escalation]);

    expect(escalated).toEqual({ status: 201, body: { state: "escalated" } });
    expect(applied).toEqual({ state: "escalated", retry: false });
    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 1,
      inventory: 0,
      requests: 0,
      po_revision: 4,
      wh_b: "INV-B@1",
    });
    expect(
      await rows(
        stack.observer,
        "SELECT action_id, state, attempts FROM app.case_action ORDER BY sequence",
      ),
    ).toEqual([
      { action_id: "ACT-1", state: "confirmed", attempts: 1 },
      // ADR 0016: nothing of an escalated plan stays authorized.
      { action_id: "ACT-2", state: "failed", attempts: 0 },
      { action_id: "ACT-3", state: "failed", attempts: 0 },
    ]);
    expect(
      await rows(
        stack.observer,
        "SELECT status, invalidated_reason FROM app.case_decision WHERE kind = 'approval' AND outcome = 'accepted'",
      ),
    ).toEqual([{ status: "superseded", invalidated_reason: "manual_escalation" }]);
    // The claim committed first; the escalation and the effect follow it.
    const events = await rows<{ kind: string }>(
      stack.observer,
      `SELECT kind FROM app.case_event
        WHERE kind IN ('action_submitted', 'escalated', 'action_applied') ORDER BY sequence`,
    );
    expect(events[0]).toEqual({ kind: "action_submitted" });
    expect(events.map((event) => event.kind).sort()).toEqual([
      "action_applied",
      "action_submitted",
      "escalated",
    ]);
    // The escalation found ACT-1 in flight: it waited for the outcome, which
    // the running application recorded, then settled with the known effect.
    const cancellation = await rows<{ kind: string; detail: { knownEffects?: unknown[] } }>(
      stack.observer,
      `SELECT kind, detail FROM app.case_event
        WHERE kind IN ('cancellation_pending', 'cancellation_settled') ORDER BY sequence`,
    );
    expect(cancellation.map((event) => event.kind)).toEqual([
      "cancellation_pending",
      "cancellation_settled",
    ]);
    expect(cancellation[1]?.detail.knownEffects).toHaveLength(1);
    expect(await rows(stack.observer, "SELECT state, reason FROM app.supplier_case")).toEqual([
      { state: "escalated", reason: "manual_escalation" },
    ]);
  });
});

describe("G4 (extension): an approval after a newer AUTH-1 version is published", () => {
  const db = new DisposableDatabase("g26d");
  let stack: CaseStack;

  beforeAll(async () => {
    await db.start();
    stack = await startCaseStack(db);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.close();
    await db.remove();
    expect(await db.leftovers()).toBe("");
  }, COMPOSE_TIMEOUT_MS + MARGIN_MS);

  it("refuses the manager's approval of the old plan as stale and reassesses before any effect", async () => {
    const { caseId, planSha256 } = await ingest(stack);
    await stack.observer.query(AUTH_1_V2);

    const approved = await call(stack, stack.manager, "POST", `/api/cases/${caseId}/decisions`, {
      actorId: "manager-1",
      decision: "approve",
      planSha256,
    });
    expect(approved.status).toBe(409);
    expect(approved.body).toMatchObject({
      error: "stale_policy",
      state: "needs_clarification",
    });
    expect(
      await rows(stack.observer, "SELECT kind, outcome, reason, status FROM app.case_decision"),
    ).toEqual([{ kind: "approval", outcome: "rejected", reason: "stale_policy", status: "void" }]);
    expect((await transitions(stack, caseId)).slice(-3)).toEqual([
      { toState: "needs_clarification", reason: "stale_policy", owner: "buyer" },
      { toState: "assessing", reason: null, owner: null },
      {
        toState: "needs_clarification",
        reason: "policy_unsupported_policy_version",
        owner: "buyer",
      },
    ]);
    expect(
      await rows(stack.observer, "SELECT state FROM app.case_action ORDER BY sequence"),
    ).toEqual([{ state: "planned" }, { state: "planned" }, { state: "planned" }]);
    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 0,
      inventory: 0,
      requests: 0,
      po_revision: 3,
      wh_b: "INV-B@1",
    });
  });
});

type Barrier = "beforeClaim" | "beforeClaimCommit" | "beforeSubmit";

/**
 * A disposable stack whose barriers run the handler the test sets for an
 * action, once. Only the application run reaches a barrier.
 */
function barrierStack(gateName: string) {
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

const decisionsAccepted = (stack: CaseStack) =>
  rows(
    stack.observer,
    `SELECT kind, status, invalidated_reason FROM app.case_decision
      WHERE outcome = 'accepted' ORDER BY kind`,
  );
const actionRows = (stack: CaseStack) =>
  rows(
    stack.observer,
    "SELECT action_id, state, reason, attempts FROM app.case_action ORDER BY sequence",
  );
const allDecisions = (status: string, reason: string) => [
  { kind: "approval", status, invalidated_reason: reason },
  { kind: "supplier_acknowledgement", status, invalidated_reason: reason },
  { kind: "warehouse_planner_confirmation", status, invalidated_reason: reason },
];
const NO_EFFECTS = { purchasing: 0, inventory: 0, requests: 0, po_revision: 3, wh_b: "INV-B@1" };
const ACT_1_ONLY = { purchasing: 1, inventory: 0, requests: 0, po_revision: 4, wh_b: "INV-B@1" };

describe("N-06 b: a demand change committed before ACT-1's claim", () => {
  const context = barrierStack("n06b");

  it("rejects the claim, writes nothing, marks the decisions stale and reassesses", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await ingest(stack);
    await authorize(stack, caseId, planSha256);
    context.handlers.set("beforeClaim:ACT-1", async () => {
      await stack.observer.query(DEMAND_V2);
    });
    const outcome = await stack.workflow.apply(caseId);

    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
    expect(await decisionsAccepted(stack)).toEqual(allDecisions("stale", "stale_source_demand"));
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "failed", reason: "stale_source_demand", attempts: 0 },
      { action_id: "ACT-2", state: "failed", reason: "stale_source_demand", attempts: 0 },
      { action_id: "ACT-3", state: "failed", reason: "stale_source_demand", attempts: 0 },
    ]);
    expect(outcome).toEqual({ state: "escalated", retry: false });
    // Reassessed against DEM@2 (hand-derived, not an oracle literal): SO-201/10
    // keeps its 70, TRO-1's 50 meets 50 of SO-202/10's 60, leaving 10 short.
    expect((await transitions(stack, caseId)).slice(-3)).toEqual([
      { toState: "needs_clarification", reason: "stale_source_demand", owner: "buyer" },
      { toState: "assessing", reason: null, owner: null },
      { toState: "escalated", reason: "unresolved_shortage", owner: "buyer" },
    ]);
    const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
    expect(detail.plan).toBeNull();
    expect((detail.impact as { shortfalls: unknown[] }).shortfalls).toContainEqual(
      expect.objectContaining({
        demandLine: { salesOrder: "SO-202", line: "10" },
        quantity: "10",
        reason: "unresolved_shortage",
      }),
    );
  });
});

describe("N-06 e: the clock passes the approval expiry before ACT-1's claim", () => {
  const context = barrierStack("n06e");

  it("rejects the claim, writes nothing, marks the decisions expired and reassesses", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await ingest(stack);
    await authorize(stack, caseId, planSha256);
    // 2026-10-21T18:00 in Copenhagen (UTC+2) is the approval expiry.
    context.handlers.set("beforeClaim:ACT-1", async () => {
      await stack.observer.query(
        "UPDATE fixture_reference.business_clock SET instant = '2026-10-21T16:00:01Z' WHERE id = 1",
      );
    });
    const outcome = await stack.workflow.apply(caseId);

    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
    const [approval] = await rows(
      stack.observer,
      "SELECT status, invalidated_reason FROM app.case_decision WHERE kind = 'approval'",
    );
    expect(approval).toEqual({ status: "expired", invalidated_reason: "approval_expired" });
    expect(
      await rows(
        stack.observer,
        `SELECT a.state, a.reason, a.attempts FROM app.case_action a
           JOIN app.case_plan p ON p.id = a.plan_row_id
          WHERE p.plan_version = 1 ORDER BY a.sequence`,
      ),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        state: "failed",
        reason: "approval_expired",
        attempts: 0,
      })),
    );
    // Same quantities at 18:00:01, so the reassessment proposes plan version 2,
    // which needs a fresh approval; the expired one never carries over.
    expect(outcome).toEqual({ state: "awaiting_approval", retry: false });
    expect((await transitions(stack, caseId)).slice(-3)).toEqual([
      { toState: "needs_clarification", reason: "approval_expired", owner: "buyer" },
      { toState: "assessing", reason: null, owner: null },
      {
        toState: "awaiting_approval",
        reason: "policy_plan_ready_for_approval",
        owner: "procurement_manager",
      },
    ]);
    expect(
      await rows(
        stack.observer,
        `SELECT p.plan_version, (SELECT count(*)::int FROM app.case_decision d
                                  WHERE d.plan_row_id = p.id) AS decisions
           FROM app.supplier_case c JOIN app.case_plan p ON p.id = c.current_plan_id`,
      ),
    ).toEqual([{ plan_version: 2, decisions: 0 }]);
  });
});

describe("BA-06: an escalation committed before ACT-1's claim", () => {
  const context = barrierStack("ba06");

  it("prevents every effect: the claim finds the case escalated", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await ingest(stack);
    await authorize(stack, caseId, planSha256);
    context.handlers.set("beforeClaim:ACT-1", async () => {
      const escalated = await call(
        stack,
        stack.manager,
        "POST",
        `/api/cases/${caseId}/escalations`,
        {
          actorId: "manager-1",
          note: "Stop this plan",
        },
      );
      expect(escalated).toEqual({ status: 201, body: { state: "escalated" } });
    });
    expect(await stack.workflow.apply(caseId)).toEqual({ state: "escalated", retry: false });

    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
    // ADR 0016: the escalation fails every unclaimed action of the plan.
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "failed", reason: "manual_escalation", attempts: 0 },
      { action_id: "ACT-2", state: "failed", reason: "manual_escalation", attempts: 0 },
      { action_id: "ACT-3", state: "failed", reason: "manual_escalation", attempts: 0 },
    ]);
    expect(await decisionsAccepted(stack)).toEqual(allDecisions("superseded", "manual_escalation"));
    expect(
      await rows(
        stack.observer,
        "SELECT count(*)::int AS n FROM app.case_event WHERE kind = 'action_submitted'",
      ),
    ).toEqual([{ n: 0 }]);
  });
});

describe("W1 (extension): AUTH-1 version 2 between the claim guard and the claim commit", () => {
  const context = barrierStack("w1");

  it("lets the granted ACT-1 write once, then refuses ACT-2 before any write", async () => {
    const { stack } = context;
    const { caseId, planSha256 } = await ingest(stack);
    await authorize(stack, caseId, planSha256);
    // The guard has read AUTH-1 version 1; version 2 commits before the claim does.
    context.handlers.set("beforeClaimCommit:ACT-1", async () => {
      await stack.observer.query(AUTH_1_V2);
    });
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });

    expect(await sourceEffects(stack.observer)).toEqual(ACT_1_ONLY);
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "confirmed", reason: null, attempts: 1 },
      { action_id: "ACT-2", state: "failed", reason: "stale_policy", attempts: 0 },
      { action_id: "ACT-3", state: "failed", reason: "stale_policy", attempts: 0 },
    ]);
    expect(
      await rows(stack.observer, "SELECT state, reason, owner FROM app.supplier_case"),
    ).toEqual([{ state: "partially_applied", reason: "stale_policy", owner: "buyer" }]);
    expect(await lockWaiters(stack)).toBe(0);
    // A later run writes nothing more.
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });
    expect(await sourceEffects(stack.observer)).toEqual(ACT_1_ONLY);
  });
});

describe("W2 (extension): the approver's role revoked between the claim guard and the claim commit", () => {
  const context = barrierStack("w2");

  it("makes the revocation wait for the claim, writes ACT-1 once and refuses ACT-2", async () => {
    const { stack, db } = context;
    const { caseId, planSha256 } = await ingest(stack);
    await authorize(stack, caseId, planSha256);
    const revoker = await db.client("migrator", "w2-revoker");
    let revoked: Promise<unknown> = Promise.resolve();
    let revocationDone = false;
    let blockedUntilCommit = false;
    context.handlers.set("beforeClaimCommit:ACT-1", async () => {
      // The claim holds manager-1's actor row FOR SHARE, so the revocation
      // waits for this transaction to end; it cannot commit inside the window.
      revoked = revoker
        .query("UPDATE app.case_actor SET active = false WHERE actor_id = 'manager-1'")
        .then(() => (revocationDone = true));
      await untilWaiters(stack, 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      blockedUntilCommit = !revocationDone;
    });
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });
    await revoked;

    expect(blockedUntilCommit).toBe(true);
    expect(revocationDone).toBe(true);
    expect(await sourceEffects(stack.observer)).toEqual(ACT_1_ONLY);
    expect(await actionRows(stack)).toEqual([
      { action_id: "ACT-1", state: "confirmed", reason: null, attempts: 1 },
      { action_id: "ACT-2", state: "failed", reason: "stale_authority", attempts: 0 },
      { action_id: "ACT-3", state: "failed", reason: "stale_authority", attempts: 0 },
    ]);
    expect(
      await rows(stack.observer, "SELECT state, reason, owner FROM app.supplier_case"),
    ).toEqual([{ state: "partially_applied", reason: "stale_authority", owner: "buyer" }]);
    expect(
      await rows(
        stack.observer,
        "SELECT status, invalidated_reason FROM app.case_decision WHERE kind = 'approval' AND outcome = 'accepted'",
      ),
    ).toEqual([{ status: "stale", invalidated_reason: "stale_authority" }]);
    expect(await lockWaiters(stack)).toBe(0);
  });
});
