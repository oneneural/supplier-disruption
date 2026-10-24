import { createHash } from "node:crypto";
import {
  canonicalJson,
  type Clock,
  type SourceRejectionReason,
} from "@supplier-disruption/contracts";
import type pg from "pg";

/** The authorities with runtime source modules. */
export type SourceAuthority = "purchasing" | "inventory" | "demand";

/**
 * The owning source refused a command or could not find the requested
 * record. A refusal is decided inside the source transaction and leaves no
 * effect and no operation record.
 */
export class SourceRejectedError extends Error {
  readonly authority: SourceAuthority;
  readonly reason: SourceRejectionReason;

  constructor(authority: SourceAuthority, reason: SourceRejectionReason, message: string) {
    super(`${authority} rejected: ${reason}: ${message}`);
    this.name = "SourceRejectedError";
    this.authority = authority;
    this.reason = reason;
  }
}

/** Bounds every source transaction's lock and statement waits. */
export interface SourceTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export const DEFAULT_SOURCE_TIMEOUTS: SourceTimeouts = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 15_000,
};

/**
 * A source module's dependencies. It takes a pool, never a client, so each
 * call checks out its own connection and cannot join a caller's transaction.
 */
export interface SourceOptions {
  pool: pg.Pool;
  /** Read times and receipt times come from this clock, never from wall time. */
  clock: Clock;
  timeouts?: Partial<SourceTimeouts>;
}

/** The outcome of a committed source operation; a replay returns the original receipt. */
export interface SourceWriteResult<Receipt> {
  replayed: boolean;
  receipt: Receipt;
}

async function inTransaction<T>(
  options: SourceOptions,
  begin: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const timeouts = { ...DEFAULT_SOURCE_TIMEOUTS, ...options.timeouts };
  const client = await options.pool.connect();
  let broken: Error | undefined;
  const asError = (thrown: unknown) =>
    thrown instanceof Error ? thrown : new Error(String(thrown));
  try {
    await client.query(begin).catch((error: unknown) => {
      broken = asError(error);
      throw error;
    });
    try {
      // Transaction-local settings: bounded waits, and ISO DateStyle so the
      // ::text timestamps and dates the modules decode never depend on the
      // session's DateStyle.
      await client.query(
        `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true),
                set_config('DateStyle', 'ISO, MDY', true)`,
        [`${timeouts.lockTimeoutMs}ms`, `${timeouts.statementTimeoutMs}ms`],
      );
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch((rollback: unknown) => {
        broken = asError(rollback);
      });
      throw error;
    }
  } finally {
    // A connection whose BEGIN or rollback failed is discarded rather than reused.
    client.release(broken);
  }
}

/**
 * Runs one source operation in its own read-committed transaction on its own
 * connection: the operation identity, the owning version row and every
 * effect commit or roll back together.
 */
export function writeTransaction<T>(
  options: SourceOptions,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction(options, "BEGIN ISOLATION LEVEL READ COMMITTED", work);
}

/** Runs a source read against one consistent snapshot on its own connection. */
export function readTransaction<T>(
  options: SourceOptions,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction(options, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", work);
}

/**
 * The immutable request digest: SHA-256 of the canonical JSON of the
 * validated command without its operation ID, so kind, target, preconditions,
 * attribution and payload are all part of it.
 */
export function requestDigest(command: { operationId: string }): string {
  // canonicalJson drops undefined fields, so the key is not part of the digest.
  return createHash("sha256")
    .update(canonicalJson({ ...command, operationId: undefined }), "utf8")
    .digest("hex");
}

/**
 * Claims an operation identity as the first statement of a write. A new
 * identity is inserted and held by this transaction, so a concurrent call
 * with the same key waits until it commits or rolls back. An existing
 * identity with the same kind and digest is a replay; any other is a reuse
 * of the key and is refused. `table` is the owner's literal operation table.
 */
export async function claimOperation(
  client: pg.PoolClient,
  authority: SourceAuthority,
  table: string,
  identity: { organization: string; operationId: string; kind: string; digest: string },
): Promise<"new" | "replay"> {
  const inserted = await client.query(
    `INSERT INTO ${table} (organization, operation_id, kind, request_digest)
     VALUES ($1, $2, $3, $4) ON CONFLICT (organization, operation_id) DO NOTHING`,
    [identity.organization, identity.operationId, identity.kind, identity.digest],
  );
  if (inserted.rowCount === 1) return "new";
  const { rows } = await client.query<{ kind: string; request_digest: string }>(
    `SELECT kind, request_digest FROM ${table} WHERE organization = $1 AND operation_id = $2`,
    [identity.organization, identity.operationId],
  );
  const [existing] = rows;
  if (existing?.kind === identity.kind && existing.request_digest === identity.digest) {
    return "replay";
  }
  throw new SourceRejectedError(
    authority,
    "source.operation_conflict",
    `operation ${identity.operationId} already exists with a different request`,
  );
}
