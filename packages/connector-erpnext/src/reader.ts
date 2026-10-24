import {
  CONNECTOR_CONTRACT_VERSION,
  connectorAvailabilitySchema,
  connectorItemUnitsSchema,
  connectorPurchaseOrderSchema,
  connectorReservationSchema,
  connectorSalesOrderSchema,
  type ConnectorAvailability,
  type ConnectorItemUnits,
  type ConnectorPurchaseOrder,
  type ConnectorRefusalReason,
  type ConnectorReservation,
  type ConnectorSalesOrder,
  type NativeRecordRef,
} from "@supplier-disruption/contracts";
import type { z } from "zod";
import { classify } from "./classify.js";
import type { ApiPrincipal } from "./config.js";
import {
  BIN_FIELDS,
  RESERVATION_FIELDS,
  nativeBinSchema,
  nativeItemSchema,
  nativePurchaseOrderSchema,
  nativeReservationSchema,
  nativeSalesOrderSchema,
  nativeStockEntrySchema,
  ratioFromFactor,
  signedWholeQuantity,
  wholeQuantity,
  type NativePurchaseOrder,
  type NativeStockEntry,
} from "./native.js";
import type { HttpRequest, Transport } from "./transport.js";

/**
 * The result of one read. `unknown` means no usable answer arrived (no
 * response or a 5xx); `invalid` means the answer does not fit the contract,
 * such as a fractional quantity or a truncated list, and is never repaired.
 */
export type ReadOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "refused";
      readonly reason: ConnectorRefusalReason;
      readonly status: number;
      readonly sourceError: string | null;
    }
  | { readonly kind: "unknown"; readonly detail: string }
  | { readonly kind: "invalid"; readonly issues: readonly string[] };

/** A purchase order read, with the native rows a conditional update must send back. */
export interface PurchaseOrderRead {
  readonly record: ConnectorPurchaseOrder;
  readonly native: NativePurchaseOrder;
}

/** A Stock Entry found by its operation marker. */
export interface MarkedStockEntry {
  readonly name: string;
  readonly docstatus: number;
  readonly modified: string;
  readonly remarks: string;
}

/** Above this many rows a list read is treated as possibly truncated. */
const LIST_LIMIT = 500;

/** True when `marker` is one whole whitespace-delimited token of `remarks`. */
export function hasMarker(remarks: string, marker: string): boolean {
  return remarks.split(/\s+/).includes(marker);
}

export function resourcePath(doctype: string, name?: string): string {
  const base = `/api/resource/${encodeURIComponent(doctype)}`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

function invalid(issues: readonly string[]): ReadOutcome<never> {
  return { kind: "invalid", issues };
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

/**
 * Reads purchasing, item, demand, stock and reservation records over HTTP
 * with one principal. Each method sends at most two requests and never
 * retries; the native `modified` of every record is kept as its token.
 */
export class ErpnextReader {
  constructor(
    readonly transport: Transport,
    readonly principal: ApiPrincipal | null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private ref(
    doctype: string,
    doc: { name: string; modified: string; docstatus: 0 | 1 | 2 },
  ): NativeRecordRef {
    return {
      system: "erpnext",
      site: this.transport.site,
      doctype,
      name: doc.name,
      modified: doc.modified,
      docstatus: doc.docstatus,
    };
  }

  private async fetch(request: HttpRequest): Promise<ReadOutcome<unknown>> {
    const outcome = classify(await this.transport.send(this.principal, request));
    if (outcome.kind === "ok") return { kind: "ok", value: outcome.body };
    if (outcome.kind === "refused") return outcome;
    return { kind: "unknown", detail: outcome.detail };
  }

  private async document<T extends z.ZodType>(
    doctype: string,
    name: string,
    schema: T,
  ): Promise<ReadOutcome<z.infer<T>>> {
    const read = await this.fetch({ method: "GET", path: resourcePath(doctype, name) });
    if (read.kind !== "ok") return read;
    const parsed = schema.safeParse((read.value as { data?: unknown } | null)?.data);
    return parsed.success ? { kind: "ok", value: parsed.data } : invalid(zodIssues(parsed.error));
  }

  private async list<T extends z.ZodType>(
    doctype: string,
    filters: readonly unknown[],
    fields: readonly string[],
    schema: T,
  ): Promise<ReadOutcome<z.infer<T>[]>> {
    const read = await this.fetch({
      method: "GET",
      path: resourcePath(doctype),
      query: { filters, fields, limit_page_length: LIST_LIMIT, order_by: "name asc" },
    });
    if (read.kind !== "ok") return read;
    const rows = (read.value as { data?: unknown } | null)?.data;
    if (!Array.isArray(rows)) return invalid(["data: expected a list"]);
    if (rows.length >= LIST_LIMIT) return invalid([`data: ${rows.length} rows may be truncated`]);
    const out: z.infer<T>[] = [];
    for (const row of rows) {
      const parsed = schema.safeParse(row);
      if (!parsed.success) return invalid(zodIssues(parsed.error));
      out.push(parsed.data);
    }
    return { kind: "ok", value: out };
  }

  /** The user the source authenticates this principal as. */
  async whoAmI(): Promise<ReadOutcome<string>> {
    const read = await this.fetch({
      method: "GET",
      path: "/api/method/frappe.auth.get_logged_user",
    });
    if (read.kind !== "ok") return read;
    const user = (read.value as { message?: unknown } | null)?.message;
    return typeof user === "string"
      ? { kind: "ok", value: user }
      : invalid(["message: not a user"]);
  }

  /**
   * A purchase order and the documents amended from it. Received quantity is
   * kept in the row unit; there is no native cancelled quantity, so it is
   * recorded as unknown on every line.
   */
  async purchaseOrder(name: string): Promise<ReadOutcome<PurchaseOrderRead>> {
    const read = await this.document("Purchase Order", name, nativePurchaseOrderSchema);
    if (read.kind !== "ok") return read;
    const doc = read.value;
    const successors = await this.list(
      "Purchase Order",
      [["amended_from", "=", name]],
      ["name"],
      nativePurchaseOrderSchema.pick({ name: true }),
    );
    if (successors.kind !== "ok") return successors;
    const issues: string[] = [];
    const lines = doc.items.map((row) => {
      const ordered = wholeQuantity(row.qty);
      const stockQuantity = wholeQuantity(row.stock_qty);
      const received = wholeQuantity(row.received_qty);
      // An absent returned quantity is unknown, never zero.
      const returned =
        row.returned_qty === null || row.returned_qty === undefined
          ? null
          : wholeQuantity(row.returned_qty);
      const returnedInvalid = returned === null && typeof row.returned_qty === "number";
      const conversion = ratioFromFactor(row.conversion_factor);
      if (!ordered || !stockQuantity || !received || returnedInvalid || !conversion) {
        issues.push(`row ${row.name}: quantity or conversion is not exact and whole`);
      }
      const demandLink =
        row.sales_order && row.sales_order_item
          ? { salesOrder: row.sales_order, row: row.sales_order_item }
          : null;
      return {
        rowId: row.name,
        position: row.idx,
        sku: row.item_code,
        uom: row.uom,
        ordered: ordered ?? "0",
        stockUom: row.stock_uom,
        stockQuantity: stockQuantity ?? "0",
        conversion: conversion ?? { numerator: "1", denominator: "1" },
        scheduleDate: row.schedule_date,
        warehouse: row.warehouse,
        received: received ?? "0",
        returned:
          returned === null
            ? { state: "unknown" as const }
            : { state: "known" as const, value: returned },
        canceled: { state: "unknown" as const },
        demandLink,
        supplierItem: row.supplier_part_no ?? null,
      };
    });
    if (issues.length > 0) return invalid(issues);
    const record = connectorPurchaseOrderSchema.safeParse({
      contractVersion: CONNECTOR_CONTRACT_VERSION,
      ref: this.ref("Purchase Order", doc),
      observedAt: this.clock().toISOString(),
      supplier: doc.supplier,
      company: doc.company,
      status: doc.status,
      amendedFrom: doc.amended_from ?? null,
      amendedBy: successors.value.map((successor) => successor.name),
      lines,
    });
    return record.success
      ? { kind: "ok", value: { record: record.data, native: doc } }
      : invalid(zodIssues(record.error));
  }

  /** Item units as the current master lists them. */
  async itemUnits(sku: string): Promise<ReadOutcome<ConnectorItemUnits>> {
    const read = await this.document("Item", sku, nativeItemSchema);
    if (read.kind !== "ok") return read;
    const doc = read.value;
    const conversions = [];
    for (const row of doc.uoms) {
      const ratio = ratioFromFactor(row.conversion_factor);
      if (!ratio) return invalid([`uom ${row.uom}: conversion factor is not exact`]);
      conversions.push({ uom: row.uom, ratio });
    }
    const record = connectorItemUnitsSchema.safeParse({
      contractVersion: CONNECTOR_CONTRACT_VERSION,
      ref: this.ref("Item", doc),
      observedAt: this.clock().toISOString(),
      sku: doc.name,
      stockUom: doc.stock_uom,
      conversions,
      supplierItems: (doc.supplier_items ?? []).flatMap((row) =>
        row.supplier_part_no
          ? [{ supplier: row.supplier, supplierItem: row.supplier_part_no }]
          : [],
      ),
      effectiveDates: { state: "unknown" },
    });
    return record.success ? { kind: "ok", value: record.data } : invalid(zodIssues(record.error));
  }

  /** A sales order's demand lines, read only. */
  async salesOrder(name: string): Promise<ReadOutcome<ConnectorSalesOrder>> {
    const read = await this.document("Sales Order", name, nativeSalesOrderSchema);
    if (read.kind !== "ok") return read;
    const doc = read.value;
    const issues: string[] = [];
    const lines = doc.items.map((row) => {
      const ordered = wholeQuantity(row.qty);
      const delivered = wholeQuantity(row.delivered_qty);
      const stockQuantity = wholeQuantity(row.stock_qty);
      const conversion = ratioFromFactor(row.conversion_factor);
      if (!ordered || !delivered || !stockQuantity || !conversion) {
        issues.push(`row ${row.name}: quantity or conversion is not exact and whole`);
      }
      return {
        rowId: row.name,
        sku: row.item_code,
        uom: row.uom,
        ordered: ordered ?? "0",
        delivered: delivered ?? "0",
        stockUom: row.stock_uom,
        stockQuantity: stockQuantity ?? "0",
        conversion: conversion ?? { numerator: "1", denominator: "1" },
        warehouse: row.warehouse,
        deliveryDate: row.delivery_date,
      };
    });
    if (issues.length > 0) return invalid(issues);
    const record = connectorSalesOrderSchema.safeParse({
      contractVersion: CONNECTOR_CONTRACT_VERSION,
      ref: this.ref("Sales Order", doc),
      observedAt: this.clock().toISOString(),
      customer: doc.customer,
      company: doc.company,
      lines,
    });
    return record.success ? { kind: "ok", value: record.data } : invalid(zodIssues(record.error));
  }

  /** Stock aggregates of one item in every warehouse this principal may read. */
  async availability(sku: string): Promise<ReadOutcome<ConnectorAvailability[]>> {
    const read = await this.list("Bin", [["item_code", "=", sku]], BIN_FIELDS, nativeBinSchema);
    if (read.kind !== "ok") return read;
    const out: ConnectorAvailability[] = [];
    for (const bin of read.value) {
      const record = connectorAvailabilitySchema.safeParse({
        contractVersion: CONNECTOR_CONTRACT_VERSION,
        ref: this.ref("Bin", bin),
        observedAt: this.clock().toISOString(),
        sku: bin.item_code,
        warehouse: bin.warehouse,
        stockUom: bin.stock_uom,
        physical: wholeQuantity(bin.actual_qty),
        reservedStock: wholeQuantity(bin.reserved_stock),
        planningReserved: wholeQuantity(bin.reserved_qty),
        ordered: wholeQuantity(bin.ordered_qty),
        projected: signedWholeQuantity(bin.projected_qty),
      });
      if (!record.success) return invalid(zodIssues(record.error));
      out.push(record.data);
    }
    return { kind: "ok", value: out };
  }

  /** Submitted reservation entries of one item, each with its owning demand line. */
  async reservations(sku: string): Promise<ReadOutcome<ConnectorReservation[]>> {
    const read = await this.list(
      "Stock Reservation Entry",
      [
        ["item_code", "=", sku],
        ["docstatus", "=", 1],
      ],
      RESERVATION_FIELDS,
      nativeReservationSchema,
    );
    if (read.kind !== "ok") return read;
    const out: ConnectorReservation[] = [];
    for (const entry of read.value) {
      const record = connectorReservationSchema.safeParse({
        contractVersion: CONNECTOR_CONTRACT_VERSION,
        ref: this.ref("Stock Reservation Entry", entry),
        observedAt: this.clock().toISOString(),
        sku: entry.item_code,
        warehouse: entry.warehouse,
        stockUom: entry.stock_uom,
        reserved: wholeQuantity(entry.reserved_qty),
        delivered: wholeQuantity(entry.delivered_qty),
        transferred: wholeQuantity(entry.transferred_qty),
        consumed: wholeQuantity(entry.consumed_qty),
        status: entry.status,
        owner: {
          voucherType: entry.voucher_type,
          voucher: entry.voucher_no,
          row: entry.voucher_detail_no,
        },
      });
      if (!record.success) return invalid(zodIssues(record.error));
      out.push(record.data);
    }
    return { kind: "ok", value: out };
  }

  async stockEntry(name: string): Promise<ReadOutcome<NativeStockEntry>> {
    return this.document("Stock Entry", name, nativeStockEntrySchema);
  }

  /**
   * Stock Entries whose remarks carry an operation marker as a whole
   * whitespace-delimited token. The server-side `like` search is only a
   * superset; `sd-op:OP-1` never matches a record marked `sd-op:OP-10`.
   */
  async stockEntriesByMarker(marker: string): Promise<ReadOutcome<MarkedStockEntry[]>> {
    const read = await this.list(
      "Stock Entry",
      [["remarks", "like", `%${marker}%`]],
      ["name", "docstatus", "modified", "remarks"],
      nativeStockEntrySchema.pick({ name: true, docstatus: true, modified: true, remarks: true }),
    );
    if (read.kind !== "ok") return read;
    return {
      kind: "ok",
      value: read.value
        .filter((entry) => hasMarker(entry.remarks ?? "", marker))
        .map((entry) => ({
          name: entry.name,
          docstatus: entry.docstatus,
          modified: entry.modified,
          remarks: entry.remarks ?? "",
        })),
    };
  }
}
