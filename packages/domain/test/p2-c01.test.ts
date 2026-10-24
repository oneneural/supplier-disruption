// P2 C-01 arithmetic and provenance. Expected values are literals from the
// frozen oracle's C-01 section, never computed by the code under test.
import { describe, expect, it } from "vitest";
import { assessCoverage } from "../src/index.js";
import { c01Input, data, stockA, stockB, stockRead } from "./literals.js";

const known = (value: string) => ({ state: "known", value });
const so = (salesOrder: string) => ({ salesOrder, line: "10" });
const segment = (sequence: number, projection = "proposed") => ({
  kind: "po_segment",
  poNumber: "PO-120",
  revision: "3",
  poLine: "10",
  sequence,
  projection,
});

describe("P2 C-01 arithmetic and provenance", () => {
  it("assesses PROP-1: coverage 70, shortage 50, conditional TRO-1 50, cost EUR 16000", () => {
    const result = assessCoverage(c01Input());

    expect(result.decision).toEqual({
      recommendedState: "awaiting_approval",
      reason: "policy_plan_ready_for_approval",
      owner: "procurement_manager",
    });
    expect(result.issues).toEqual([]);
    expect(result.totals).toEqual({
      uom: "EA",
      demandOpen: known("120"),
      preTransferCoverage: known("70"),
      preTransferShortage: known("50"),
      conditionalTransfer: known("50"),
      conditionalShortage: known("0"),
    });
    expect(
      result.eligibility.map((entry) => [
        entry.warehouse,
        entry.state === "known" && entry.eligible,
      ]),
    ).toEqual([
      ["WH-A", "30"],
      ["WH-B", "50"],
    ]);
    expect(result.allocations).toEqual([
      {
        demandLine: so("SO-201"),
        stage: "pre_transfer",
        supply: { kind: "stock", warehouse: "WH-A", stockVersion: "INV-A@1" },
        quantity: "30",
        uom: "EA",
      },
      {
        demandLine: so("SO-201"),
        stage: "pre_transfer",
        supply: segment(1),
        quantity: "40",
        uom: "EA",
      },
      {
        demandLine: so("SO-202"),
        stage: "conditional_transfer",
        supply: { kind: "transfer_option", optionId: "TRO-1", basedOn: "INV-B@1" },
        quantity: "50",
        uom: "EA",
      },
    ]);
    expect(
      result.demand.map((line) => [
        line.salesOrder,
        line.preTransferCovered,
        line.preTransferGap,
        line.conditionalTransfer,
        line.conditionalGap,
        line.supplyLinks,
      ]),
    ).toEqual([
      [
        "SO-201",
        known("70"),
        known("0"),
        known("0"),
        known("0"),
        [{ poNumber: "PO-120", poLine: "10" }],
      ],
      [
        "SO-202",
        known("0"),
        known("50"),
        known("50"),
        known("0"),
        [{ poNumber: "PO-120", poLine: "10" }],
      ],
    ]);
  });

  it("keeps the late 80 visible as later replenishment and never adds the accepted 120", () => {
    const { supply } = assessCoverage(c01Input());
    const segments = supply.filter((bucket) => bucket.supply.kind === "po_segment");
    expect(segments).toEqual([
      {
        supply: segment(1),
        destination: "WH-A",
        quantity: "40",
        uom: "EA",
        arrival: { state: "dated", date: "2026-10-23" },
        allocated: "40",
        disposition: "allocated",
        reason: null,
      },
      {
        supply: segment(2),
        destination: "WH-A",
        quantity: "80",
        uom: "EA",
        arrival: { state: "dated", date: "2026-10-26" },
        allocated: "0",
        disposition: "late",
        reason: "policy_arrival_after_cutoff",
      },
      {
        supply: segment(1, "accepted"),
        destination: "WH-A",
        quantity: "120",
        uom: "EA",
        arrival: { state: "dated", date: "2026-10-23" },
        allocated: "0",
        disposition: "replaced_by_proposal",
        reason: "policy_replaced_by_proposal",
      },
    ]);
  });

  it("states every shortfall with line, quantity, cutoff, reason and owner; TRO-1 is a quote, not supply", () => {
    const result = assessCoverage(c01Input());
    expect(result.shortfalls).toEqual([
      {
        stage: "pre_transfer",
        demandLine: so("SO-202"),
        quantity: "50",
        uom: "EA",
        receiptCutoff: "2026-10-23",
        reason: "policy_conditional_transfer_pending",
        owner: "warehouse_planner",
      },
    ]);
    expect(
      result.transferOptions.map((option) => [option.optionId, option.status, option.assigned]),
    ).toEqual([["TRO-1", "supported", "50"]]);
    // Pending decisions: nothing is approved, confirmed or acknowledged.
    expect(result.plan?.payload.decisions).toEqual([
      { kind: "approval", role: "procurement_manager", subject: "PLAN-1" },
      { kind: "supplier_acknowledgement", role: "supplier_contact", subject: "PROP-1" },
      { kind: "warehouse_planner_confirmation", role: "warehouse_planner", subject: "TRO-1" },
    ]);
    expect(result.authorization).toEqual({
      policy: { policyId: "AUTH-1", version: 1 },
      cost: { minorUnits: 16000, currency: "EUR" },
      currencyPermitted: true,
      limits: [
        { role: "buyer", maxMinorUnits: 10000 },
        { role: "procurement_manager", maxMinorUnits: 50000 },
      ],
      minimumApproverRole: "procurement_manager",
    });
    const text = JSON.stringify(result);
    for (const forbidden of ["applying", "plan_verified", "confirmed", "approved"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("proposes ACT-1, ACT-2, ACT-3 in order with their preconditions and predecessor", () => {
    const plan = assessCoverage(c01Input()).plan;
    expect(plan?.payload.planId).toBe("PLAN-1");
    expect(plan?.payload.planVersion).toBe(1);
    expect(plan?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan?.sha256).not.toBe("H1");
    expect(plan?.payload.actions).toEqual([
      {
        actionId: "ACT-1",
        kind: "amend_schedule",
        poNumber: "PO-120",
        poLine: "10",
        uom: "EA",
        segments: [
          { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
          { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
        ],
        preconditions: { expectedRevision: "3" },
        predecessors: [],
      },
      {
        actionId: "ACT-2",
        kind: "reserve",
        sku: "PART-A",
        warehouse: "WH-B",
        uom: "EA",
        quantity: "50",
        preconditions: { expectedVersion: "INV-B@1", minimumEligible: "50" },
        predecessors: [],
      },
      {
        actionId: "ACT-3",
        kind: "create_transfer_request",
        optionId: "TRO-1",
        sku: "PART-A",
        uom: "EA",
        from: "WH-B",
        to: "WH-A",
        quantity: "50",
        dispatchDate: "2026-10-22",
        arrivalDate: "2026-10-23",
        preconditions: {
          reservationFromAction: "ACT-2",
          baseStockVersion: "INV-B@1",
          stockVersionFromAction: "ACT-2",
          validUntil: "2026-10-22T10:00:00.000Z",
          optionTermsSha256: plan?.payload.transferOptions[0]?.termsSha256,
        },
        predecessors: ["ACT-2"],
      },
    ]);
  });

  it("leaves source records unchanged: physical stock and unrelated reservations as read", () => {
    const input = c01Input();
    const before = JSON.stringify(input);
    const result = assessCoverage(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(data<{ record: unknown }>(input.reads.stock[0]?.read).record).toEqual(stockA());
    expect(data<{ record: unknown }>(input.reads.stock[1]?.read).record).toEqual(stockB());
    const a = result.eligibility.find((entry) => entry.warehouse === "WH-A");
    expect(a).toMatchObject({
      physical: "40",
      unrelatedReservations: [{ reservationId: "RES-A-77", quantity: "10" }],
    });
  });

  it("uses numeric priority, not input order", () => {
    const input = c01Input();
    data<{ record: { lines: unknown[] } }>(input.reads.demand).record.lines.reverse();
    const result = assessCoverage(input);
    expect(
      result.allocations.map((entry) => [
        entry.demandLine.salesOrder,
        entry.supply.kind,
        entry.quantity,
      ]),
    ).toEqual([
      ["SO-201", "stock", "30"],
      ["SO-201", "po_segment", "40"],
      ["SO-202", "transfer_option", "50"],
    ]);
  });

  // Boundary literals, not oracle scenarios: the TRO-1 cost against the AUTH-1 limits.
  describe("AUTH-1 limits and currency", () => {
    const withCost = (cost: { minorUnits: number; currency: string }) => {
      const input = c01Input();
      const option = data<{ records: Array<Record<string, unknown>> }>(input.reads.transferOptions)
        .records[0];
      if (option === undefined) throw new Error("TRO-1 literal missing");
      option.cost = cost;
      return assessCoverage(input);
    };

    it("lets the procurement manager approve exactly EUR 50000", () => {
      const result = withCost({ minorUnits: 50000, currency: "EUR" });
      expect(result.decision).toEqual({
        recommendedState: "awaiting_approval",
        reason: "policy_plan_ready_for_approval",
        owner: "procurement_manager",
      });
      expect(result.plan?.payload.decisions.map((decision) => decision.kind)).toContain("approval");
    });

    it("blocks EUR 50001, which no role may approve, and builds no plan", () => {
      const result = withCost({ minorUnits: 50001, currency: "EUR" });
      expect(result.decision).toEqual({
        recommendedState: "needs_clarification",
        reason: "policy_no_approver_within_limits",
        owner: "buyer",
      });
      expect(result.issues).toEqual([
        {
          reason: "policy_no_approver_within_limits",
          owner: "buyer",
          subject: "reads.policies.authorization",
          nextEvidence:
            "no AUTH-1 role may approve 50001 minor units of EUR; a cheaper option or a reviewed approval limit is required",
        },
      ]);
      expect(result.authorization).toMatchObject({
        currencyPermitted: true,
        minimumApproverRole: null,
      });
      expect(result.plan).toBeNull();
    });

    it("blocks a USD 16000 cost as a currency AUTH-1 does not permit", () => {
      const result = withCost({ minorUnits: 16000, currency: "USD" });
      expect(result.decision).toEqual({
        recommendedState: "needs_clarification",
        reason: "policy_currency_not_permitted",
        owner: "buyer",
      });
      expect(result.authorization).toMatchObject({
        currencyPermitted: false,
        minimumApproverRole: null,
      });
      expect(result.plan).toBeNull();
    });
  });

  // Review literal, not an oracle scenario: SO-301/10 and SO-302/10 tie on
  // priority while segments 1 and 2 tie on arrival, so only one of the two
  // reversals changes which segment covers which line.
  it("blocks a combined line and supply tie that a joint reversal would hide", () => {
    const input = c01Input();
    const po = data<{
      record: { lines: Array<{ ordered: string; acceptedSegments: unknown[] }> };
    }>(input.reads.purchaseOrder).record.lines[0];
    if (po === undefined) throw new Error("PO-120/10 literal missing");
    po.ordered = "40";
    po.acceptedSegments = [
      { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
    ];
    data<{ terms: { segments: unknown[] } }>(input.reads.supplierInput).terms.segments = [
      { sequence: 1, quantity: "20", arrival: { state: "dated", date: "2026-10-23" } },
      { sequence: 2, quantity: "20", arrival: { state: "dated", date: "2026-10-23" } },
    ];
    // WH-A: physical 10 less the unrelated RES-A-77 10 leaves 0 eligible.
    input.reads.stock[0] = stockRead({ ...stockA(), physical: "10" });
    const lines = data<{ record: { lines: Array<Record<string, unknown>> } }>(input.reads.demand)
      .record.lines;
    lines[0] = { ...lines[0], salesOrder: "SO-301", open: "20", priority: 1 };
    lines[1] = { ...lines[1], salesOrder: "SO-302", open: "20", priority: 1 };
    const result = assessCoverage(input);
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_allocation_tie",
      owner: "buyer",
    });
    expect(result.allocations).toEqual([]);
    expect(result.plan).toBeNull();
  });

  describe("arrival against the 2026-10-23 cutoff", () => {
    const withSegments = (segments: unknown[]) => {
      const input = c01Input();
      data<{ terms: { segments: unknown[] } }>(input.reads.supplierInput).terms.segments = segments;
      return assessCoverage(input);
    };
    const coverage = (result: ReturnType<typeof assessCoverage>) =>
      result.totals.preTransferCoverage;

    it("counts an arrival on the cutoff date", () => {
      expect(
        coverage(
          withSegments([
            { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
            { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
          ]),
        ),
      ).toEqual(known("70"));
    });

    it("does not count an arrival one day after the cutoff", () => {
      const result = withSegments([
        { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-24" } },
        { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
      ]);
      expect(coverage(result)).toEqual(known("30"));
    });

    it("never counts an undated segment", () => {
      const result = withSegments([
        { sequence: 1, quantity: "40", arrival: { state: "undated" } },
        { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
      ]);
      expect(coverage(result)).toEqual(known("30"));
      expect(result.supply.find((bucket) => bucket.disposition === "undated")?.reason).toBe(
        "policy_arrival_undated",
      );
    });

    it("cannot rescue a late transfer arrival with an earlier dispatch", () => {
      const input = c01Input();
      const option = data<{ records: Array<Record<string, unknown>> }>(input.reads.transferOptions)
        .records[0];
      if (option === undefined) throw new Error("TRO-1 literal missing");
      option.dispatchDate = "2026-10-22";
      option.arrivalDate = "2026-10-24";
      const result = assessCoverage(input);
      expect(result.transferOptions[0]?.reasons).toContainEqual({
        reason: "policy_transfer_arrival_after_cutoff",
        owner: "warehouse_planner",
      });
      expect(result.totals.conditionalShortage).toEqual(known("50"));
      expect(result.plan).toBeNull();
    });
  });
});
