// Shared setup for the fixture authority source gates (D2 to D8). Commands and expected
// values are independently written literals from the frozen oracle
// (docs/oracles/first-slice-oracles.md, C-01 and N-15); none is imported
// from the seed manifest or produced by the source modules' read helpers.
// Results are observed through raw SQL on a separate migrator connection.
import type {
  AmendScheduleCommand,
  CreateTransferRequestCommand,
  ReserveStockCommand,
} from "@supplier-disruption/contracts";
import type pg from "pg";
import { expect } from "vitest";
import { createDemandSource } from "../src/authorities/demand/index.js";
import { createInventorySource } from "../src/authorities/inventory/index.js";
import {
  SourceRejectedError,
  createPurchasingSource,
} from "../src/authorities/purchasing/index.js";
import type { SourceTimeouts } from "../src/authorities/runtime.js";
import { createControlledClock } from "../src/clock.js";
import type { DisposableDatabase } from "./disposable.js";

export const ORG = "ORG-NDL";
const v = "supplier-domain.v1";

/** C-01 ACT-1: PO-120 line 10 at revision 3, split 40 on 2026-10-23 and 80 on 2026-10-26. */
export const ACT_1: AmendScheduleCommand = {
  contractVersion: v,
  kind: "amend_schedule",
  organization: ORG,
  operationId: "OP-ACT-1",
  poNumber: "PO-120",
  poLine: "10",
  uom: "EA",
  expectedRevision: "3",
  planId: "PLAN-1",
  actionId: "ACT-1",
  segments: [
    { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
    { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
  ],
};

/** C-01 ACT-2: reserve 50 EA PART-A at WH-B for PLAN-1, bound to INV-B@1. */
export const ACT_2: ReserveStockCommand = {
  contractVersion: v,
  kind: "reserve",
  organization: ORG,
  operationId: "OP-ACT-2",
  sku: "PART-A",
  warehouse: "WH-B",
  uom: "EA",
  quantity: "50",
  expectedVersion: "INV-B@1",
  planId: "PLAN-1",
  actionId: "ACT-2",
};

/** The stored label of the oracle's `INV-B@1+ACT-2` (ADR 0005). */
export const INV_B_AFTER_ACT_2 = "INV-B@1.ACT-2";

/** C-01 ACT-3: transfer request for TRO-1 drawing on ACT-2's reservation. */
export function act3(
  reservationId: string,
  predecessorReceiptId: string,
): CreateTransferRequestCommand {
  return {
    contractVersion: v,
    kind: "create_transfer_request",
    organization: ORG,
    operationId: "OP-ACT-3",
    optionId: "TRO-1",
    sku: "PART-A",
    uom: "EA",
    from: "WH-B",
    to: "WH-A",
    quantity: "50",
    dispatchDate: "2026-10-22",
    arrivalDate: "2026-10-23",
    expectedStockVersion: INV_B_AFTER_ACT_2,
    reservationId,
    predecessorReceiptId,
    planId: "PLAN-1",
    actionId: "ACT-3",
  };
}

/** The three source modules on an API-role pool, with the controlled business clock. */
export function sources(
  db: DisposableDatabase,
  name: string,
  pool?: pg.Pool,
  timeouts?: Partial<SourceTimeouts>,
) {
  const api = pool ?? db.pool("api", name);
  // The clock has its own pool: a source samples receipt time while holding a
  // connection, so sharing the source pool could exhaust it.
  const clock = createControlledClock(db.pool("api", `${name}-clock`, 2));
  const options = { pool: api, clock, timeouts };
  return {
    pool: api,
    clock,
    purchasing: createPurchasingSource(options),
    inventory: createInventorySource(options),
    demand: createDemandSource(options),
  };
}

/** The refusal reason of a thrown error, failing the test for anything but a source refusal. */
export function refusalReason(error: unknown): string {
  expect(error, "source call should be refused").toBeInstanceOf(SourceRejectedError);
  return (error as SourceRejectedError).reason;
}

/** The refusal reason of a source call, failing the test if it succeeded or threw anything else. */
export async function refusal(call: Promise<unknown>): Promise<string> {
  return refusalReason(
    await call.then(
      () => undefined,
      (thrown: unknown) => thrown,
    ),
  );
}

export async function rows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  observer: pg.Client,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await observer.query<T>(text, values)).rows;
}

export async function poHead(observer: pg.Client): Promise<number> {
  const [row] = await rows<{ revision: number }>(
    observer,
    "SELECT revision FROM fixture_purchasing.po_head WHERE po_number = 'PO-120'",
  );
  return Number(row?.revision);
}

/** Line 10 of PO-120 at a revision: quantities and the accepted schedule. */
export async function poLine(observer: pg.Client, revision: number) {
  const [line] = await rows(
    observer,
    `SELECT ordered::text, received::text, canceled::text, sku, uom, destination
       FROM fixture_purchasing.po_line
      WHERE po_number = 'PO-120' AND revision = $1 AND line_number = '10'`,
    [revision],
  );
  const segments = await rows(
    observer,
    `SELECT sequence, quantity::text, arrival_date::text
       FROM fixture_purchasing.po_line_segment
      WHERE po_number = 'PO-120' AND revision = $1 AND line_number = '10' ORDER BY sequence`,
    [revision],
  );
  return { line, segments };
}

export async function stockHead(observer: pg.Client, warehouse: string): Promise<string> {
  const [row] = await rows<{ version: string }>(
    observer,
    `SELECT version FROM fixture_inventory.stock_head
      WHERE organization = 'ORG-NDL' AND sku = 'PART-A' AND warehouse = $1`,
    [warehouse],
  );
  return String(row?.version);
}

/**
 * Raw buckets of one stock version and ELIG-1 computed here in SQL: physical
 * minus holds, safety stock and each reservation once.
 */
export async function stock(observer: pg.Client, version: string) {
  const [row] = await rows<{ physical: string; eligible: string }>(
    observer,
    `SELECT s.physical::text AS physical,
            (s.physical - s.quality_hold - s.safety_stock
              - coalesce((SELECT sum(r.quantity) FROM fixture_inventory.reservation r
                           WHERE r.snapshot_version = s.version), 0))::text AS eligible
       FROM fixture_inventory.stock_snapshot s WHERE s.version = $1`,
    [version],
  );
  const reservations = await rows(
    observer,
    `SELECT reservation_id, quantity::text, plan_id FROM fixture_inventory.reservation
      WHERE snapshot_version = $1 ORDER BY reservation_id`,
    [version],
  );
  if (row === undefined) throw new Error(`no stock version ${version}`);
  return { ...row, reservations };
}

export async function count(observer: pg.Client, table: string): Promise<number> {
  const [row] = await rows<{ n: number }>(observer, `SELECT count(*)::int AS n FROM ${table}`);
  return Number(row?.n);
}

/** Every row of the named tables with its xmin, so a rewrite with equal values is visible. */
export async function fingerprint(observer: pg.Client, tables: readonly string[]): Promise<string> {
  const parts: unknown[] = [];
  for (const table of tables) {
    parts.push(
      table,
      await rows(
        observer,
        `SELECT xmin::text AS xmin, to_jsonb(t)::text AS row FROM ${table} t ORDER BY 2`,
      ),
    );
  }
  return JSON.stringify(parts);
}

export const DEMAND_TABLES = [
  "fixture_demand.demand_snapshot",
  "fixture_demand.demand_line",
  "fixture_demand.supply_link",
  "fixture_demand.demand_head",
] as const;

/**
 * Waits until `count` backends of the named application are blocked on a
 * lock. This observes ordering in PostgreSQL itself; it never assumes it from
 * elapsed time. pg_locks is readable by every role, unlike other roles' wait
 * events in pg_stat_activity.
 */
export async function lockWaiters(
  observer: pg.Client,
  application: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [row] = await rows<{ n: number }>(
      observer,
      `SELECT count(DISTINCT l.pid)::int AS n
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.application_name = $1 AND NOT l.granted`,
      [application],
    );
    if (Number(row?.n) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(`${application}: ${String(row?.n)} lock waiters, expected ${expected}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Waits for contenders well beyond lockWaiters' 20 s deadline, so a loaded
 * host fails the barrier rather than timing out a contender first.
 */
export const RACE_TIMEOUTS: SourceTimeouts = { lockTimeoutMs: 60_000, statementTimeoutMs: 90_000 };

/**
 * Starts every call behind a held head, waits until PostgreSQL reports each
 * one blocked, then releases them together. The head is released also when
 * the barrier fails, and no call's rejection is left unhandled.
 */
export async function raceBehindHead<T>(
  db: DisposableDatabase,
  observer: pg.Client,
  application: string,
  lockSql: string,
  calls: Array<() => Promise<T>>,
  /** Runs while every call is blocked, before the head is released. */
  whileBlocked?: () => Promise<void>,
): Promise<PromiseSettledResult<T>[]> {
  const blocker = await holdHead(db, lockSql);
  let contenders: Promise<PromiseSettledResult<T>[]>;
  try {
    contenders = Promise.allSettled(calls.map((call) => call()));
    await lockWaiters(observer, application, calls.length);
    await whileBlocked?.();
  } finally {
    await blocker.release();
  }
  return contenders;
}

/**
 * Holds a row lock on a source head from a migrator transaction, so source
 * calls started meanwhile queue behind it; release() lets them run.
 */
export async function holdHead(
  db: DisposableDatabase,
  lockSql: string,
): Promise<{ release: () => Promise<void> }> {
  const blocker = await db.client("migrator", "blocker");
  await blocker.query("BEGIN");
  await blocker.query(lockSql);
  return {
    release: async () => {
      await blocker.query("COMMIT");
    },
  };
}

/** Moves the controlled business clock, as tests do with a direct migrator update. */
export async function setClock(observer: pg.Client, instant: string): Promise<void> {
  await observer.query("UPDATE fixture_reference.business_clock SET instant = $1", [instant]);
}

/** Epoch milliseconds of the stored clock instant, read independently. */
export async function clockEpochMs(observer: pg.Client): Promise<number> {
  const [row] = await rows<{ ms: string }>(
    observer,
    "SELECT (extract(epoch FROM instant) * 1000)::bigint::text AS ms FROM fixture_reference.business_clock",
  );
  return Number(row?.ms);
}
