import type { VerificationEntry, VerificationStatus } from "@supplier-disruption/contracts";
import type { CaseRow, EventRow } from "./store.js";
import { isoInstant } from "./store.js";

interface Detail {
  planSha256?: string;
  bundleTime?: string;
  validUntil?: string;
  missing?: string[];
  checks?: Array<{ check: string; ok: boolean }>;
  recheck?: boolean;
  outcome?: string;
}

function entryOf(event: EventRow): VerificationEntry | null {
  const detail = event.detail as Detail;
  const base = {
    sequence: event.sequence,
    occurredAt: isoInstant(event.occurredAt),
    actorId: event.actorId,
    recheck: detail.recheck === true,
    planSha256: detail.planSha256 ?? null,
  };
  if (event.kind === "verification_unavailable") {
    return {
      ...base,
      outcome: "unavailable",
      bundleTime: null,
      validUntil: null,
      failedChecks: [],
      missing: [],
    };
  }
  if (event.kind !== "verification") return null;
  // The first read-back records its outcome as the state it moved to.
  const outcome =
    detail.outcome ??
    (event.toState === "plan_verified" ? "verified" : (event.reason ?? "unknown"));
  return {
    ...base,
    outcome,
    bundleTime: detail.bundleTime ?? null,
    validUntil: detail.validUntil ?? null,
    failedChecks: (detail.checks ?? []).filter((check) => !check.ok).map((check) => check.check),
    missing: detail.missing ?? [],
  };
}

/**
 * Whether the current plan's verification still holds now (ADR 0015). A
 * read-back supports `plan_verified` for four hours (VERIFY-1@1); after that,
 * or once a recheck no longer matches, nothing currently confirms the plan,
 * while every earlier verification stays inspectable in `history`.
 *
 * - `current`: the last read-back matched and its validity has not ended.
 * - `expired`: the last matching read-back is older than its validity.
 * - `mismatch`: the latest completed read-back found a missing or different record.
 * - `unavailable`: the latest attempt could not read the sources and no
 *   matching read-back is still valid; this is not a mismatch.
 * - `superseded`: a later supplier revision replaced the case.
 * - `none`: the plan was never read back.
 */
export function verificationCurrency(
  row: CaseRow,
  planSha256: string | null,
  events: readonly EventRow[],
  now: string,
  recheckable: boolean,
): VerificationStatus {
  const history = events
    .map(entryOf)
    .filter((entry): entry is VerificationEntry => entry !== null)
    // An unavailable first read-back carries no plan hash; it is the current plan's.
    .filter((entry) => entry.planSha256 === null || entry.planSha256 === planSha256);
  const lastVerified = history.findLast((entry) => entry.outcome === "verified") ?? null;
  const lastAttempt = history.at(-1) ?? null;
  const lastCompleted = history.findLast((entry) => entry.outcome !== "unavailable") ?? null;
  const valid =
    lastVerified?.validUntil != null && Date.parse(now) < Date.parse(lastVerified.validUntil);
  let status: VerificationStatus["status"];
  if (row.state === "superseded") status = "superseded";
  else if (lastAttempt === null) status = "none";
  else if (lastCompleted !== null && lastCompleted.outcome !== "verified") status = "mismatch";
  else if (valid) status = "current";
  else if (lastAttempt.outcome === "unavailable") status = "unavailable";
  else if (lastVerified !== null) status = "expired";
  else status = "none";
  return {
    status,
    currentUntil: status === "current" ? (lastVerified?.validUntil ?? null) : null,
    lastVerified,
    lastAttempt,
    history,
    recheckable,
  };
}

/** The queue's next step for a verified case whose read-back is no longer valid. */
export function expiredNextAction(row: CaseRow, now: string): string | null {
  if (row.state !== "plan_verified" || row.verifiedUntil === null) return null;
  const until = isoInstant(row.verifiedUntil);
  if (Date.parse(now) < Date.parse(until)) return null;
  return `Verification expired at ${until}; recheck the source records before relying on this plan`;
}
