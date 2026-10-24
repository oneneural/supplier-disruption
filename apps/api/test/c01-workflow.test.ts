// End to end: the canonical C-01 case through the API and the real
// worker process, from a stored supplier message to `plan_verified`, on a
// disposable database. Duplicate ingest (N-01) and the buyer over the limit
// (N-05 a) are steps of the same flow. Expected values are frozen-oracle
// literals; source records are observed with raw SQL on a migrator connection.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MSG_0001,
  ORG_NDL,
  TestWorker,
  call,
  rows,
  sourceEffects,
  startCaseStack,
  waitForState,
  type CaseStack,
} from "./case-support.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";

const db = new DisposableDatabase("c01");
const worker = new TestWorker();
let stack: CaseStack;
let caseId: string;
let planSha256: string;

beforeAll(
  async () => {
    await db.start();
    stack = await startCaseStack(db);
    await worker.start(db, stack.baseUrl);
  },
  START_TIMEOUT_MS + 3 * COMPOSE_TIMEOUT_MS,
);

afterAll(async () => {
  await worker.stop();
  await stack?.close();
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

const NO_EFFECTS = { purchasing: 0, inventory: 0, requests: 0, po_revision: 3, wh_b: "INV-B@1" };
const SCHEDULE = [
  { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
  { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
];

describe("C-01 durable case workflow", () => {
  it("ingests MSG-0001 once and assesses it; a second delivery is a duplicate with no new record", async () => {
    const first = randomUUID();
    const ingest = (deliveryId: string) =>
      call(stack, stack.buyer, "POST", "/api/cases/ingest", {
        organizationId: ORG_NDL,
        deliveryId,
        ...MSG_0001,
      });
    const created = await ingest(first);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      disposition: "accept",
      caseRef: "CASE-1",
      state: "awaiting_approval",
    });
    caseId = created.body.caseId as string;

    const duplicate = await ingest(randomUUID());
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ disposition: "duplicate", caseId });
    const replay = await ingest(first);
    expect(replay.body).toMatchObject({ disposition: "accept", caseId, replayed: true });

    expect(await rows(stack.observer, "SELECT count(*)::int AS n FROM app.supplier_case")).toEqual([
      { n: 1 },
    ]);
    expect(await rows(stack.observer, "SELECT plan_id, plan_version FROM app.case_plan")).toEqual([
      { plan_id: "PLAN-1", plan_version: 1 },
    ]);
    // Both deliveries are stored with their exact bytes and digests.
    const messages = await rows<{ disposition: string; ok: boolean }>(
      stack.observer,
      `SELECT disposition, encode(sha256(content), 'hex') = content_sha256 AS ok
         FROM app.supplier_message ORDER BY received_at, disposition`,
    );
    expect(messages.map((message) => message.disposition).sort()).toEqual(["accept", "duplicate"]);
    expect(messages.every((message) => message.ok)).toBe(true);
    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);

    const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
    const plan = detail.plan as { sha256: string; payload: Record<string, unknown> };
    planSha256 = plan.sha256;
    const payload = plan.payload as {
      allocations: unknown[];
      actions: Array<{ actionId: string; kind: string }>;
      authorization: { cost: unknown };
      gaps: unknown[];
    };
    expect(payload.allocations).toEqual([
      {
        demandLine: { salesOrder: "SO-201", line: "10" },
        stage: "pre_transfer",
        supply: { kind: "stock", warehouse: "WH-A", stockVersion: "INV-A@1" },
        quantity: "30",
        uom: "EA",
      },
      {
        demandLine: { salesOrder: "SO-201", line: "10" },
        stage: "pre_transfer",
        supply: {
          kind: "po_segment",
          poNumber: "PO-120",
          revision: "3",
          poLine: "10",
          sequence: 1,
          projection: "proposed",
        },
        quantity: "40",
        uom: "EA",
      },
      {
        demandLine: { salesOrder: "SO-202", line: "10" },
        stage: "conditional_transfer",
        supply: { kind: "transfer_option", optionId: "TRO-1", basedOn: "INV-B@1" },
        quantity: "50",
        uom: "EA",
      },
    ]);
    expect(payload.actions.map((action) => [action.actionId, action.kind])).toEqual([
      ["ACT-1", "amend_schedule"],
      ["ACT-2", "reserve"],
      ["ACT-3", "create_transfer_request"],
    ]);
    expect(payload.authorization.cost).toEqual({ minorUnits: 16_000, currency: "EUR" });
    const impact = detail.impact as { totals: Record<string, unknown> };
    expect(impact.totals).toMatchObject({
      preTransferCoverage: { state: "known", value: "70" },
      preTransferShortage: { state: "known", value: "50" },
      conditionalTransfer: { state: "known", value: "50" },
      conditionalShortage: { state: "known", value: "0" },
    });
  });

  it("lists only the caller's simulated actors and records a note without changing the case", async () => {
    const actors = await call(
      stack,
      stack.buyer,
      "GET",
      `/api/cases/actors?organizationId=${ORG_NDL}`,
    );
    expect(actors.status).toBe(200);
    expect(actors.body.actors).toEqual([
      { actorId: "buyer-1", role: "buyer", vendorId: null, simulated: true },
      { actorId: "cs-1", role: "customer_service_owner", vendorId: null, simulated: true },
      { actorId: "supplier-1", role: "supplier_contact", vendorId: "V-100", simulated: true },
    ]);

    const note = await call(stack, stack.buyer, "POST", `/api/cases/${caseId}/notes`, {
      actorId: "buyer-1",
      field: "segments[1].arrival",
      note: "Can the second segment arrive earlier?",
    });
    expect(note.status).toBe(201);
    expect(note.body).toEqual({ recorded: "note", state: "awaiting_approval" });
    // A note is never a way to act as another user's actor.
    const borrowed = await call(stack, stack.buyer, "POST", `/api/cases/${caseId}/notes`, {
      actorId: "manager-1",
      note: "Quantity is wrong",
    });
    expect(borrowed.status).toBe(403);
    expect(
      await rows(
        stack.observer,
        "SELECT kind, actor_id, detail->>'note' AS note FROM app.case_event WHERE kind = 'note'",
      ),
    ).toEqual([
      { kind: "note", actor_id: "buyer-1", note: "Can the second segment arrive earlier?" },
    ]);
    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
  });

  it("rejects the buyer's approval of EUR 160 over the EUR 100 limit before any effect", async () => {
    const refused = await call(stack, stack.buyer, "POST", `/api/cases/${caseId}/decisions`, {
      actorId: "buyer-1",
      decision: "approve",
      planSha256,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      error: "over_approval_limit",
      state: "awaiting_approval",
    });
    // The buyer account cannot act as the manager either.
    const impersonation = await call(stack, stack.buyer, "POST", `/api/cases/${caseId}/decisions`, {
      actorId: "manager-1",
      decision: "approve",
      planSha256,
    });
    expect(impersonation.status).toBe(403);
    expect(
      await rows(
        stack.observer,
        "SELECT actor_id, outcome, reason, status FROM app.case_decision ORDER BY occurred_at",
      ),
    ).toEqual([
      { actor_id: "buyer-1", outcome: "rejected", reason: "over_approval_limit", status: "void" },
    ]);
    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
  });

  it("applies the manager-approved, acknowledged plan in the worker and verifies it by read-back", async () => {
    const approved = await call(stack, stack.manager, "POST", `/api/cases/${caseId}/decisions`, {
      actorId: "manager-1",
      decision: "approve",
      planSha256,
    });
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ state: "awaiting_acknowledgement" });

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
    expect(confirmed.body).toMatchObject({
      outcome: "accepted",
      state: "awaiting_acknowledgement",
    });
    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);

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

    const detail = await waitForState(stack, stack.buyer, caseId, "plan_verified");

    // ACT-1: PO-120 revision 4 with the two segments; received and canceled unchanged.
    expect(
      await rows(
        stack.observer,
        `SELECT s.revision, s.sequence, s.quantity::text AS quantity, s.arrival_date::text AS arrival
           FROM fixture_purchasing.po_line_segment s
          WHERE s.po_number = 'PO-120' AND s.line_number = '10' ORDER BY s.revision, s.sequence`,
      ),
    ).toEqual([
      { revision: 3, sequence: 1, quantity: "120", arrival: "2026-10-23" },
      { revision: 4, sequence: 1, quantity: "40", arrival: "2026-10-23" },
      { revision: 4, sequence: 2, quantity: "80", arrival: "2026-10-26" },
    ]);
    expect(
      await rows(
        stack.observer,
        `SELECT revision, received::text AS received, canceled::text AS canceled
           FROM fixture_purchasing.po_line WHERE po_number = 'PO-120' ORDER BY revision`,
      ),
    ).toEqual([
      { revision: 3, received: "0", canceled: "0" },
      { revision: 4, received: "0", canceled: "0" },
    ]);

    // ACT-2: one new 50 EA reservation for PLAN-1 at WH-B; RES-B-31 unchanged; physical 70.
    const [head] = await rows<{ version: string }>(
      stack.observer,
      "SELECT version FROM fixture_inventory.stock_head WHERE warehouse = 'WH-B'",
    );
    expect(head?.version).toBe("INV-B@1.ACT-2");
    const reservations = await rows<{
      reservation_id: string;
      quantity: string;
      plan_id: string | null;
    }>(
      stack.observer,
      `SELECT reservation_id, quantity::text AS quantity, plan_id FROM fixture_inventory.reservation
        WHERE snapshot_version = 'INV-B@1.ACT-2' ORDER BY plan_id NULLS FIRST`,
    );
    expect(reservations.map(({ quantity, plan_id }) => ({ quantity, plan_id }))).toEqual([
      { quantity: "20", plan_id: null },
      { quantity: "50", plan_id: "PLAN-1" },
    ]);
    expect(reservations[0]?.reservation_id).toBe("RES-B-31");
    const planReservation = reservations[1]?.reservation_id;
    expect(
      await rows(
        stack.observer,
        `SELECT warehouse, version, physical::text AS physical FROM fixture_inventory.stock_snapshot
          WHERE version IN ('INV-A@1', 'INV-B@1.ACT-2') ORDER BY warehouse`,
      ),
    ).toEqual([
      { warehouse: "WH-A", version: "INV-A@1", physical: "40" },
      { warehouse: "WH-B", version: "INV-B@1.ACT-2", physical: "70" },
    ]);

    // ACT-3: one requested transfer of 50 EA from WH-B to WH-A arriving 2026-10-23, on that reservation.
    expect(
      await rows(
        stack.observer,
        `SELECT from_warehouse, to_warehouse, quantity::text AS quantity, arrival_date::text AS arrival,
                status, plan_id, reservation_id FROM fixture_inventory.transfer_request`,
      ),
    ).toEqual([
      {
        from_warehouse: "WH-B",
        to_warehouse: "WH-A",
        quantity: "50",
        arrival: "2026-10-23",
        status: "requested",
        plan_id: "PLAN-1",
        reservation_id: planReservation,
      },
    ]);
    // Each operation ID produced exactly one effect; demand and WH-A are untouched.
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
        `SELECT (SELECT version FROM fixture_demand.demand_head) AS demand,
                (SELECT version FROM fixture_inventory.stock_head WHERE warehouse = 'WH-A') AS wh_a,
                (SELECT string_agg(reservation_id || ':' || quantity::text, ',')
                   FROM fixture_inventory.reservation WHERE snapshot_version = 'INV-A@1') AS wh_a_reservations`,
      ),
    ).toEqual([{ demand: "DEM@1", wh_a: "INV-A@1", wh_a_reservations: "RES-A-77:10" }]);

    // The application's own records: every action confirmed, every check matched.
    const actions = detail.actions as Array<{ actionId: string; state: string; attempts: number }>;
    expect(actions.map(({ actionId, state, attempts }) => [actionId, state, attempts])).toEqual([
      ["ACT-1", "confirmed", 1],
      ["ACT-2", "confirmed", 1],
      ["ACT-3", "confirmed", 1],
    ]);
    const verification = detail.verification as {
      checks: Array<{ check: string; ok: boolean }>;
      missing: string[];
      planningReferences: unknown[];
      physicalDelivery: Record<string, unknown>;
    };
    expect(verification.missing).toEqual([]);
    expect(verification.checks.filter((check) => !check.ok)).toEqual([]);
    expect(verification.planningReferences).toEqual([
      {
        demandLine: "SO-201/10",
        supply: { kind: "stock", warehouse: "WH-A" },
        quantity: "30",
      },
      {
        demandLine: "SO-201/10",
        supply: {
          kind: "po_segment",
          poNumber: "PO-120",
          revision: "4",
          poLine: "10",
          sequence: 1,
        },
        quantity: "40",
      },
      {
        demandLine: "SO-202/10",
        supply: {
          kind: "transfer_request",
          transferRequestId: expect.stringMatching(/^TRQ-/) as unknown,
          reservationId: planReservation,
        },
        quantity: "50",
      },
    ]);
    expect(verification.physicalDelivery).toMatchObject({
      supplierReceipt: "not_recorded",
      transferReceipt: "not_recorded",
    });
    const timeline = (detail.timeline as Array<{ toState: string | null }>)
      .map((event) => event.toState)
      .filter((state) => state !== null);
    expect(timeline).toEqual([
      "received",
      "assessing",
      "awaiting_approval",
      "awaiting_acknowledgement",
      "applying",
      "verifying",
      "plan_verified",
    ]);
    const list = await call(stack, stack.buyer, "GET", `/api/cases?organizationId=${ORG_NDL}`);
    expect(list.body.cases).toEqual([
      expect.objectContaining({ caseId, state: "plan_verified", owner: "buyer" }),
    ]);
  });
});
