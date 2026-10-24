// P7 prior commitments of a verified predecessor plan (ADR 0015).
// Every input is a labeled change of the canonical C-01 literals after PLAN-1
// was applied: PO-120 at revision 4, a 50 EA PLAN-1 reservation at WH-B and
// its requested transfer. These are not frozen oracle scenarios.
import { describe, expect, it } from "vitest";
import { assessCoverage } from "../src/index.js";
import { ORG, c01Input, data, stockA, stockB, stockRead } from "./literals.js";

const known = (value: string) => ({ state: "known", value });
const segment = (sequence: number, quantity: string, date: string) => ({
  sequence,
  quantity,
  arrival: { state: "dated", date },
});

type Status = "requested" | "dispatched" | "received" | "unknown";

function commitment(status: Status, change: Record<string, unknown> = {}) {
  return {
    commitmentId: "ACT-3",
    planId: "PLAN-1",
    reservationId: "RES-P1",
    requestId: "TRQ-1",
    sku: "PART-A",
    uom: "EA",
    from: "WH-B",
    to: "WH-A",
    quantity: "50",
    arrivalDate: "2026-10-23",
    status,
    ...change,
  };
}

function commitmentsRead(records: unknown[], predecessorPlanId = "PLAN-1") {
  return {
    status: "ok",
    provenance: {
      scope: {
        owner: "inventory",
        resource: "prior_commitments",
        organization: ORG,
        selectors: { planId: predecessorPlanId },
      },
      readAt: "2026-10-21T07:00:00.000Z",
      observedAt: { state: "not_returned" },
    },
    data: { predecessorPlanId, records },
  };
}

interface PoLine {
  lineNumber: string;
  ordered: string;
  received: string;
  acceptedSegments: unknown[];
  [field: string]: unknown;
}

/**
 * MSG-0002 against the applied C-01 records: the supplier moves the second
 * segment to 2026-10-28 on revision 4. WH-B holds RES-B-31 and the PLAN-1
 * reservation in its successor version.
 */
function successor(
  records: unknown[] | null,
  options: { reservations?: unknown[]; segments?: unknown[] } = {},
) {
  const input = c01Input() as ReturnType<typeof c01Input> & {
    reads: { priorCommitments?: unknown };
  };
  input.planId = "PLAN-2";
  input.proposalId = "PROP-2";
  const supplier = data<{
    identity: Record<string, unknown>;
    terms: Record<string, unknown>;
  }>(input.reads.supplierInput);
  supplier.identity.messageId = "MSG-0002";
  supplier.identity.proposalId = "PROP-2";
  supplier.identity.evidenceRef = "MSG-0002@1";
  supplier.terms.baseRevision = "4";
  supplier.terms.segments = options.segments ?? [
    segment(1, "40", "2026-10-23"),
    segment(2, "80", "2026-10-28"),
  ];
  const po = data<{ currentRevision: string; record: { revision: string; lines: PoLine[] } }>(
    input.reads.purchaseOrder,
  );
  po.currentRevision = "4";
  po.record.revision = "4";
  po.record.lines[0]!.acceptedSegments = [
    segment(1, "40", "2026-10-23"),
    segment(2, "80", "2026-10-26"),
  ];
  const b = stockB();
  b.version = "INV-B@1.ACT-2";
  b.reservations = (options.reservations ?? [
    ...b.reservations,
    { reservationId: "RES-P1", quantity: "50", binding: { kind: "plan", planId: "PLAN-1" } },
  ]) as typeof b.reservations;
  input.reads.stock = [stockRead(stockA()), stockRead(b)];
  if (records !== null) input.reads.priorCommitments = commitmentsRead(records);
  return input;
}

describe("P7 prior commitments of a verified predecessor", () => {
  it("counts the requested PLAN-1 transfer before any new transfer and creates no new effect", () => {
    const result = assessCoverage(successor([commitment("requested")]));
    expect(result.decision).toEqual({
      recommendedState: "awaiting_approval",
      reason: "policy_plan_ready_for_approval",
      owner: "buyer",
    });
    expect(result.allocations).toEqual([
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
          revision: "4",
          poLine: "10",
          sequence: 1,
          projection: "proposed",
        },
        quantity: "40",
        uom: "EA",
      },
      {
        demandLine: { salesOrder: "SO-202", line: "10" },
        stage: "prior_commitment",
        supply: {
          kind: "prior_commitment",
          planId: "PLAN-1",
          commitmentId: "ACT-3",
          requestId: "TRQ-1",
        },
        quantity: "50",
        uom: "EA",
      },
    ]);
    // The PLAN-1 reservation is deducted once, as committed stock, never as free stock.
    expect(result.eligibility.find((entry) => entry.warehouse === "WH-B")).toMatchObject({
      state: "known",
      stockVersion: "INV-B@1.ACT-2",
      unrelatedReservations: [{ reservationId: "RES-B-31", quantity: "20" }],
      commitmentReservations: [{ reservationId: "RES-P1", planId: "PLAN-1", quantity: "50" }],
      eligible: "0",
    });
    expect(result.transferOptions.map((option) => [option.optionId, option.status])).toEqual([
      ["TRO-1", "not_needed"],
    ]);
    expect(result.totals).toMatchObject({
      preTransferCoverage: known("70"),
      preTransferShortage: known("50"),
      priorCommitment: known("50"),
      conditionalTransfer: known("0"),
      conditionalShortage: known("0"),
    });
    expect(result.shortfalls).toEqual([
      {
        stage: "pre_transfer",
        demandLine: { salesOrder: "SO-202", line: "10" },
        quantity: "50",
        uom: "EA",
        receiptCutoff: "2026-10-23",
        reason: "policy_prior_commitment_covered",
        owner: "warehouse_planner",
      },
    ]);

    // Only the schedule amendment: no second reservation or transfer request.
    const payload = result.plan?.payload;
    expect(payload?.planId).toBe("PLAN-2");
    expect(payload?.actions.map((action) => [action.actionId, action.kind])).toEqual([
      ["ACT-1", "amend_schedule"],
    ]);
    expect(payload?.actions[0]).toMatchObject({ preconditions: { expectedRevision: "4" } });
    expect(payload?.decisions).toEqual([{ kind: "approval", role: "buyer", subject: "PLAN-2" }]);
    expect(
      payload?.bindings
        .filter((binding) => binding.kind === "prior_commitments")
        .map((binding) => [binding.key, binding.members]),
    ).toEqual([["PLAN-1", ["ACT-3"]]]);
  });

  it("counts a dispatched commitment the same way, even after its reservation left the source", () => {
    const b = stockB();
    const result = assessCoverage(
      successor([commitment("dispatched")], { reservations: b.reservations }),
    );
    expect(result.decision.recommendedState).toBe("awaiting_approval");
    expect(result.totals.priorCommitment).toEqual(known("50"));
    expect(result.plan?.payload.actions.map((action) => action.kind)).toEqual(["amend_schedule"]);
  });

  it("still refuses a plan reservation that no listed commitment of the predecessor names", () => {
    const withoutRead = assessCoverage(successor(null));
    expect(withoutRead.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_plan_reservation_unsupported",
      owner: "warehouse_planner",
    });
    expect(withoutRead.plan).toBeNull();

    const b = stockB();
    const foreign = assessCoverage(
      successor([commitment("requested")], {
        reservations: [
          ...b.reservations,
          { reservationId: "RES-P1", quantity: "50", binding: { kind: "plan", planId: "PLAN-1" } },
          { reservationId: "RES-P9", quantity: "5", binding: { kind: "plan", planId: "PLAN-9" } },
        ],
      }),
    );
    expect(foreign.decision.reason).toBe("policy_plan_reservation_unsupported");
    expect(foreign.plan).toBeNull();

    const otherPlan = assessCoverage(successor([commitment("requested", { planId: "PLAN-9" })]));
    expect(otherPlan.decision.reason).toBe("policy_prior_commitment_mismatch");
    expect(otherPlan.plan).toBeNull();
  });

  it("never releases or replaces an unknown commitment", () => {
    for (const input of [
      successor([commitment("unknown")]),
      // Requested, but its reservation is no longer held at WH-B.
      successor([commitment("requested")], { reservations: stockB().reservations }),
    ]) {
      const result = assessCoverage(input);
      expect(result.decision).toEqual({
        recommendedState: "needs_clarification",
        reason: "policy_prior_commitment_unknown",
        owner: "warehouse_planner",
      });
      expect(result.allocations.some((entry) => entry.stage !== "pre_transfer")).toBe(false);
      // No new transfer is assessed against an unreconciled effect.
      expect(result.transferOptions).toEqual([]);
      expect(result.totals.priorCommitment).toEqual({ state: "unknown" });
      expect(result.totals.conditionalShortage).toEqual({ state: "unknown" });
      expect(result.plan).toBeNull();
    }
    // The unknown commitment's reservation stays deducted at WH-B.
    expect(
      assessCoverage(successor([commitment("unknown")])).eligibility.find(
        (entry) => entry.warehouse === "WH-B",
      ),
    ).toMatchObject({ eligible: "0" });
  });

  it("refuses to count a received commitment that no stock record books", () => {
    // What the system produces: a receipt observation books no stock, so the
    // PLAN-1 reservation is still held at WH-B and WH-A is still INV-A@1.
    // Counting the transfer as delivered would reopen the 50 EA gap for a
    // second transfer while the first one still holds its stock.
    for (const input of [
      successor([commitment("received")]),
      // Even with the reservation gone, WH-A shows no receipt.
      successor([commitment("received")], { reservations: stockB().reservations }),
    ]) {
      const result = assessCoverage(input);
      expect(result.decision).toEqual({
        recommendedState: "needs_clarification",
        reason: "policy_prior_commitment_unknown",
        owner: "warehouse_planner",
      });
      expect(result.transferOptions).toEqual([]);
      expect(result.totals.priorCommitment).toEqual({ state: "unknown" });
      expect(result.plan).toBeNull();
      expect(
        result.supply.find((bucket) => bucket.supply.kind === "prior_commitment"),
      ).toMatchObject({ allocated: "0", reason: "policy_prior_commitment_unknown" });
    }
    expect(
      assessCoverage(successor([commitment("received")])).eligibility.find(
        (entry) => entry.warehouse === "WH-B",
      ),
    ).toMatchObject({ eligible: "0" });
  });

  it("fails closed when the commitment's source warehouse was not read", () => {
    const input = successor([commitment("requested")]);
    input.reads.stock = [input.reads.stock[0]!];
    const result = assessCoverage(input);
    expect(result.plan).toBeNull();
    expect(result.allocations.some((entry) => entry.stage === "prior_commitment")).toBe(false);
  });

  it("carries a commitment inherited through the predecessor's own lineage", () => {
    // PLAN-3 succeeds PLAN-2, which relied on PLAN-1's transfer and made none itself.
    const input = successor(null);
    input.planId = "PLAN-3";
    const read = commitmentsRead([commitment("requested")], "PLAN-2");
    (read.data as Record<string, unknown>).inheritedPlanIds = ["PLAN-1"];
    input.reads.priorCommitments = read;
    const result = assessCoverage(input);
    expect(result.decision.recommendedState).toBe("awaiting_approval");
    expect(result.totals.priorCommitment).toEqual(known("50"));
    expect(result.plan?.payload.actions.map((action) => action.kind)).toEqual(["amend_schedule"]);

    // Without the lineage, PLAN-1's record does not belong to predecessor PLAN-2.
    const unlisted = successor(null);
    unlisted.planId = "PLAN-3";
    unlisted.reads.priorCommitments = commitmentsRead([commitment("requested")], "PLAN-2");
    expect(assessCoverage(unlisted).decision.reason).toBe("policy_prior_commitment_mismatch");
  });

  it("keeps the whole commitment and reports its surplus instead of resizing it", () => {
    const input = successor([commitment("requested")]);
    const demand = data<{ record: { lines: Array<Record<string, unknown>> } }>(input.reads.demand);
    demand.record.lines[1]!.open = "20";
    // The schedule still totals the outstanding 120.
    const result = assessCoverage(input);
    expect(result.supply.find((bucket) => bucket.supply.kind === "prior_commitment")).toMatchObject(
      {
        quantity: "50",
        allocated: "20",
        disposition: "partially_allocated",
        reason: "policy_prior_commitment_surplus",
      },
    );
    expect(result.totals.priorCommitment).toEqual(known("20"));
    expect(result.plan?.payload.actions.map((action) => action.kind)).toEqual(["amend_schedule"]);
  });

  it("uses only the selected line's outstanding quantity on a partially received multi-line PO", () => {
    const input = successor([commitment("requested")], {
      segments: [segment(1, "30", "2026-10-23"), segment(2, "70", "2026-10-28")],
    });
    const po = data<{ record: { lines: PoLine[] } }>(input.reads.purchaseOrder);
    const line10 = po.record.lines[0]!;
    line10.received = "20";
    line10.acceptedSegments = [segment(1, "30", "2026-10-23"), segment(2, "70", "2026-10-26")];
    po.record.lines.push({
      ...structuredClone(line10),
      lineNumber: "20",
      ordered: "60",
      received: "60",
      acceptedSegments: [],
    });
    const result = assessCoverage(input);

    // Line 10: 120 ordered, 20 received, so the schedule must total 100.
    expect(result.decision.recommendedState).toBe("escalated");
    expect(result.decision.reason).toBe("unresolved_shortage");
    expect(
      result.allocations.map((entry) => [entry.demandLine.salesOrder, entry.stage, entry.quantity]),
    ).toEqual([
      ["SO-201", "pre_transfer", "30"],
      ["SO-201", "pre_transfer", "30"],
      ["SO-201", "prior_commitment", "10"],
      ["SO-202", "prior_commitment", "40"],
    ]);
    const lines = new Set(
      result.supply.flatMap((bucket) =>
        bucket.supply.kind === "po_segment" ? [bucket.supply.poLine] : [],
      ),
    );
    expect([...lines]).toEqual(["10"]);
    // The leftover 10 EA would need TRO-1, which is based on the pre-reservation version.
    expect(result.transferOptions[0]).toMatchObject({ optionId: "TRO-1", status: "blocked" });
    expect(result.totals).toMatchObject({
      preTransferCoverage: known("60"),
      preTransferShortage: known("60"),
      priorCommitment: known("50"),
      conditionalTransfer: known("0"),
      conditionalShortage: known("10"),
    });

    // A changed schedule total for the partially received line is refused.
    const total = successor([commitment("requested")]);
    data<{ record: { lines: PoLine[] } }>(total.reads.purchaseOrder).record.lines[0]!.received =
      "20";
    expect(assessCoverage(total).decision.reason).toBe("policy_schedule_total_mismatch");
  });

  it("refuses a commitment for another destination or SKU", () => {
    const result = assessCoverage(successor([commitment("requested", { to: "WH-C" })]));
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_prior_commitment_mismatch",
      owner: "warehouse_planner",
    });
  });
});
