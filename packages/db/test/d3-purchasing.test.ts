// D3 conditional purchasing: the purchasing source checks the base revision
// inside its own transaction while holding the PO head, appends the successor
// and keeps history. Observed through raw SQL on a separate migrator connection.
import type { AmendScheduleCommand } from "@supplier-disruption/contracts";
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
  RACE_TIMEOUTS,
  raceBehindHead,
  poHead,
  poLine,
  refusal,
  refusalReason,
  rows,
  sources,
} from "./source-support.js";

const db = new DisposableDatabase("d3");
let observer: pg.Client;

const LINE_10 = {
  ordered: "120",
  received: "0",
  canceled: "0",
  sku: "PART-A",
  uom: "EA",
  destination: "WH-A",
};

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "d3-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

async function reset(): Promise<void> {
  await db.reset();
  observer = await db.client("migrator", "d3-observer");
}

async function revisions(poNumber = "PO-120"): Promise<number[]> {
  return (
    await rows<{ revision: number }>(
      observer,
      "SELECT revision FROM fixture_purchasing.po_revision WHERE po_number = $1 ORDER BY 1",
      [poNumber],
    )
  ).map((row) => row.revision);
}

describe("D3 conditional purchasing", () => {
  it("amends PO-120 from revision 3 to exactly revision 4 with C-01's two segments, keeping revision 3", async () => {
    const { purchasing } = sources(db, "d3-api");
    const result = await purchasing.amendSchedule(ACT_1);
    expect(result.replayed).toBe(false);
    expect(result.receipt).toMatchObject({
      kind: "amend_schedule",
      organization: "ORG-NDL",
      operationId: "OP-ACT-1",
      planId: "PLAN-1",
      actionId: "ACT-1",
      poNumber: "PO-120",
      poLine: "10",
      priorRevision: "3",
      successorRevision: "4",
    });

    expect(await poHead(observer)).toBe(4);
    expect(await revisions()).toEqual([3, 4]);
    expect(await poLine(observer, 4)).toEqual({
      line: LINE_10,
      segments: [
        { sequence: 1, quantity: "40", arrival_date: "2026-10-23" },
        { sequence: 2, quantity: "80", arrival_date: "2026-10-26" },
      ],
    });
    // Revision 3 is retained exactly as accepted.
    expect(await poLine(observer, 3)).toEqual({
      line: LINE_10,
      segments: [{ sequence: 1, quantity: "120", arrival_date: "2026-10-23" }],
    });
    expect(
      await rows(
        observer,
        `SELECT receipt_id::text, plan_id, action_id, prior_revision, successor_revision
           FROM fixture_purchasing.operation_receipt WHERE operation_id = 'OP-ACT-1'`,
      ),
    ).toEqual([
      {
        receipt_id: result.receipt.receiptId,
        plan_id: "PLAN-1",
        action_id: "ACT-1",
        prior_revision: 3,
        successor_revision: 4,
      },
    ]);
  });

  it("replaces only the amended line's outstanding schedule; other lines and quantities stay", async () => {
    // Migrator setup: another PO whose line 10 has receipts and cancellations
    // and whose line 20 must be carried over unchanged.
    await observer.query(`
      INSERT INTO fixture_purchasing.po_revision (po_number, revision, organization, vendor_id)
        VALUES ('PO-121', 1, 'ORG-NDL', 'V-100');
      INSERT INTO fixture_purchasing.po_line
          (po_number, revision, line_number, sku, uom, destination, ordered, received, canceled)
        VALUES ('PO-121', 1, '10', 'PART-A', 'EA', 'WH-A', 40, 5, 5),
               ('PO-121', 1, '20', 'PART-A', 'EA', 'WH-B', 15, 5, 0);
      INSERT INTO fixture_purchasing.po_line_segment
          (po_number, revision, line_number, sequence, quantity, arrival_date)
        VALUES ('PO-121', 1, '10', 1, 30, '2026-10-25'),
               ('PO-121', 1, '20', 1, 10, '2026-10-24'),
               ('PO-121', 1, '20', 2, 5, NULL);
      INSERT INTO fixture_purchasing.po_head (po_number, organization, revision)
        VALUES ('PO-121', 'ORG-NDL', 1);`);
    const { purchasing } = sources(db, "d3-api-lines");
    const amend: AmendScheduleCommand = {
      ...ACT_1,
      operationId: "OP-PO-121",
      poNumber: "PO-121",
      expectedRevision: "1",
      segments: [
        { sequence: 1, quantity: "10", arrival: { state: "dated", date: "2026-10-25" } },
        { sequence: 2, quantity: "20", arrival: { state: "undated" } },
      ],
    };
    // The segments must total ordered minus received minus canceled (30).
    expect(
      await refusal(
        purchasing.amendSchedule({
          ...amend,
          operationId: "OP-PO-121-TOTAL",
          segments: [{ sequence: 1, quantity: "40", arrival: { state: "undated" } }],
        }),
      ),
    ).toBe("purchasing.schedule_quantity_mismatch");
    expect(
      await refusal(
        purchasing.amendSchedule({ ...amend, operationId: "OP-PO-121-UOM", uom: "CTN" }),
      ),
    ).toBe("source.uom_mismatch");
    expect(
      await refusal(
        purchasing.amendSchedule({ ...amend, operationId: "OP-PO-121-LINE", poLine: "30" }),
      ),
    ).toBe("purchasing.unknown_po_line");
    expect(await revisions("PO-121")).toEqual([1]);

    expect((await purchasing.amendSchedule(amend)).receipt.successorRevision).toBe("2");
    const lines = (revision: number) =>
      rows(
        observer,
        `SELECT line_number, ordered::text, received::text, canceled::text, destination
           FROM fixture_purchasing.po_line WHERE po_number = 'PO-121' AND revision = $1
          ORDER BY line_number`,
        [revision],
      );
    const segments = (revision: number) =>
      rows(
        observer,
        `SELECT line_number, sequence, quantity::text, arrival_date::text
           FROM fixture_purchasing.po_line_segment WHERE po_number = 'PO-121' AND revision = $1
          ORDER BY line_number, sequence`,
        [revision],
      );
    const quantities = [
      { line_number: "10", ordered: "40", received: "5", canceled: "5", destination: "WH-A" },
      { line_number: "20", ordered: "15", received: "5", canceled: "0", destination: "WH-B" },
    ];
    expect(await lines(1)).toEqual(quantities);
    expect(await lines(2)).toEqual(quantities);
    const line20 = [
      { line_number: "20", sequence: 1, quantity: "10", arrival_date: "2026-10-24" },
      { line_number: "20", sequence: 2, quantity: "5", arrival_date: null },
    ];
    expect(await segments(1)).toEqual([
      { line_number: "10", sequence: 1, quantity: "30", arrival_date: "2026-10-25" },
      ...line20,
    ]);
    expect(await segments(2)).toEqual([
      { line_number: "10", sequence: 1, quantity: "10", arrival_date: "2026-10-25" },
      { line_number: "10", sequence: 2, quantity: "20", arrival_date: null },
      ...line20,
    ]);
  });

  it(
    "competing operations bound to revision 3 yield one successor and one stale_base_revision",
    async () => {
      await reset();
      const pool = db.pool("api", "d3-contender");
      const { purchasing } = sources(db, "unused", pool, RACE_TIMEOUTS);
      // Both start and wait behind the held PO head, then run together.
      const results = await raceBehindHead(
        db,
        observer,
        "d3-contender",
        "SELECT 1 FROM fixture_purchasing.po_head WHERE po_number = 'PO-120' FOR UPDATE",
        [
          () => purchasing.amendSchedule({ ...ACT_1, operationId: "OP-RACE-A" }),
          () =>
            purchasing.amendSchedule({
              ...ACT_1,
              operationId: "OP-RACE-B",
              actionId: "ACT-9",
              segments: [
                { sequence: 1, quantity: "60", arrival: { state: "dated", date: "2026-10-24" } },
                { sequence: 2, quantity: "60", arrival: { state: "dated", date: "2026-10-27" } },
              ],
            }),
        ],
      );

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(refusalReason(rejected[0]!.reason)).toBe("stale_base_revision");

      expect(await poHead(observer)).toBe(4);
      expect(await revisions()).toEqual([3, 4]);
      expect(
        await rows(observer, "SELECT count(*)::int AS n FROM fixture_purchasing.operation_receipt"),
      ).toEqual([{ n: 1 }]);
      // The refused operation left no operation record.
      expect(
        await rows(observer, "SELECT operation_id FROM fixture_purchasing.operation ORDER BY 1"),
      ).toHaveLength(1);
      expect((await poLine(observer, 3)).segments).toEqual([
        { sequence: 1, quantity: "120", arrival_date: "2026-10-23" },
      ]);
    },
    RESET_TIMEOUT_MS + 30_000,
  );

  it(
    "a foreign revision committed before the source transaction is refused as stale_base_revision",
    async () => {
      await reset();
      // Another actor advances PO-120 to revision 4 in the owning fixture.
      await observer.query(`
        BEGIN;
        INSERT INTO fixture_purchasing.po_revision (po_number, revision, organization, vendor_id)
          VALUES ('PO-120', 4, 'ORG-NDL', 'V-100');
        INSERT INTO fixture_purchasing.po_line
            (po_number, revision, line_number, sku, uom, destination, ordered, received, canceled)
          VALUES ('PO-120', 4, '10', 'PART-A', 'EA', 'WH-A', 120, 0, 0);
        INSERT INTO fixture_purchasing.po_line_segment
            (po_number, revision, line_number, sequence, quantity, arrival_date)
          VALUES ('PO-120', 4, '10', 1, 120, '2026-10-25');
        UPDATE fixture_purchasing.po_head SET revision = 4 WHERE po_number = 'PO-120';
        COMMIT;`);
      const { purchasing } = sources(db, "d3-api-foreign");
      expect(await refusal(purchasing.amendSchedule(ACT_1))).toBe("stale_base_revision");

      expect(await poHead(observer)).toBe(4);
      expect(await revisions()).toEqual([3, 4]);
      expect((await poLine(observer, 4)).segments).toEqual([
        { sequence: 1, quantity: "120", arrival_date: "2026-10-25" },
      ]);
      expect(
        await rows(
          observer,
          `SELECT (SELECT count(*) FROM fixture_purchasing.operation)::int AS operations,
                  (SELECT count(*) FROM fixture_purchasing.operation_receipt)::int AS receipts`,
        ),
      ).toEqual([{ operations: 0, receipts: 0 }]);
    },
    RESET_TIMEOUT_MS + 30_000,
  );
});
