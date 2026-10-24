import { z } from "zod";
import {
  businessDateSchema,
  instantSchema,
  knowable,
  labelSchema,
  quantitySchema,
  sha256Schema,
} from "./primitives.js";
import { demandSnapshotSchema, stockSnapshotSchema } from "./sources.js";

/**
 * Contracts of a remote market source connector (ADR 0018). They
 * describe what a remote ERP returned, without translating it into the
 * fixture authorities' business labels. Native names, units and tokens are
 * kept verbatim; a value the remote source does not hold is `unknown`, never
 * zero. Mapping into the domain contracts is a separate, explicit step that
 * may report the record as unresolved.
 */
export const CONNECTOR_CONTRACT_VERSION = "source-connector.v1";
export const connectorContractVersionSchema = z.literal(CONNECTOR_CONTRACT_VERSION);

/** A native document name, DocType, unit or warehouse as the remote source spells it. */
export const nativeNameSchema = z.string().min(1).max(140);

/**
 * One remote document at the version a read observed. `modified` is the
 * source's own concurrency token, copied byte for byte; it orders nothing and
 * is not a business revision number. `docstatus` 0 is a draft, 1 submitted
 * and 2 cancelled.
 */
export const nativeRecordRefSchema = z.strictObject({
  system: z.literal("erpnext"),
  /** The origin of the source instance, so records from two sites never compare equal. */
  site: z.url(),
  doctype: nativeNameSchema,
  name: nativeNameSchema,
  modified: z.string().min(1).max(64),
  docstatus: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

/** An exact positive conversion ratio from a source unit into stock units. */
export const conversionRatioSchema = z.strictObject({
  numerator: z.string().regex(/^[1-9][0-9]{0,17}$/),
  denominator: z.string().regex(/^[1-9][0-9]{0,17}$/),
});

/** An explicit native link from a purchase line to one demand line. */
export const nativeDemandLinkSchema = z.strictObject({
  salesOrder: nativeNameSchema,
  row: nativeNameSchema,
});

/**
 * One purchase-order row. Quantities are whole numbers in the row's own
 * unit; `stockQuantity` and `conversion` come from the row, not today's item
 * master. ERPNext has no cancelled-quantity field, so `canceled` is unknown
 * unless a future source supplies it.
 */
export const connectorPurchaseOrderLineSchema = z.strictObject({
  rowId: nativeNameSchema,
  position: z.int().min(1),
  sku: nativeNameSchema,
  uom: nativeNameSchema,
  ordered: quantitySchema,
  stockUom: nativeNameSchema,
  stockQuantity: quantitySchema,
  conversion: conversionRatioSchema,
  scheduleDate: businessDateSchema,
  warehouse: nativeNameSchema,
  received: quantitySchema,
  /** Unknown when the source omits it; an absent value is never zero. */
  returned: knowable(quantitySchema),
  canceled: knowable(quantitySchema),
  demandLink: nativeDemandLinkSchema.nullable(),
  supplierItem: nativeNameSchema.nullable(),
});

/** A purchase order as read, with its amendment lineage in both directions. */
export const connectorPurchaseOrderSchema = z.strictObject({
  contractVersion: connectorContractVersionSchema,
  ref: nativeRecordRefSchema,
  observedAt: instantSchema,
  supplier: nativeNameSchema,
  company: nativeNameSchema,
  status: z.string().max(140),
  amendedFrom: nativeNameSchema.nullable(),
  amendedBy: z.array(nativeNameSchema),
  lines: z.array(connectorPurchaseOrderLineSchema).min(1),
});

/**
 * Item units from the current item master. The master holds no effective
 * dates, so `effectiveDates` is always unknown here; a conversion exists only
 * as a listed master row, never from a lookup helper's default.
 */
export const connectorItemUnitsSchema = z.strictObject({
  contractVersion: connectorContractVersionSchema,
  ref: nativeRecordRefSchema,
  observedAt: instantSchema,
  sku: nativeNameSchema,
  stockUom: nativeNameSchema,
  conversions: z.array(z.strictObject({ uom: nativeNameSchema, ratio: conversionRatioSchema })),
  supplierItems: z.array(
    z.strictObject({ supplier: nativeNameSchema, supplierItem: nativeNameSchema }),
  ),
  effectiveDates: z.strictObject({ state: z.literal("unknown") }),
});

/** One sales-order row. Ordered and delivered quantities are in the row unit. */
export const connectorDemandLineSchema = z.strictObject({
  rowId: nativeNameSchema,
  sku: nativeNameSchema,
  uom: nativeNameSchema,
  ordered: quantitySchema,
  delivered: quantitySchema,
  stockUom: nativeNameSchema,
  stockQuantity: quantitySchema,
  conversion: conversionRatioSchema,
  warehouse: nativeNameSchema,
  deliveryDate: businessDateSchema,
});

export const connectorSalesOrderSchema = z.strictObject({
  contractVersion: connectorContractVersionSchema,
  ref: nativeRecordRefSchema,
  observedAt: instantSchema,
  customer: nativeNameSchema,
  company: nativeNameSchema,
  lines: z.array(connectorDemandLineSchema).min(1),
});

/**
 * One item/warehouse stock aggregate. `physical` is on-hand stock and
 * `reservedStock` the physical holds of reservation entries. `planningReserved`
 * is open sales demand, a different concept that must never be subtracted
 * again; `ordered` and `projected` are inbound planning figures, never stock.
 */
export const connectorAvailabilitySchema = z.strictObject({
  contractVersion: connectorContractVersionSchema,
  ref: nativeRecordRefSchema,
  observedAt: instantSchema,
  sku: nativeNameSchema,
  warehouse: nativeNameSchema,
  stockUom: nativeNameSchema,
  physical: quantitySchema,
  reservedStock: quantitySchema,
  planningReserved: quantitySchema,
  ordered: quantitySchema,
  projected: z.string().regex(/^-?(?:0|[1-9][0-9]{0,17})$/),
});

/** One submitted stock reservation entry and the native demand line that owns it. */
export const connectorReservationSchema = z.strictObject({
  contractVersion: connectorContractVersionSchema,
  ref: nativeRecordRefSchema,
  observedAt: instantSchema,
  sku: nativeNameSchema,
  warehouse: nativeNameSchema,
  stockUom: nativeNameSchema,
  reserved: quantitySchema,
  delivered: quantitySchema,
  transferred: quantitySchema,
  consumed: quantitySchema,
  status: z.string().max(140),
  owner: z.strictObject({
    voucherType: nativeNameSchema,
    voucher: nativeNameSchema,
    row: nativeNameSchema,
  }),
});

/** Write operations the connector can attempt or must report as unsupported. */
export const connectorOperationKindSchema = z.enum([
  "update_schedule_date",
  "create_transfer_request_draft",
  "update_items_quantity",
  "split_line",
  "cancel_and_amend",
  "plan_bound_reservation",
  "transfer_submission",
]);

/**
 * Why an operation did not apply. `missing_source_token`, `duplicate_operation`
 * and `operation_conflict` are decided by the connector before any request;
 * the others classify the source's response.
 */
export const connectorRefusalReasonSchema = z.enum([
  "missing_source_token",
  "duplicate_operation",
  "operation_conflict",
  "stale_source_token",
  "authentication_failed",
  "permission_denied",
  "not_found",
  "business_validation",
  "rejected",
]);

/**
 * The connector's own durable operation record. The remote source offers no
 * native idempotency, so this record, written before the request, plus a
 * read-back is the only protection against a second effect. `unknown` means
 * the source may or may not have committed; only a read-back may move it.
 * `unsupported` operations were never sent and stay with an operator.
 */
export const connectorOperationStateSchema = z.enum([
  "dispatching",
  "applied",
  "refused",
  "unknown",
  "manual_reconciliation",
  "unsupported",
]);

export const connectorOperationEventSchema = z.strictObject({
  at: instantSchema,
  state: connectorOperationStateSchema,
  /** HTTP status, absent when no response arrived or no request was sent. */
  status: z.int().min(100).max(599).optional(),
  /** The source's exception type, such as `TimestampMismatchError`. */
  sourceError: z.string().max(200).optional(),
  note: z.string().max(500),
});

/**
 * The exact effect an operation intends, kept so that a read-back after a
 * lost response or a restart can compare the source against it. A schedule
 * update lists every row as it must read afterwards, so a change to any other
 * row is a divergence rather than success.
 */
export const connectorOperationIntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("update_schedule_date"),
    rowId: nativeNameSchema,
    scheduleDate: businessDateSchema,
    rowsAfter: z
      .array(
        z.strictObject({
          rowId: nativeNameSchema,
          sku: nativeNameSchema,
          ordered: quantitySchema,
          received: quantitySchema,
          scheduleDate: businessDateSchema,
        }),
      )
      .min(1),
  }),
  z.strictObject({
    kind: z.literal("create_transfer_request_draft"),
    company: nativeNameSchema,
    sku: nativeNameSchema,
    stockUom: nativeNameSchema,
    /** Zero is accepted here only so that the refusal of an invalid request is recorded. */
    quantity: quantitySchema,
    from: nativeNameSchema,
    to: nativeNameSchema,
  }),
  z.strictObject({ kind: z.literal("not_sent") }),
]);

export const connectorOperationRecordSchema = z.strictObject({
  contractVersion: connectorContractVersionSchema,
  operationId: labelSchema,
  kind: connectorOperationKindSchema,
  target: z.strictObject({ doctype: nativeNameSchema, name: nativeNameSchema.nullable() }),
  intent: connectorOperationIntentSchema,
  /** The source token the request was conditional on; null for a create. */
  expectedModified: z.string().min(1).max(64).nullable(),
  /** A unique marker written into the created record, used to find it after a lost response. */
  marker: z.string().min(1).max(140).nullable(),
  requestSha256: sha256Schema,
  state: connectorOperationStateSchema,
  reason: connectorRefusalReasonSchema.nullable(),
  /** The native document the operation created or changed, once read back. */
  nativeName: nativeNameSchema.nullable(),
  /** The source token read back after the effect, when one was observed. */
  observedModified: z.string().min(1).max(64).nullable(),
  /** Requests actually sent. A connector never sends a second one for an operation. */
  requestsSent: z.int().min(0).max(1),
  history: z.array(connectorOperationEventSchema).min(1),
});

/**
 * A domain stock snapshot with the provenance its contract has no field for:
 * every native record read, and the caller's declaration of the buckets
 * ERPNext does not hold. Declared values are assertions, not source data.
 */
export const mappedStockSnapshotSchema = z.strictObject({
  snapshot: stockSnapshotSchema,
  sources: z.array(nativeRecordRefSchema).min(1),
  declared: z.strictObject({
    qualityHold: quantitySchema,
    safetyStock: quantitySchema,
    declaredBy: z.string().min(1).max(200),
  }),
});

/** A domain demand snapshot with the native record it came from. */
export const mappedDemandSnapshotSchema = z.strictObject({
  snapshot: demandSnapshotSchema,
  sources: z.array(nativeRecordRefSchema).min(1),
});

export type NativeRecordRef = z.infer<typeof nativeRecordRefSchema>;
export type ConversionRatio = z.infer<typeof conversionRatioSchema>;
export type ConnectorPurchaseOrderLine = z.infer<typeof connectorPurchaseOrderLineSchema>;
export type ConnectorPurchaseOrder = z.infer<typeof connectorPurchaseOrderSchema>;
export type ConnectorItemUnits = z.infer<typeof connectorItemUnitsSchema>;
export type ConnectorDemandLine = z.infer<typeof connectorDemandLineSchema>;
export type ConnectorSalesOrder = z.infer<typeof connectorSalesOrderSchema>;
export type ConnectorAvailability = z.infer<typeof connectorAvailabilitySchema>;
export type ConnectorReservation = z.infer<typeof connectorReservationSchema>;
export type ConnectorOperationKind = z.infer<typeof connectorOperationKindSchema>;
export type ConnectorRefusalReason = z.infer<typeof connectorRefusalReasonSchema>;
export type ConnectorOperationState = z.infer<typeof connectorOperationStateSchema>;
export type ConnectorOperationEvent = z.infer<typeof connectorOperationEventSchema>;
export type ConnectorOperationIntent = z.infer<typeof connectorOperationIntentSchema>;
export type ConnectorOperationRecord = z.infer<typeof connectorOperationRecordSchema>;
export type MappedStockSnapshot = z.infer<typeof mappedStockSnapshotSchema>;
export type MappedDemandSnapshot = z.infer<typeof mappedDemandSnapshotSchema>;
