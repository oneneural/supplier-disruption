// AUTH-1 approval checks against the current policy version. Expected
// values are frozen-oracle literals (N-05, N-06 c), never computed by the code
// under test.
import type { Policy } from "@supplier-disruption/contracts";
import { describe, expect, it } from "vitest";
import { approvalRefusal } from "../src/index.js";

const LIMITS = [
  { role: "buyer", maxMinorUnits: 10_000 },
  { role: "procurement_manager", maxMinorUnits: 50_000 },
] as const;

const AUTH_1: Policy = {
  contractVersion: "supplier-domain.v1",
  policyId: "AUTH-1",
  version: 1,
  currency: "EUR",
  limits: [...LIMITS],
  transferRequires: ["supplier_acknowledgement", "warehouse_planner_confirmation"],
};

/** The C-01 plan's AUTH-1 requirement: TRO-1 at EUR 160.00. */
const C01 = {
  policy: { policyId: "AUTH-1", version: 1 },
  cost: { minorUnits: 16_000, currency: "EUR" },
  currencyPermitted: true,
  limits: [...LIMITS],
};

describe("AUTH-1 approval against the current policy version", () => {
  it("refuses the buyer's EUR 160 over the EUR 100 limit and permits the manager", () => {
    expect(approvalRefusal(C01, AUTH_1, "buyer")).toEqual({
      reason: "over_approval_limit",
      limit: { role: "buyer", maxMinorUnits: 10_000 },
    });
    expect(approvalRefusal(C01, AUTH_1, "procurement_manager")).toBeNull();
  });

  it("refuses a DKK 1 190.00 plan for every approver (N-05 b)", () => {
    const dkk = {
      ...C01,
      cost: { minorUnits: 119_000, currency: "DKK" },
      currencyPermitted: false,
    };
    for (const role of ["buyer", "procurement_manager"] as const) {
      expect(approvalRefusal(dkk, AUTH_1, role)?.reason).toBe("currency_not_permitted");
    }
    // A plan that claims the currency is permitted is still checked against the policy.
    const claimed = { ...dkk, currencyPermitted: true };
    expect(approvalRefusal(claimed, AUTH_1, "procurement_manager")?.reason).toBe(
      "currency_not_permitted",
    );
  });

  it("refuses a role without an AUTH-1 limit", () => {
    expect(approvalRefusal(C01, AUTH_1, "warehouse_planner")?.reason).toBe("role_not_permitted");
  });

  it("makes the plan stale when AUTH-1 version 2 is current, even for the manager (N-06 c)", () => {
    const version2: Policy = {
      ...AUTH_1,
      version: 2,
      limits: [
        { role: "buyer", maxMinorUnits: 10_000 },
        { role: "procurement_manager", maxMinorUnits: 15_000 },
      ],
    };
    expect(approvalRefusal(C01, version2, "procurement_manager")).toEqual({
      reason: "stale_policy",
      limit: null,
    });
    // A newer version with unchanged limits still invalidates the old binding.
    expect(approvalRefusal(C01, { ...AUTH_1, version: 2 }, "procurement_manager")?.reason).toBe(
      "stale_policy",
    );
    // Changed limits under the same version number are not the bound policy either.
    expect(approvalRefusal(C01, { ...version2, version: 1 }, "procurement_manager")?.reason).toBe(
      "stale_policy",
    );
  });
});
