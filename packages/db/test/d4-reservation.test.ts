// D4 conditional reservation: the inventory source holds the warehouse's stock
// head, checks the bound version and ELIG-1's eligible quantity in its own
// transaction and appends an attributed successor. Observed through raw SQL
// on a separate migrator connection, with ELIG-1 computed there.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import {
  ACT_2,
  INV_B_AFTER_ACT_2,
  fingerprint,
  RACE_TIMEOUTS,
  raceBehindHead,
  refusal,
  refusalReason,
  rows,
  sources,
  stock,
  stockHead,
} from "./source-support.js";

const db = new DisposableDatabase("d4");
let observer: pg.Client;

const INVENTORY_TABLES = [
  "fixture_inventory.stock_head",
  "fixture_inventory.stock_snapshot",
  "fixture_inventory.reservation",
  "fixture_inventory.operation",
  "fixture_inventory.operation_receipt",
  "fixture_inventory.transfer_request",
  "fixture_inventory.in_transit",
] as const;

const WH_A = {
  physical: "40",
  eligible: "30",
  reservations: [{ reservation_id: "RES-A-77", quantity: "10", plan_id: null }],
};
const INV_B_1 = {
  physical: "70",
  eligible: "50",
  reservations: [{ reservation_id: "RES-B-31", quantity: "20", plan_id: null }],
};

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "d4-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

async function reset(): Promise<void> {
  await db.reset();
  observer = await db.client("migrator", "d4-observer");
}

describe("D4 conditional reservation", () => {
  it("refuses 51 EA against fresh INV-B@1 (eligible 50) with no reservation, receipt or version advance", async () => {
    const before = await fingerprint(observer, INVENTORY_TABLES);
    const { inventory } = sources(db, "d4-api-51");
    expect(
      await refusal(inventory.reserve({ ...ACT_2, operationId: "OP-51", quantity: "51" })),
    ).toBe("inventory.insufficient_eligible_stock");
    expect(await fingerprint(observer, INVENTORY_TABLES)).toBe(before);
    expect(await stockHead(observer, "WH-B")).toBe("INV-B@1");
  });

  it("reserves 50 at WH-B for PLAN-1/ACT-2 as the attributed successor of INV-B@1", async () => {
    const { inventory } = sources(db, "d4-api");
    const { replayed, receipt } = await inventory.reserve(ACT_2);
    expect(replayed).toBe(false);
    expect(receipt).toMatchObject({
      kind: "reserve",
      operationId: "OP-ACT-2",
      planId: "PLAN-1",
      actionId: "ACT-2",
      sku: "PART-A",
      warehouse: "WH-B",
      priorVersion: "INV-B@1",
      successorVersion: INV_B_AFTER_ACT_2,
      quantity: "50",
    });

    expect(await stockHead(observer, "WH-B")).toBe(INV_B_AFTER_ACT_2);
    // Physical stays 70, RES-B-31 stays 20 and exactly ACT-2's reservation is added.
    expect(await stock(observer, INV_B_AFTER_ACT_2)).toEqual({
      physical: "70",
      eligible: "0",
      reservations: [
        { reservation_id: "RES-B-31", quantity: "20", plan_id: null },
        { reservation_id: receipt.reservationId, quantity: "50", plan_id: "PLAN-1" },
      ],
    });
    expect(await stock(observer, "INV-B@1")).toEqual(INV_B_1);
    expect(await stockHead(observer, "WH-A")).toBe("INV-A@1");
    expect(await stock(observer, "INV-A@1")).toEqual(WH_A);
    // The successor records its parent and causing receipt.
    expect(
      await rows(
        observer,
        `SELECT receipt_id::text, prior_version, successor_version, reservation_id, plan_id, action_id
           FROM fixture_inventory.operation_receipt WHERE operation_id = 'OP-ACT-2'`,
      ),
    ).toEqual([
      {
        receipt_id: receipt.receiptId,
        prior_version: "INV-B@1",
        successor_version: INV_B_AFTER_ACT_2,
        reservation_id: receipt.reservationId,
        plan_id: "PLAN-1",
        action_id: "ACT-2",
      },
    ]);
    const read = await inventory.readStock({
      organization: "ORG-NDL",
      sku: "PART-A",
      warehouse: "WH-B",
    });
    expect(read.currentVersion).toBe(INV_B_AFTER_ACT_2);
    expect(read.lineage).toEqual({
      parentVersion: "INV-B@1",
      receiptId: receipt.receiptId,
      operationId: "OP-ACT-2",
      planId: "PLAN-1",
      actionId: "ACT-2",
      recordedAt: receipt.recordedAt,
    });
    // The seeded business clock: 09:00 in Copenhagen on 2026-10-21.
    expect(Date.parse(receipt.recordedAt)).toBe(Date.parse("2026-10-21T09:00:00+02:00"));
  });

  it(
    "concurrent contenders bound to the same version cannot overreserve",
    async () => {
      await reset();
      const pool = db.pool("api", "d4-contender");
      const { inventory } = sources(db, "unused", pool, RACE_TIMEOUTS);
      // 30 + 30 exceeds the 50 eligible; distinct plans so no label is shared.
      const results = await raceBehindHead(
        db,
        observer,
        "d4-contender",
        "SELECT 1 FROM fixture_inventory.stock_head WHERE warehouse = 'WH-B' FOR UPDATE",
        [
          () => inventory.reserve({ ...ACT_2, operationId: "OP-C-A", quantity: "30" }),
          () =>
            inventory.reserve({
              ...ACT_2,
              operationId: "OP-C-B",
              quantity: "30",
              planId: "PLAN-7",
              actionId: "ACT-7",
            }),
        ],
      );
      const rejected = results.filter((result) => result.status === "rejected");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(refusalReason(rejected[0]!.reason)).toBe("stale_source_stock");

      const head = await stockHead(observer, "WH-B");
      const current = await stock(observer, head);
      expect(current.physical).toBe("70");
      expect(current.eligible).toBe("20");
      expect(current.reservations.filter((row) => row.plan_id !== null)).toHaveLength(1);
      expect(
        await rows(observer, "SELECT count(*)::int AS n FROM fixture_inventory.operation_receipt"),
      ).toEqual([{ n: 1 }]);
      expect(await stock(observer, "INV-B@1")).toEqual(INV_B_1);
    },
    RESET_TIMEOUT_MS + 30_000,
  );

  it(
    "a foreign RES-B-40 makes INV-B@2; a command bound to INV-B@1 is refused even for 10 EA",
    async () => {
      await reset();
      // Another actor reserves 20 EA at WH-B in the owning fixture.
      await observer.query(`
        BEGIN;
        INSERT INTO fixture_inventory.stock_snapshot
            (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
          SELECT 'INV-B@2', organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock
            FROM fixture_inventory.stock_snapshot WHERE version = 'INV-B@1';
        INSERT INTO fixture_inventory.reservation (snapshot_version, reservation_id, quantity, plan_id)
          VALUES ('INV-B@2', 'RES-B-31', 20, NULL), ('INV-B@2', 'RES-B-40', 20, NULL);
        UPDATE fixture_inventory.stock_head SET version = 'INV-B@2' WHERE warehouse = 'WH-B';
        COMMIT;`);
      expect(await stock(observer, "INV-B@2")).toMatchObject({ physical: "70", eligible: "30" });
      const before = await fingerprint(observer, INVENTORY_TABLES);
      const { inventory } = sources(db, "d4-api-foreign");
      expect(
        await refusal(inventory.reserve({ ...ACT_2, operationId: "OP-STALE", quantity: "10" })),
      ).toBe("stale_source_stock");
      expect(await fingerprint(observer, INVENTORY_TABLES)).toBe(before);
      expect(await stockHead(observer, "WH-B")).toBe("INV-B@2");
    },
    RESET_TIMEOUT_MS + 30_000,
  );
});
