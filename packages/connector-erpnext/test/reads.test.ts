// Reads and domain mapping over recorded, redacted sandbox responses. No network.
import { describe, expect, it } from "vitest";
import {
  ErpnextReader,
  classify,
  mapDemandSnapshot,
  mapStockSnapshot,
  masterConversion,
  purchaseOrderGaps,
  ratioFromFactor,
  resourcePath,
  type LabelMap,
  type ReadOutcome,
} from "../src/index.js";
import { fixture, lost, on, replay, response } from "./helpers.js";

const PO_PATH = resourcePath("Purchase Order", "PUR-ORD-2026-00001");
const LIST_PO = resourcePath("Purchase Order");
const clock = () => new Date("2026-10-22T11:16:00.000Z");

const labels: LabelMap = {
  organization: { company: "Nordlund Distribution (fictional)", label: "ORG-NDL" },
  items: { "PART-A": "PART-A" },
  warehouses: { "WH-A - NDL": "WH-A", "WH-B - NDL": "WH-B" },
  units: { EA: "EA" },
};

function ok<T>(outcome: ReadOutcome<T>): T {
  if (outcome.kind !== "ok") throw new Error(JSON.stringify(outcome));
  return outcome.value;
}

describe("response classification", () => {
  it("separates refusals from uncertain outcomes", () => {
    expect(classify(response("put-stale-417"))).toMatchObject({
      kind: "refused",
      reason: "stale_source_token",
      sourceError: "TimestampMismatchError",
    });
    expect(classify(response("reader-put-403"))).toMatchObject({ reason: "permission_denied" });
    expect(classify(response("invalid-token-401"))).toMatchObject({
      reason: "authentication_failed",
    });
    // A lost concurrent update answered HTTP 500; it is never read as a refusal.
    expect(classify(response("put-concurrent-500"))).toMatchObject({
      kind: "unknown",
      status: 500,
      sourceError: "QueryDeadlockError",
    });
    expect(classify(lost)).toMatchObject({ kind: "unknown", status: null });
    expect(
      classify({
        kind: "response",
        status: 417,
        body: { exc_type: "UpdateAfterSubmitError" },
        elapsedMs: 1,
      }),
    ).toMatchObject({ kind: "refused", reason: "business_validation" });
  });
});

describe("purchase order reads", () => {
  it("keeps native rows, units and tokens, and records cancelled quantity as unknown", async () => {
    const transport = replay(
      on("GET", PO_PATH, response("po-120")),
      on("GET", LIST_PO, response("po-no-successors")),
    );
    const { record } = ok(
      await new ErpnextReader(transport, null, clock).purchaseOrder("PUR-ORD-2026-00001"),
    );
    expect(record.ref).toEqual({
      system: "erpnext",
      site: "http://127.0.0.1:18082",
      doctype: "Purchase Order",
      name: "PUR-ORD-2026-00001",
      modified: "2026-10-22 13:20:55.721729",
      docstatus: 1,
    });
    expect(
      record.lines.map((line) => [line.sku, line.uom, line.ordered, line.stockQuantity]),
    ).toEqual([
      ["PART-A", "EA", "120", "120"],
      ["PART-U", "Box", "6", "60"],
    ]);
    expect(record.lines[1]!.conversion).toEqual({ numerator: "10", denominator: "1" });
    expect(record.lines.every((line) => line.canceled.state === "unknown")).toBe(true);
    expect(purchaseOrderGaps(record).map((gap) => gap.code)).toEqual([
      "revision_not_native",
      "canceled_quantity_not_native",
      "canceled_quantity_not_native",
    ]);
  });

  it("keeps received quantity on a partly received order", async () => {
    const path = resourcePath("Purchase Order", "PUR-ORD-2026-00006");
    const transport = replay(
      on("GET", path, response("po-partly-received")),
      on("GET", LIST_PO, response("po-no-successors")),
    );
    const { record } = ok(
      await new ErpnextReader(transport, null, clock).purchaseOrder("PUR-ORD-2026-00006"),
    );
    expect(record.lines[0]).toMatchObject({
      ordered: "20",
      received: "5",
      returned: { state: "known", value: "0" },
    });
  });

  it("maps an absent returned quantity to unknown, never zero", async () => {
    const recorded = fixture("po-120") as {
      body: { data: { items: Record<string, unknown>[] } };
    };
    delete recorded.body.data.items[0]!.returned_qty;
    const transport = replay(
      on("GET", PO_PATH, { kind: "response", status: 200, body: recorded.body, elapsedMs: 1 }),
      on("GET", LIST_PO, response("po-no-successors")),
    );
    const { record } = ok(
      await new ErpnextReader(transport, null, clock).purchaseOrder("PUR-ORD-2026-00001"),
    );
    expect(record.lines.map((line) => line.returned)).toEqual([
      { state: "unknown" },
      { state: "known", value: "0" },
    ]);
  });

  it("refuses a fractional quantity instead of rounding it", async () => {
    const recorded = fixture("po-120") as {
      status: number;
      body: { data: { items: { qty: number }[] } };
    };
    recorded.body.data.items[0]!.qty = 119.5;
    const transport = replay(
      on("GET", PO_PATH, { kind: "response", status: 200, body: recorded.body, elapsedMs: 1 }),
      on("GET", LIST_PO, response("po-no-successors")),
    );
    const outcome = await new ErpnextReader(transport, null, clock).purchaseOrder(
      "PUR-ORD-2026-00001",
    );
    expect(outcome.kind).toBe("invalid");
  });

  it("reports an unauthenticated read as refused and a lost read as unknown", async () => {
    const refused = await new ErpnextReader(
      replay(on("GET", PO_PATH, response("anonymous-403"))),
      null,
    ).purchaseOrder("PUR-ORD-2026-00001");
    expect(refused).toMatchObject({ kind: "refused", reason: "permission_denied", status: 403 });
    const unknown = await new ErpnextReader(replay(on("GET", PO_PATH, lost)), null).purchaseOrder(
      "PUR-ORD-2026-00001",
    );
    expect(unknown.kind).toBe("unknown");
  });
});

describe("units, stock and reservations", () => {
  it("uses only listed item-master conversions", async () => {
    const transport = replay(on("GET", resourcePath("Item", "PART-A"), response("item-part-a")));
    const units = ok(await new ErpnextReader(transport, null, clock).itemUnits("PART-A"));
    expect(masterConversion(units, "Box")).toEqual({
      status: "listed",
      ratio: { numerator: "10", denominator: "1" },
    });
    // The sandbox helper answered 1.0 for this unlisted unit (probe P02b).
    expect(masterConversion(units, "Unit")).toEqual({ status: "unlisted" });
    expect(units.effectiveDates).toEqual({ state: "unknown" });
  });

  it("maps a Bin and its reservation entries to the C-01 eligible stock", async () => {
    const transport = replay(
      on("GET", resourcePath("Bin"), response("bins-part-a")),
      on("GET", resourcePath("Stock Reservation Entry"), response("reservations-part-a")),
    );
    const reader = new ErpnextReader(transport, null, clock);
    const bins = ok(await reader.availability("PART-A"));
    const reservations = ok(await reader.reservations("PART-A"));
    const buckets = { qualityHold: "0", safetyStock: "0", declaredBy: "test" };
    const mapped = bins.map((availability) =>
      mapStockSnapshot({ availability, reservations, labels, buckets }),
    );
    const snapshots = mapped.map((result) => {
      if (result.status !== "mapped") throw new Error(JSON.stringify(result.gaps));
      // Declared buckets travel with who declared them; they are not source data.
      expect(result.value.declared).toEqual(buckets);
      expect(result.value.sources.map((ref) => ref.doctype)).toEqual([
        "Bin",
        "Stock Reservation Entry",
      ]);
      return result.value.snapshot;
    });
    expect(
      snapshots.map((snapshot) => [
        snapshot.warehouse,
        snapshot.physical,
        snapshot.reservations.map((reservation) => [
          reservation.reservationId,
          reservation.quantity,
        ]),
      ]),
    ).toEqual([
      ["WH-B", "70", [["MAT-SRE-2026-00002", "20"]]],
      ["WH-A", "40", [["MAT-SRE-2026-00001", "10"]]],
    ]);
    expect(snapshots.every((snapshot) => /^erp-[0-9a-f]{16}$/.test(snapshot.version))).toBe(true);
  });

  it("gives a new stock version when any declared input changes", async () => {
    const transport = replay(
      on("GET", resourcePath("Bin"), response("bins-part-a")),
      on("GET", resourcePath("Stock Reservation Entry"), response("reservations-part-a")),
    );
    const reader = new ErpnextReader(transport, null, clock);
    const [whB] = ok(await reader.availability("PART-A"));
    const reservations = ok(await reader.reservations("PART-A"));
    const version = (buckets: { qualityHold: string; safetyStock: string; declaredBy: string }) => {
      const mapped = mapStockSnapshot({ availability: whB!, reservations, labels, buckets });
      if (mapped.status !== "mapped") throw new Error(JSON.stringify(mapped.gaps));
      return mapped.value.snapshot.version;
    };
    const base = { qualityHold: "0", safetyStock: "0", declaredBy: "test" };
    expect(version(base)).toBe(version({ ...base }));
    const versions = new Set([
      version(base),
      version({ ...base, qualityHold: "5" }),
      version({ ...base, safetyStock: "5" }),
      version({ ...base, declaredBy: "another planner" }),
    ]);
    expect(versions.size).toBe(4);
    const relabelled = mapStockSnapshot({
      availability: whB!,
      reservations,
      labels: { ...labels, warehouses: { ...labels.warehouses, "WH-B - NDL": "WH-B2" } },
      buckets: base,
    });
    expect(relabelled.status === "mapped" && relabelled.value.snapshot.version).not.toBe(
      version(base),
    );
  });

  it("gives a new demand version when an application attribute or line label changes", async () => {
    const path = resourcePath("Sales Order", "SAL-ORD-2026-00001");
    const reader = new ErpnextReader(replay(on("GET", path, response("so-201"))), null, clock);
    const salesOrder = ok(await reader.salesOrder("SAL-ORD-2026-00001"));
    const row = salesOrder.lines[0]!.rowId;
    const attributes = {
      receiptCutoff: "2026-10-23",
      calendar: { policyId: "CAL-CPH-1", version: 1 },
      priority: 1,
      supplyLinks: [{ poNumber: "PO-120", poLine: "10" }],
    };
    const version = (lineLabel: string, changed: Partial<typeof attributes> = {}) => {
      const mapped = mapDemandSnapshot({
        salesOrder,
        labels,
        orderLabel: "SO-201",
        lineLabels: { [row]: lineLabel },
        attributes: { [row]: { ...attributes, ...changed } },
      });
      if (mapped.status !== "mapped") throw new Error(JSON.stringify(mapped.gaps));
      expect(mapped.value.sources).toEqual([salesOrder.ref]);
      return mapped.value.snapshot.version;
    };
    const base = version("10");
    expect(version("10")).toBe(base);
    const changed = [
      version("20"),
      version("10", { receiptCutoff: "2026-10-24" }),
      version("10", { calendar: { policyId: "CAL-CPH-1", version: 2 } }),
      version("10", { priority: 2 }),
      version("10", { supplyLinks: [] }),
    ];
    expect(new Set([base, ...changed]).size).toBe(6);
  });

  it("leaves a snapshot unresolved without declared buckets or with a missing reservation", async () => {
    const transport = replay(
      on("GET", resourcePath("Bin"), response("bins-part-a")),
      on("GET", resourcePath("Stock Reservation Entry"), response("reservations-part-a")),
    );
    const reader = new ErpnextReader(transport, null, clock);
    const [whB] = ok(await reader.availability("PART-A"));
    const reservations = ok(await reader.reservations("PART-A"));
    const undeclared = mapStockSnapshot({ availability: whB!, reservations, labels });
    expect(undeclared).toMatchObject({
      status: "unresolved",
      gaps: [{ code: "quality_hold_not_native" }, { code: "safety_stock_not_native" }],
    });
    const buckets = { qualityHold: "0", safetyStock: "0", declaredBy: "test" };
    const missing = mapStockSnapshot({ availability: whB!, reservations: [], labels, buckets });
    expect(missing).toMatchObject({
      status: "unresolved",
      gaps: [{ code: "reservation_total_mismatch" }],
    });
    const unmapped = mapStockSnapshot({
      availability: whB!,
      reservations,
      labels: { ...labels, warehouses: {} },
      buckets,
    });
    expect(unmapped).toMatchObject({
      status: "unresolved",
      gaps: [{ code: "unmapped_warehouse" }],
    });
  });

  it("converts decimal factors exactly", () => {
    expect(ratioFromFactor(10)).toEqual({ numerator: "10", denominator: "1" });
    expect(ratioFromFactor(0.25)).toEqual({ numerator: "1", denominator: "4" });
    expect(ratioFromFactor(0)).toBeNull();
    expect(ratioFromFactor(1e-7)).toBeNull();
  });
});
