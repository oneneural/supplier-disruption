// R4 scoped transfer options and authoritative absence: the inventory
// collection returns every option of one exact SKU, unit and direction whose
// base belongs to the organization, unfiltered and in ID order; valid anchors
// with no match are a complete empty set, a missing anchor or a failure never
// is. Also R5's option bound and purity, including the read-mutates-input
// observer check. Setup and observation use raw SQL on separate migrator
// connections.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  NODE_TIMEOUT_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import {
  ALL_RECORDS,
  CLOCK_START,
  ORG,
  TRANSFER_QUERY,
  TRO_1,
  expectNoEvidence,
  readers,
  recordCounts,
  transferScope,
} from "./reference-support.js";
import { fingerprint, refusal, rows } from "./source-support.js";

const db = new DisposableDatabase("r4");
let observer: pg.Client;

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "r4-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

const okOptions = (records: unknown[], query = TRANSFER_QUERY) => ({
  status: "ok",
  scope: transferScope(query),
  readAt: CLOCK_START,
  observedAt: { state: "unknown" },
  data: { records, complete: true },
});

/** Inserts a supplemental option; unspecified terms are TRO-1's. */
async function addOption(id: string, terms: Record<string, string> = {}): Promise<void> {
  const option = {
    sku: "PART-A",
    uom: "EA",
    from_warehouse: "WH-B",
    to_warehouse: "WH-A",
    quantity: "50",
    dispatch_date: "2026-10-22",
    arrival_date: "2026-10-23",
    cost_minor_units: "16000",
    currency: "EUR",
    valid_until: "2026-10-22T12:00:00+02:00",
    based_on: "INV-B@1",
    owner_role: "warehouse_planner",
    ...terms,
  };
  await observer.query(
    `INSERT INTO fixture_inventory.transfer_option
       (option_id, sku, uom, from_warehouse, to_warehouse, quantity, dispatch_date, arrival_date,
        cost_minor_units, currency, valid_until, based_on, owner_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, ...Object.values(option)],
  );
}

/** The option a supplemental row reads as: TRO-1's terms on a UTC session, with changes. */
const option = (optionId: string, changes: Record<string, unknown> = {}) => ({
  ...TRO_1,
  optionId,
  ...changes,
});

const matching = `SELECT count(*)::int AS n FROM fixture_inventory.transfer_option o
                    JOIN fixture_inventory.stock_snapshot s ON s.version = o.based_on
                   WHERE o.sku = 'PART-A' AND o.uom = 'EA' AND o.from_warehouse = 'WH-B'
                     AND o.to_warehouse = 'WH-A' AND s.organization = 'ORG-NDL'`;

describe("R4 scoped transfer options and authoritative absence", () => {
  it("R5: a scope of exactly 100 options is complete; 101 is unavailable with no prefix", async () => {
    // Supplemental same-scope options TRO-B002 to TRO-B100; the seed supplies TRO-1.
    await observer.query(`
      INSERT INTO fixture_inventory.transfer_option
        (option_id, sku, uom, from_warehouse, to_warehouse, quantity, dispatch_date, arrival_date,
         cost_minor_units, currency, valid_until, based_on, owner_role)
      SELECT 'TRO-B' || lpad(n::text, 3, '0'), 'PART-A', 'EA', 'WH-B', 'WH-A', 50, '2026-10-22',
             '2026-10-23', 16000, 'EUR', '2026-10-22T12:00:00+02:00', 'INV-B@1', 'warehouse_planner'
        FROM generate_series(2, 100) AS n`);
    expect(await rows(observer, matching)).toEqual([{ n: 100 }]);
    const { inventory } = readers(db, "r4-bound");
    const full = await inventory.readTransferOptions(TRANSFER_QUERY);
    expect(full).toMatchObject({ status: "ok", data: { complete: true } });
    // Option ID order, byte-wise: TRO-1 sorts before TRO-B002.
    expect(full.status === "ok" && full.data.records.map((record) => record.optionId)).toEqual([
      "TRO-1",
      ...Array.from({ length: 99 }, (_, index) => `TRO-B${String(index + 2).padStart(3, "0")}`),
    ]);

    await addOption("TRO-B101");
    expect(await rows(observer, matching)).toEqual([{ n: 101 }]);
    const over = await inventory.readTransferOptions(TRANSFER_QUERY);
    expect(over).toEqual({
      status: "unavailable",
      scope: transferScope(),
      reason: "collection_bound_exceeded",
      attemptedAt: CLOCK_START,
    });
    expectNoEvidence(over);
    await observer.query(
      "DELETE FROM fixture_inventory.transfer_option WHERE option_id LIKE 'TRO-B%'",
    );
    expect(await rows(observer, matching)).toEqual([{ n: 1 }]);
  });

  it("valid ORG-NDL anchors return exactly TRO-1 with its full terms and exact scope", async () => {
    expect(
      await rows(
        observer,
        `SELECT option_id, quantity::text, cost_minor_units::text, currency, dispatch_date::text,
                arrival_date::text, (valid_until = '2026-10-22T12:00:00+02:00') AS valid_until_matches,
                based_on, owner_role
           FROM fixture_inventory.transfer_option`,
      ),
    ).toEqual([
      {
        option_id: "TRO-1",
        quantity: "50",
        cost_minor_units: "16000",
        currency: "EUR",
        dispatch_date: "2026-10-22",
        arrival_date: "2026-10-23",
        valid_until_matches: true,
        based_on: "INV-B@1",
        owner_role: "warehouse_planner",
      },
    ]);
    const { inventory } = readers(db, "r4-canonical");
    expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toEqual(okOptions([TRO_1]));
  });

  it("without TRO-1 the valid scope is a complete empty set, and a singular miss alone never proves it", async () => {
    await observer.query("DELETE FROM fixture_inventory.transfer_option WHERE option_id = 'TRO-1'");
    expect(await rows(observer, matching)).toEqual([{ n: 0 }]);
    const { inventory } = readers(db, "r4-absent");
    expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toEqual(okOptions([]));
    // The singular read keeps its throwing contract.
    expect(
      await refusal(inventory.readTransferOption({ organization: ORG, optionId: "TRO-1" })),
    ).toBe("source.not_found");

    // Supplemental same-scope option, with TRO-1 still absent.
    await addOption("TRO-7", { quantity: "30", cost_minor_units: "9000" });
    expect(
      await refusal(inventory.readTransferOption({ organization: ORG, optionId: "TRO-1" })),
    ).toBe("source.not_found");
    expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toEqual(
      okOptions([option("TRO-7", { quantity: "30", cost: { minorUnits: 9000, currency: "EUR" } })]),
    );
  });

  it("no option of another SKU, unit, direction, destination or foreign base leaks into the scope", async () => {
    // Supplemental snapshots each option is based on, so every one is otherwise valid.
    await observer.query(`
      INSERT INTO fixture_inventory.stock_snapshot
        (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
      VALUES ('INV-PB@1', 'ORG-NDL', 'PART-B', 'WH-B', 'EA', NULL, 70, 0, 0),
             ('INV-BC@1', 'ORG-NDL', 'PART-A', 'WH-B', 'CTN', NULL, 7, 0, 0),
             ('INV-C@1', 'ORG-NDL', 'PART-A', 'WH-C', 'EA', NULL, 70, 0, 0),
             ('INV-F@1', 'ORG-FOREIGN', 'PART-A', 'WH-B', 'EA', NULL, 70, 0, 0)`);
    await addOption("TRO-SKU", { sku: "PART-B", based_on: "INV-PB@1" });
    await addOption("TRO-UOM", { uom: "CTN", quantity: "5", based_on: "INV-BC@1" });
    await addOption("TRO-DIR", {
      from_warehouse: "WH-A",
      to_warehouse: "WH-B",
      based_on: "INV-A@1",
    });
    await addOption("TRO-DEST", { to_warehouse: "WH-C" });
    // Another source warehouse into the same destination; WH-C has a snapshot but no head.
    await addOption("TRO-SRC", { from_warehouse: "WH-C", based_on: "INV-C@1" });
    await addOption("TRO-FOREIGN", { based_on: "INV-F@1" });
    const { inventory } = readers(db, "r4-leaks");
    const canonical = okOptions([
      option("TRO-7", { quantity: "30", cost: { minorUnits: 9000, currency: "EUR" } }),
    ]);
    expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toEqual(canonical);
    // The reverse direction is its own scope and holds only its own option.
    const reverse = { ...TRANSFER_QUERY, fromWarehouse: "WH-A", toWarehouse: "WH-B" };
    expect(await inventory.readTransferOptions(reverse)).toEqual(
      okOptions([option("TRO-DIR", { from: "WH-A", to: "WH-B", basedOn: "INV-A@1" })], reverse),
    );
    // The foreign option is not readable as ORG-NDL's, singularly either.
    expect(
      await refusal(inventory.readTransferOption({ organization: ORG, optionId: "TRO-FOREIGN" })),
    ).toBe("source.not_found");
  });

  it("returns late, expired and retained-base options unchanged, in ID order, with no judgement", async () => {
    // Supplemental retained (non-head) WH-B version and three same-scope options.
    await observer.query(`
      INSERT INTO fixture_inventory.stock_snapshot
        (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
      VALUES ('INV-B@0', 'ORG-NDL', 'PART-A', 'WH-B', 'EA', NULL, 90, 0, 0)`);
    await addOption("TRO-RET", { based_on: "INV-B@0" });
    await addOption("TRO-LATE", { arrival_date: "2026-10-30", dispatch_date: "2026-10-29" });
    await addOption("TRO-EXP", {
      valid_until: "2026-10-01T12:00:00+02:00",
      cost_minor_units: "99000",
    });
    const { inventory } = readers(db, "r4-unfiltered");
    expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toEqual(
      okOptions([
        option("TRO-7", { quantity: "30", cost: { minorUnits: 9000, currency: "EUR" } }),
        option("TRO-EXP", {
          validUntil: "2026-10-01T10:00:00+00:00",
          cost: { minorUnits: 99000, currency: "EUR" },
        }),
        option("TRO-LATE", { dispatchDate: "2026-10-29", arrivalDate: "2026-10-30" }),
        option("TRO-RET", { basedOn: "INV-B@0" }),
      ]),
    );
  });

  it("a missing scope anchor is not found, never a successful empty set", async () => {
    const { inventory } = readers(db, "r4-anchors");
    const queries = [
      { ...TRANSFER_QUERY, sku: "PART-B" },
      { ...TRANSFER_QUERY, toWarehouse: "WH-C" },
      { ...TRANSFER_QUERY, fromWarehouse: "WH-C" },
      { ...TRANSFER_QUERY, organization: "ORG-FOREIGN" },
      { ...TRANSFER_QUERY, uom: "CTN" },
    ];
    for (const query of queries) {
      expect(await inventory.readTransferOptions(query), JSON.stringify(query)).toEqual({
        status: "not_found",
        scope: transferScope(query),
        readAt: CLOCK_START,
        reason: "scope_anchor_not_found",
      });
    }
    // A malformed query is invalid, not absent.
    for (const query of [
      { ...TRANSFER_QUERY, toWarehouse: "WH-B" },
      { ...TRANSFER_QUERY, uom: "ea" },
      { ...TRANSFER_QUERY, optionId: "TRO-1" },
    ]) {
      expect(await inventory.readTransferOptions(query), JSON.stringify(query)).toMatchObject({
        status: "unavailable",
        reason: "invalid_query",
      });
    }
  });

  it("heads agreeing on another unit are not found; heads disagreeing on the unit are invalid data", async () => {
    const { inventory } = readers(db, "r4-units");
    const ctn = { ...TRANSFER_QUERY, uom: "CTN" };
    const head = (warehouse: string, version: string) =>
      observer.query(
        `UPDATE fixture_inventory.stock_head SET version = $2
          WHERE organization = 'ORG-NDL' AND sku = 'PART-A' AND warehouse = $1`,
        [warehouse, version],
      );
    // Supplemental PART-A WH-A carton snapshot; INV-BC@1 (WH-B, CTN) and its
    // carton option TRO-UOM were added by the leak test.
    await observer.query(`
      INSERT INTO fixture_inventory.stock_snapshot
        (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
      VALUES ('INV-AC@1', 'ORG-NDL', 'PART-A', 'WH-A', 'CTN', NULL, 3, 0, 0)`);

    // WH-B stocks PART-A in EA and WH-A in CTN: inconsistent, whichever unit is asked.
    await head("WH-A", "INV-AC@1");
    for (const query of [TRANSFER_QUERY, ctn]) {
      const result = await inventory.readTransferOptions(query);
      expect(result, query.uom).toEqual({
        status: "unavailable",
        scope: transferScope(query),
        reason: "invalid_data",
        attemptedAt: CLOCK_START,
      });
      expectNoEvidence(result);
    }

    // Both heads in CTN: no EA scope exists, and the CTN scope holds its option.
    await head("WH-B", "INV-BC@1");
    expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toEqual({
      status: "not_found",
      scope: transferScope(),
      readAt: CLOCK_START,
      reason: "scope_anchor_not_found",
    });
    expect(await inventory.readTransferOptions(ctn)).toEqual(
      okOptions([option("TRO-UOM", { uom: "CTN", quantity: "5", basedOn: "INV-BC@1" })], ctn),
    );

    await head("WH-A", "INV-A@1");
    await head("WH-B", "INV-B@1");
    expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toMatchObject({ status: "ok" });
  });

  it("a head or included base that is not the scope's stock is invalid data", async () => {
    const { inventory } = readers(db, "r4-corrupt");
    // Supplemental PART-B snapshot at WH-A, then the PART-A WH-A head pointed at it.
    await observer.query(`
      INSERT INTO fixture_inventory.stock_snapshot
        (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
      VALUES ('INV-X@1', 'ORG-NDL', 'PART-B', 'WH-A', 'EA', NULL, 1, 0, 0);
      UPDATE fixture_inventory.stock_head SET version = 'INV-X@1'
       WHERE organization = 'ORG-NDL' AND sku = 'PART-A' AND warehouse = 'WH-A'`);
    expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toEqual({
      status: "unavailable",
      scope: transferScope(),
      reason: "invalid_data",
      attemptedAt: CLOCK_START,
    });
    await observer.query(`
      UPDATE fixture_inventory.stock_head SET version = 'INV-A@1'
       WHERE organization = 'ORG-NDL' AND sku = 'PART-A' AND warehouse = 'WH-A'`);

    // Supplemental same-scope options based on another warehouse's or unit's stock.
    for (const [id, base] of [
      ["TRO-BAD-WH", "INV-A@1"],
      ["TRO-BAD-UOM", "INV-BC@1"],
      ["TRO-BAD-SKU", "INV-PB@1"],
    ] as const) {
      await addOption(id, { based_on: base });
      const result = await inventory.readTransferOptions(TRANSFER_QUERY);
      expect(result, id).toMatchObject({ status: "unavailable", reason: "invalid_data" });
      expectNoEvidence(result);
      await observer.query("DELETE FROM fixture_inventory.transfer_option WHERE option_id = $1", [
        id,
      ]);
    }
    expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toMatchObject({ status: "ok" });
  });

  it(
    "a permission or connection failure stays unavailable and carries no successful data or read time",
    async () => {
      await observer.query("REVOKE SELECT ON fixture_inventory.transfer_option FROM sd_api");
      const { inventory } = readers(db, "r4-revoked");
      const revoked = await inventory.readTransferOptions(TRANSFER_QUERY);
      expect(revoked).toEqual({
        status: "unavailable",
        scope: transferScope(),
        reason: "permission_denied",
        attemptedAt: CLOCK_START,
      });
      expectNoEvidence(revoked);
      expect((await db.migrate()).code).toBe(0);
      expect(await inventory.readTransferOptions(TRANSFER_QUERY)).toMatchObject({ status: "ok" });

      const ended = readers(db, "r4-ended");
      await ended.pool.end();
      const closed = await ended.inventory.readTransferOptions(TRANSFER_QUERY);
      expect(closed).toEqual({
        status: "unavailable",
        scope: transferScope(),
        reason: "connection_unavailable",
        attemptedAt: CLOCK_START,
      });
      expectNoEvidence(closed);
    },
    NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it("R5: option reads change no source, reference or application record", async () => {
    // Every setup write is above; nothing else writes during the measured interval.
    const second = await db.client("migrator", "r4-second-observer");
    const before = await fingerprint(observer, ALL_RECORDS);
    const counts = await recordCounts(second);
    const { inventory } = readers(db, "r4-purity");
    const results = await Promise.all([
      inventory.readTransferOptions(TRANSFER_QUERY),
      inventory.readTransferOptions({
        ...TRANSFER_QUERY,
        fromWarehouse: "WH-A",
        toWarehouse: "WH-B",
      }),
      inventory.readTransferOptions({ ...TRANSFER_QUERY, sku: "PART-B" }),
      inventory.readTransferOptions({ ...TRANSFER_QUERY, toWarehouse: "WH-B" }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "ok",
      "ok",
      "not_found",
      "unavailable",
    ]);
    expect(await fingerprint(observer, ALL_RECORDS)).toBe(before);
    expect(await recordCounts(second)).toEqual(counts);
  });
});
