import { createHash } from "node:crypto";
import {
  DOMAIN_CONTRACT_VERSION,
  demandSnapshotSchema,
  labelSchema,
  mappedDemandSnapshotSchema,
  mappedStockSnapshotSchema,
  stockSnapshotSchema,
  uomSchema,
  type ConnectorAvailability,
  type ConnectorItemUnits,
  type ConnectorPurchaseOrder,
  type ConnectorReservation,
  type ConnectorSalesOrder,
  type ConversionRatio,
  type MappedDemandSnapshot,
  type MappedStockSnapshot,
  type NativeRecordRef,
  type Quantity,
} from "@supplier-disruption/contracts";
import { stable } from "./stable.js";

/**
 * Explicit native-to-label maps, supplied by whoever composes the connector.
 * Nothing is matched by similar text: a native name absent from its map
 * leaves the record unresolved.
 */
export interface LabelMap {
  readonly organization: { readonly company: string; readonly label: string };
  readonly items: Readonly<Record<string, string>>;
  readonly warehouses: Readonly<Record<string, string>>;
  readonly units: Readonly<Record<string, string>>;
}

export interface Gap {
  readonly code: string;
  readonly detail: string;
}

export type Mapping<T> =
  | { readonly status: "mapped"; readonly value: T }
  | { readonly status: "unresolved"; readonly gaps: readonly Gap[] };

/**
 * A snapshot version over everything that produced the snapshot: each native
 * token read and every caller input (labels, declarations and application
 * attributes) as it appears in the result. Changing any of them, not only the
 * source, gives a new version.
 */
function versionOf(sources: readonly NativeRecordRef[], inputs: unknown): string {
  const tokens = sources.map((ref) => [ref.doctype, ref.name, ref.modified]).sort();
  const digest = createHash("sha256")
    .update(JSON.stringify(stable({ tokens, inputs })))
    .digest("hex");
  return `erp-${digest.slice(0, 16)}`;
}

function label(
  map: Readonly<Record<string, string>>,
  native: string,
  kind: string,
  gaps: Gap[],
): string {
  const value = Object.hasOwn(map, native) ? map[native] : undefined;
  if (value === undefined || !labelSchema.safeParse(value).success) {
    gaps.push({ code: `unmapped_${kind}`, detail: native });
    return "";
  }
  return value;
}

function unit(map: LabelMap, native: string, gaps: Gap[]): string {
  const value = Object.hasOwn(map.units, native) ? map.units[native] : undefined;
  if (value === undefined || !uomSchema.safeParse(value).success) {
    gaps.push({ code: "unmapped_unit", detail: native });
    return "";
  }
  return value;
}

/**
 * The stock buckets ERPNext does not hold. Quality holds and safety stock
 * have no Bin field, so a caller must state them, with who stated them, or
 * the snapshot stays unresolved; they are never assumed to be zero.
 */
export interface DeclaredBuckets {
  readonly qualityHold: Quantity;
  readonly safetyStock: Quantity;
  readonly declaredBy: string;
}

/**
 * Maps one Bin and its submitted reservation entries to a domain stock
 * snapshot. Physical stock is `actual_qty`; each entry becomes an
 * `unrelated` reservation, because no native reservation is bound to an
 * application plan. The entries must account for the Bin's reserved stock
 * exactly, and a partly used entry is not interpreted. The declared buckets
 * travel beside the snapshot with who declared them, so they are never
 * mistaken for source data.
 */
export function mapStockSnapshot(input: {
  readonly availability: ConnectorAvailability;
  readonly reservations: readonly ConnectorReservation[];
  readonly labels: LabelMap;
  readonly buckets?: DeclaredBuckets;
}): Mapping<MappedStockSnapshot> {
  const { availability, labels } = input;
  const gaps: Gap[] = [];
  if (availability.ref.docstatus !== 0)
    gaps.push({ code: "unexpected_bin_state", detail: availability.ref.name });
  const sku = label(labels.items, availability.sku, "item", gaps);
  const warehouse = label(labels.warehouses, availability.warehouse, "warehouse", gaps);
  const uom = unit(labels, availability.stockUom, gaps);
  const entries = input.reservations.filter(
    (entry) => entry.sku === availability.sku && entry.warehouse === availability.warehouse,
  );
  let held = 0n;
  const reservations = entries.map((entry) => {
    if (entry.delivered !== "0" || entry.transferred !== "0" || entry.consumed !== "0") {
      gaps.push({ code: "reservation_partly_used", detail: entry.ref.name });
    }
    if (!labelSchema.safeParse(entry.ref.name).success) {
      gaps.push({ code: "unmapped_reservation", detail: entry.ref.name });
    }
    held += BigInt(entry.reserved);
    return {
      reservationId: entry.ref.name,
      quantity: entry.reserved,
      binding: { kind: "unrelated" as const },
    };
  });
  if (held !== BigInt(availability.reservedStock)) {
    gaps.push({
      code: "reservation_total_mismatch",
      detail: `entries ${held}, bin reserved stock ${availability.reservedStock}`,
    });
  }
  if (!input.buckets) {
    gaps.push({ code: "quality_hold_not_native", detail: availability.warehouse });
    gaps.push({ code: "safety_stock_not_native", detail: availability.warehouse });
  }
  if (gaps.length > 0 || !input.buckets) return { status: "unresolved", gaps };
  const sources = [availability.ref, ...entries.map((entry) => entry.ref)];
  const declared = {
    qualityHold: input.buckets.qualityHold,
    safetyStock: input.buckets.safetyStock,
    declaredBy: input.buckets.declaredBy,
  };
  const body = {
    contractVersion: DOMAIN_CONTRACT_VERSION,
    organization: labels.organization.label,
    sku,
    warehouse,
    uom,
    physical: availability.physical,
    qualityHold: declared.qualityHold,
    safetyStock: declared.safetyStock,
    reservations,
  };
  const snapshot = stockSnapshotSchema.parse({
    ...body,
    version: versionOf(sources, { body, declared }),
    observedAt: { state: "known", value: availability.observedAt },
  });
  return {
    status: "mapped",
    value: mappedStockSnapshotSchema.parse({ snapshot, sources, declared }),
  };
}

/**
 * Application-owned attributes of a demand line. ERPNext holds a delivery
 * date, not the receipt cutoff, calendar policy or priority, and one PO row
 * links to at most one demand row, so several supply links stay application
 * records.
 */
export interface DemandAttributes {
  readonly receiptCutoff: string;
  readonly calendar: { readonly policyId: string; readonly version: number };
  readonly priority: number;
  readonly supplyLinks: readonly { readonly poNumber: string; readonly poLine: string }[];
}

/**
 * Maps a sales order to a demand snapshot. Open quantity is ordered minus
 * delivered in the row unit, which must be the stock unit with ratio 1.
 */
export function mapDemandSnapshot(input: {
  readonly salesOrder: ConnectorSalesOrder;
  readonly labels: LabelMap;
  readonly orderLabel: string;
  readonly lineLabels: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, DemandAttributes>>;
}): Mapping<MappedDemandSnapshot> {
  const { salesOrder, labels } = input;
  const gaps: Gap[] = [];
  if (salesOrder.ref.docstatus !== 1)
    gaps.push({ code: "demand_not_submitted", detail: salesOrder.ref.name });
  if (salesOrder.company !== labels.organization.company) {
    gaps.push({ code: "unmapped_company", detail: salesOrder.company });
  }
  const lines = salesOrder.lines.map((row) => {
    const attributes = Object.hasOwn(input.attributes, row.rowId)
      ? input.attributes[row.rowId]
      : undefined;
    if (!attributes) gaps.push({ code: "demand_attributes_missing", detail: row.rowId });
    if (row.uom !== row.stockUom || row.conversion.numerator !== row.conversion.denominator) {
      gaps.push({ code: "demand_unit_not_stock_unit", detail: row.rowId });
    }
    const open = BigInt(row.ordered) - BigInt(row.delivered);
    if (open < 0n) gaps.push({ code: "demand_over_delivered", detail: row.rowId });
    return {
      salesOrder: input.orderLabel,
      line: label(input.lineLabels, row.rowId, "demand_line", gaps),
      sku: label(labels.items, row.sku, "item", gaps),
      uom: unit(labels, row.uom, gaps),
      open: open < 0n ? "0" : open.toString(),
      delivered: { state: "known" as const, value: row.delivered },
      destination: label(labels.warehouses, row.warehouse, "warehouse", gaps),
      receiptCutoff: attributes?.receiptCutoff ?? "",
      calendar: attributes?.calendar ?? { policyId: "", version: 1 },
      priority: attributes?.priority ?? 1,
      supplyLinks: [...(attributes?.supplyLinks ?? [])],
    };
  });
  if (gaps.length > 0) return { status: "unresolved", gaps };
  const sources = [salesOrder.ref];
  const body = {
    contractVersion: DOMAIN_CONTRACT_VERSION,
    organization: labels.organization.label,
    lines,
  };
  const snapshot = demandSnapshotSchema.parse({
    ...body,
    version: versionOf(sources, body),
    observedAt: { state: "known", value: salesOrder.observedAt },
  });
  return { status: "mapped", value: mappedDemandSnapshotSchema.parse({ snapshot, sources }) };
}

/**
 * Why a native purchase order cannot become a domain PO revision. ERPNext
 * has no revision counter (`modified` is a token, not an ordering) and no
 * cancelled quantity, so every submitted PO reports both gaps rather than a
 * fabricated revision or a zero.
 */
export function purchaseOrderGaps(po: ConnectorPurchaseOrder): Gap[] {
  const gaps: Gap[] = [{ code: "revision_not_native", detail: po.ref.name }];
  if (po.ref.docstatus !== 1) gaps.push({ code: "po_not_submitted", detail: po.ref.name });
  for (const line of po.lines) {
    if (line.canceled.state === "unknown") {
      gaps.push({ code: "canceled_quantity_not_native", detail: line.rowId });
    }
  }
  return gaps;
}

/**
 * The exact conversion of one unit into the item's stock unit, only from a
 * listed item-master row. The conversion helper's default of 1.0 for an
 * unlisted unit (probe P02b) is never consulted. Effective dates are not
 * native, so the result supports a current read, not a historical mapping.
 */
export function masterConversion(
  units: ConnectorItemUnits,
  uom: string,
):
  { readonly status: "listed"; readonly ratio: ConversionRatio } | { readonly status: "unlisted" } {
  const row = units.conversions.find((conversion) => conversion.uom === uom);
  return row ? { status: "listed", ratio: row.ratio } : { status: "unlisted" };
}
