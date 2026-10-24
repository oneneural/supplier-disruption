// D8 demand and bucket separation: demand is read-only with explicit supply
// links, in-transit stock is neither physical nor eligible, and accepted
// inbound stays apart from proposed segments. Expected values are oracle
// literals (C-01 canonical base and N-15) checked against raw SQL.
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
  DEMAND_TABLES,
  act3,
  fingerprint,
  poLine,
  refusal,
  rows,
  sources,
  stock,
  stockHead,
} from "./source-support.js";

const db = new DisposableDatabase("d8");
let observer: pg.Client;

const ORG = { organization: "ORG-NDL" };
const v = "supplier-domain.v1";

function demandLine(salesOrder: string, open: string, priority: number) {
  return {
    salesOrder,
    line: "10",
    sku: "PART-A",
    uom: "EA",
    open,
    delivered: { state: "known", value: "0" },
    destination: "WH-A",
    receiptCutoff: "2026-10-23",
    calendar: { policyId: "CAL-CPH-1", version: 1 },
    priority,
    supplyLinks: [{ poNumber: "PO-120", poLine: "10" }],
  };
}

const DEM_1 = {
  contractVersion: v,
  organization: "ORG-NDL",
  version: "DEM@1",
  observedAt: { state: "unknown" },
  lines: [demandLine("SO-201", "70", 1), demandLine("SO-202", "50", 2)],
};

const PROPOSAL_SEGMENTS = [
  { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
  { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
];

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "d8-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

describe("D8 demand and bucket separation", () => {
  it("reads DEM@1 with both supply links to PO-120/10 and delivered 0", async () => {
    const { demand } = sources(db, "d8-api-read");
    const read = await demand.readDemand(ORG);
    expect(read.currentVersion).toBe("DEM@1");
    expect(read.record).toEqual(DEM_1);
    expect(
      await rows(
        observer,
        `SELECT l.sales_order, l.open_quantity::text, l.delivered_quantity::text, k.po_number, k.po_line
           FROM fixture_demand.demand_line l
           JOIN fixture_demand.supply_link k USING (version, sales_order, line)
          WHERE l.version = 'DEM@1' ORDER BY 1`,
      ),
    ).toEqual([
      {
        sales_order: "SO-201",
        open_quantity: "70",
        delivered_quantity: "0",
        po_number: "PO-120",
        po_line: "10",
      },
      {
        sales_order: "SO-202",
        open_quantity: "50",
        delivered_quantity: "0",
        po_number: "PO-120",
        po_line: "10",
      },
    ]);
  });

  it("keeps accepted inbound apart from the proposed segments, before and after ACT-1", async () => {
    const { purchasing } = sources(db, "d8-api-inbound");
    const proposal = async () =>
      rows(
        observer,
        `SELECT content -> 'segments' AS segments FROM fixture_reference.supplier_input
          WHERE proposal_id = 'PROP-1'`,
      );
    const accepted = await purchasing.readPurchaseOrder({ ...ORG, poNumber: "PO-120" });
    expect(accepted.currentRevision).toBe("3");
    expect(accepted.record.lines[0]?.acceptedSegments).toEqual([
      { sequence: 1, quantity: "120", arrival: { state: "dated", date: "2026-10-23" } },
    ]);
    expect(await proposal()).toEqual([{ segments: PROPOSAL_SEGMENTS }]);

    // Every source mutation of C-01 leaves demand unchanged.
    const demandBefore = await fingerprint(observer, DEMAND_TABLES);
    const { inventory } = sources(db, "d8-api-apply");
    await purchasing.amendSchedule(ACT_1);
    const { receipt } = await inventory.reserve(ACT_2);
    await inventory.createTransferRequest(act3(receipt.reservationId, receipt.receiptId));
    expect(await fingerprint(observer, DEMAND_TABLES)).toBe(demandBefore);

    // The accepted schedule is now revision 4; the proposal record and revision 3 are unchanged.
    expect((await poLine(observer, 4)).segments).toEqual([
      { sequence: 1, quantity: "40", arrival_date: "2026-10-23" },
      { sequence: 2, quantity: "80", arrival_date: "2026-10-26" },
    ]);
    expect((await poLine(observer, 3)).segments).toEqual([
      { sequence: 1, quantity: "120", arrival_date: "2026-10-23" },
    ]);
    expect(await proposal()).toEqual([{ segments: PROPOSAL_SEGMENTS }]);
    // The links stay explicit: PO-120/10 carries no revision and survives the amendment.
    expect((await sources(db, "d8-api-links").demand.readDemand(ORG)).record).toEqual(DEM_1);
  });

  it("denies API demand DML; migrator setup adds DEM@2 with SO-202/10 open 60 and keeps DEM@1", async () => {
    const api = await db.client("api", "d8-api-dml");
    const denied = async (text: string) =>
      api.query(text).then(
        () => "ok",
        (error: { code?: string }) => error.code,
      );
    for (const text of [
      "UPDATE fixture_demand.demand_line SET open_quantity = 60 WHERE sales_order = 'SO-202'",
      "INSERT INTO fixture_demand.demand_snapshot (version, organization) VALUES ('DEM@X', 'ORG-NDL')",
      "DELETE FROM fixture_demand.supply_link",
      "UPDATE fixture_demand.demand_head SET version = version",
    ]) {
      expect(await denied(text), text).toBe("42501");
    }

    // The order system changes SO-202/10 in the owning fixture.
    await observer.query(`
      BEGIN;
      INSERT INTO fixture_demand.demand_snapshot (version, organization, observed_at)
        VALUES ('DEM@2', 'ORG-NDL', NULL);
      INSERT INTO fixture_demand.demand_line
          (version, sales_order, line, sku, uom, open_quantity, delivered_quantity, destination,
           receipt_cutoff, calendar_policy_id, calendar_policy_version, priority)
        SELECT 'DEM@2', sales_order, line, sku, uom,
               CASE WHEN sales_order = 'SO-202' THEN 60 ELSE open_quantity END,
               delivered_quantity, destination, receipt_cutoff, calendar_policy_id,
               calendar_policy_version, priority
          FROM fixture_demand.demand_line WHERE version = 'DEM@1';
      INSERT INTO fixture_demand.supply_link (version, sales_order, line, po_number, po_line)
        SELECT 'DEM@2', sales_order, line, po_number, po_line
          FROM fixture_demand.supply_link WHERE version = 'DEM@1';
      UPDATE fixture_demand.demand_head SET version = 'DEM@2' WHERE organization = 'ORG-NDL';
      COMMIT;`);
    const { demand } = sources(db, "d8-api-dem2");
    const current = await demand.readDemand(ORG);
    expect(current.currentVersion).toBe("DEM@2");
    expect(current.record).toEqual({
      ...DEM_1,
      version: "DEM@2",
      lines: [demandLine("SO-201", "70", 1), demandLine("SO-202", "60", 2)],
    });
    const retained = await demand.readDemand({ ...ORG, version: "DEM@1" });
    expect(retained).toMatchObject({ currentVersion: "DEM@2", record: DEM_1 });
  });

  it(
    "N-15: in-transit TRR-9 is neither physical nor eligible stock and is not subtracted again",
    async () => {
      await db.reset();
      observer = await db.client("migrator", "d8-observer");
      // TRR-9 was dispatched before the snapshots; INV-B@1 already excludes it.
      await observer.query(`
        INSERT INTO fixture_inventory.in_transit
            (transit_id, sku, uom, from_warehouse, to_warehouse, quantity, dispatched_on, arrival_date)
          VALUES ('TRR-9', 'PART-A', 'EA', 'WH-B', 'WH-A', 20, NULL, '2026-10-24')`);
      expect(await stock(observer, "INV-B@1")).toMatchObject({ physical: "70", eligible: "50" });
      expect(await stock(observer, "INV-A@1")).toMatchObject({ physical: "40", eligible: "30" });

      const { inventory } = sources(db, "d8-api-transit");
      const whA = await inventory.readStock({ ...ORG, sku: "PART-A", warehouse: "WH-A" });
      const whB = await inventory.readStock({ ...ORG, sku: "PART-A", warehouse: "WH-B" });
      expect([whA.record.physical, whB.record.physical]).toEqual(["40", "70"]);
      const trr9 = {
        contractVersion: v,
        transitId: "TRR-9",
        sku: "PART-A",
        uom: "EA",
        from: "WH-B",
        to: "WH-A",
        quantity: "20",
        dispatchedOn: { state: "unknown" },
        arrival: { state: "dated", date: "2026-10-24" },
      };
      expect(
        (await inventory.readInTransit({ ...ORG, sku: "PART-A", warehouse: "WH-A" })).records,
      ).toEqual([trr9]);
      expect(
        (await inventory.readInTransit({ ...ORG, sku: "PART-A", warehouse: "WH-B" })).records,
      ).toEqual([trr9]);

      // The reservation guard sees exactly 50 eligible at WH-B: 51 is refused, 50 fits.
      expect(
        await refusal(inventory.reserve({ ...ACT_2, operationId: "OP-51", quantity: "51" })),
      ).toBe("inventory.insufficient_eligible_stock");
      await inventory.reserve(ACT_2);
      expect(await stock(observer, await stockHead(observer, "WH-B"))).toMatchObject({
        physical: "70",
        eligible: "0",
      });
      expect(await stock(observer, "INV-A@1")).toMatchObject({ physical: "40", eligible: "30" });
      expect(
        await rows(observer, "SELECT transit_id, quantity::text FROM fixture_inventory.in_transit"),
      ).toEqual([{ transit_id: "TRR-9", quantity: "20" }]);
    },
    RESET_TIMEOUT_MS + 30_000,
  );
});
