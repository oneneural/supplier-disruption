import { z } from "zod";
import type { ConversionRatio } from "@supplier-disruption/contracts";

/**
 * The parts of ERPNext v16.52.0 documents the connector reads. Unknown fields
 * pass through untouched, because a conditional purchase-order update must
 * send every row back exactly as it was read.
 */
const name = z.string().min(1).max(140);
const optionalName = name.nullable().optional();
const docstatus = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const date = z.iso.date();

export const nativePurchaseOrderRowSchema = z.looseObject({
  name,
  idx: z.int().min(1),
  item_code: name,
  qty: z.number(),
  stock_qty: z.number(),
  uom: name,
  stock_uom: name,
  conversion_factor: z.number(),
  schedule_date: date,
  warehouse: name,
  received_qty: z.number(),
  returned_qty: z.number().nullable().optional(),
  sales_order: optionalName,
  sales_order_item: optionalName,
  supplier_part_no: optionalName,
});

export const nativePurchaseOrderSchema = z.looseObject({
  name,
  modified: z.string().min(1).max(64),
  docstatus,
  status: z.string().max(140),
  supplier: name,
  company: name,
  amended_from: optionalName,
  items: z.array(nativePurchaseOrderRowSchema).min(1),
});

export const nativeItemSchema = z.looseObject({
  name,
  modified: z.string().min(1).max(64),
  docstatus,
  stock_uom: name,
  uoms: z.array(z.looseObject({ uom: name, conversion_factor: z.number() })),
  supplier_items: z
    .array(z.looseObject({ supplier: name, supplier_part_no: optionalName }))
    .optional(),
});

export const nativeSalesOrderSchema = z.looseObject({
  name,
  modified: z.string().min(1).max(64),
  docstatus,
  customer: name,
  company: name,
  items: z
    .array(
      z.looseObject({
        name,
        item_code: name,
        uom: name,
        qty: z.number(),
        stock_uom: name,
        stock_qty: z.number(),
        conversion_factor: z.number(),
        delivered_qty: z.number(),
        warehouse: name,
        delivery_date: date,
      }),
    )
    .min(1),
});

export const BIN_FIELDS = [
  "name",
  "modified",
  "docstatus",
  "item_code",
  "warehouse",
  "stock_uom",
  "actual_qty",
  "reserved_stock",
  "reserved_qty",
  "ordered_qty",
  "projected_qty",
] as const;

export const nativeBinSchema = z.looseObject({
  name,
  modified: z.string().min(1).max(64),
  docstatus,
  item_code: name,
  warehouse: name,
  stock_uom: name,
  actual_qty: z.number(),
  reserved_stock: z.number(),
  reserved_qty: z.number(),
  ordered_qty: z.number(),
  projected_qty: z.number(),
});

export const RESERVATION_FIELDS = [
  "name",
  "modified",
  "docstatus",
  "status",
  "item_code",
  "warehouse",
  "stock_uom",
  "voucher_type",
  "voucher_no",
  "voucher_detail_no",
  "reserved_qty",
  "delivered_qty",
  "transferred_qty",
  "consumed_qty",
] as const;

export const nativeReservationSchema = z.looseObject({
  name,
  modified: z.string().min(1).max(64),
  docstatus,
  status: z.string().max(140),
  item_code: name,
  warehouse: name,
  stock_uom: name,
  voucher_type: name,
  voucher_no: name,
  voucher_detail_no: name,
  reserved_qty: z.number(),
  delivered_qty: z.number(),
  transferred_qty: z.number(),
  consumed_qty: z.number(),
});

export const nativeStockEntrySchema = z.looseObject({
  name,
  modified: z.string().min(1).max(64),
  docstatus,
  stock_entry_type: name,
  company: name,
  remarks: z.string().nullable().optional(),
  items: z.array(
    z.looseObject({
      item_code: name,
      qty: z.number(),
      uom: name,
      conversion_factor: z.number(),
      s_warehouse: optionalName,
      t_warehouse: optionalName,
    }),
  ),
});

export type NativePurchaseOrder = z.infer<typeof nativePurchaseOrderSchema>;
export type NativeStockEntry = z.infer<typeof nativeStockEntrySchema>;

/**
 * A whole, nonnegative quantity from a JSON number, or null. A fraction is
 * never rounded: it makes the record unreadable under the whole-unit contract.
 */
export function wholeQuantity(value: number): string | null {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

/** A whole quantity that may be negative, such as a projected balance. */
export function signedWholeQuantity(value: number): string | null {
  return Number.isSafeInteger(value) ? String(value) : null;
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

/**
 * The exact ratio of a positive decimal factor as the source printed it.
 * JavaScript prints the shortest decimal that round-trips, which is the
 * value the source serialized; exponent forms are refused rather than guessed.
 */
export function ratioFromFactor(value: number): ConversionRatio | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return null;
  const fraction = match[2] ?? "";
  let numerator = BigInt(`${match[1]}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  const n = numerator.toString();
  const d = denominator.toString();
  return n.length <= 18 && d.length <= 18 ? { numerator: n, denominator: d } : null;
}
