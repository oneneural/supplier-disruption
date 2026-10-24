// Read outcomes shared by the reference reads and the scoped inventory
// collection (ADR 0006). Types only: no SQL, factory or business rule. Each
// owner re-exports them from its public entry.
import type { Instant } from "@supplier-disruption/contracts";

/**
 * The fixed number of records a complete collection may hold. One more row
 * is fetched to detect overflow, which makes the read unavailable rather than
 * a truncated success. A local fixture safeguard, not a business limit.
 */
export type CollectionBound = 100;

/** What a read asked for: owner, resource, requested organization and every selector. */
export interface ReadScope<Owner extends string, Resource extends string, Selectors> {
  owner: Owner;
  resource: Resource;
  organization: string;
  selectors: Selectors;
}

/** A successful read of the exact scope. These records carry no stored observation time. */
export interface ReadOk<Scope, Data> {
  status: "ok";
  scope: Scope;
  /** Business time sampled from the injected clock before the read transaction. */
  readAt: Instant;
  observedAt: { state: "unknown" };
  data: Data;
}

/** The singular record, or the inventory scope anchor, does not exist in that read. */
export interface ReadNotFound<Scope, Reason extends string> {
  status: "not_found";
  scope: Scope;
  readAt: Instant;
  reason: Reason;
}

/** Several candidates match where exactly one is required; none is chosen. */
export interface ReadAmbiguous<Scope, Reason extends string> {
  status: "ambiguous";
  scope: Scope;
  readAt: Instant;
  reason: Reason;
}

export type ReadUnavailableReason =
  | "invalid_query"
  | "scope_mismatch"
  | "binding_missing"
  | "clock_unavailable"
  | "connection_unavailable"
  | "permission_denied"
  | "read_timeout"
  | "invalid_data"
  | "read_failed"
  | "collection_bound_exceeded";

/** Why a well-formed query could not be read. */
export type ReadFailureReason = Exclude<ReadUnavailableReason, "invalid_query">;

/**
 * The evidence could not be read. It never means absent or empty, and it
 * carries no data, completeness or read time. `attemptedAt` is the clock
 * sample when one was obtained.
 */
export interface ReadUnavailable<Scope> {
  status: "unavailable";
  scope: Scope;
  reason: ReadFailureReason;
  attemptedAt?: Instant;
}

/**
 * The query was malformed, so nothing was read and no clock was sampled. Its
 * scope echoes what the caller passed without validating it, so the
 * organization and selectors are unknown values.
 */
export interface ReadInvalidQuery<Scope> {
  status: "unavailable";
  scope: Omit<Scope, "organization" | "selectors"> & { organization: unknown; selectors: unknown };
  reason: "invalid_query";
}

/**
 * Every record matching the scope in that read's snapshot, in a stated order.
 * An empty collection is authoritative absence for those predicates at that
 * read only.
 */
export interface CompleteCollection<T> {
  records: T[];
  complete: true;
}
