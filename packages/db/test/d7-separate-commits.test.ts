// D7 separate commits and response loss: each source commits on its own,
// independently of the caller and of the other source. Two tiny wrappers
// stand in for transport faults: one rejects before the call is made, the
// other discards the response after the call has actually committed. No
// application journal, restart or recovery is claimed here.
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
  ACT_1,
  ACT_2,
  INV_B_AFTER_ACT_2,
  act3,
  count,
  poHead,
  poLine,
  rows,
  sources,
  stock,
  stockHead,
} from "./source-support.js";

const db = new DisposableDatabase("d7");
let observer: pg.Client;

const ORG = { organization: "ORG-NDL" };

/** The call is never made: a definitive failure before submission. */
async function rejectBeforeCall(_call: () => Promise<unknown>): Promise<never> {
  return Promise.reject(new Error("rejected before the call"));
}

/** The call commits, then its response is thrown away. */
async function loseResponse(call: () => Promise<unknown>): Promise<never> {
  await call();
  throw new Error("response lost after the call");
}

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "d7-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

async function inventoryEffects() {
  return rows(
    observer,
    `SELECT (SELECT count(*) FROM fixture_inventory.operation)::int AS operations,
            (SELECT count(*) FROM fixture_inventory.transfer_request)::int AS requests,
            (SELECT count(*) FROM fixture_inventory.reservation WHERE plan_id IS NOT NULL)::int AS plan_reservations`,
  );
}

describe("D7 separate commits and response loss", () => {
  it("purchasing commits and inventory fails before any effect: only PO-120@4 exists", async () => {
    const { purchasing, inventory } = sources(db, "d7-api");
    await purchasing.amendSchedule(ACT_1);
    await expect(rejectBeforeCall(() => inventory.reserve(ACT_2))).rejects.toThrow(
      "rejected before the call",
    );

    expect(await poHead(observer)).toBe(4);
    expect((await poLine(observer, 4)).segments).toEqual([
      { sequence: 1, quantity: "40", arrival_date: "2026-10-23" },
      { sequence: 2, quantity: "80", arrival_date: "2026-10-26" },
    ]);
    expect(await stockHead(observer, "WH-B")).toBe("INV-B@1");
    expect(await inventoryEffects()).toEqual([
      { operations: 0, requests: 0, plan_reservations: 0 },
    ]);
    expect(await inventory.lookupOperation({ ...ORG, operationId: "OP-ACT-2" })).toBeNull();
  });

  it("inventory commits but the response is lost: one reservation is found by its operation ID", async () => {
    const { inventory } = sources(db, "d7-api-reserve");
    await expect(loseResponse(() => inventory.reserve(ACT_2))).rejects.toThrow("response lost");

    const found = await rows<{ reservation_id: string; successor_version: string }>(
      observer,
      `SELECT reservation_id, successor_version FROM fixture_inventory.operation_receipt
        WHERE operation_id = 'OP-ACT-2'`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.successor_version).toBe(INV_B_AFTER_ACT_2);
    expect((await stock(observer, INV_B_AFTER_ACT_2)).reservations).toEqual([
      { reservation_id: "RES-B-31", quantity: "20", plan_id: null },
      { reservation_id: found[0]!.reservation_id, quantity: "50", plan_id: "PLAN-1" },
    ]);

    // Read-back by operation ID before any retry finds the native record.
    const lookup = await inventory.lookupOperation({ ...ORG, operationId: "OP-ACT-2" });
    expect(lookup).toMatchObject({
      receipt: { kind: "reserve", reservationId: found[0]!.reservation_id },
      reservation: { reservationId: found[0]!.reservation_id, quantity: "50" },
    });
    // A retry of the same command returns that effect and adds none.
    expect((await inventory.reserve(ACT_2)).replayed).toBe(true);
    expect(await inventoryEffects()).toEqual([
      { operations: 1, requests: 0, plan_reservations: 1 },
    ]);
    // The parent version keeps no plan reservation; its successor holds exactly one.
    expect(
      await rows(
        observer,
        `SELECT snapshot_version FROM fixture_inventory.reservation WHERE plan_id = 'PLAN-1'`,
      ),
    ).toEqual([{ snapshot_version: INV_B_AFTER_ACT_2 }]);
  });

  it("the transfer request commits but the response is lost: one request is found by its operation ID", async () => {
    const { inventory } = sources(db, "d7-api-transfer");
    const [act2] = await rows<{ reservation_id: string; receipt_id: string }>(
      observer,
      "SELECT reservation_id, receipt_id::text FROM fixture_inventory.operation_receipt WHERE operation_id = 'OP-ACT-2'",
    );
    const command = act3(act2!.reservation_id, act2!.receipt_id);
    await expect(loseResponse(() => inventory.createTransferRequest(command))).rejects.toThrow(
      "response lost",
    );

    const found = await rows<{ transfer_request_id: string }>(
      observer,
      `SELECT transfer_request_id FROM fixture_inventory.operation_receipt WHERE operation_id = 'OP-ACT-3'`,
    );
    expect(found).toHaveLength(1);
    expect(
      await rows(
        observer,
        "SELECT request_id, status, quantity::text FROM fixture_inventory.transfer_request",
      ),
    ).toEqual([{ request_id: found[0]!.transfer_request_id, status: "requested", quantity: "50" }]);
    expect(await inventory.lookupOperation({ ...ORG, operationId: "OP-ACT-3" })).toMatchObject({
      request: { requestId: found[0]!.transfer_request_id, quantity: "50" },
    });
    expect((await inventory.createTransferRequest(command)).replayed).toBe(true);
    expect(await count(observer, "fixture_inventory.transfer_request")).toBe(1);
  });

  it(
    "a caller's rolled-back acknowledgement transaction cannot remove the source commits",
    async () => {
      await db.reset();
      observer = await db.client("migrator", "d7-observer");
      const { purchasing, inventory } = sources(db, "d7-api-caller");
      // The caller's own application transaction, on its own API connection.
      const caller = await db.client("api", "d7-caller");
      await caller.query("BEGIN");
      await caller.query(
        `INSERT INTO auth.verification (id, identifier, value, expires_at)
         VALUES ('d7-ack', 'd7', 'acknowledged', now() + interval '1 hour')`,
      );
      const amended = await purchasing.amendSchedule(ACT_1);
      const reserved = await inventory.reserve(ACT_2);
      // The source commits are visible to an independent observer before the caller ends.
      expect(await poHead(observer)).toBe(4);
      expect(await stockHead(observer, "WH-B")).toBe(INV_B_AFTER_ACT_2);
      await caller.query("ROLLBACK");

      expect(await rows(observer, "SELECT id FROM auth.verification WHERE id = 'd7-ack'")).toEqual(
        [],
      );
      expect(await poHead(observer)).toBe(4);
      expect(await stockHead(observer, "WH-B")).toBe(INV_B_AFTER_ACT_2);
      expect(
        await rows(
          observer,
          `SELECT receipt_id::text FROM fixture_purchasing.operation_receipt
           UNION ALL SELECT receipt_id::text FROM fixture_inventory.operation_receipt ORDER BY 1`,
        ),
      ).toEqual(
        [amended.receipt.receiptId, reserved.receipt.receiptId]
          .sort()
          .map((receipt_id) => ({ receipt_id })),
      );
    },
    RESET_TIMEOUT_MS + 30_000,
  );
});
