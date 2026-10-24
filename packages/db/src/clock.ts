import { instantSchema, type Clock } from "@supplier-disruption/contracts";
import type pg from "pg";

/** The controlled clock row is missing or does not hold a usable instant. */
export class BusinessClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessClockError";
  }
}

/**
 * Test-mode business clock. Every `now()` reads the fixture clock row; nothing
 * is cached, so every instance sharing the database sees each advance. A
 * missing or unusable row fails the call and never falls back to wall time.
 * Instants are returned in UTC with millisecond precision.
 */
export function createControlledClock(database: pg.Pool | pg.ClientBase): Clock {
  return {
    async now() {
      const { rows } = await database.query<{ instant: string | null }>(
        `SELECT to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS instant
           FROM fixture_reference.business_clock WHERE id = 1`,
      );
      const [row] = rows;
      if (row === undefined) {
        throw new BusinessClockError("the controlled business clock row is missing");
      }
      const parsed = instantSchema.safeParse(row.instant);
      if (!parsed.success) {
        throw new BusinessClockError("the controlled business clock row holds no usable instant");
      }
      return parsed.data;
    },
  };
}
