import { canonicalJson, type ActorRole, type Policy } from "@supplier-disruption/contracts";

/** The AUTH-1 fields of a plan that an approval decision is checked against. */
export interface ApprovalRequirement {
  policy: { policyId: string; version: number };
  cost: { minorUnits: number; currency: string };
  currencyPermitted: boolean;
  limits: ReadonlyArray<{ role: ActorRole; maxMinorUnits: number }>;
}

/**
 * Why AUTH-1 refuses an approval, in the order the checks run. Oracle N-05
 * and N-06 c values (ADR 0013).
 */
export type ApprovalRefusal =
  "stale_policy" | "currency_not_permitted" | "role_not_permitted" | "over_approval_limit";

/**
 * Checks one role's approval of a plan against the current AUTH-1 version.
 * The plan must still be bound to that version with the same currency and
 * limits; a newer version makes it stale even when the older row still
 * exists. Then the cost must be in the policy currency, the role must have
 * a limit and the cost must be within it. Null means AUTH-1 permits it.
 */
export function approvalRefusal(
  requirement: ApprovalRequirement,
  current: Policy,
  role: ActorRole,
): { reason: ApprovalRefusal; limit: { role: ActorRole; maxMinorUnits: number } | null } | null {
  if (
    current.policyId !== "AUTH-1" ||
    current.policyId !== requirement.policy.policyId ||
    current.version !== requirement.policy.version ||
    canonicalJson(sortLimits(current.limits)) !== canonicalJson(sortLimits(requirement.limits))
  ) {
    return { reason: "stale_policy", limit: null };
  }
  const limit = current.limits.find((entry) => entry.role === role) ?? null;
  if (!requirement.currencyPermitted || requirement.cost.currency !== current.currency) {
    return { reason: "currency_not_permitted", limit };
  }
  if (limit === null) return { reason: "role_not_permitted", limit };
  if (requirement.cost.minorUnits > limit.maxMinorUnits) {
    return { reason: "over_approval_limit", limit };
  }
  return null;
}

const sortLimits = (limits: ReadonlyArray<{ role: string; maxMinorUnits: number }>) =>
  [...limits].sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
