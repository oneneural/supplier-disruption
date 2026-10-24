import { systemClock, type DomainClockMode } from "@supplier-disruption/config";
import type { Clock } from "@supplier-disruption/contracts";
import { createControlledClock } from "@supplier-disruption/db";
import type pg from "pg";

/**
 * Composes the API's business clock: real wall time in system mode, or the
 * fixture clock row read through the API's pool in controlled mode, which
 * configuration accepts only for tests with fixture data, and in the explicit
 * demonstration mode (ADR 0012). Operational timers never use it.
 */
export function composeBusinessClock(mode: DomainClockMode, pool: pg.Pool): Clock {
  return mode === "system" ? systemClock : createControlledClock(pool);
}
