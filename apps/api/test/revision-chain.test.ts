// Consecutive revisions on a disposable database with the real worker
// (ADR 0015): a second later revision inherits PLAN-1's transfer through its
// verified predecessor instead of dead-ending, and an approved successor
// whose inherited commitment stops holding is refused at its claim. MSG-0002
// and MSG-0003 are synthetic test inputs, not frozen oracle cases.
import { randomUUID } from "node:crypto";
import {
  DOMAIN_CONTRACT_VERSION,
  type CaseDetail,
  type SupplierProposalTerms,
} from "@supplier-disruption/contracts";
import { supplierContentSha256 } from "@supplier-disruption/db";
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

const db = new DisposableDatabase("chain");
const worker = new TestWorker();
let stack: CaseStack;
const cases = { first: "", second: "", third: "" };

const SOURCE = "fixture-supplier-mail";
const segment = (sequence: number, quantity: string, date: string) => ({
  sequence,
  quantity,
  arrival: { state: "dated" as const, date },
});

/** Stores and ingests a later revision of PO-120 line 10 moving the 80 EA. */
async function revise(messageId: string, baseRevision: string, secondArrival: string) {
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
  return call(stack, stack.buyer, "POST", "/api/cases/ingest", {
    organizationId: ORG_NDL,
    deliveryId: randomUUID(),
    sourceSystem: SOURCE,
    messageId,
    inputVersion: 1,
  });
}

const detailOf = async (caseId: string) =>
  (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body as unknown as CaseDetail;

const counted = (detail: CaseDetail) =>
  (detail.plan?.payload.allocations ?? []).flatMap((allocation) =>
    allocation.supply.kind === "prior_commitment"
      ? [[allocation.supply.planId, allocation.supply.commitmentId, allocation.quantity]]
      : [],
  );

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

describe("consecutive supplier revisions", () => {
  it("verifies C-01 and a first successor that counts PLAN-1's transfer", async () => {
    const created = await call(stack, stack.buyer, "POST", "/api/cases/ingest", {
      organizationId: ORG_NDL,
      deliveryId: randomUUID(),
      ...MSG_0001,
    });
    cases.first = created.body.caseId as string;
    const sha = (await detailOf(cases.first)).plan?.sha256 ?? "";
    const post = (path: string, account: string, body: Record<string, unknown>) =>
      call(stack, account, "POST", `/api/cases/${cases.first}/${path}`, body);
    await post("decisions", stack.manager, {
      actorId: "manager-1",
      decision: "approve",
      planSha256: sha,
    });
    await post("acknowledgements", stack.manager, {
      kind: "warehouse_planner_confirmation",
      actorId: "planner-1",
      planSha256: sha,
      optionId: "TRO-1",
      quantity: "50",
      arrivalDate: "2026-10-23",
    });
    await post("acknowledgements", stack.buyer, {
      kind: "supplier_acknowledgement",
      actorId: "supplier-1",
      proposalId: "PROP-1",
      poNumber: "PO-120",
      poLine: "10",
      segments: [segment(1, "40", "2026-10-23"), segment(2, "80", "2026-10-26")],
    });
    await waitForState(stack, stack.buyer, cases.first, "plan_verified");

    const second = await revise("MSG-0002", "4", "2026-10-28");
    expect(second.body).toMatchObject({ disposition: "accept", state: "awaiting_approval" });
    cases.second = second.body.caseId as string;
    const detail = await detailOf(cases.second);
    expect(counted(detail)).toEqual([["PLAN-1", "ACT-3", "50"]]);
    await call(stack, stack.buyer, "POST", `/api/cases/${cases.second}/decisions`, {
      actorId: "buyer-1",
      decision: "approve",
      planSha256: detail.plan?.sha256,
    });
    await waitForState(stack, stack.buyer, cases.second, "plan_verified");
  });

  it("carries PLAN-1's transfer forward to a second successor instead of dead-ending", async () => {
    const before = await sourceEffects(stack.observer);
    const third = await revise("MSG-0003", "5", "2026-10-29");
    expect(third.status).toBe(201);
    expect(third.body).toMatchObject({ disposition: "accept", state: "awaiting_approval" });
    cases.third = third.body.caseId as string;

    const detail = await detailOf(cases.third);
    expect(detail.lineage.predecessor).toMatchObject({
      caseId: cases.second,
      state: "superseded",
      planId: "PLAN-2",
    });
    expect((await detailOf(cases.second)).case.state).toBe("superseded");
    // PLAN-3 counts PLAN-1's request, inherited through PLAN-2, and adds only ACT-1.
    expect(counted(detail)).toEqual([["PLAN-1", "ACT-3", "50"]]);
    expect(detail.plan?.payload.actions.map((action) => action.kind)).toEqual(["amend_schedule"]);
    expect(
      detail.plan?.payload.bindings
        .filter((binding) => binding.kind === "prior_commitments")
        .map((binding) => [binding.key, binding.members]),
    ).toEqual([["PLAN-2", ["ACT-3"]]]);
    expect(await sourceEffects(stack.observer)).toEqual(before);
  });

  it("refuses the approved successor at its claim once the inherited transfer stops holding", async () => {
    const [request] = await rows<{ request_id: string }>(
      stack.observer,
      "SELECT request_id FROM fixture_inventory.transfer_request",
    );
    // A dispatch of only 20 of the 50 EA: the commitment is no longer known.
    await stack.observer.query(
      `INSERT INTO fixture_inventory.transfer_observation
         (observation_id, organization, request_id, kind, quantity, observed_on, recorded_at)
       VALUES ('OBS-PARTIAL', 'ORG-NDL', $1, 'dispatched', 20, '2026-10-22', '2026-10-21T07:00:00Z')`,
      [request?.request_id],
    );
    const before = await sourceEffects(stack.observer);
    const sha = (await detailOf(cases.third)).plan?.sha256;
    const approved = await call(stack, stack.buyer, "POST", `/api/cases/${cases.third}/decisions`, {
      actorId: "buyer-1",
      decision: "approve",
      planSha256: sha,
    });
    expect(approved.status).toBe(201);

    const detail = await waitForState(stack, stack.buyer, cases.third, "needs_clarification");
    expect(detail.case).toMatchObject({
      state: "needs_clarification",
      reason: "policy_prior_commitment_unknown",
      owner: "warehouse_planner",
    });
    expect(
      (detail.timeline as Array<{ kind: string; reason: string | null }>).find(
        (event) => event.kind === "approval_invalidated",
      ),
    ).toMatchObject({ reason: "stale_prior_commitment" });
    expect(
      (detail.actions as Array<{ planSha256: string; actionId: string; state: string }>)
        .filter((action) => action.planSha256 === sha)
        .map(({ actionId, state }) => [actionId, state]),
    ).toEqual([["ACT-1", "failed"]]);
    // No schedule change, reservation, request or release happened.
    expect(await sourceEffects(stack.observer)).toEqual(before);
    expect(detail.plan).toBeNull();
    expect(
      await rows(
        stack.observer,
        `SELECT plan_id, quantity::text AS quantity FROM fixture_inventory.reservation
          WHERE plan_id IS NOT NULL`,
      ),
    ).toEqual([{ plan_id: "PLAN-1", quantity: "50" }]);
  });
});
