import { z } from "zod";
import {
  coverageAssessmentInputSchema,
  coverageAssessmentSchema,
  envelopeObservedAtSchema,
  purchaseOrderDataSchema,
  readEvidenceSchema,
  readProvenanceSchema,
  readReasonSchema,
  readScopeSchema,
  supplierInputDataSchema,
} from "./assessment.js";
import {
  instantSchema,
  knowable,
  labelSchema,
  revisionSchema,
  sha256Schema,
  versionNumberSchema,
} from "./primitives.js";
import { vendorSchema } from "./reference.js";
import { supplierInputIdentitySchema, supplierProposalSchema } from "./sources.js";

/**
 * Intake identity and source guard contracts (ADR 0008). Intake
 * classifies one structured supplier input as `accept`, `duplicate` or
 * `blocked` before any assessment runs. It writes nothing: an accepted input
 * is eligible for assessment, never an accepted PO amendment, an approval or
 * permission to execute, and its receipt is a value the caller must retain.
 */
export const INTAKE_CONTRACT_VERSION = "supplier-intake.v1";

/**
 * Why intake blocked an input. The four unprefixed values are the frozen
 * oracle's (N-02 to N-04); every `intake_` value is an implementation
 * contract decision recorded in ADR 0008.
 */
export const intakeBlockReasonSchema = z.enum([
  "unverified_sender",
  "vendor_mismatch",
  "unknown_po_line",
  "stale_base_revision",
  "intake_invalid_input",
  "intake_content_hash_mismatch",
  "intake_identity_conflict",
  "intake_ambiguous_sender",
  "intake_scope_mismatch",
  "intake_source_unavailable",
  "intake_possible_duplicate",
  "intake_unknown_po",
  "intake_ambiguous_po_line",
  "intake_base_revision_ahead",
]);

/**
 * The structured input as delivered: identity and proposal. `supplierText`
 * is opaque evidence text kept beside them. It is never parsed for identity,
 * policy, recipients, roles, permissions or tool configuration, and it is
 * not part of the terms or their digest. Strict parsing means no supplier
 * field can carry a receipt, state or authority claim.
 */
export const intakeDeliverySchema = z.strictObject({
  identity: supplierInputIdentitySchema,
  proposal: supplierProposalSchema,
  supplierText: z.string().max(20_000).optional(),
});

/**
 * A reference read the assessment contract has no slot for: the vendor
 * registered for a sender, or one vendor by ID. Scope, binding and
 * provenance are kept as the read returned them.
 */
export const intakeReadScopeSchema = z.strictObject({
  owner: z.literal("reference"),
  resource: z.enum(["registered_vendor", "vendor"]),
  organization: labelSchema,
  selectors: readScopeSchema.shape.selectors,
  binding: readScopeSchema.shape.binding.unwrap(),
});

export const intakeReadProvenanceSchema = z.strictObject({
  scope: intakeReadScopeSchema,
  readAt: instantSchema,
  observedAt: envelopeObservedAtSchema,
});

/** The same outcomes as `readEvidenceSchema`, for the intake-only vendor reads. */
export const intakeVendorEvidenceSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    provenance: intakeReadProvenanceSchema,
    data: vendorSchema,
  }),
  z.strictObject({
    status: z.literal("not_found"),
    scope: intakeReadScopeSchema,
    readAt: knowable(instantSchema),
    reason: readReasonSchema,
  }),
  z.strictObject({
    status: z.literal("ambiguous"),
    scope: intakeReadScopeSchema,
    readAt: instantSchema,
    reason: readReasonSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    scope: intakeReadScopeSchema,
    reason: readReasonSchema,
    attemptedAt: knowable(instantSchema),
  }),
]);

/**
 * An immutable acceptance receipt. A pure value proposed by intake for the
 * caller to retain; it is not a durable record, a lock or a uniqueness
 * guarantee. The message key is organization, source system and message ID.
 */
export const intakeReceiptSchema = z.strictObject({
  contractVersion: z.literal(INTAKE_CONTRACT_VERSION),
  receiptId: labelSchema,
  organization: labelSchema,
  sourceSystem: labelSchema,
  messageId: labelSchema,
  inputVersion: versionNumberSchema,
  sender: z.email(),
  vendorId: labelSchema,
  contentSha256: sha256Schema,
  proposalId: labelSchema,
  evidenceRef: labelSchema,
  poNumber: labelSchema,
  poLine: labelSchema,
  baseRevision: revisionSchema,
  acceptedAt: instantSchema,
  /** The application case the receipt belongs to, when the caller has one. */
  caseId: labelSchema.nullable(),
});

/** What the trusted prior-acceptance lookup was asked for. */
export const priorAcceptanceQuerySchema = z.strictObject({
  organization: labelSchema,
  sourceSystem: labelSchema,
  messageId: labelSchema,
  contentSha256: sha256Schema,
});

/**
 * The trusted application's prior-acceptance lookup, never a supplier field
 * and never a source operation lookup. `receipt` is a receipt for the same
 * message key; `candidate` is a receipt of a different message with the same
 * terms digest; `none` is authoritative absence; `unavailable` is a failed
 * lookup, which is never absence.
 */
export const priorAcceptanceSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("none"), query: priorAcceptanceQuerySchema }),
  z.strictObject({
    status: z.literal("receipt"),
    query: priorAcceptanceQuerySchema,
    receipt: intakeReceiptSchema,
  }),
  z.strictObject({
    status: z.literal("candidate"),
    query: priorAcceptanceQuerySchema,
    receipt: intakeReceiptSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    query: priorAcceptanceQuerySchema,
    reason: readReasonSchema,
  }),
]);

const assessmentReads = coverageAssessmentInputSchema.shape.reads;

/** The assessment reads intake passes through unchanged after acceptance. */
export const intakeAssessmentReadsSchema = assessmentReads.omit({
  supplierInput: true,
  purchaseOrder: true,
});

/**
 * One intake call. Organization, times and IDs come from trusted composition;
 * `delivery` is the supplier-originated part. The purchase order read must be
 * a current-head read. A vendor read may be null when it was not read, which
 * blocks a new input but not an exact replay.
 */
export const intakeInputSchema = z.strictObject({
  contractVersion: z.literal(INTAKE_CONTRACT_VERSION),
  organization: labelSchema,
  assessedAt: instantSchema,
  receiptId: labelSchema,
  caseId: labelSchema.nullable(),
  planId: labelSchema,
  planVersion: versionNumberSchema,
  delivery: intakeDeliverySchema,
  priorAcceptance: priorAcceptanceSchema,
  reads: z.strictObject({
    supplierInput: readEvidenceSchema(supplierInputDataSchema),
    registeredVendor: intakeVendorEvidenceSchema,
    vendor: intakeVendorEvidenceSchema.nullable(),
    purchaseOrder: readEvidenceSchema(purchaseOrderDataSchema),
    assessment: intakeAssessmentReadsSchema,
  }),
  candidateOffers: coverageAssessmentInputSchema.shape.candidateOffers,
});

/**
 * The trusted envelope alone: what intake needs to state any result. Its
 * other parts are validated separately, so malformed supplier or context
 * fields become an owned block rather than a thrown error.
 */
export const intakeEnvelopeSchema = intakeInputSchema.extend({
  delivery: z.unknown(),
  priorAcceptance: z.unknown(),
  reads: z.unknown(),
  candidateOffers: z.unknown(),
});

const decisionBase = {
  contractVersion: z.literal(INTAKE_CONTRACT_VERSION),
  organization: labelSchema,
  decidedAt: instantSchema,
};

export const intakeAcceptSchema = z.strictObject({
  disposition: z.literal("accept"),
  ...decisionBase,
  identity: supplierInputIdentitySchema,
  proposal: supplierProposalSchema,
  /** Resolved from the exact registered sender, never stated by the supplier. */
  vendorId: labelSchema,
  association: z.strictObject({
    poNumber: labelSchema,
    poLine: labelSchema,
    baseRevision: revisionSchema,
    currentRevision: revisionSchema,
  }),
  contentSha256: sha256Schema,
  provenance: z.strictObject({
    supplierInput: readProvenanceSchema,
    registeredVendor: intakeReadProvenanceSchema,
    vendor: intakeReadProvenanceSchema,
    purchaseOrder: readProvenanceSchema,
  }),
  proposedReceipt: intakeReceiptSchema,
});

/** An exact replay of an accepted input: no new receipt, proposal, assessment or plan. */
export const intakeDuplicateSchema = z.strictObject({
  disposition: z.literal("duplicate"),
  ...decisionBase,
  identity: supplierInputIdentitySchema,
  priorReceipt: intakeReceiptSchema,
});

/** No assessment input, no plan. The evidence examined is kept to explain the quarantine. */
export const intakeBlockedSchema = z.strictObject({
  disposition: z.literal("blocked"),
  ...decisionBase,
  decision: z.strictObject({
    recommendedState: z.literal("needs_clarification"),
    reason: intakeBlockReasonSchema,
    owner: z.literal("buyer"),
  }),
  /** The input the first failing guard concerns, such as `reads.purchaseOrder`. */
  subject: z.string().min(1).max(200),
  /** The first failing guard's detail, then any further guard failures found. */
  diagnostics: z.array(z.string().min(1).max(2000)).min(1),
  /** The delivered identity, or null when the delivery did not parse. */
  identity: supplierInputIdentitySchema.nullable(),
  examined: z.strictObject({
    supplierInput: readEvidenceSchema(supplierInputDataSchema).optional(),
    registeredVendor: intakeVendorEvidenceSchema.optional(),
    priorAcceptance: priorAcceptanceSchema.optional(),
    vendor: intakeVendorEvidenceSchema.optional(),
    purchaseOrder: readEvidenceSchema(purchaseOrderDataSchema).optional(),
  }),
});

export const intakeDecisionSchema = z.discriminatedUnion("disposition", [
  intakeAcceptSchema,
  intakeDuplicateSchema,
  intakeBlockedSchema,
]);

/** Intake and, only for `accept`, the assessment of the accepted input. */
export const intakeOutcomeSchema = z
  .strictObject({
    intake: intakeDecisionSchema,
    assessment: coverageAssessmentSchema.nullable(),
  })
  .refine(
    (outcome) => (outcome.intake.disposition === "accept") === (outcome.assessment !== null),
    {
      message: "only an accepted input is assessed",
      path: ["assessment"],
    },
  );

export type IntakeBlockReason = z.infer<typeof intakeBlockReasonSchema>;
export type IntakeDelivery = z.infer<typeof intakeDeliverySchema>;
export type IntakeReadScope = z.infer<typeof intakeReadScopeSchema>;
export type IntakeReadProvenance = z.infer<typeof intakeReadProvenanceSchema>;
export type IntakeVendorEvidence = z.infer<typeof intakeVendorEvidenceSchema>;
export type IntakeReceipt = z.infer<typeof intakeReceiptSchema>;
export type PriorAcceptanceQuery = z.infer<typeof priorAcceptanceQuerySchema>;
export type PriorAcceptance = z.infer<typeof priorAcceptanceSchema>;
export type IntakeAssessmentReads = z.infer<typeof intakeAssessmentReadsSchema>;
export type IntakeInput = z.infer<typeof intakeInputSchema>;
export type IntakeAccept = z.infer<typeof intakeAcceptSchema>;
export type IntakeDuplicate = z.infer<typeof intakeDuplicateSchema>;
export type IntakeBlocked = z.infer<typeof intakeBlockedSchema>;
export type IntakeDecision = z.infer<typeof intakeDecisionSchema>;
export type IntakeOutcome = z.infer<typeof intakeOutcomeSchema>;
