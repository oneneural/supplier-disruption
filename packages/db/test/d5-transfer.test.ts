// D5 transfer conservation: a transfer request draws on ACT-2's existing
// reservation, links it once and moves no stock. Observed through raw SQL on
// a separate migrator connection.
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
  act3,
  count,
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

const db = new DisposableDatabase("d5");
let observer: pg.Client;
let reservationId: string;
let receiptId: string;

const SOURCE_TABLES = [
  "fixture_inventory.stock_head",
  "fixture_inventory.stock_snapshot",
  "fixture_inventory.reservation",
  "fixture_inventory.operation",
  "fixture_inventory.operation_receipt",
  "fixture_inventory.transfer_request",
  "fixture_inventory.in_transit",
  "fixture_purchasing.po_line",
] as const;

/** Physical stock, transit and goods received, none of which a request may change. */
async function conserved() {
  return {
    heads: [await stockHead(observer, "WH-A"), await stockHead(observer, "WH-B")],
    whA: await stock(observer, "INV-A@1"),
    whB: await stock(observer, INV_B_AFTER_ACT_2),
    snapshots: await count(observer, "fixture_inventory.stock_snapshot"),
    inTransit: await count(observer, "fixture_inventory.in_transit"),
    received: await rows(observer, "SELECT received::text FROM fixture_purchasing.po_line"),
  };
}

async function prepare(): Promise<void> {
  observer = await db.client("migrator", "d5-observer");
  const { inventory } = sources(db, "d5-setup");
  const { receipt } = await inventory.reserve(ACT_2);
  reservationId = receipt.reservationId;
  receiptId = receipt.receiptId;
}

beforeAll(async () => {
  await db.start();
  await db.prepare();
  await prepare();
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

describe("D5 transfer conservation", () => {
  it("refuses a missing, unrelated, wrong-plan, wrong-SKU or wrong-quantity reservation and a stale stock version", async () => {
    const before = await fingerprint(observer, SOURCE_TABLES);
    const { inventory } = sources(db, "d5-api-refusals");
    const command = act3(reservationId, receiptId);
    const cases = [
      [{ reservationId: "RSV-MISSING" }, "inventory.reservation_mismatch"],
      [{ reservationId: "RES-B-31", quantity: "20" }, "inventory.reservation_mismatch"],
      [{ planId: "PLAN-9" }, "inventory.reservation_mismatch"],
      [{ quantity: "40" }, "inventory.reservation_mismatch"],
      [{ sku: "PART-B" }, "source.not_found"],
      [{ expectedStockVersion: "INV-B@1" }, "stale_source_stock"],
      [{ optionId: "TRO-9" }, "inventory.transfer_option_mismatch"],
      [{ arrivalDate: "2026-10-24" }, "inventory.transfer_option_mismatch"],
      [
        { predecessorReceiptId: "00000000-0000-4000-8000-000000000000" },
        "inventory.predecessor_receipt_mismatch",
      ],
    ] as const;
    for (const [index, [change, reason]] of cases.entries()) {
      expect(
        await refusal(
          inventory.createTransferRequest({
            ...command,
            ...change,
            operationId: `OP-BAD-${index}`,
          }),
        ),
        JSON.stringify(change),
      ).toBe(reason);
    }
    expect(await fingerprint(observer, SOURCE_TABLES)).toBe(before);
  });

  it("creates one requested WH-B to WH-A transfer of 50 EA for TRO-1 on ACT-2's reservation, moving no stock", async () => {
    const before = await conserved();
    expect(before.whB).toMatchObject({ physical: "70", eligible: "0" });
    const { inventory } = sources(db, "d5-api");
    const command = act3(reservationId, receiptId);
    const { replayed, receipt } = await inventory.createTransferRequest(command);
    expect(replayed).toBe(false);
    expect(receipt).toMatchObject({
      kind: "create_transfer_request",
      operationId: "OP-ACT-3",
      planId: "PLAN-1",
      actionId: "ACT-3",
      stockVersion: INV_B_AFTER_ACT_2,
      reservationId,
      requestVersion: 1,
    });

    expect(
      await rows(
        observer,
        `SELECT request_id, version, status, option_id, sku, uom, from_warehouse, to_warehouse,
                quantity::text, dispatch_date::text, arrival_date::text, stock_version,
                reservation_id, plan_id
           FROM fixture_inventory.transfer_request`,
      ),
    ).toEqual([
      {
        request_id: receipt.transferRequestId,
        version: 1,
        status: "requested",
        option_id: "TRO-1",
        sku: "PART-A",
        uom: "EA",
        from_warehouse: "WH-B",
        to_warehouse: "WH-A",
        quantity: "50",
        dispatch_date: "2026-10-22",
        arrival_date: "2026-10-23",
        stock_version: INV_B_AFTER_ACT_2,
        reservation_id: reservationId,
        plan_id: "PLAN-1",
      },
    ]);
    expect(
      await rows(
        observer,
        `SELECT kind, prior_version, successor_version, reservation_id, transfer_request_id
           FROM fixture_inventory.operation_receipt WHERE operation_id = 'OP-ACT-3'`,
      ),
    ).toEqual([
      {
        kind: "create_transfer_request",
        prior_version: INV_B_AFTER_ACT_2,
        successor_version: null,
        reservation_id: reservationId,
        transfer_request_id: receipt.transferRequestId,
      },
    ]);
    // No stock version, physical, transit or goods receipt change; WH-A gains nothing.
    expect(await conserved()).toEqual(before);
    expect(before.whA).toEqual({
      physical: "40",
      eligible: "30",
      reservations: [{ reservation_id: "RES-A-77", quantity: "10", plan_id: null }],
    });

    // An identical replay returns the same receipt and creates no second request.
    const again = await inventory.createTransferRequest(command);
    expect(again).toEqual({ replayed: true, receipt });
    expect(await count(observer, "fixture_inventory.transfer_request")).toBe(1);
  });

  it(
    "two distinct operations racing for ACT-2's reservation yield exactly one request and one linkage",
    async () => {
      await db.reset();
      await prepare();
      const before = await conserved();
      const pool = db.pool("api", "d5-contender");
      const { inventory } = sources(db, "unused", pool, RACE_TIMEOUTS);
      const command = act3(reservationId, receiptId);
      const results = await raceBehindHead(
        db,
        observer,
        "d5-contender",
        "SELECT 1 FROM fixture_inventory.stock_head WHERE warehouse = 'WH-B' FOR UPDATE",
        [
          () => inventory.createTransferRequest({ ...command, operationId: "OP-RACE-A" }),
          () => inventory.createTransferRequest({ ...command, operationId: "OP-RACE-B" }),
        ],
      );
      const rejected = results.filter((result) => result.status === "rejected");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(refusalReason(rejected[0]!.reason)).toBe("inventory.reservation_already_linked");

      expect(
        await rows(
          observer,
          "SELECT reservation_id, quantity::text FROM fixture_inventory.transfer_request",
        ),
      ).toEqual([{ reservation_id: reservationId, quantity: "50" }]);
      expect(
        await rows(
          observer,
          `SELECT count(*)::int AS n FROM fixture_inventory.operation_receipt
            WHERE kind = 'create_transfer_request'`,
        ),
      ).toEqual([{ n: 1 }]);
      expect(await conserved()).toEqual(before);
    },
    RESET_TIMEOUT_MS + 30_000,
  );

  it(
    "a foreign stock change after ACT-2 is refused as stale_source_stock",
    async () => {
      await db.reset();
      await prepare();
      // Another actor adds RES-B-40 on top of ACT-2's successor.
      await observer.query(`
        BEGIN;
        INSERT INTO fixture_inventory.stock_snapshot
            (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
          SELECT 'INV-B@3', organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock
            FROM fixture_inventory.stock_snapshot WHERE version = '${INV_B_AFTER_ACT_2}';
        INSERT INTO fixture_inventory.reservation (snapshot_version, reservation_id, quantity, plan_id)
          SELECT 'INV-B@3', reservation_id, quantity, plan_id FROM fixture_inventory.reservation
           WHERE snapshot_version = '${INV_B_AFTER_ACT_2}';
        INSERT INTO fixture_inventory.reservation (snapshot_version, reservation_id, quantity, plan_id)
          VALUES ('INV-B@3', 'RES-B-40', 5, NULL);
        UPDATE fixture_inventory.stock_head SET version = 'INV-B@3' WHERE warehouse = 'WH-B';
        COMMIT;`);
      const { inventory } = sources(db, "d5-api-foreign");
      expect(await refusal(inventory.createTransferRequest(act3(reservationId, receiptId)))).toBe(
        "stale_source_stock",
      );
      expect(await count(observer, "fixture_inventory.transfer_request")).toBe(0);
    },
    RESET_TIMEOUT_MS + 30_000,
  );
});
