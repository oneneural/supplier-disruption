// D6 source identity and read-back: native idempotency for every mutation,
// changed-request refusal, lookup of actual current records, and source
// observation time kept apart from the injected clock's read time. Expected
// values are oracle literals checked against raw SQL on a migrator connection.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInventorySource } from "../src/authorities/inventory/index.js";
import { createControlledClock } from "../src/clock.js";
import { instantFromPostgres } from "../src/authorities/values.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import {
  ACT_1,
  ACT_2,
  INV_B_AFTER_ACT_2,
  act3,
  clockEpochMs,
  count,
  fingerprint,
  RACE_TIMEOUTS,
  raceBehindHead,
  refusal,
  rows,
  setClock,
  sources,
} from "./source-support.js";

const db = new DisposableDatabase("d6");
let observer: pg.Client;

const ORG = { organization: "ORG-NDL" };
const at = (instant: string) => Date.parse(instant);

const SOURCE_TABLES = [
  "fixture_purchasing.po_head",
  "fixture_purchasing.po_revision",
  "fixture_purchasing.po_line_segment",
  "fixture_purchasing.operation",
  "fixture_purchasing.operation_receipt",
  "fixture_inventory.stock_head",
  "fixture_inventory.stock_snapshot",
  "fixture_inventory.reservation",
  "fixture_inventory.operation",
  "fixture_inventory.operation_receipt",
  "fixture_inventory.transfer_request",
] as const;

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "d6-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

/**
 * Runs two identical calls that both wait behind a held head, then releases
 * them together. whileBlocked runs while both are waiting.
 */
async function concurrently<T>(
  application: string,
  lockSql: string,
  call: (source: ReturnType<typeof sources>) => Promise<T>,
  whileBlocked?: () => Promise<void>,
): Promise<T[]> {
  const source = sources(db, application, db.pool("api", application), RACE_TIMEOUTS);
  const results = await raceBehindHead(
    db,
    observer,
    application,
    lockSql,
    [() => call(source), () => call(source)],
    whileBlocked,
  );
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

/** Receipt business times, read independently as epoch milliseconds. */
async function recordedTimes() {
  return rows(
    observer,
    `SELECT operation_id, (extract(epoch FROM recorded_at) * 1000)::bigint::text AS ms
       FROM fixture_purchasing.operation_receipt
     UNION ALL
     SELECT operation_id, (extract(epoch FROM recorded_at) * 1000)::bigint::text
       FROM fixture_inventory.operation_receipt
     ORDER BY 1`,
  );
}

describe("D6 source identity and read-back", () => {
  it("converts PostgreSQL timestamp text to offset-qualified instants without losing precision", () => {
    expect(instantFromPostgres("2026-10-21 07:00:00+00")).toBe("2026-10-21T07:00:00+00:00");
    expect(instantFromPostgres("2026-10-21 12:25:00.123456+05:30")).toBe(
      "2026-10-21T12:25:00.123456+05:30",
    );
    expect(instantFromPostgres("2026-10-21 03:00:00-04")).toBe("2026-10-21T03:00:00-04:00");
    for (const text of [
      "2026-10-21T07:00:00Z",
      "2026-10-21 07:00:00",
      "1883-01-01 00:00:00+00:50:20",
    ]) {
      expect(() => instantFromPostgres(text), text).toThrow("timestamp");
    }
  });

  it("reads normalize known times, keep null times unknown and separate read time from observation time", async () => {
    const source = sources(db, "d6-api-read");
    const first = await source.inventory.readStock({ ...ORG, sku: "PART-A", warehouse: "WH-A" });
    expect(first.record.version).toBe("INV-A@1");
    expect(first.record.observedAt.state).toBe("known");
    const observed = (first.record.observedAt as { value: string }).value;
    expect(at(observed)).toBe(at("2026-10-21T08:55:00+02:00"));
    expect(at(first.readAt)).toBe(at("2026-10-21T09:00:00+02:00"));
    expect(at(first.readAt)).toBe(await clockEpochMs(observer));

    // The controlled clock advances; the source record and its observation time do not.
    await setClock(observer, "2026-10-21T10:00:00+02:00");
    const second = await source.inventory.readStock({ ...ORG, sku: "PART-A", warehouse: "WH-A" });
    expect(second.record).toEqual(first.record);
    expect(second.currentVersion).toBe("INV-A@1");
    expect(at(second.readAt)).toBe(at("2026-10-21T10:00:00+02:00"));
    expect(at(second.readAt)).toBe(await clockEpochMs(observer));
    expect(
      await rows(
        observer,
        `SELECT (extract(epoch FROM observed_at) * 1000)::bigint::text AS ms
           FROM fixture_inventory.stock_snapshot WHERE version = 'INV-A@1'`,
      ),
    ).toEqual([{ ms: String(at("2026-10-21T08:55:00+02:00")) }]);

    // Null observation and effective times stay unknown, never the clock.
    const po = await source.purchasing.readPurchaseOrder({ ...ORG, poNumber: "PO-120" });
    expect(po.record.observedAt).toEqual({ state: "unknown" });
    // A malformed revision is a validation error, never a database error.
    await expect(
      source.purchasing.readPurchaseOrder({ ...ORG, poNumber: "PO-120", revision: "abc" }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(po.record.effectiveDate).toEqual({ state: "unknown" });
    const demand = await source.demand.readDemand(ORG);
    expect(demand.record.observedAt).toEqual({ state: "unknown" });
    const option = await source.inventory.readTransferOption({ ...ORG, optionId: "TRO-1" });
    expect(at(option.record.validUntil)).toBe(at("2026-10-22T12:00:00+02:00"));

    // A session in another time zone returns other PostgreSQL text for the same instants.
    const kolkata = new pg.Pool({
      connectionString: db.url("api"),
      application_name: "d6-kolkata",
      options: "-c TimeZone=Asia/Kolkata",
      max: 2,
    });
    try {
      const inventory = createInventorySource({
        pool: kolkata,
        clock: createControlledClock(kolkata),
      });
      const shifted = await inventory.readStock({ ...ORG, sku: "PART-A", warehouse: "WH-A" });
      const value = (shifted.record.observedAt as { value: string }).value;
      expect(value).toMatch(/\+05:30$/);
      expect(at(value)).toBe(at("2026-10-21T08:55:00+02:00"));
      const tro = await inventory.readTransferOption({ ...ORG, optionId: "TRO-1" });
      expect(at(tro.record.validUntil)).toBe(at("2026-10-22T12:00:00+02:00"));
    } finally {
      await kolkata.end();
    }
  });

  it("identical concurrent and sequential replays return the existing receipt and one effect, for every mutation", async () => {
    // Each receipt's business time is the clock while the head is held: the
    // clock moves from the instant the calls start to a distinct one while
    // they wait, and the receipt must carry the later instant.
    const T1 = "2026-10-21T10:17:42.123+02:00";
    const T2 = "2026-10-21T10:18:05.456+02:00";
    const T3 = "2026-10-21T10:19:30.789+02:00";
    await setClock(observer, "2026-10-21T10:05:00+02:00");
    const [a1, a2] = await concurrently(
      "d6-act1",
      "SELECT 1 FROM fixture_purchasing.po_head WHERE po_number = 'PO-120' FOR UPDATE",
      (source) => source.purchasing.amendSchedule(ACT_1),
      () => setClock(observer, T1),
    );
    expect([a1!.replayed, a2!.replayed].sort()).toEqual([false, true]);
    expect(a2!.receipt).toEqual(a1!.receipt);
    expect(at(a1!.receipt.recordedAt)).toBe(at(T1));
    expect(await count(observer, "fixture_purchasing.operation_receipt")).toBe(1);
    expect(
      await rows(observer, "SELECT revision FROM fixture_purchasing.po_revision ORDER BY 1"),
    ).toEqual([{ revision: 3 }, { revision: 4 }]);

    const [r1, r2] = await concurrently(
      "d6-act2",
      "SELECT 1 FROM fixture_inventory.stock_head WHERE warehouse = 'WH-B' FOR UPDATE",
      (source) => source.inventory.reserve(ACT_2),
      () => setClock(observer, T2),
    );
    expect([r1!.replayed, r2!.replayed].sort()).toEqual([false, true]);
    expect(r2!.receipt).toEqual(r1!.receipt);
    expect(at(r1!.receipt.recordedAt)).toBe(at(T2));
    expect(
      await rows(
        observer,
        "SELECT count(*)::int AS n FROM fixture_inventory.reservation WHERE plan_id = 'PLAN-1'",
      ),
    ).toEqual([{ n: 1 }]);

    const act3Command = act3(r1!.receipt.reservationId, r1!.receipt.receiptId);
    const [t1, t2] = await concurrently(
      "d6-act3",
      "SELECT 1 FROM fixture_inventory.stock_head WHERE warehouse = 'WH-B' FOR UPDATE",
      (source) => source.inventory.createTransferRequest(act3Command),
      () => setClock(observer, T3),
    );
    expect([t1!.replayed, t2!.replayed].sort()).toEqual([false, true]);
    expect(t2!.receipt).toEqual(t1!.receipt);
    expect(at(t1!.receipt.recordedAt)).toBe(at(T3));
    expect(await count(observer, "fixture_inventory.transfer_request")).toBe(1);
    expect(await recordedTimes()).toEqual([
      { operation_id: "OP-ACT-1", ms: String(at(T1)) },
      { operation_id: "OP-ACT-2", ms: String(at(T2)) },
      { operation_id: "OP-ACT-3", ms: String(at(T3)) },
    ]);
    // The successor's lineage shows when the reservation was added.
    const stockAfter = await sources(db, "d6-api-lineage").inventory.readStock({
      ...ORG,
      sku: "PART-A",
      warehouse: "WH-B",
    });
    expect(stockAfter.lineage).toMatchObject({
      parentVersion: "INV-B@1",
      receiptId: r1!.receipt.receiptId,
    });
    expect(at(stockAfter.lineage!.recordedAt)).toBe(at(T2));

    // Sequential replays after each base has moved on, and after the clock has
    // advanced, still return the original effect and its original time.
    await setClock(observer, "2026-10-21T11:00:00+02:00");
    const before = await fingerprint(observer, SOURCE_TABLES);
    const source = sources(db, "d6-api-replay");
    expect(await source.purchasing.amendSchedule(ACT_1)).toEqual({
      replayed: true,
      receipt: a1!.receipt,
    });
    expect(await source.inventory.reserve(ACT_2)).toEqual({ replayed: true, receipt: r1!.receipt });
    expect(await source.inventory.createTransferRequest(act3Command)).toEqual({
      replayed: true,
      receipt: t1!.receipt,
    });
    expect(await fingerprint(observer, SOURCE_TABLES)).toBe(before);
    expect(await recordedTimes()).toEqual([
      { operation_id: "OP-ACT-1", ms: String(at(T1)) },
      { operation_id: "OP-ACT-2", ms: String(at(T2)) },
      { operation_id: "OP-ACT-3", ms: String(at(T3)) },
    ]);
  }, 60_000);

  it("refuses a changed request, kind or target under a used operation ID, with no effect", async () => {
    const before = await fingerprint(observer, SOURCE_TABLES);
    const { purchasing, inventory } = sources(db, "d6-api-conflict");
    const [act2Receipt] = await rows<{ reservation_id: string; receipt_id: string }>(
      observer,
      "SELECT reservation_id, receipt_id::text FROM fixture_inventory.operation_receipt WHERE operation_id = 'OP-ACT-2'",
    );
    // Each call starts only when its refusal is awaited, so no rejection is unhandled.
    const conflicts = [
      () =>
        purchasing.amendSchedule({
          ...ACT_1,
          segments: [
            { sequence: 1, quantity: "50", arrival: { state: "dated", date: "2026-10-23" } },
            { sequence: 2, quantity: "70", arrival: { state: "dated", date: "2026-10-26" } },
          ],
        }),
      () => purchasing.amendSchedule({ ...ACT_1, expectedRevision: "4" }),
      () => purchasing.amendSchedule({ ...ACT_1, poLine: "20" }),
      () => inventory.reserve({ ...ACT_2, quantity: "49" }),
      () => inventory.reserve({ ...ACT_2, warehouse: "WH-A", expectedVersion: "INV-A@1" }),
      // ACT-2's operation ID reused for another kind.
      () =>
        inventory.createTransferRequest({
          ...act3(act2Receipt!.reservation_id, act2Receipt!.receipt_id),
          operationId: "OP-ACT-2",
        }),
    ];
    for (const [index, call] of conflicts.entries()) {
      expect(await refusal(call()), `conflict ${index}`).toBe("source.operation_conflict");
    }
    expect(await fingerprint(observer, SOURCE_TABLES)).toBe(before);
  });

  it("lookup returns actual current records, not saved success data, and nothing for an absent operation", async () => {
    const { purchasing, inventory } = sources(db, "d6-api-lookup");
    const amended = await purchasing.lookupOperation({ ...ORG, operationId: "OP-ACT-1" });
    expect(amended?.currentRevision).toBe("4");
    expect(amended?.effect.lines[0]?.acceptedSegments).toEqual([
      { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
      { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
    ]);

    // A test controller changes each current effect in its owning fixture.
    const [reservation] = await rows<{ reservation_id: string }>(
      observer,
      "SELECT reservation_id FROM fixture_inventory.operation_receipt WHERE operation_id = 'OP-ACT-2'",
    );
    await observer.query(`
      UPDATE fixture_purchasing.po_line_segment SET arrival_date = '2026-10-27'
       WHERE po_number = 'PO-120' AND revision = 4 AND sequence = 2;
      UPDATE fixture_inventory.reservation SET quantity = 49
       WHERE snapshot_version = '${INV_B_AFTER_ACT_2}' AND reservation_id = '${reservation!.reservation_id}';
      UPDATE fixture_inventory.transfer_request SET quantity = 40;`);

    const changedPo = await purchasing.lookupOperation({ ...ORG, operationId: "OP-ACT-1" });
    expect(changedPo?.receipt).toEqual(amended?.receipt);
    expect(changedPo?.effect.lines[0]?.acceptedSegments[1]).toEqual({
      sequence: 2,
      quantity: "80",
      arrival: { state: "dated", date: "2026-10-27" },
    });
    const reserved = await inventory.lookupOperation({ ...ORG, operationId: "OP-ACT-2" });
    expect(reserved?.receipt).toMatchObject({ kind: "reserve", quantity: "50" });
    expect(reserved).toMatchObject({
      currentVersion: INV_B_AFTER_ACT_2,
      reservation: {
        reservationId: reservation!.reservation_id,
        quantity: "49",
        binding: { kind: "plan", planId: "PLAN-1" },
      },
    });
    const requested = await inventory.lookupOperation({ ...ORG, operationId: "OP-ACT-3" });
    expect(requested?.receipt).toMatchObject({ kind: "create_transfer_request" });
    expect(requested).toMatchObject({ request: { quantity: "40", status: "requested" } });

    // Released by another actor: the current version no longer holds it.
    await observer.query(`
      BEGIN;
      INSERT INTO fixture_inventory.stock_snapshot
          (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
        SELECT 'INV-B@9', organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock
          FROM fixture_inventory.stock_snapshot WHERE version = '${INV_B_AFTER_ACT_2}';
      INSERT INTO fixture_inventory.reservation (snapshot_version, reservation_id, quantity, plan_id)
        VALUES ('INV-B@9', 'RES-B-31', 20, NULL);
      UPDATE fixture_inventory.stock_head SET version = 'INV-B@9' WHERE warehouse = 'WH-B';
      COMMIT;`);
    expect(await inventory.lookupOperation({ ...ORG, operationId: "OP-ACT-2" })).toMatchObject({
      currentVersion: "INV-B@9",
      reservation: null,
    });

    expect(await purchasing.lookupOperation({ ...ORG, operationId: "OP-NEVER" })).toBeNull();
    expect(await inventory.lookupOperation({ ...ORG, operationId: "OP-NEVER" })).toBeNull();
    // Another organization's lookup never sees these operations.
    expect(
      await inventory.lookupOperation({ organization: "ORG-OTHER", operationId: "OP-ACT-2" }),
    ).toBeNull();
  });

  it("decodes dates and times the same under a non-ISO session DateStyle", async () => {
    const legacy = db.pool(
      "api",
      "d6-datestyle",
      4,
      "-c DateStyle=SQL,DMY -c TimeZone=America/New_York",
    );
    expect((await legacy.query("SHOW DateStyle")).rows).toEqual([{ DateStyle: "SQL, DMY" }]);
    const { purchasing, inventory, demand } = sources(db, "d6-api-datestyle", legacy);

    const stock = await inventory.readStock({ ...ORG, sku: "PART-A", warehouse: "WH-A" });
    expect(at((stock.record.observedAt as { value: string }).value)).toBe(
      at("2026-10-21T08:55:00+02:00"),
    );
    const option = await inventory.readTransferOption({ ...ORG, optionId: "TRO-1" });
    expect(at(option.record.validUntil)).toBe(at("2026-10-22T12:00:00+02:00"));
    expect([option.record.dispatchDate, option.record.arrivalDate]).toEqual([
      "2026-10-22",
      "2026-10-23",
    ]);
    const po = await purchasing.readPurchaseOrder({ ...ORG, poNumber: "PO-120", revision: "3" });
    expect(po.record.lines[0]?.acceptedSegments).toEqual([
      { sequence: 1, quantity: "120", arrival: { state: "dated", date: "2026-10-23" } },
    ]);
    expect((await demand.readDemand(ORG)).record.lines.map((line) => line.receiptCutoff)).toEqual([
      "2026-10-23",
      "2026-10-23",
    ]);
    const reserved = await inventory.lookupOperation({ ...ORG, operationId: "OP-ACT-2" });
    expect(at(reserved!.receipt.recordedAt)).toBe(at("2026-10-21T10:18:05.456+02:00"));
  });
});
