// P5 N-14 effective item-master mapping. CTN and BOX inputs and the expected
// state, reason and owner are literals from the frozen oracle's N-14 rows; the
// date and remainder boundary checks are separately labeled test literals.
import { describe, expect, it } from "vitest";
import { assessCoverage, convertQuantity, selectMapping } from "../src/index.js";
import { c01Input, data, map1 } from "./literals.js";

type Mapping = Parameters<typeof convertQuantity>[1];

/** KF-A-01 CTN = 10 EA, effective 2026-01-01 through 2026-09-30 only. */
function ctnMapping() {
  return {
    ...map1(),
    mappingId: "MAP-CTN-1",
    sourceUom: "CTN",
    ratio: { numerator: "10", denominator: "1" },
    effectiveThrough: "2026-09-30",
  };
}

function proposalIn(uom: string, mappings: unknown[]) {
  const input = c01Input();
  const supplier = data<{ terms: { uom: string; segments: Array<{ quantity: string }> } }>(
    input.reads.supplierInput,
  );
  supplier.terms.uom = uom;
  // 4 + 8 cartons would be 40 + 80 EA only under a usable 10:1 mapping.
  supplier.terms.segments[0]!.quantity = "4";
  supplier.terms.segments[1]!.quantity = "8";
  const read = input.reads.itemMappings as {
    provenance: { scope: { selectors: Record<string, unknown> } };
  };
  read.provenance.scope.selectors.sourceUom = uom;
  data<{ records: unknown[] }>(input.reads.itemMappings).records = mappings;
  return input;
}

const blocked = {
  recommendedState: "needs_clarification",
  reason: "uom_conversion_unavailable",
  owner: "buyer",
};

const query = {
  vendorId: "V-100",
  vendorItem: "KF-A-01",
  sourceUom: "CTN",
  sku: "PART-A",
  stockUom: "EA",
};

describe("P5 N-14 effective mapping", () => {
  it("a: a CTN mapping that expired on 2026-09-30 blocks without a plan", () => {
    const result = assessCoverage(proposalIn("CTN", [ctnMapping()]));
    expect(result.decision).toEqual(blocked);
    expect(result.plan).toBeNull();
    expect(result.allocations).toEqual([]);
    expect(result.totals.preTransferCoverage).toEqual({ state: "unknown" });
    // Nothing was projected, so the accepted 120 is not shown as replaced.
    const accepted = result.supply.find(
      (bucket) => bucket.supply.kind === "po_segment" && bucket.supply.projection === "accepted",
    );
    expect(accepted).toMatchObject({
      quantity: "120",
      disposition: "not_projected",
      reason: "policy_schedule_not_projected",
    });
    expect(result.supply.map((bucket) => bucket.disposition)).not.toContain("replaced_by_proposal");
  });

  // Boundary literals, not oracle scenarios: Copenhagen is UTC+2 on 2026-09-30,
  // so its date changes at 22:00Z while the UTC date is still 2026-09-30.
  it("takes the mapping date in Copenhagen at midnight, not in UTC", () => {
    const after = proposalIn("CTN", [ctnMapping()]);
    after.assessedAt = "2026-09-30T22:30:00.000Z";
    expect(assessCoverage(after).decision).toEqual(blocked);

    const before = proposalIn("CTN", [ctnMapping()]);
    before.assessedAt = "2026-09-30T21:59:59.999Z";
    const result = assessCoverage(before);
    expect(result.issues.map((issue) => issue.reason)).not.toContain("uom_conversion_unavailable");
    expect(result.decision.recommendedState).toBe("awaiting_approval");
  });

  it("b: a BOX quantity with no mapping blocks the same way", () => {
    const result = assessCoverage(proposalIn("BOX", []));
    expect(result.decision).toEqual(blocked);
    expect(result.plan).toBeNull();
    expect(result.allocations).toEqual([]);
  });

  it("C-01's EA quantities still convert 1:1 under MAP-1@1", () => {
    const result = assessCoverage(c01Input());
    expect(result.plan?.payload.proposal.conversion).toEqual({
      mappingId: "MAP-1",
      version: 1,
      numerator: "1",
      denominator: "1",
    });
  });

  it("treats both mapping dates as inclusive (boundary literals, not an oracle scenario)", () => {
    const mapping = ctnMapping();
    const records = [mapping as unknown as Mapping];
    expect(selectMapping(records, { ...query, onDate: "2025-12-31" }).ok).toBe(false);
    expect(selectMapping(records, { ...query, onDate: "2026-01-01" }).ok).toBe(true);
    expect(selectMapping(records, { ...query, onDate: "2026-09-30" }).ok).toBe(true);
    expect(selectMapping(records, { ...query, onDate: "2026-10-01" })).toMatchObject({
      ok: false,
      reason: "uom_conversion_unavailable",
    });
  });

  it("uses the assessment date in Copenhagen: a CTN mapping effective that day converts 4 + 8 to 40 + 80", () => {
    const current = { ...ctnMapping(), effectiveThrough: "2026-10-21" };
    const result = assessCoverage(proposalIn("CTN", [current]));
    expect(result.decision.recommendedState).toBe("awaiting_approval");
    expect(result.plan?.payload.actions[0]).toMatchObject({
      kind: "amend_schedule",
      uom: "EA",
      segments: [
        { sequence: 1, quantity: "40" },
        { sequence: 2, quantity: "80" },
      ],
    });
  });

  it("rejects an integer conversion with a nonzero remainder", () => {
    const thirds = {
      ...ctnMapping(),
      ratio: { numerator: "10", denominator: "3" },
      effectiveThrough: null,
    };
    expect(convertQuantity("3", thirds as unknown as Mapping)).toBe(10n);
    expect(convertQuantity("4", thirds as unknown as Mapping)).toBeNull();
    const result = assessCoverage(proposalIn("CTN", [thirds]));
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_conversion_nonintegral",
      owner: "buyer",
    });
    expect(result.plan).toBeNull();
  });
});
