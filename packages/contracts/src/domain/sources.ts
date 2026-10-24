import { z } from "zod";
import {
  actorRoleSchema,
  arrivalSchema,
  businessDateSchema,
  domainContractVersionSchema,
  instantSchema,
  knowable,
  labelSchema,
  moneySchema,
  positiveQuantitySchema,
  quantitySchema,
  revisionSchema,
  sha256Schema,
  uomSchema,
  versionNumberSchema,
} from "./primitives.js";

/** The fixture authorities whose records the first slice reads. */
export const sourceAuthoritySchema = z.enum([
  "purchasing",
  "inventory",
  "demand",
  "transfer",
  "item_master",
  "supplier",
]);

/**
 * Identifies one source record: organization and authority, document, optional
 * line and segment, and the source's own version or revision. The version is
 * the source's ordering, independent of when the record was observed.
 */
export const sourceIdentitySchema = z.strictObject({
  organization: labelSchema,
  authority: sourceAuthoritySchema,
  document: labelSchema,
  line: labelSchema.optional(),
  segment: labelSchema.optional(),
  version: labelSchema,
  observedAt: knowable(instantSchema),
  effectiveDate: knowable(businessDateSchema),
});

/** A reference to one PO line at one revision. */
export const poLineRefSchema = z.strictObject({
  poNumber: labelSchema,
  poLine: labelSchema,
});

/** A dated (or undated) schedule segment of a PO line or a supplier proposal. */
export const scheduleSegmentSchema = z.strictObject({
  sequence: z.int().min(1),
  quantity: positiveQuantitySchema,
  arrival: arrivalSchema,
});

function uniqueSequences(segments: readonly { sequence: number }[]): boolean {
  return new Set(segments.map((segment) => segment.sequence)).size === segments.length;
}

export const purchaseOrderLineSchema = z.strictObject({
  lineNumber: labelSchema,
  sku: labelSchema,
  uom: uomSchema,
  destination: labelSchema,
  ordered: quantitySchema,
  received: quantitySchema,
  canceled: quantitySchema,
  acceptedSegments: z.array(scheduleSegmentSchema).refine(uniqueSequences, "duplicate sequence"),
});

/** One accepted PO revision, owned by purchasing. */
export const purchaseOrderRevisionSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  organization: labelSchema,
  poNumber: labelSchema,
  revision: revisionSchema,
  vendorId: labelSchema,
  observedAt: knowable(instantSchema),
  effectiveDate: knowable(businessDateSchema),
  lines: z.array(purchaseOrderLineSchema).min(1),
});

/**
 * Proposed terms as the supplier stated them. A proposal is not an accepted PO
 * amendment and never adds supply beside the accepted schedule. The vendor is
 * resolved from the registered sender at intake, not stated by the supplier.
 */
export const supplierProposalTermsSchema = z.strictObject({
  poNumber: labelSchema,
  poLine: labelSchema,
  baseRevision: revisionSchema,
  vendorItem: labelSchema,
  uom: uomSchema,
  segments: z.array(scheduleSegmentSchema).min(1).refine(uniqueSequences, "duplicate sequence"),
  /** Field paths the supplier left unresolved. */
  unresolvedFields: z.array(z.string().min(1).max(200)),
});

/** Identity of one structured supplier input. Its content hash excludes the message ID. */
export const supplierInputIdentitySchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  sourceSystem: labelSchema,
  messageId: labelSchema,
  inputVersion: versionNumberSchema,
  contentSha256: sha256Schema,
  sender: z.email(),
  proposalId: labelSchema,
  evidenceRef: labelSchema,
  authoredAt: knowable(instantSchema),
  receivedAt: knowable(instantSchema),
});

export const supplierProposalSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  proposalId: labelSchema,
  terms: supplierProposalTermsSchema,
  evidence: z.strictObject({
    sourceSystem: labelSchema,
    messageId: labelSchema,
    inputVersion: versionNumberSchema,
  }),
});

const positiveIntegerString = z.string().regex(/^[1-9][0-9]{0,17}$/);

/**
 * One item-master mapping version. The ratio converts one source unit into
 * `numerator / denominator` stock units exactly. Dates are inclusive; a null
 * `effectiveThrough` has no end. No conversion or substitute equivalence
 * exists outside an effective mapping.
 */
export const itemMappingSchema = z
  .strictObject({
    contractVersion: domainContractVersionSchema,
    mappingId: labelSchema,
    version: versionNumberSchema,
    vendorId: labelSchema,
    vendorItem: labelSchema,
    sourceUom: uomSchema,
    sku: labelSchema,
    stockUom: uomSchema,
    ratio: z.strictObject({ numerator: positiveIntegerString, denominator: positiveIntegerString }),
    effectiveFrom: businessDateSchema,
    effectiveThrough: businessDateSchema.nullable(),
    provenance: z.literal("item_master"),
  })
  .refine(
    (mapping) =>
      mapping.effectiveThrough === null || mapping.effectiveThrough >= mapping.effectiveFrom,
    { message: "effectiveThrough precedes effectiveFrom", path: ["effectiveThrough"] },
  );

/**
 * An individually identified reservation. `unrelated` reservations belong to
 * no plan; a plan-bound reservation names its plan.
 */
export const reservationSchema = z.strictObject({
  reservationId: labelSchema,
  quantity: positiveQuantitySchema,
  binding: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unrelated") }),
    z.strictObject({ kind: z.literal("plan"), planId: labelSchema }),
  ]),
});

/**
 * One versioned stock snapshot of a SKU at a warehouse. Physical stock,
 * quality holds, safety stock and reservations are separate buckets. Eligible
 * stock is derived by policy, never stored or accepted as a writable counter.
 */
export const stockSnapshotSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  organization: labelSchema,
  version: labelSchema,
  sku: labelSchema,
  warehouse: labelSchema,
  uom: uomSchema,
  observedAt: knowable(instantSchema),
  physical: quantitySchema,
  qualityHold: quantitySchema,
  safetyStock: quantitySchema,
  reservations: z
    .array(reservationSchema)
    .refine(
      (items) => new Set(items.map((item) => item.reservationId)).size === items.length,
      "duplicate reservationId",
    ),
});

/**
 * Expected inbound supply, referenced by its purchasing source identity. The
 * quantity and arrival stay with purchasing; inbound is never stock.
 */
export const expectedInboundRefSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  sku: labelSchema,
  destination: labelSchema,
  purchasing: z.strictObject({
    poNumber: labelSchema,
    revision: revisionSchema,
    poLine: labelSchema,
    segment: z.int().min(1),
  }),
});

/** A transfer already dispatched: neither source nor destination physical stock. */
export const inTransitRecordSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  transitId: labelSchema,
  sku: labelSchema,
  uom: uomSchema,
  from: labelSchema,
  to: labelSchema,
  quantity: positiveQuantitySchema,
  dispatchedOn: knowable(businessDateSchema),
  arrival: arrivalSchema,
});

/**
 * One demand line. Open and delivered quantities, destination, cutoff and
 * priority come from the demand authority, as do its explicit supply links,
 * which are versioned with the demand snapshot.
 */
export const demandLineSchema = z.strictObject({
  salesOrder: labelSchema,
  line: labelSchema,
  sku: labelSchema,
  uom: uomSchema,
  open: quantitySchema,
  delivered: knowable(quantitySchema),
  destination: labelSchema,
  receiptCutoff: businessDateSchema,
  calendar: z.strictObject({ policyId: labelSchema, version: versionNumberSchema }),
  priority: z.int().min(1),
  supplyLinks: z.array(poLineRefSchema),
});

export const demandSnapshotSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  organization: labelSchema,
  version: labelSchema,
  observedAt: knowable(instantSchema),
  lines: z.array(demandLineSchema).min(1),
});

/**
 * A transfer option (quote). It is valid until `validUntil` and only for the
 * stock version it was based on. An option is not a confirmation; the
 * planner's confirmation is a separate event.
 */
export const transferOptionSchema = z
  .strictObject({
    contractVersion: domainContractVersionSchema,
    optionId: labelSchema,
    sku: labelSchema,
    uom: uomSchema,
    from: labelSchema,
    to: labelSchema,
    quantity: positiveQuantitySchema,
    dispatchDate: businessDateSchema,
    arrivalDate: businessDateSchema,
    cost: moneySchema,
    validUntil: instantSchema,
    basedOn: labelSchema,
    owner: actorRoleSchema,
  })
  .refine((option) => option.from !== option.to, {
    message: "from and to must differ",
    path: ["to"],
  })
  // A dispatch date is never an arrival: the option arrives on or after it.
  .refine((option) => option.dispatchDate <= option.arrivalDate, {
    message: "arrivalDate precedes dispatchDate",
    path: ["arrivalDate"],
  });

export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;
export type PurchaseOrderRevision = z.infer<typeof purchaseOrderRevisionSchema>;
export type ScheduleSegment = z.infer<typeof scheduleSegmentSchema>;
export type SupplierProposalTerms = z.infer<typeof supplierProposalTermsSchema>;
export type SupplierProposal = z.infer<typeof supplierProposalSchema>;
export type SupplierInputIdentity = z.infer<typeof supplierInputIdentitySchema>;
export type ItemMapping = z.infer<typeof itemMappingSchema>;
export type Reservation = z.infer<typeof reservationSchema>;
export type StockSnapshot = z.infer<typeof stockSnapshotSchema>;
export type ExpectedInboundRef = z.infer<typeof expectedInboundRefSchema>;
export type InTransitRecord = z.infer<typeof inTransitRecordSchema>;
export type DemandSnapshot = z.infer<typeof demandSnapshotSchema>;
export type TransferOption = z.infer<typeof transferOptionSchema>;
