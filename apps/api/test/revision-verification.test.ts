// End to end on a disposable database with the real worker: the
// verified C-01 plan's validity, recheck, expiry and unavailable evidence; a
// later supplier revision as a linked successor that reuses PLAN-1's
// transfer instead of reserving again; stale, conflicting and repeated
// revisions; a source change after verification; transfer observations kept
// apart from physical stock; and the linked history across an API restart.
// MSG-0002 to MSG-0004 are synthetic test inputs, not frozen oracle cases.
import { randomUUID } from "node:crypto";
import {
  DOMAIN_CONTRACT_VERSION,
  type CaseDetail,
  type SupplierProposalTerms,
} from "@supplier-disruption/contracts";
import { supplierContentSha256 } from "@supplier-disruption/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPriorCommitments } from "../src/cases/sources.js";
import { resumeInterruptedCases } from "../src/cases/workflow.js";
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

const db = new DisposableDatabase("revision");
const worker = new TestWorker();
let stack: CaseStack;
let predecessorId: string;
let predecessorSha: string;
let successorId: string;
let successorSha: string;

const SOURCE = "fixture-supplier-mail";
const segment = (sequence: number, quantity: string, date: string) => ({
  sequence,
  quantity,
  arrival: { state: "dated" as const, date },
});

/** Stores a structured supplier input as the fixture mail connector would. */
async function supplierInput(messageId: string, baseRevision: string, secondArrival: string) {
  const terms: SupplierProposalTerms = {
    poNumber: "PO-120",
    poLine: "10",
    baseRevision,
    vendorItem: "KF-A-01",
    uom: "EA",
    segments: [segment(1, "40", "2026-10-23"), segment(2, "80", secondArrival)],
    unresolvedFields: [],
  };
  await stack.workflow.sources.reference.recordSupplierInput({
    identity: {
      contractVersion: DOMAIN_CONTRACT_VERSION,
      sourceSystem: SOURCE,
      messageId,
      inputVersion: 1,
      contentSha256: supplierContentSha256(terms),
      sender: "orders@kestrel-fasteners.test",
      proposalId: `PROP-${messageId}`,
      evidenceRef: `${messageId}@1`,
      authoredAt: { state: "unknown" },
      receivedAt: { state: "unknown" },
    },
    terms,
  });
}

const ingest = (messageId: string, deliveryId: string = randomUUID()) =>
  call(stack, stack.buyer, "POST", "/api/cases/ingest", {
    organizationId: ORG_NDL,
    deliveryId,
    sourceSystem: SOURCE,
    messageId,
    inputVersion: 1,
  });

const detailOf = async (caseId: string) =>
  (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body as unknown as CaseDetail;

const recheck = (caseId: string, account: string, actorId: string) =>
  call(stack, account, "POST", `/api/cases/${caseId}/verifications`, { actorId });

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

describe("verified-plan freshness and later supplier revisions", () => {
  it("verifies C-01 and reports its verification as current until the four-hour limit", async () => {
    const created = await call(stack, stack.buyer, "POST", "/api/cases/ingest", {
      organizationId: ORG_NDL,
      deliveryId: randomUUID(),
      ...MSG_0001,
    });
    expect(created.body).toMatchObject({ caseRef: "CASE-1", state: "awaiting_approval" });
    predecessorId = created.body.caseId as string;
    predecessorSha = (await detailOf(predecessorId)).plan?.sha256 as string;
    const decide = (path: string, account: string, body: Record<string, unknown>) =>
      call(stack, account, "POST", `/api/cases/${predecessorId}/${path}`, body);
    expect(
      (
        await decide("decisions", stack.manager, {
          actorId: "manager-1",
          decision: "approve",
          planSha256: predecessorSha,
        })
      ).status,
    ).toBe(201);
    await decide("acknowledgements", stack.manager, {
      kind: "warehouse_planner_confirmation",
      actorId: "planner-1",
      planSha256: predecessorSha,
      optionId: "TRO-1",
      quantity: "50",
      arrivalDate: "2026-10-23",
    });
    await decide("acknowledgements", stack.buyer, {
      kind: "supplier_acknowledgement",
      actorId: "supplier-1",
      proposalId: "PROP-1",
      poNumber: "PO-120",
      poLine: "10",
      segments: [segment(1, "40", "2026-10-23"), segment(2, "80", "2026-10-26")],
    });
    const detail = await waitForState(stack, stack.buyer, predecessorId, "plan_verified");
    // The business clock stands at 2026-10-21T07:00Z; VERIFY-1@1 adds four hours.
    expect(detail.verificationStatus).toMatchObject({
      status: "current",
      currentUntil: "2026-10-21T11:00:00.000Z",
      lastVerified: { outcome: "verified", recheck: false, planSha256: predecessorSha },
    });
  });

  it("expires after four hours, records unavailable evidence apart from a mismatch, and renews on a matching recheck", async () => {
    // A customer service owner cannot ask for a recheck.
    expect((await recheck(predecessorId, stack.buyer, "cs-1")).status).toBe(403);
    const renewed = await recheck(predecessorId, stack.buyer, "buyer-1");
    expect(renewed.body).toEqual({
      outcome: "verified",
      state: "plan_verified",
      validUntil: "2026-10-21T11:00:00.000Z",
    });

    await stack.observer.query(
      "UPDATE fixture_reference.business_clock SET instant = '2026-10-21T11:00:00Z'",
    );
    const expired = await detailOf(predecessorId);
    expect(expired.case).toMatchObject({
      state: "plan_verified",
      nextAction:
        "Verification expired at 2026-10-21T11:00:00.000Z; recheck the source records before relying on this plan",
    });
    expect(expired.verificationStatus).toMatchObject({
      status: "expired",
      currentUntil: null,
      lastVerified: { outcome: "verified", validUntil: "2026-10-21T11:00:00.000Z" },
    });

    // The demand source cannot be read: an unavailable attempt, not a mismatch.
    await stack.observer.query("REVOKE SELECT ON fixture_demand.demand_head FROM sd_api");
    try {
      const unreadable = await recheck(predecessorId, stack.manager, "planner-1");
      expect(unreadable.body).toMatchObject({ outcome: "unavailable", state: "plan_verified" });
    } finally {
      await stack.observer.query("GRANT SELECT ON fixture_demand.demand_head TO sd_api");
    }
    const unavailable = await detailOf(predecessorId);
    expect(unavailable.case.state).toBe("plan_verified");
    expect(unavailable.verificationStatus).toMatchObject({
      status: "unavailable",
      lastAttempt: { outcome: "unavailable", actorId: "planner-1", recheck: true },
      lastVerified: { outcome: "verified", validUntil: "2026-10-21T11:00:00.000Z" },
    });

    const again = await recheck(predecessorId, stack.manager, "planner-1");
    expect(again.body).toEqual({
      outcome: "verified",
      state: "plan_verified",
      validUntil: "2026-10-21T15:00:00.000Z",
    });
    const current = await detailOf(predecessorId);
    expect(current.verificationStatus.status).toBe("current");
    expect(
      (current.verificationStatus.history as Array<{ outcome: string }>).map(
        (entry) => entry.outcome,
      ),
    ).toEqual(["verified", "verified", "unavailable", "verified"]);
    expect(current.case.nextAction).toBe(
      "Plan verified in the records; physical receipt has not happened",
    );
  });

  it("rejects an out-of-order revision without touching the verified case", async () => {
    await supplierInput("MSG-0003", "3", "2026-10-27");
    const stale = await ingest("MSG-0003");
    expect(stale.body).toMatchObject({
      disposition: "blocked",
      reason: "stale_base_revision",
      caseRef: "CASE-2",
    });
    expect((await detailOf(predecessorId)).case.state).toBe("plan_verified");
    expect(
      await rows(
        stack.observer,
        "SELECT count(*)::int AS n FROM app.supplier_case WHERE predecessor_case_id IS NOT NULL",
      ),
    ).toEqual([{ n: 0 }]);
  });

  it("opens a linked successor for a later valid revision that reuses PLAN-1's transfer and no approval", async () => {
    await supplierInput("MSG-0002", "4", "2026-10-28");
    const before = await sourceEffects(stack.observer);
    const created = await ingest("MSG-0002");
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      disposition: "accept",
      caseRef: "CASE-3",
      state: "awaiting_approval",
    });
    successorId = created.body.caseId as string;

    const predecessor = await detailOf(predecessorId);
    expect(predecessor.case).toMatchObject({
      state: "superseded",
      reason: "later_supplier_revision",
      nextAction: "Follow the successor case",
    });
    expect(predecessor.lineage).toMatchObject({
      predecessor: null,
      successor: { caseId: successorId, caseRef: "CASE-3", state: "awaiting_approval" },
    });
    // The verified evidence, plan, decisions and actions stay exactly as they were.
    expect(predecessor.plan?.sha256).toBe(predecessorSha);
    expect(predecessor.verificationStatus).toMatchObject({
      status: "superseded",
      lastVerified: { outcome: "verified", validUntil: "2026-10-21T15:00:00.000Z" },
    });
    expect(
      (predecessor.actions as Array<{ actionId: string; state: string }>).map(
        ({ actionId, state }) => [actionId, state],
      ),
    ).toEqual([
      ["ACT-1", "confirmed"],
      ["ACT-2", "confirmed"],
      ["ACT-3", "confirmed"],
    ]);
    expect(
      (predecessor.decisions as Array<{ kind: string; status: string }>).map(({ kind, status }) => [
        kind,
        status,
      ]),
    ).toEqual([
      ["approval", "current"],
      ["warehouse_planner_confirmation", "current"],
      ["supplier_acknowledgement", "current"],
    ]);

    const successor = await detailOf(successorId);
    successorSha = successor.plan?.sha256 ?? "";
    expect(successorSha).not.toBe(predecessorSha);
    expect(successor.lineage.predecessor).toMatchObject({
      caseId: predecessorId,
      caseRef: "CASE-1",
      state: "superseded",
      planId: "PLAN-1",
      planSha256: predecessorSha,
    });
    const payload = successor.plan?.payload as unknown as {
      planId: string;
      allocations: Array<{ demandLine: { salesOrder: string }; stage: string; quantity: string }>;
      actions: Array<{ actionId: string; kind: string }>;
      decisions: unknown[];
    };
    expect(payload.planId).toBe("PLAN-3");
    expect(
      payload.allocations.map((entry) => [
        entry.demandLine.salesOrder,
        entry.stage,
        entry.quantity,
      ]),
    ).toEqual([
      ["SO-201", "pre_transfer", "30"],
      ["SO-201", "pre_transfer", "40"],
      ["SO-202", "prior_commitment", "50"],
    ]);
    expect(payload.actions.map((action) => [action.actionId, action.kind])).toEqual([
      ["ACT-1", "amend_schedule"],
    ]);
    expect(payload.decisions).toEqual([{ kind: "approval", role: "buyer", subject: "PLAN-3" }]);

    // PLAN-1's approval authorizes nothing on the successor or the superseded case.
    const reused = await call(stack, stack.manager, "POST", `/api/cases/${successorId}/decisions`, {
      actorId: "manager-1",
      decision: "approve",
      planSha256: predecessorSha,
    });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ error: "plan_mismatch" });
    const closed = await call(
      stack,
      stack.manager,
      "POST",
      `/api/cases/${predecessorId}/decisions`,
      {
        actorId: "manager-1",
        decision: "approve",
        planSha256: predecessorSha,
      },
    );
    expect(closed.body).toMatchObject({ error: "invalid_case_state" });
    expect(await sourceEffects(stack.observer)).toEqual(before);
  });

  it("refuses a conflicting revision while the successor is open and treats a repeat as a duplicate", async () => {
    await supplierInput("MSG-0004", "4", "2026-10-29");
    const conflict = await ingest("MSG-0004");
    expect(conflict.body).toMatchObject({
      disposition: "blocked",
      reason: "revision_conflict",
      caseRef: "CASE-4",
      state: "needs_clarification",
    });
    const conflicted = await detailOf(conflict.body.caseId as string);
    expect(conflicted.lineage).toEqual({ predecessor: null, successor: null });
    expect(conflicted.plan).toBeNull();

    const repeat = await ingest("MSG-0002");
    expect(repeat.body).toMatchObject({ disposition: "duplicate", caseId: successorId });
    expect(
      await rows(
        stack.observer,
        `SELECT case_number, state, predecessor_case_id IS NOT NULL AS linked
           FROM app.supplier_case ORDER BY case_number`,
      ),
    ).toEqual([
      { case_number: 1, state: "superseded", linked: false },
      { case_number: 2, state: "needs_clarification", linked: false },
      { case_number: 3, state: "awaiting_approval", linked: true },
      { case_number: 4, state: "needs_clarification", linked: false },
    ]);
  });

  it("applies only the successor's amendment, with no second reservation or transfer, and verifies the prior commitment", async () => {
    const approved = await call(stack, stack.buyer, "POST", `/api/cases/${successorId}/decisions`, {
      actorId: "buyer-1",
      decision: "approve",
      planSha256: successorSha,
    });
    expect(approved.status).toBe(201);
    const detail = await waitForState(stack, stack.buyer, successorId, "plan_verified");
    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 2,
      inventory: 2,
      requests: 1,
      po_revision: 5,
      wh_b: "INV-B@1.ACT-2",
    });
    expect(
      await rows(
        stack.observer,
        `SELECT plan_id, quantity::text AS quantity FROM fixture_inventory.reservation
          WHERE snapshot_version = 'INV-B@1.ACT-2' ORDER BY plan_id NULLS FIRST`,
      ),
    ).toEqual([
      { plan_id: null, quantity: "20" },
      { plan_id: "PLAN-1", quantity: "50" },
    ]);
    const verification = detail.verification as {
      checks: Array<{ check: string; ok: boolean }>;
      planningReferences: Array<{ supply: Record<string, unknown> }>;
    };
    expect(verification.checks.filter((check) => !check.ok)).toEqual([]);
    expect(verification.planningReferences.map((reference) => reference.supply)).toContainEqual({
      kind: "prior_commitment",
      planId: "PLAN-1",
      commitmentId: "ACT-3",
      transferRequestId: expect.stringMatching(/^TRQ-/) as unknown,
      status: "requested",
    });
    expect(detail.verificationStatus).toMatchObject({
      status: "current",
      currentUntil: "2026-10-21T15:00:00.000Z",
    });
  });

  it("makes current success disappear after a source change while the verified evidence stays", async () => {
    // A simulated foreign change: the ERP moves PO-120 to revision 6 with the same schedule.
    await stack.workflow.sources.purchasing.amendSchedule({
      contractVersion: DOMAIN_CONTRACT_VERSION,
      kind: "amend_schedule",
      organization: "ORG-NDL",
      operationId: "ERP-FOREIGN-1",
      poNumber: "PO-120",
      poLine: "10",
      uom: "EA",
      expectedRevision: "5",
      planId: "ERP-FOREIGN",
      actionId: "ERP-1",
      segments: [segment(1, "40", "2026-10-23"), segment(2, "80", "2026-10-28")],
    });
    const checked = await recheck(successorId, stack.buyer, "buyer-1");
    expect(checked.body).toEqual({
      outcome: "verification_mismatch",
      state: "partially_applied",
      validUntil: null,
    });
    const detail = await detailOf(successorId);
    expect(detail.case).toMatchObject({ state: "partially_applied", owner: "warehouse_planner" });
    expect(detail.verificationStatus).toMatchObject({
      status: "mismatch",
      currentUntil: null,
      lastAttempt: { outcome: "verification_mismatch", failedChecks: ["ACT-1.current_revision"] },
      lastVerified: { outcome: "verified", validUntil: "2026-10-21T15:00:00.000Z" },
    });
    // A later recheck still sees the change: nothing was written to hide it.
    const still = await recheck(successorId, stack.buyer, "buyer-1");
    expect(still.body).toMatchObject({ outcome: "verification_mismatch" });
    expect((await sourceEffects(stack.observer))?.po_revision).toBe(6);
  });

  it("keeps dispatch and receipt observations apart from requests, inbound and physical stock", async () => {
    const records = () =>
      rows(
        stack.observer,
        `SELECT (SELECT string_agg(s.warehouse || ':' || version || ':' || physical::text, ',' ORDER BY s.warehouse)
                   FROM fixture_inventory.stock_snapshot s
                   JOIN fixture_inventory.stock_head h USING (version)) AS stock,
                (SELECT string_agg(request_id || ':' || status || ':' || quantity::text, ',')
                   FROM fixture_inventory.transfer_request) AS requests,
                (SELECT count(*)::int FROM fixture_inventory.in_transit) AS in_transit,
                (SELECT string_agg(revision::text || ':' || quantity::text, ',' ORDER BY revision, sequence)
                   FROM fixture_purchasing.po_line_segment WHERE po_number = 'PO-120') AS inbound`,
      );
    const [request] = await rows<{ request_id: string }>(
      stack.observer,
      "SELECT request_id FROM fixture_inventory.transfer_request",
    );
    const requestId = request?.request_id ?? "";
    const plan = (await detailOf(predecessorId)).plan as {
      planId: string;
    };
    const [reservation] = await rows<{ reservation_id: string }>(
      stack.observer,
      "SELECT reservation_id FROM fixture_inventory.transfer_request",
    );
    const commitment = {
      planId: plan.planId,
      inheritedPlanIds: [],
      transfers: [
        {
          planId: plan.planId,
          commitmentId: "ACT-3",
          operationId: (
            await rows<{ operation_id: string }>(
              stack.observer,
              `SELECT operation_id FROM app.case_action WHERE case_id = $1 AND action_id = 'ACT-3'`,
              [predecessorId],
            )
          )[0]!.operation_id,
          reservationId: reservation!.reservation_id,
          sku: "PART-A",
          uom: "EA",
          from: "WH-B",
          to: "WH-A",
          quantity: "50",
          arrivalDate: "2026-10-23",
        },
      ],
    };
    const status = async () => {
      const read = await readPriorCommitments(
        stack.workflow.sources,
        commitment,
        "2026-10-21T11:00:00.000Z",
      );
      expect(read.status).toBe("ok");
      return (read as { data: { records: Array<{ status: string }> } }).data.records[0]?.status;
    };
    const baseline = await records();
    expect(await status()).toBe("requested");

    const observe = (kind: string, observedOn: string) =>
      stack.observer.query(
        `INSERT INTO fixture_inventory.transfer_observation
           (observation_id, organization, request_id, kind, quantity, observed_on, recorded_at)
         VALUES ($1, 'ORG-NDL', $2, $3, 50, $4, '2026-10-21T11:00:00Z')`,
        [`OBS-${kind}`, requestId, kind, observedOn],
      );
    await observe("dispatched", "2026-10-22");
    expect(await status()).toBe("dispatched");
    expect(await records()).toEqual(baseline);
    await observe("received", "2026-10-23");
    expect(await status()).toBe("received");
    // A receipt observation is evidence only: no stock version, request or inbound line changes.
    expect(await records()).toEqual(baseline);
    // The successor counted that transfer as committed. Booked nowhere, the
    // receipt no longer holds as a commitment, so its read-back reference fails.
    const rechecked = await recheck(successorId, stack.buyer, "buyer-1");
    expect(rechecked.body).toMatchObject({ outcome: "planning_reference_mismatch" });
    expect((await detailOf(successorId)).verificationStatus.lastAttempt).toMatchObject({
      outcome: "planning_reference_mismatch",
      failedChecks: expect.arrayContaining([
        "ACT-1.current_revision",
        "reference.SO-202/10.prior_commitment.ACT-3",
      ]) as unknown,
    });
    // The API can read observations but never write them.
    await expect(
      stack.observer.query(
        "SELECT has_table_privilege('sd_api', 'fixture_inventory.transfer_observation', 'INSERT') AS insert",
      ),
    ).resolves.toMatchObject({ rows: [{ insert: false }] });
  });

  it("keeps one linked history across an API restart and a repeated delivery", async () => {
    await stack.stopApi();
    await stack.startApi();
    // No case waits on a job: superseded, mismatched and blocked cases wait on people.
    expect(await resumeInterruptedCases(stack.db, stack.boss)).toEqual([]);
    const predecessor = await detailOf(predecessorId);
    const successor = await detailOf(successorId);
    expect(predecessor.lineage.successor).toMatchObject({ caseId: successorId });
    expect(successor.lineage.predecessor).toMatchObject({ caseId: predecessorId });
    expect(predecessor.verificationStatus.lastVerified).toMatchObject({ outcome: "verified" });
    expect(successor.verificationStatus.status).toBe("mismatch");
    const repeat = await ingest("MSG-0002");
    expect(repeat.body).toMatchObject({ disposition: "duplicate", caseId: successorId });
    expect(
      await rows(
        stack.observer,
        `SELECT c.case_number, p.plan_id, count(a.*)::int AS actions
           FROM app.supplier_case c JOIN app.case_plan p ON p.id = c.current_plan_id
           LEFT JOIN app.case_action a ON a.plan_row_id = p.id
          GROUP BY c.case_number, p.plan_id ORDER BY c.case_number`,
      ),
    ).toEqual([
      { case_number: 1, plan_id: "PLAN-1", actions: 3 },
      { case_number: 3, plan_id: "PLAN-3", actions: 1 },
    ]);
  });

  it("marks a record missing on recheck as uncertain, so no later read can restore the plan", async () => {
    const [operation] = await rows<{ operation_id: string }>(
      stack.observer,
      "SELECT operation_id FROM app.case_action WHERE case_id = $1 AND action_id = 'ACT-1'",
      [successorId],
    );
    const operationId = operation?.operation_id ?? "";
    // Point ACT-1's journal entry at an operation ID the ERP has no record
    // of, as a lost record would read; the source itself is not touched.
    const move = (from: string, to: string) =>
      stack.observer.query(
        "UPDATE app.case_action SET operation_id = $2 WHERE case_id = $3 AND operation_id = $1",
        [from, to, successorId],
      );
    await move(operationId, `${operationId}-hidden`);
    try {
      const missing = await recheck(successorId, stack.buyer, "buyer-1");
      expect(missing.body).toEqual({
        outcome: "verification_missing_record",
        state: "partially_applied",
        validUntil: null,
      });
    } finally {
      await move(`${operationId}-hidden`, operationId);
    }
    const detail = await detailOf(successorId);
    expect(detail.case.reason).toBe("verification_missing_record");
    expect(
      detail.actions
        .filter((action) => action.planSha256 === successorSha)
        .map(({ actionId, state, reason }) => [actionId, state, reason]),
    ).toEqual([["ACT-1", "unknown", "verification_missing_record"]]);
    expect(detail.verificationStatus.recheckable).toBe(false);
    // The record is back, but the action stays uncertain until it is reconciled.
    const refused = await recheck(successorId, stack.buyer, "buyer-1");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "invalid_case_state" });
    expect((await detailOf(successorId)).case.state).toBe("partially_applied");
  });
});
