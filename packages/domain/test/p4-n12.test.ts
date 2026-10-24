// P4 N-12 shortage, unavailable evidence and substitute. Inputs and expected
// states, reasons and owners are literals from the frozen oracle's N-12 rows.
import { describe, expect, it } from "vitest";
import { assessCoverage } from "../src/index.js";
import { c01Input, data, stockB, stockRead, stockScope, unavailable } from "./literals.js";

const known = (value: string) => ({ state: "known", value });
const unknown = { state: "unknown" };

/** N-12a: INV-B@3, physical 70, RES-B-31 20 and RES-B-41 50; no transfer option exists. */
function n12a() {
  const input = c01Input();
  input.reads.stock[1] = stockRead({
    ...stockB(),
    version: "INV-B@3",
    reservations: [
      { reservationId: "RES-B-31", quantity: "20", binding: { kind: "unrelated" } },
      { reservationId: "RES-B-41", quantity: "50", binding: { kind: "unrelated" } },
    ],
  });
  data<{ records: unknown[] }>(input.reads.transferOptions).records = [];
  return input;
}

/** N-12b: the inventory authority is unavailable when reading WH-B. */
function n12b() {
  const input = c01Input();
  input.reads.stock[1] = { warehouse: "WH-B", read: unavailable(stockScope("WH-B")) } as never;
  return input;
}

/** N-12c: MSG-0001 also offers 50 EA PART-A2 arriving 2026-10-22 as an optional substitute. */
function n12c() {
  const input = c01Input();
  input.candidateOffers = [
    {
      offerId: "MSG-0001-ALT-1",
      kind: "optional_substitute",
      sku: "PART-A2",
      quantity: "50",
      uom: "EA",
      arrival: { state: "dated", date: "2026-10-22" },
      evidence: {
        sourceSystem: "fixture-supplier-mail",
        messageId: "MSG-0001",
        inputVersion: 1,
        evidenceRef: "MSG-0001@1",
      },
    },
  ];
  return input;
}

describe("P4 N-12 reason, state and owner distinctions", () => {
  it("a: escalated, unresolved_shortage, buyer, gap 50 EA on SO-202/10", () => {
    const result = assessCoverage(n12a());
    expect(result.decision).toEqual({
      recommendedState: "escalated",
      reason: "unresolved_shortage",
      owner: "buyer",
    });
    expect(result.eligibility.find((entry) => entry.warehouse === "WH-B")).toMatchObject({
      state: "known",
      physical: "70",
      eligible: "0",
    });
    expect(result.transferOptions).toEqual([]);
    expect(result.shortfalls).toEqual([
      {
        stage: "pre_transfer",
        demandLine: { salesOrder: "SO-202", line: "10" },
        quantity: "50",
        uom: "EA",
        receiptCutoff: "2026-10-23",
        reason: "unresolved_shortage",
        owner: "buyer",
      },
      {
        stage: "conditional",
        demandLine: { salesOrder: "SO-202", line: "10" },
        quantity: "50",
        uom: "EA",
        receiptCutoff: "2026-10-23",
        reason: "unresolved_shortage",
        owner: "buyer",
      },
    ]);
    expect(result.totals.conditionalShortage).toEqual(known("50"));
    expect(result.plan).toBeNull();
  });

  it("b: needs_clarification, evidence_unavailable, warehouse planner; known pre-transfer arithmetic stays visible", () => {
    const result = assessCoverage(n12b());
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "evidence_unavailable",
      owner: "warehouse_planner",
    });
    expect(result.eligibility.find((entry) => entry.warehouse === "WH-B")).toEqual({
      state: "unknown",
      warehouse: "WH-B",
      reason: "evidence_unavailable",
    });
    expect(result.totals).toEqual({
      uom: "EA",
      demandOpen: known("120"),
      preTransferCoverage: known("70"),
      preTransferShortage: known("50"),
      conditionalTransfer: unknown,
      conditionalShortage: unknown,
    });
    const so202 = result.demand.find((line) => line.salesOrder === "SO-202");
    expect(so202).toMatchObject({
      preTransferGap: known("50"),
      conditionalTransfer: unknown,
      conditionalGap: unknown,
    });
    expect(result.transferOptions[0]).toMatchObject({
      optionId: "TRO-1",
      status: "unknown",
      reasons: [{ reason: "evidence_unavailable", owner: "warehouse_planner" }],
    });
    expect(result.shortfalls).toEqual([
      {
        stage: "pre_transfer",
        demandLine: { salesOrder: "SO-202", line: "10" },
        quantity: "50",
        uom: "EA",
        receiptCutoff: "2026-10-23",
        reason: "evidence_unavailable",
        owner: "warehouse_planner",
      },
    ]);
    expect(result.plan).toBeNull();
  });

  it("c: PART-A2 is unsupported_substitution for the buyer; PART-A assessment is C-01's", () => {
    const result = assessCoverage(n12c());
    const canonical = assessCoverage(c01Input());
    expect(result.substitutes).toEqual([
      {
        offerId: "MSG-0001-ALT-1",
        sku: "PART-A2",
        quantity: "50",
        uom: "EA",
        arrival: { state: "dated", date: "2026-10-22" },
        status: "unsupported",
        reason: "unsupported_substitution",
        owner: "buyer",
        evidence: {
          sourceSystem: "fixture-supplier-mail",
          messageId: "MSG-0001",
          inputVersion: 1,
          evidenceRef: "MSG-0001@1",
        },
      },
    ]);
    expect(result.allocations).toEqual(canonical.allocations);
    expect(result.totals).toEqual(canonical.totals);
    expect(result.decision).toEqual(canonical.decision);
    expect(result.plan?.payload.actions).toEqual(canonical.plan?.payload.actions);
    expect(JSON.stringify(result.allocations)).not.toContain("PART-A2");
    // The substitute's provenance is bound, so the hash differs; no equality is claimed.
    expect(result.plan?.payload.candidateOffers).toHaveLength(1);
  });

  it("rejects an offer whose evidence is not the assessed supplier input", () => {
    const input = n12c();
    const offer = input.candidateOffers[0] as { evidence: Record<string, unknown> };
    offer.evidence = { ...offer.evidence, messageId: "MSG-0002", evidenceRef: "MSG-0002@1" };
    const result = assessCoverage(input);
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_identity_mismatch",
      owner: "buyer",
    });
    expect(result.issues.map((issue) => issue.subject)).toEqual([
      "candidateOffers[MSG-0001-ALT-1]",
    ]);
    expect(result.plan).toBeNull();
  });

  it("keeps the three reasons distinct", () => {
    const reasons = [n12a(), n12b(), n12c()].map((input) => {
      const result = assessCoverage(input);
      return [result.decision.reason, result.substitutes[0]?.reason ?? null];
    });
    expect(reasons).toEqual([
      ["unresolved_shortage", null],
      ["evidence_unavailable", null],
      ["policy_plan_ready_for_approval", "unsupported_substitution"],
    ]);
  });

  it("an authoritatively empty option list is not an unavailable read, and a missing list is not empty", () => {
    const empty = c01Input();
    data<{ records: unknown[] }>(empty.reads.transferOptions).records = [];
    expect(assessCoverage(empty).decision.reason).toBe("unresolved_shortage");

    const missing = c01Input();
    missing.reads.transferOptions = unavailable(
      (missing.reads.transferOptions as { provenance: { scope: unknown } }).provenance.scope,
      "read_timeout",
    ) as never;
    const result = assessCoverage(missing);
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "evidence_unavailable",
      owner: "warehouse_planner",
    });
    expect(result.totals.conditionalShortage).toEqual(unknown);
  });
});
