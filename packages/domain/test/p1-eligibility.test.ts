// P1 exact quantities and ELIG-1 eligibility. C-01 literals come from the
// frozen oracle; the hold/safety boundary fixture and large values are
// separately labeled test-only literals, not oracle scenarios.
import { describe, expect, it } from "vitest";
import {
  AssessmentInputError,
  QuantityRangeError,
  assessCoverage,
  deriveEligibility,
  formatQuantity,
  parseQuantity,
} from "../src/index.js";
import { c01Input, data, stockA, stockB } from "./literals.js";

type Snapshot = Parameters<typeof deriveEligibility>[0];
const snapshot = (value: unknown) => value as Snapshot;

describe("P1 exact quantities and eligibility", () => {
  it("derives C-01 eligibility: A 40 - 10 = 30, B 70 - 20 = 50, leaving the records unchanged", () => {
    const a = stockA();
    const b = stockB();
    const before = JSON.stringify([a, b]);
    expect(deriveEligibility(snapshot(a))).toEqual({
      ok: true,
      value: {
        warehouse: "WH-A",
        stockVersion: "INV-A@1",
        uom: "EA",
        physical: "40",
        qualityHold: "0",
        safetyStock: "0",
        unrelatedReservations: [{ reservationId: "RES-A-77", quantity: "10" }],
        eligible: "30",
      },
    });
    expect(deriveEligibility(snapshot(b))).toMatchObject({ ok: true, value: { eligible: "50" } });
    expect(JSON.stringify([a, b])).toBe(before);
  });

  it("subtracts nonzero holds and safety stock once each (boundary fixture, not an oracle scenario)", () => {
    const boundary = {
      ...stockA(),
      version: "BOUNDARY@1",
      physical: "100",
      qualityHold: "7",
      safetyStock: "5",
      reservations: [
        { reservationId: "RES-X-1", quantity: "11", binding: { kind: "unrelated" } },
        { reservationId: "RES-X-2", quantity: "13", binding: { kind: "unrelated" } },
      ],
    };
    // 100 - 7 - 5 - 11 - 13 = 64
    expect(deriveEligibility(snapshot(boundary))).toMatchObject({
      ok: true,
      value: { eligible: "64" },
    });
  });

  it("keeps values above 2^53 and at 18 digits exact", () => {
    const large = (physical: string) => ({
      ...stockA(),
      physical,
      reservations: [{ reservationId: "RES-L-1", quantity: "1", binding: { kind: "unrelated" } }],
    });
    expect(deriveEligibility(snapshot(large("9007199254740993")))).toMatchObject({
      ok: true,
      value: { eligible: "9007199254740992" },
    });
    expect(deriveEligibility(snapshot(large("999999999999999999")))).toMatchObject({
      ok: true,
      value: { eligible: "999999999999999998" },
    });
  });

  it("rejects numeric, fractional and noncanonical quantities", () => {
    for (const value of [40, "40.0", "4e1", "-1", "040", " 40", "1000000000000000000"]) {
      expect(() => parseQuantity(value)).toThrow();
    }
    const numeric = c01Input();
    data<{ record: Record<string, unknown> }>(numeric.reads.stock[0]?.read).record.physical = 40;
    expect(() => assessCoverage(numeric)).toThrow(AssessmentInputError);
    const fractional = c01Input();
    data<{ record: Record<string, unknown> }>(fractional.reads.stock[0]?.read).record.physical =
      "40.5";
    expect(() => assessCoverage(fractional)).toThrow(AssessmentInputError);
  });

  it("refuses duplicate reservation IDs and deductions beyond physical stock", () => {
    const duplicate = {
      ...stockB(),
      reservations: [
        { reservationId: "RES-B-31", quantity: "20", binding: { kind: "unrelated" } },
        { reservationId: "RES-B-31", quantity: "20", binding: { kind: "unrelated" } },
      ],
    };
    expect(deriveEligibility(snapshot(duplicate))).toMatchObject({
      ok: false,
      reason: "policy_inconsistent_stock",
    });
    const negative = { ...stockA(), physical: "5" };
    expect(deriveEligibility(snapshot(negative))).toMatchObject({
      ok: false,
      reason: "policy_inconsistent_stock",
    });

    const input = c01Input();
    data<{ record: Record<string, unknown> }>(input.reads.stock[0]?.read).record.physical = "5";
    const result = assessCoverage(input);
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_inconsistent_stock",
      owner: "warehouse_planner",
    });
    expect(result.eligibility.find((entry) => entry.warehouse === "WH-A")).toEqual({
      state: "unknown",
      warehouse: "WH-A",
      reason: "policy_inconsistent_stock",
    });
    expect(result.plan).toBeNull();
  });

  it("refuses out-of-range output instead of wrapping", () => {
    expect(() => formatQuantity(1_000_000_000_000_000_000n)).toThrow(QuantityRangeError);
    expect(() => formatQuantity(-1n)).toThrow(QuantityRangeError);
    // Two open lines of 18 nines total 19 digits.
    const input = c01Input();
    for (const line of data<{ record: { lines: Array<Record<string, unknown>> } }>(
      input.reads.demand,
    ).record.lines) {
      line.open = "999999999999999999";
    }
    const result = assessCoverage(input);
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_quantity_out_of_range",
      owner: "buyer",
    });
    expect(result.plan).toBeNull();
  });
});
