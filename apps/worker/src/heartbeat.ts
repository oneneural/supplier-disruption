import { workerHeartbeat } from "@supplier-disruption/db/worker";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

const DB_CONNECT_TIMEOUT_MS = 5_000;
// Server-side bound, including lock waits; the client-side bound backs it up.
export const DB_STATEMENT_TIMEOUT_MS = 5_000;
const DB_QUERY_TIMEOUT_MS = 6_000;

/**
 * Heartbeat pool. A blocked or unreachable database fails a heartbeat after
 * these bounds and the next beat tries again, instead of one stuck write
 * silently holding every later beat. All stay below the 10 s freshness bound.
 */
export function heartbeatPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: "sd-worker",
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    query_timeout: DB_QUERY_TIMEOUT_MS,
  });
}

/**
 * SQLSTATE classes a retry cannot fix: 42, syntax error or access rule
 * violation (such as 42501 insufficient_privilege or 42P01 undefined_table),
 * and 3F, invalid schema name.
 */
const PERMANENT_SQLSTATE_CLASSES = new Set(["42", "3F"]);

/**
 * Whether a database error has a permanent SQLSTATE class. Drizzle wraps the
 * driver error, so the first SQLSTATE among the error and its causes counts.
 */
export function isPermanentDatabaseError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return PERMANENT_SQLSTATE_CLASSES.has(code.slice(0, 2));
    }
    current = current.cause;
  }
  return false;
}

/**
 * Writes this boot's first heartbeat. A worker restarted inside the same
 * container boot reuses the boot ID, so this is an upsert that refreshes the
 * row's start and observation times.
 */
export async function writeFirstHeartbeat(
  db: NodePgDatabase,
  bootId: string,
  buildRevision: string,
): Promise<void> {
  await db
    .insert(workerHeartbeat)
    .values({ bootId, buildRevision })
    .onConflictDoUpdate({
      target: workerHeartbeat.bootId,
      set: { buildRevision, startedAt: sql`now()`, observedAt: sql`now()` },
    });
}
