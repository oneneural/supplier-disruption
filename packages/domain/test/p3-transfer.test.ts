// P3 transfer feasibility and N-15 in-transit exclusion. N-15 literals are the
// frozen oracle's; the TRO-1 boundary variants are separately labeled
// single-field changes of the canonical quote, not oracle scenarios.
import { describe, expect, it } from "vitest";
import { assessCoverage } from "../src/index.js";
import {
  c01Input,
  data,
  stockB,
  stockRead,
  stockScope,
  transitScope,
  tro1,
  trr9,
} from "./literals.js";

const known = (value: string) => ({ state: "known", value });

function withOption(change: (option: Record<string, unknown>) => void) {
  const input = c01Input();
  const option = data<{ records: Array<Record<string, unknown>> }>(input.reads.transferOptions)
    .records[0];
  if (option === undefined) throw new Error("TRO-1 literal missing");
  change(option);
  return input;
}

function n15Input() {
  const input = c01Input();
  input.reads.inTransit = [
    { warehouse: "WH-A", read: { ...input.reads.inTransit[0]!.read, data: { records: [trr9()] } } },
    { warehouse: "WH-B", read: { ...input.reads.inTransit[1]!.read, data: { records: [trr9()] } } },
  ];
  return input;
}

describe("P3 transfer feasibility and N-15", () => {
  it("N-15: TRR-9 is neither A stock nor on-time supply, and B is not reduced again", () => {
    const result = assessCoverage(n15Input());
    expect(
      result.eligibility.map((entry) =>
        entry.state === "known" ? [entry.warehouse, entry.physical, entry.eligible] : entry,
      ),
    ).toEqual([
      ["WH-A", "40", "30"],
      ["WH-B", "70", "50"],
    ]);
    expect(result.supply.filter((bucket) => bucket.supply.kind === "in_transit")).toEqual([
      {
        supply: { kind: "in_transit", transitId: "TRR-9" },
        destination: "WH-A",
        quantity: "20",
        uom: "EA",
        arrival: { state: "dated", date: "2026-10-24" },
        allocated: "0",
        disposition: "not_stock",
        reason: "policy_in_transit_not_stock",
      },
    ]);
    expect(result.allocations.some((entry) => entry.supply.kind === "in_transit")).toBe(false);
    expect(result.totals).toEqual({
      uom: "EA",
      demandOpen: known("120"),
      preTransferCoverage: known("70"),
      preTransferShortage: known("50"),
      conditionalTransfer: known("50"),
      conditionalShortage: known("0"),
    });
    expect(result.decision.recommendedState).toBe("awaiting_approval");
    // The same C-01 allocation as without transit.
    expect(result.allocations).toEqual(assessCoverage(c01Input()).allocations);
  });

  it("supports exactly the quoted 50 and never resizes the quote", () => {
    const result = assessCoverage(c01Input());
    expect(result.transferOptions).toHaveLength(1);
    expect(result.transferOptions[0]).toMatchObject({
      optionId: "TRO-1",
      status: "supported",
      reasons: [],
      assigned: "50",
      terms: { quantity: "50", cost: { minorUnits: 16000, currency: "EUR" } },
    });
    expect(
      result.plan?.payload.actions.map((action) => "quantity" in action && action.quantity),
    ).toEqual([false, "50", "50"]);
  });

  const blocked: Array<[string, () => ReturnType<typeof c01Input>, string]> = [
    [
      "wrong SKU",
      () => withOption((option) => (option.sku = "PART-A2")),
      "policy_transfer_sku_mismatch",
    ],
    [
      "wrong destination",
      () => withOption((option) => (option.to = "WH-C")),
      "policy_transfer_destination_mismatch",
    ],
    [
      "bound stock version differs",
      () => withOption((option) => (option.basedOn = "INV-B@0")),
      "policy_transfer_stock_version_mismatch",
    ],
    [
      "late arrival",
      () => withOption((option) => (option.arrivalDate = "2026-10-24")),
      "policy_transfer_arrival_after_cutoff",
    ],
    [
      "quote expired before assessment",
      () => withOption((option) => (option.validUntil = "2026-10-21T06:59:59.999Z")),
      "policy_transfer_quote_expired",
    ],
    [
      "assessment exactly at validUntil",
      () => withOption((option) => (option.validUntil = "2026-10-21T07:00:00.000Z")),
      "policy_transfer_quote_expired",
    ],
    [
      "insufficient eligible stock at B",
      () => {
        const input = c01Input();
        const b = { ...stockB(), physical: "69" };
        input.reads.stock[1] = stockRead(b);
        return input;
      },
      "policy_transfer_insufficient_eligible_stock",
    ],
  ];

  it.each(blocked)(
    "blocks TRO-1 on %s with a specific reason and owner",
    (_name, build, reason) => {
      const result = assessCoverage(build());
      expect(result.transferOptions[0]).toMatchObject({
        optionId: "TRO-1",
        status: "blocked",
        assigned: "0",
      });
      expect(result.transferOptions[0]?.reasons).toContainEqual({
        reason,
        owner: "warehouse_planner",
      });
      // No partial transfer, proportional quote or cost is invented.
      expect(result.allocations.filter((entry) => entry.stage === "conditional_transfer")).toEqual(
        [],
      );
      expect(result.totals.conditionalShortage).toEqual(known("50"));
      expect(result.decision).toEqual({
        recommendedState: "escalated",
        reason: "unresolved_shortage",
        owner: "buyer",
      });
      expect(result.plan).toBeNull();
    },
  );

  it("an option whose source stock was not read is unknown, never assumed sufficient", () => {
    const input = c01Input();
    input.reads.stock.pop();
    const result = assessCoverage(input);
    expect(result.transferOptions[0]).toMatchObject({
      optionId: "TRO-1",
      status: "unknown",
      reasons: [{ reason: "policy_evidence_not_found", owner: "warehouse_planner" }],
    });
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_evidence_not_found",
      owner: "warehouse_planner",
    });
    expect(result.totals.conditionalShortage).toEqual({ state: "unknown" });
    expect(result.plan).toBeNull();
  });

  it("raises the missing source read once, however many options draw on it", () => {
    const input = c01Input();
    input.reads.stock.pop();
    data<{ records: unknown[] }>(input.reads.transferOptions).records.push({
      ...tro1(),
      optionId: "TRO-2",
    });
    const result = assessCoverage(input);
    expect(result.transferOptions.map((option) => [option.optionId, option.status])).toEqual([
      ["TRO-1", "unknown"],
      ["TRO-2", "unknown"],
    ]);
    expect(result.issues.filter((issue) => issue.subject === "reads.stock[WH-B]")).toEqual([
      {
        reason: "policy_evidence_not_found",
        owner: "warehouse_planner",
        subject: "reads.stock[WH-B]",
        nextEvidence: "the stock at WH-B, the source of a transfer option, must be read",
      },
    ]);
  });

  // Boundary literals, not oracle scenarios. An unusable WH-B record (a
  // superseded version or inconsistent stock) is a rank-0 block that stops
  // allocation before options are assessed; these WH-B outcomes reach them.
  it.each([
    [
      "not_found",
      { status: "not_found", readAt: { state: "unknown" }, reason: "source.not_found" },
      "policy_evidence_not_found",
    ],
    [
      "ambiguous",
      { status: "ambiguous", readAt: "2026-10-21T07:00:00.000Z", reason: "record_ambiguous" },
      "policy_evidence_ambiguous",
    ],
  ])("gives an option the source warehouse's own reason: WH-B %s", (_label, outcome, reason) => {
    const input = c01Input();
    input.reads.stock[1] = {
      warehouse: "WH-B",
      read: { ...outcome, scope: stockScope("WH-B") },
    } as never;
    const result = assessCoverage(input);
    expect(result.eligibility.find((entry) => entry.warehouse === "WH-B")).toEqual({
      state: "unknown",
      warehouse: "WH-B",
      reason,
    });
    expect(result.transferOptions[0]).toMatchObject({
      optionId: "TRO-1",
      status: "unknown",
      reasons: [{ reason, owner: "warehouse_planner" }],
    });
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason,
      owner: "warehouse_planner",
    });
    expect(result.plan).toBeNull();
  });

  it("requires the destination's in-transit read, as it requires the destination stock", () => {
    const input = c01Input();
    input.reads.inTransit.shift();
    const result = assessCoverage(input);
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_evidence_not_found",
      owner: "warehouse_planner",
    });
    expect(result.issues).toContainEqual({
      reason: "policy_evidence_not_found",
      owner: "warehouse_planner",
      subject: "reads.inTransit[WH-A]",
      nextEvidence: "the in-transit records of the destination must be read",
    });
    expect(result.plan).toBeNull();
  });

  it("accepts the quote one millisecond before validUntil", () => {
    const result = assessCoverage(
      withOption((option) => (option.validUntil = "2026-10-21T07:00:00.001Z")),
    );
    expect(result.transferOptions[0]?.status).toBe("supported");
  });

  it("binds validUntil into ACT-3 for the execution-time recheck", () => {
    const action = assessCoverage(c01Input()).plan?.payload.actions[2];
    expect(action?.kind === "create_transfer_request" && action.preconditions.validUntil).toBe(
      "2026-10-22T10:00:00.000Z",
    );
  });

  it("keeps transit reads scoped per warehouse and refuses a mismatched scope", () => {
    const input = n15Input();
    input.reads.inTransit[0] = {
      warehouse: "WH-A",
      read: {
        ...input.reads.inTransit[0]!.read,
        provenance: {
          ...(input.reads.inTransit[0]!.read as { provenance: Record<string, unknown> }).provenance,
          scope: transitScope("WH-B"),
        },
      },
    } as never;
    const result = assessCoverage(input);
    expect(result.decision.reason).toBe("policy_identity_mismatch");
    expect(result.plan).toBeNull();
  });
});
