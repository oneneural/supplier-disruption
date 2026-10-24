// Focused risk paths, each on its own disposable database, with the
// application run driven directly (no worker) so the test controls each run:
// N-06 a, a foreign stock change after approval that invalidates it before
// any claim; and N-09 b, a reservation whose response is lost after commit,
// reconciled by operation ID and read-back after a restart without a
// duplicate effect. Expected values are frozen-oracle literals.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseWorkflow } from "../src/cases/workflow.js";
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

/** Ingests MSG-0001 and records the manager's approval and the planner's confirmation. */
async function approvedCase(stack: CaseStack) {
  const created = await call(stack, stack.buyer, "POST", "/api/cases/ingest", {
    organizationId: ORG_NDL,
    deliveryId: randomUUID(),
    ...MSG_0001,
  });
  expect(created.body).toMatchObject({ disposition: "accept", state: "awaiting_approval" });
  const caseId = created.body.caseId as string;
  const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
  const planSha256 = (detail.plan as { sha256: string }).sha256;
  const approved = await call(stack, stack.manager, "POST", `/api/cases/${caseId}/decisions`, {
    actorId: "manager-1",
    decision: "approve",
    planSha256,
  });
  expect(approved.status).toBe(201);
  const confirmed = await call(
    stack,
    stack.manager,
    "POST",
    `/api/cases/${caseId}/acknowledgements`,
    {
      kind: "warehouse_planner_confirmation",
      actorId: "planner-1",
      planSha256,
      optionId: "TRO-1",
      quantity: "50",
      arrivalDate: "2026-10-23",
    },
  );
  expect(confirmed.body).toMatchObject({ outcome: "accepted" });
  return caseId;
}

/** The simulated supplier acknowledgement that completes the wait. */
async function acknowledge(stack: CaseStack, caseId: string) {
  const acknowledged = await call(
    stack,
    stack.buyer,
    "POST",
    `/api/cases/${caseId}/acknowledgements`,
    {
      kind: "supplier_acknowledgement",
      actorId: "supplier-1",
      proposalId: "PROP-1",
      poNumber: "PO-120",
      poLine: "10",
      segments: SCHEDULE,
    },
  );
  expect(acknowledged.body).toMatchObject({ outcome: "accepted", state: "applying" });
}

describe("N-06 a: a newer conflicting stock version invalidates the approval", () => {
  const db = new DisposableDatabase("n06");
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

  it("rejects the claim, writes nothing, marks the approval stale and reassesses to escalation", async () => {
    const caseId = await approvedCase(stack);
    // Another actor's reservation RES-B-40 of 20 EA moves WH-B to INV-B@2 (eligible 30).
    await stack.observer.query(`
      INSERT INTO fixture_inventory.stock_snapshot
        (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
      SELECT 'INV-B@2', organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock
        FROM fixture_inventory.stock_snapshot WHERE version = 'INV-B@1';
      INSERT INTO fixture_inventory.reservation (snapshot_version, reservation_id, quantity, plan_id)
      VALUES ('INV-B@2', 'RES-B-31', 20, NULL), ('INV-B@2', 'RES-B-40', 20, NULL);
      UPDATE fixture_inventory.stock_head SET version = 'INV-B@2' WHERE warehouse = 'WH-B';`);
    await acknowledge(stack, caseId);

    expect(await stack.workflow.apply(caseId)).toEqual({ state: "escalated", retry: false });

    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 0,
      inventory: 0,
      requests: 0,
      po_revision: 3,
      wh_b: "INV-B@2",
    });
    expect(
      await rows(
        stack.observer,
        `SELECT kind, status, invalidated_reason FROM app.case_decision
          WHERE outcome = 'accepted' ORDER BY kind`,
      ),
    ).toEqual([
      { kind: "approval", status: "stale", invalidated_reason: "stale_source_stock" },
      {
        kind: "supplier_acknowledgement",
        status: "stale",
        invalidated_reason: "stale_source_stock",
      },
      {
        kind: "warehouse_planner_confirmation",
        status: "stale",
        invalidated_reason: "stale_source_stock",
      },
    ]);
    expect(
      await rows(
        stack.observer,
        "SELECT action_id, state, reason FROM app.case_action ORDER BY sequence",
      ),
    ).toEqual([
      { action_id: "ACT-1", state: "failed", reason: "stale_source_stock" },
      { action_id: "ACT-2", state: "failed", reason: "stale_source_stock" },
      { action_id: "ACT-3", state: "failed", reason: "stale_source_stock" },
    ]);

    const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
    const transitions = (
      detail.timeline as Array<{
        toState: string | null;
        reason: string | null;
        owner: string | null;
      }>
    ).filter((event) => event.toState !== null);
    expect(
      transitions.slice(-3).map(({ toState, reason, owner }) => ({ toState, reason, owner })),
    ).toEqual([
      { toState: "needs_clarification", reason: "stale_source_stock", owner: "warehouse_planner" },
      { toState: "assessing", reason: null, owner: null },
      { toState: "escalated", reason: "unresolved_shortage", owner: "buyer" },
    ]);
    // The reassessment quantifies the gap; the earlier plan is history, not current.
    expect(detail.plan).toBeNull();
    const impact = detail.impact as { shortfalls: Array<Record<string, unknown>> };
    expect(impact.shortfalls).toContainEqual(
      expect.objectContaining({
        demandLine: { salesOrder: "SO-202", line: "10" },
        quantity: "50",
        reason: "unresolved_shortage",
        owner: "buyer",
      }),
    );
    expect((detail.plans as unknown[]).length).toBe(1);
  });
});

describe("N-09 b: a reservation committed with its response lost is reconciled by read-back", () => {
  const db = new DisposableDatabase("n09");
  let stack: CaseStack;
  let lost = false;

  beforeAll(async () => {
    await db.start();
    stack = await startCaseStack(db, {
      faults: {
        afterSourceWrite({ actionId }) {
          if (actionId === "ACT-2" && !lost) {
            lost = true;
            return Promise.reject(
              new Error("simulated timeout after inventory committed the reservation"),
            );
          }
          return Promise.resolve();
        },
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.close();
    await db.remove();
    expect(await db.leftovers()).toBe("");
  }, COMPOSE_TIMEOUT_MS + MARGIN_MS);

  it("records ACT-2 unknown, then after a restart confirms it by operation ID and finishes once", async () => {
    const caseId = await approvedCase(stack);
    await acknowledge(stack, caseId);

    expect(await stack.workflow.apply(caseId)).toEqual({ state: "partially_applied", retry: true });
    expect(
      await rows(
        stack.observer,
        "SELECT action_id, state, attempts FROM app.case_action ORDER BY sequence",
      ),
    ).toEqual([
      { action_id: "ACT-1", state: "confirmed", attempts: 1 },
      { action_id: "ACT-2", state: "unknown", attempts: 1 },
      { action_id: "ACT-3", state: "authorized", attempts: 0 },
    ]);
    expect(
      await rows(stack.observer, "SELECT state, reason, owner FROM app.supplier_case"),
    ).toEqual([
      { state: "partially_applied", reason: "outcome_unknown", owner: "warehouse_planner" },
    ]);
    // The reservation exists at the source although the API never saw the response.
    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 1,
      inventory: 1,
      requests: 0,
      po_revision: 4,
      wh_b: "INV-B@1.ACT-2",
    });

    // A restarted API: a new workflow on the same records, without the fault.
    const restarted = new CaseWorkflow({ ...stack.workflow.deps, faults: {} });
    expect(await restarted.apply(caseId)).toEqual({ state: "plan_verified", retry: false });

    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 1,
      inventory: 2,
      requests: 1,
      po_revision: 4,
      wh_b: "INV-B@1.ACT-2",
    });
    expect(
      await rows(
        stack.observer,
        `SELECT count(DISTINCT reservation_id)::int AS n FROM fixture_inventory.reservation
          WHERE plan_id = 'PLAN-1'`,
      ),
    ).toEqual([{ n: 1 }]);
    // ACT-2 was never resubmitted: read-back found it.
    expect(
      await rows(
        stack.observer,
        "SELECT action_id, state, attempts FROM app.case_action ORDER BY sequence",
      ),
    ).toEqual([
      { action_id: "ACT-1", state: "confirmed", attempts: 1 },
      { action_id: "ACT-2", state: "confirmed", attempts: 1 },
      { action_id: "ACT-3", state: "confirmed", attempts: 1 },
    ]);
    const kinds = await rows<{ kind: string; to_state: string | null }>(
      stack.observer,
      "SELECT kind, to_state FROM app.case_event ORDER BY sequence",
    );
    expect(kinds.map((event) => event.kind)).toContain("action_reconciled");
    expect(
      kinds
        .filter((event) => event.to_state !== null)
        .map((event) => event.to_state)
        .slice(-4),
    ).toEqual(["partially_applied", "applying", "verifying", "plan_verified"]);
  });
});

describe("N-06 d: the approver loses authority between a lost response and its retry", () => {
  const db = new DisposableDatabase("n06d");
  let stack: CaseStack;
  let lost = false;

  beforeAll(async () => {
    await db.start();
    stack = await startCaseStack(db, {
      faults: {
        afterSourceWrite({ actionId }) {
          if (actionId === "ACT-2" && !lost) {
            lost = true;
            return Promise.reject(new Error("simulated timeout after the reservation committed"));
          }
          return Promise.resolve();
        },
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.close();
    await db.remove();
    expect(await db.leftovers()).toBe("");
  }, COMPOSE_TIMEOUT_MS + MARGIN_MS);

  it("reconciles ACT-2 by read-back but claims and writes no ACT-3, and marks the approval stale", async () => {
    const caseId = await approvedCase(stack);
    await acknowledge(stack, caseId);
    expect(await stack.workflow.apply(caseId)).toEqual({ state: "partially_applied", retry: true });

    // The approving manager's actor binding is withdrawn before the retry.
    await stack.observer.query(
      "UPDATE app.case_actor SET active = false WHERE actor_id = 'manager-1'",
    );
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });

    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 1,
      inventory: 1,
      requests: 0,
      po_revision: 4,
      wh_b: "INV-B@1.ACT-2",
    });
    expect(
      await rows(
        stack.observer,
        "SELECT action_id, state, reason, attempts FROM app.case_action ORDER BY sequence",
      ),
    ).toEqual([
      { action_id: "ACT-1", state: "confirmed", reason: null, attempts: 1 },
      { action_id: "ACT-2", state: "confirmed", reason: null, attempts: 1 },
      { action_id: "ACT-3", state: "failed", reason: "stale_authority", attempts: 0 },
    ]);
    expect(
      await rows(
        stack.observer,
        "SELECT status, invalidated_reason FROM app.case_decision WHERE kind = 'approval' AND outcome = 'accepted'",
      ),
    ).toEqual([{ status: "stale", invalidated_reason: "stale_authority" }]);
    expect(
      await rows(stack.observer, "SELECT state, reason, owner FROM app.supplier_case"),
    ).toEqual([{ state: "partially_applied", reason: "stale_authority", owner: "buyer" }]);
    // A later run changes nothing: the failed claim is final.
    expect(await stack.workflow.apply(caseId)).toEqual({
      state: "partially_applied",
      retry: false,
    });
    expect((await sourceEffects(stack.observer))?.requests).toBe(0);
  });
});
