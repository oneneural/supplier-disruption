import { HEARTBEAT_FRESHNESS_MS, SCHEMA_TAG } from "@supplier-disruption/db";
import type pg from "pg";

export interface HealthDependencies {
  /** A small pool with short connect and query timeouts, separate from request traffic. */
  pool: pg.Pool;
  /** This container boot's ID. Undefined outside the image, where no boot ID exists. */
  bootId: string | undefined;
  /** Whether the pg-boss producer has started; enqueueing fails until it has. */
  queueStarted: () => boolean;
}

export type ReadinessReason =
  "database_unreachable" | "schema_missing" | "schema_incompatible" | "queue_unavailable";

export type Readiness = { ready: true } | { ready: false; reason: ReadinessReason };

// Undefined table or schema, or no privilege on it: migrations have not run, or not fully.
const SCHEMA_MISSING_CODES = new Set(["42P01", "3F000", "42501"]);

/**
 * API readiness: the API's own role reaches the database, the schema tag the
 * migrator recorded equals the one compiled into this build, and the queue
 * producer has started. It never depends on the worker or the web server.
 */
export async function apiReadiness(deps: HealthDependencies): Promise<Readiness> {
  let tag: string | undefined;
  try {
    const { rows } = await deps.pool.query<{ tag: string }>(
      "SELECT tag FROM app.schema_tag WHERE id = 1",
    );
    tag = rows[0]?.tag;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const missing = typeof code === "string" && SCHEMA_MISSING_CODES.has(code);
    return { ready: false, reason: missing ? "schema_missing" : "database_unreachable" };
  }
  if (tag === undefined) return { ready: false, reason: "schema_missing" };
  if (tag !== SCHEMA_TAG) return { ready: false, reason: "schema_incompatible" };
  if (!deps.queueStarted()) return { ready: false, reason: "queue_unavailable" };
  return { ready: true };
}

export type HeartbeatReason =
  "boot_id_unconfigured" | "database_unreachable" | "no_current_boot_row" | "stale";

export type HeartbeatStatus =
  { fresh: true; ageMs: number } | { fresh: false; reason: HeartbeatReason; ageMs?: number };

/**
 * The worker heartbeat for this container boot only. Rows written by an
 * earlier boot, or by anything else, never count, however recent they are.
 */
export async function currentBootHeartbeat(deps: HealthDependencies): Promise<HeartbeatStatus> {
  if (deps.bootId === undefined) return { fresh: false, reason: "boot_id_unconfigured" };
  let rows: Array<{ age_ms: string }>;
  try {
    ({ rows } = await deps.pool.query<{ age_ms: string }>(
      `SELECT floor(extract(epoch FROM now() - observed_at) * 1000)::bigint AS age_ms
         FROM worker.heartbeat WHERE boot_id = $1`,
      [deps.bootId],
    ));
  } catch {
    return { fresh: false, reason: "database_unreachable" };
  }
  const row = rows[0];
  if (row === undefined) return { fresh: false, reason: "no_current_boot_row" };
  const ageMs = Number(row.age_ms);
  return ageMs < HEARTBEAT_FRESHNESS_MS
    ? { fresh: true, ageMs }
    : { fresh: false, reason: "stale", ageMs };
}
