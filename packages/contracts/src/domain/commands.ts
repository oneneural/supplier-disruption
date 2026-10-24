import { z } from "zod";
import {
  businessDateSchema,
  domainContractVersionSchema,
  instantSchema,
  labelSchema,
  positiveQuantitySchema,
  revisionSchema,
  sha256Schema,
  uomSchema,
} from "./primitives.js";
import { scheduleSegmentSchema } from "./sources.js";

/**
 * Source commands and native receipts of the fixture purchasing and
 * inventory/transfer authorities. A command names its operation, target and
 * the exact source version it is conditional on; the owning source checks
 * that version inside its own write transaction. A plan or action label in a
 * command records attribution only and is never proof of authorization.
 */

/**
 * The idempotency key of one source operation, unique per organization and
 * authority across operation kinds. Distinct from an action label: `ACT-2`
 * names a plan action, while its operation ID names one source request.
 */
export const operationIdSchema = labelSchema;

/** A native receipt ID, assigned by the owning source when it commits an effect. */
export const receiptIdSchema = z.uuid();

/**
 * Why a source refused a command. The two unqualified values are the oracle's
 * conflict reasons; the namespaced values are source errors the oracle leaves
 * open. A refused command has no effect and leaves no operation record.
 */
export const sourceRejectionReasonSchema = z.enum([
  "stale_base_revision",
  "stale_source_stock",
  "source.operation_conflict",
  "source.not_found",
  "source.uom_mismatch",
  "purchasing.unknown_po_line",
  "purchasing.schedule_quantity_mismatch",
  "inventory.insufficient_eligible_stock",
  "inventory.version_label_unavailable",
  "inventory.reservation_mismatch",
  "inventory.reservation_already_linked",
  "inventory.transfer_option_mismatch",
  "inventory.predecessor_receipt_mismatch",
]);

function uniqueSequences(segments: readonly { sequence: number }[]): boolean {
  return new Set(segments.map((segment) => segment.sequence)).size === segments.length;
}

const attribution = {
  planId: labelSchema,
  actionId: labelSchema,
};

/**
 * Replace one PO line's outstanding schedule, conditional on the PO being at
 * `expectedRevision`. The segments must total ordered minus received minus
 * canceled; quantities ordered, received and canceled never change.
 */
export const amendScheduleCommandSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  kind: z.literal("amend_schedule"),
  organization: labelSchema,
  operationId: operationIdSchema,
  poNumber: labelSchema,
  poLine: labelSchema,
  uom: uomSchema,
  expectedRevision: revisionSchema,
  ...attribution,
  segments: z.array(scheduleSegmentSchema).min(1).refine(uniqueSequences, "duplicate sequence"),
});

/**
 * Reserve stock at one warehouse, conditional on its stock being at
 * `expectedVersion` and the derived eligible quantity covering `quantity`.
 */
export const reserveStockCommandSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  kind: z.literal("reserve"),
  organization: labelSchema,
  operationId: operationIdSchema,
  sku: labelSchema,
  warehouse: labelSchema,
  uom: uomSchema,
  quantity: positiveQuantitySchema,
  expectedVersion: labelSchema,
  ...attribution,
});

/**
 * Create one requested transfer drawing on an existing plan reservation, not
 * on eligible stock. `expectedStockVersion` is the source warehouse's version
 * produced by `predecessorReceiptId`, which created `reservationId`.
 */
export const createTransferRequestCommandSchema = z
  .strictObject({
    contractVersion: domainContractVersionSchema,
    kind: z.literal("create_transfer_request"),
    organization: labelSchema,
    operationId: operationIdSchema,
    optionId: labelSchema,
    sku: labelSchema,
    uom: uomSchema,
    from: labelSchema,
    to: labelSchema,
    quantity: positiveQuantitySchema,
    dispatchDate: businessDateSchema,
    arrivalDate: businessDateSchema,
    expectedStockVersion: labelSchema,
    reservationId: labelSchema,
    predecessorReceiptId: receiptIdSchema,
    ...attribution,
  })
  .refine((command) => command.from !== command.to, {
    message: "from and to must differ",
    path: ["to"],
  });

const receiptBase = {
  contractVersion: domainContractVersionSchema,
  receiptId: receiptIdSchema,
  organization: labelSchema,
  operationId: operationIdSchema,
  /** SHA-256 of the canonical JSON of the validated command without its operation ID. */
  requestDigest: sha256Schema,
  ...attribution,
  /** Business time of the accepted effect, sampled from the injected clock while the source held its head. */
  recordedAt: instantSchema,
};

/** Purchasing's native receipt: the PO line amended from one revision to its successor. */
export const amendScheduleReceiptSchema = z.strictObject({
  ...receiptBase,
  kind: z.literal("amend_schedule"),
  poNumber: labelSchema,
  poLine: labelSchema,
  priorRevision: revisionSchema,
  successorRevision: revisionSchema,
});

/** Inventory's native receipt: one reservation and the stock version it produced. */
export const reservationReceiptSchema = z.strictObject({
  ...receiptBase,
  kind: z.literal("reserve"),
  sku: labelSchema,
  warehouse: labelSchema,
  priorVersion: labelSchema,
  successorVersion: labelSchema,
  reservationId: labelSchema,
  quantity: positiveQuantitySchema,
});

/** The transfer authority's native receipt: one request bound to one reservation. */
export const transferRequestReceiptSchema = z.strictObject({
  ...receiptBase,
  kind: z.literal("create_transfer_request"),
  sku: labelSchema,
  warehouse: labelSchema,
  /** The stock version checked; linking a reservation does not change it. */
  stockVersion: labelSchema,
  reservationId: labelSchema,
  transferRequestId: labelSchema,
  requestVersion: z.int().min(1),
});

export const inventoryReceiptSchema = z.discriminatedUnion("kind", [
  reservationReceiptSchema,
  transferRequestReceiptSchema,
]);

/**
 * A transfer request. `requested` is not dispatched: no stock leaves the
 * source warehouse, nothing is in transit and the destination gains nothing.
 * It draws on one identified plan reservation at the source warehouse.
 */
export const transferRequestSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  organization: labelSchema,
  requestId: labelSchema,
  version: z.int().min(1),
  status: z.literal("requested"),
  optionId: labelSchema,
  sku: labelSchema,
  uom: uomSchema,
  from: labelSchema,
  to: labelSchema,
  quantity: positiveQuantitySchema,
  dispatchDate: businessDateSchema,
  arrivalDate: businessDateSchema,
  reservation: z.strictObject({ stockVersion: labelSchema, reservationId: labelSchema }),
  planId: labelSchema,
});

export type SourceRejectionReason = z.infer<typeof sourceRejectionReasonSchema>;
export type AmendScheduleCommand = z.infer<typeof amendScheduleCommandSchema>;
export type ReserveStockCommand = z.infer<typeof reserveStockCommandSchema>;
export type CreateTransferRequestCommand = z.infer<typeof createTransferRequestCommandSchema>;
export type AmendScheduleReceipt = z.infer<typeof amendScheduleReceiptSchema>;
export type ReservationReceipt = z.infer<typeof reservationReceiptSchema>;
export type TransferRequestReceipt = z.infer<typeof transferRequestReceiptSchema>;
export type InventoryReceipt = z.infer<typeof inventoryReceiptSchema>;
export type TransferRequest = z.infer<typeof transferRequestSchema>;
