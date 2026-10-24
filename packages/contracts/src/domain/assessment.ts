import { z } from "zod";
import {
  actorRoleSchema,
  arrivalSchema,
  businessDateSchema,
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
import { itemSchema, policySchema } from "./reference.js";
import {
  demandSnapshotSchema,
  inTransitRecordSchema,
  itemMappingSchema,
  poLineRefSchema,
  purchaseOrderRevisionSchema,
  scheduleSegmentSchema,
  stockSnapshotSchema,
  supplierInputIdentitySchema,
  supplierProposalTermsSchema,
  transferOptionSchema,
} from "./sources.js";

/**
 * Coverage assessment and proposed plan contracts (ADR 0007). An
 * assessment is a deterministic calculation over materialized source reads;
 * it writes nothing. A proposed plan is an immutable, hashed intent, never an
 * approval, a source command or evidence of a source effect.
 */
export const ASSESSMENT_CONTRACT_VERSION = "coverage-assessment.v1";
export const PLAN_CONTRACT_VERSION = "coverage-plan.v1";
/** The rule implementation a result and plan were produced by. */
export const COVERAGE_RULES_VERSION = "coverage-allocation-rules.v1";

/**
 * A reason value. Oracle reasons are exact; reasons the oracle leaves open
 * carry the `policy_` prefix (ADR 0007).
 */
export const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

/** A read classification, such as `connection_unavailable` or `source.not_found`. */
export const readReasonSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,62}$/);

/**
 * What a read asked for, as the composing caller stated it: owner, resource,
 * organization, every selector and, for reference reads, the trusted fixture
 * binding. A collection scope carries its fixed bound.
 */
export const readScopeSchema = z.strictObject({
  owner: z.enum(["purchasing", "inventory", "demand", "reference"]),
  resource: z.enum([
    "purchase_order",
    "stock",
    "demand",
    "in_transit",
    "transfer_options",
    "item",
    "item_mappings",
    "policy",
    "supplier_input",
    "prior_commitments",
  ]),
  organization: labelSchema,
  selectors: z.record(
    z.string().regex(/^[a-z][A-Za-z]{0,31}$/),
    z.union([z.string().min(1).max(320), z.int()]),
  ),
  binding: z
    .strictObject({
      state: z.enum(["validated", "attempted"]),
      label: labelSchema,
      organizationId: z.uuid(),
    })
    .optional(),
  bound: z.literal(100).optional(),
});

/**
 * Observation time as the read envelope stated it. `not_returned` means the
 * envelope has no such field (the record may carry its own); `unknown` means
 * the envelope said it is unknown. Read time is never observation time.
 */
export const envelopeObservedAtSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("known"), value: instantSchema }),
  z.strictObject({ state: z.literal("unknown") }),
  z.strictObject({ state: z.literal("not_returned") }),
]);

export const readProvenanceSchema = z.strictObject({
  scope: readScopeSchema,
  /** Business time the source sampled before its own read transaction. */
  readAt: instantSchema,
  observedAt: envelopeObservedAtSchema,
});

/**
 * One attempted read. Only `ok` carries data. `not_found` and `ambiguous`
 * are attributable outcomes of a read that ran; `unavailable` means the
 * evidence could not be read and is never zero, empty or remembered data.
 */
export function readEvidenceSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("ok"), provenance: readProvenanceSchema, data }),
    z.strictObject({
      status: z.literal("not_found"),
      scope: readScopeSchema,
      readAt: knowable(instantSchema),
      reason: readReasonSchema,
    }),
    z.strictObject({
      status: z.literal("ambiguous"),
      scope: readScopeSchema,
      readAt: instantSchema,
      reason: readReasonSchema,
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      scope: readScopeSchema,
      reason: readReasonSchema,
      attemptedAt: knowable(instantSchema),
    }),
  ]);
}

/** How a stock version came to be, as the inventory read returned it. */
export const stockLineageSchema = z.strictObject({
  parentVersion: labelSchema,
  receiptId: z.uuid(),
  operationId: labelSchema,
  planId: labelSchema,
  actionId: labelSchema,
  recordedAt: instantSchema,
});

export const purchaseOrderDataSchema = z.strictObject({
  currentRevision: revisionSchema,
  record: purchaseOrderRevisionSchema,
});
export const stockDataSchema = z.strictObject({
  currentVersion: labelSchema,
  record: stockSnapshotSchema,
  lineage: stockLineageSchema.nullable(),
});
export const demandDataSchema = z.strictObject({
  currentVersion: labelSchema,
  record: demandSnapshotSchema,
});
/** A complete scoped collection: an empty one is authoritative absence at that read. */
export const transferOptionsDataSchema = z.strictObject({
  records: z.array(transferOptionSchema).max(100),
  complete: z.literal(true),
});
export const inTransitDataSchema = z.strictObject({ records: z.array(inTransitRecordSchema) });
export const itemMappingsDataSchema = z.strictObject({
  records: z.array(itemMappingSchema).max(100),
  complete: z.literal(true),
});
export const supplierInputDataSchema = z.strictObject({
  identity: supplierInputIdentitySchema,
  terms: supplierProposalTermsSchema,
});

/**
 * One transfer commitment a verified predecessor plan already made: its plan
 * reservation at the source warehouse and the transfer request drawing on it
 * (ADR 0015). `status` is what the warehouse records show now: `requested`
 * and `dispatched` are future supply at the arrival date, `received` counts
 * only through the destination's physical stock read, and `unknown` is an
 * effect that cannot be reconciled and is never released or replaced.
 */
export const priorCommitmentSchema = z.strictObject({
  /** The predecessor plan's transfer request action, such as `ACT-3`. */
  commitmentId: labelSchema,
  planId: labelSchema,
  reservationId: labelSchema,
  requestId: labelSchema.nullable(),
  sku: labelSchema,
  uom: uomSchema,
  from: labelSchema,
  to: labelSchema,
  quantity: positiveQuantitySchema,
  arrivalDate: businessDateSchema,
  status: z.enum(["requested", "dispatched", "received", "unknown"]),
});
export const priorCommitmentsDataSchema = z.strictObject({
  predecessorPlanId: labelSchema,
  /**
   * Earlier plans in the predecessor's own lineage whose commitments it
   * relied on and carries forward; their records keep their own plan ID.
   */
  inheritedPlanIds: z.array(labelSchema).max(20).optional(),
  records: z
    .array(priorCommitmentSchema)
    .max(100)
    .refine(
      (records) =>
        new Set(records.map((record) => `${record.planId}/${record.commitmentId}`)).size ===
        records.length,
      "duplicate commitmentId within a plan",
    ),
});

const evidenceRefSchema = z.strictObject({
  sourceSystem: labelSchema,
  messageId: labelSchema,
  inputVersion: versionNumberSchema,
  evidenceRef: labelSchema,
});

/**
 * A structured candidate offered beside the proposal, such as an optional
 * substitute SKU. It is an annotation from evidence, never part of the
 * proposal terms and never an item mapping.
 */
export const candidateOfferSchema = z.strictObject({
  offerId: labelSchema,
  kind: z.literal("optional_substitute"),
  sku: labelSchema,
  quantity: positiveQuantitySchema,
  uom: uomSchema,
  arrival: arrivalSchema,
  evidence: evidenceRefSchema,
});

function uniqueWarehouses(entries: readonly { warehouse: string }[]): boolean {
  return new Set(entries.map((entry) => entry.warehouse)).size === entries.length;
}

const warehouseReadSchema = <T extends z.ZodType>(data: T) =>
  z.strictObject({ warehouse: labelSchema, read: readEvidenceSchema(data) });

/**
 * Everything one assessment uses. The caller has established the sender,
 * vendor and PO line association (intake); the assessment still rejects
 * inconsistent identities. IDs and the assessment instant are explicit.
 */
export const coverageAssessmentInputSchema = z.strictObject({
  contractVersion: z.literal(ASSESSMENT_CONTRACT_VERSION),
  organization: labelSchema,
  assessedAt: instantSchema,
  planId: labelSchema,
  planVersion: versionNumberSchema,
  vendorId: labelSchema,
  poLine: poLineRefSchema,
  proposalId: labelSchema,
  reads: z.strictObject({
    supplierInput: readEvidenceSchema(supplierInputDataSchema),
    purchaseOrder: readEvidenceSchema(purchaseOrderDataSchema),
    demand: readEvidenceSchema(demandDataSchema),
    stock: z
      .array(warehouseReadSchema(stockDataSchema))
      .min(1)
      .refine(uniqueWarehouses, "duplicate warehouse"),
    inTransit: z
      .array(warehouseReadSchema(inTransitDataSchema))
      .refine(uniqueWarehouses, "duplicate warehouse"),
    transferOptions: readEvidenceSchema(transferOptionsDataSchema),
    item: readEvidenceSchema(itemSchema),
    itemMappings: readEvidenceSchema(itemMappingsDataSchema),
    /** Only for a successor of a verified case: the predecessor plan's commitments. */
    priorCommitments: readEvidenceSchema(priorCommitmentsDataSchema).optional(),
    policies: z.strictObject({
      calendar: readEvidenceSchema(policySchema),
      eligibility: readEvidenceSchema(policySchema),
      allocation: readEvidenceSchema(policySchema),
      authorization: readEvidenceSchema(policySchema),
    }),
  }),
  candidateOffers: z
    .array(candidateOfferSchema)
    .refine(
      (offers) => new Set(offers.map((offer) => offer.offerId)).size === offers.length,
      "duplicate offerId",
    ),
});

/** Recommended case states for later API composition; an assessment never writes a case. */
export const recommendedStateSchema = z.enum([
  "needs_clarification",
  "escalated",
  "awaiting_approval",
]);

export const demandLineRefSchema = z.strictObject({ salesOrder: labelSchema, line: labelSchema });

/** A supply source by identity. */
export const supplyRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stock"), warehouse: labelSchema, stockVersion: labelSchema }),
  z.strictObject({
    kind: z.literal("po_segment"),
    poNumber: labelSchema,
    revision: revisionSchema,
    poLine: labelSchema,
    sequence: z.int().min(1),
    projection: z.enum(["proposed", "accepted"]),
  }),
  z.strictObject({
    kind: z.literal("transfer_option"),
    optionId: labelSchema,
    basedOn: labelSchema,
  }),
  z.strictObject({ kind: z.literal("in_transit"), transitId: labelSchema }),
  z.strictObject({
    kind: z.literal("prior_commitment"),
    planId: labelSchema,
    commitmentId: labelSchema,
    requestId: labelSchema.nullable(),
  }),
]);

export const supplyBucketSchema = z.strictObject({
  supply: supplyRefSchema,
  destination: labelSchema,
  quantity: quantitySchema,
  uom: uomSchema,
  arrival: arrivalSchema.nullable(),
  allocated: quantitySchema,
  disposition: z.enum([
    "allocated",
    "partially_allocated",
    "unallocated",
    "late",
    "undated",
    "replaced_by_proposal",
    "not_projected",
    "not_stock",
  ]),
  reason: reasonCodeSchema.nullable(),
});

export const allocationSchema = z.strictObject({
  demandLine: demandLineRefSchema,
  stage: z.enum(["pre_transfer", "prior_commitment", "conditional_transfer"]),
  supply: supplyRefSchema,
  quantity: positiveQuantitySchema,
  uom: uomSchema,
});

export const eligibilityResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("known"),
    warehouse: labelSchema,
    stockVersion: labelSchema,
    uom: uomSchema,
    physical: quantitySchema,
    qualityHold: quantitySchema,
    safetyStock: quantitySchema,
    unrelatedReservations: z.array(
      z.strictObject({ reservationId: labelSchema, quantity: positiveQuantitySchema }),
    ),
    /** Present only when a predecessor plan's commitments hold stock here (ADR 0015). */
    commitmentReservations: z
      .array(
        z.strictObject({
          reservationId: labelSchema,
          planId: labelSchema,
          quantity: positiveQuantitySchema,
        }),
      )
      .optional(),
    eligible: quantitySchema,
  }),
  z.strictObject({ state: z.literal("unknown"), warehouse: labelSchema, reason: reasonCodeSchema }),
]);

export const demandAssessmentSchema = z.strictObject({
  salesOrder: labelSchema,
  line: labelSchema,
  sku: labelSchema,
  uom: uomSchema,
  priority: z.int().min(1),
  open: quantitySchema,
  destination: labelSchema,
  receiptCutoff: businessDateSchema,
  supplyLinks: z.array(poLineRefSchema),
  preTransferCovered: knowable(quantitySchema),
  preTransferGap: knowable(quantitySchema),
  /** Present only with prior commitments: what they cover of the pre-transfer gap. */
  priorCommitment: knowable(quantitySchema).optional(),
  conditionalTransfer: knowable(quantitySchema),
  conditionalGap: knowable(quantitySchema),
});

/** A reason with the role that must supply the next evidence or decision. */
export const ownedReasonSchema = z.strictObject({
  reason: reasonCodeSchema,
  owner: actorRoleSchema,
});

export const assessmentIssueSchema = z.strictObject({
  reason: reasonCodeSchema,
  owner: actorRoleSchema,
  /** The input the issue concerns, such as `reads.stock[WH-B]`. */
  subject: z.string().min(1).max(200),
  nextEvidence: z.string().min(1).max(400),
});

export const shortfallSchema = z.strictObject({
  stage: z.enum(["pre_transfer", "conditional"]),
  demandLine: demandLineRefSchema,
  quantity: positiveQuantitySchema,
  uom: uomSchema,
  receiptCutoff: businessDateSchema,
  reason: reasonCodeSchema,
  owner: actorRoleSchema,
});

export const transferOptionAssessmentSchema = z.strictObject({
  optionId: labelSchema,
  status: z.enum(["supported", "blocked", "unknown", "not_needed"]),
  reasons: z.array(ownedReasonSchema),
  terms: transferOptionSchema,
  termsSha256: sha256Schema,
  assigned: quantitySchema,
});

export const substituteAssessmentSchema = z.strictObject({
  offerId: labelSchema,
  sku: labelSchema,
  quantity: positiveQuantitySchema,
  uom: uomSchema,
  arrival: arrivalSchema,
  status: z.literal("unsupported"),
  reason: z.literal("unsupported_substitution"),
  owner: z.literal("buyer"),
  evidence: evidenceRefSchema,
});

export const totalsSchema = z.strictObject({
  /** The stock unit of every total; null only when no unit could be established. */
  uom: uomSchema.nullable(),
  demandOpen: knowable(quantitySchema),
  preTransferCoverage: knowable(quantitySchema),
  preTransferShortage: knowable(quantitySchema),
  /** Present only with prior commitments. */
  priorCommitment: knowable(quantitySchema).optional(),
  conditionalTransfer: knowable(quantitySchema),
  conditionalShortage: knowable(quantitySchema),
});

/**
 * The cost and decisions AUTH-1 attaches to a plan. Informational: it grants
 * no authorization and records no approval.
 */
export const authorizationRequirementSchema = z.strictObject({
  policy: z.strictObject({ policyId: labelSchema, version: versionNumberSchema }),
  cost: moneySchema,
  currencyPermitted: z.boolean(),
  limits: z.array(z.strictObject({ role: actorRoleSchema, maxMinorUnits: z.int().min(0) })),
  minimumApproverRole: actorRoleSchema.nullable(),
});

/** One read the plan used, by identity, with its versions and content digest. */
export const sourceBindingSchema = z.strictObject({
  kind: z.enum([
    "supplier_input",
    "purchase_order",
    "stock",
    "demand",
    "item",
    "item_mappings",
    "policy",
    "transfer_options",
    "in_transit",
    "prior_commitments",
  ]),
  key: z.string().min(1).max(200),
  /** The record's own version as returned; null when the read returns none. */
  version: z.string().min(1).max(64).nullable(),
  /** The current head as returned; null when the read returns none. */
  currentVersion: z.string().min(1).max(64).nullable(),
  /** Collection member identities, or null for a singular record. */
  members: z.array(z.string().min(1).max(200)).nullable(),
  lineage: stockLineageSchema.nullable(),
  scope: readScopeSchema,
  readAt: instantSchema,
  observedAt: envelopeObservedAtSchema,
  /** The record's own observation time, or null when the record has no such field. */
  recordObservedAt: knowable(instantSchema).nullable(),
  contentSha256: sha256Schema,
});

/** A proposed action intent. Not a callable source command and not authorized. */
export const actionIntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    actionId: labelSchema,
    kind: z.literal("amend_schedule"),
    poNumber: labelSchema,
    poLine: labelSchema,
    uom: uomSchema,
    segments: z.array(scheduleSegmentSchema).min(1),
    preconditions: z.strictObject({ expectedRevision: revisionSchema }),
    predecessors: z.array(labelSchema),
  }),
  z.strictObject({
    actionId: labelSchema,
    kind: z.literal("reserve"),
    sku: labelSchema,
    warehouse: labelSchema,
    uom: uomSchema,
    quantity: positiveQuantitySchema,
    preconditions: z.strictObject({
      expectedVersion: labelSchema,
      minimumEligible: positiveQuantitySchema,
    }),
    predecessors: z.array(labelSchema),
  }),
  z.strictObject({
    actionId: labelSchema,
    kind: z.literal("create_transfer_request"),
    optionId: labelSchema,
    sku: labelSchema,
    uom: uomSchema,
    from: labelSchema,
    to: labelSchema,
    quantity: positiveQuantitySchema,
    dispatchDate: businessDateSchema,
    arrivalDate: businessDateSchema,
    preconditions: z.strictObject({
      /** The reservation this request draws on is the one this action creates. */
      reservationFromAction: labelSchema,
      /** The bound base version; the successor comes only from the named action's receipt. */
      baseStockVersion: labelSchema,
      stockVersionFromAction: labelSchema,
      /** Must be rechecked at execution time; the source does not enforce it. */
      validUntil: instantSchema,
      optionTermsSha256: sha256Schema,
    }),
    predecessors: z.array(labelSchema),
  }),
]);

export const requiredDecisionSchema = z.strictObject({
  kind: z.enum(["approval", "supplier_acknowledgement", "warehouse_planner_confirmation"]),
  role: actorRoleSchema,
  subject: labelSchema,
});

export const planPayloadSchema = z.strictObject({
  contractVersion: z.literal(PLAN_CONTRACT_VERSION),
  ruleImplementation: z.literal(COVERAGE_RULES_VERSION),
  organization: labelSchema,
  planId: labelSchema,
  planVersion: versionNumberSchema,
  assessedAt: instantSchema,
  proposal: z.strictObject({
    proposalId: labelSchema,
    vendorId: labelSchema,
    sourceSystem: labelSchema,
    messageId: labelSchema,
    inputVersion: versionNumberSchema,
    evidenceRef: labelSchema,
    contentSha256: sha256Schema,
    sender: z.email(),
    terms: supplierProposalTermsSchema,
    conversion: z.strictObject({
      mappingId: labelSchema,
      version: versionNumberSchema,
      numerator: positiveQuantitySchema,
      denominator: positiveQuantitySchema,
    }),
  }),
  bindings: z.array(sourceBindingSchema),
  demand: z.array(
    demandAssessmentSchema.pick({
      salesOrder: true,
      line: true,
      sku: true,
      uom: true,
      priority: true,
      open: true,
      destination: true,
      receiptCutoff: true,
      supplyLinks: true,
    }),
  ),
  allocations: z.array(allocationSchema),
  gaps: z.array(
    z.strictObject({
      demandLine: demandLineRefSchema,
      preTransfer: quantitySchema,
      conditional: quantitySchema,
    }),
  ),
  transferOptions: z.array(transferOptionAssessmentSchema),
  candidateOffers: z.array(substituteAssessmentSchema),
  authorization: authorizationRequirementSchema,
  actions: z.array(actionIntentSchema).min(1),
  decisions: z.array(requiredDecisionSchema),
  assumptions: z.array(reasonCodeSchema),
});

/** An immutable proposed plan: the payload and the SHA-256 of its canonical JSON. */
export const proposedPlanSchema = z.strictObject({
  payload: planPayloadSchema,
  sha256: sha256Schema,
});

export const coverageAssessmentSchema = z.strictObject({
  contractVersion: z.literal(ASSESSMENT_CONTRACT_VERSION),
  ruleImplementation: z.literal(COVERAGE_RULES_VERSION),
  organization: labelSchema,
  assessedAt: instantSchema,
  proposalId: labelSchema,
  decision: z.strictObject({
    recommendedState: recommendedStateSchema,
    reason: reasonCodeSchema,
    owner: actorRoleSchema,
  }),
  issues: z.array(assessmentIssueSchema),
  eligibility: z.array(eligibilityResultSchema),
  demand: z.array(demandAssessmentSchema),
  supply: z.array(supplyBucketSchema),
  allocations: z.array(allocationSchema),
  transferOptions: z.array(transferOptionAssessmentSchema),
  substitutes: z.array(substituteAssessmentSchema),
  shortfalls: z.array(shortfallSchema),
  totals: totalsSchema,
  authorization: authorizationRequirementSchema.nullable(),
  plan: proposedPlanSchema.nullable(),
});

export type ReadScope = z.infer<typeof readScopeSchema>;
export type ReadProvenance = z.infer<typeof readProvenanceSchema>;
export type EnvelopeObservedAt = z.infer<typeof envelopeObservedAtSchema>;
export type ReadEvidence<T> =
  | { status: "ok"; provenance: ReadProvenance; data: T }
  | {
      status: "not_found";
      scope: ReadScope;
      readAt: { state: "known"; value: string } | { state: "unknown" };
      reason: string;
    }
  | { status: "ambiguous"; scope: ReadScope; readAt: string; reason: string }
  | {
      status: "unavailable";
      scope: ReadScope;
      reason: string;
      attemptedAt: { state: "known"; value: string } | { state: "unknown" };
    };
export type StockLineage = z.infer<typeof stockLineageSchema>;
export type CandidateOffer = z.infer<typeof candidateOfferSchema>;
export type PriorCommitment = z.infer<typeof priorCommitmentSchema>;
export type CoverageAssessmentInput = z.infer<typeof coverageAssessmentInputSchema>;
export type RecommendedState = z.infer<typeof recommendedStateSchema>;
export type SupplyRef = z.infer<typeof supplyRefSchema>;
export type SupplyBucket = z.infer<typeof supplyBucketSchema>;
export type Allocation = z.infer<typeof allocationSchema>;
export type EligibilityResult = z.infer<typeof eligibilityResultSchema>;
export type DemandAssessment = z.infer<typeof demandAssessmentSchema>;
export type AssessmentIssue = z.infer<typeof assessmentIssueSchema>;
export type Shortfall = z.infer<typeof shortfallSchema>;
export type TransferOptionAssessment = z.infer<typeof transferOptionAssessmentSchema>;
export type SubstituteAssessment = z.infer<typeof substituteAssessmentSchema>;
export type AssessmentTotals = z.infer<typeof totalsSchema>;
export type AuthorizationRequirement = z.infer<typeof authorizationRequirementSchema>;
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export type ActionIntent = z.infer<typeof actionIntentSchema>;
export type RequiredDecision = z.infer<typeof requiredDecisionSchema>;
export type PlanPayload = z.infer<typeof planPayloadSchema>;
export type ProposedPlan = z.infer<typeof proposedPlanSchema>;
export type CoverageAssessment = z.infer<typeof coverageAssessmentSchema>;
