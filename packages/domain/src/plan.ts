import {
  COVERAGE_RULES_VERSION,
  PLAN_CONTRACT_VERSION,
  planPayloadSchema,
  type ActionIntent,
  type Arrival,
  type AuthorizationRequirement,
  type CoverageAssessment,
  type CoverageAssessmentInput,
  type ItemMapping,
  type PlanPayload,
  type ProposedPlan,
  type ReadProvenance,
  type RequiredDecision,
  type SourceBinding,
  type SupplierProposalTerms,
  type SupplierInputIdentity,
  type TransferOption,
} from "@supplier-disruption/contracts";
import { contentSha256, frozenCopy } from "./digest.js";
import { compareText } from "./eligibility.js";
import {
  normalDemand,
  normalMappings,
  normalOptions,
  normalPolicy,
  normalPurchaseOrder,
  normalStock,
  normalTerms,
  normalTransit,
} from "./normalize.js";
import { ASSUMPTIONS } from "./reasons.js";

export interface PlanParts {
  input: CoverageAssessmentInput;
  result: CoverageAssessment;
  mapping: ItemMapping;
  supplier: { identity: SupplierInputIdentity; terms: SupplierProposalTerms };
  poLine: { lineNumber: string; uom: string };
  /** The proposed schedule in stock units, by sequence. */
  proposed: Array<{ sequence: number; quantity: string; arrival: Arrival }>;
  option: TransferOption | null;
  authorization: AuthorizationRequirement;
}

type Evidence = { status: string; provenance?: ReadProvenance; data?: unknown };

function provenance(evidence: Evidence): ReadProvenance {
  if (evidence.status !== "ok" || evidence.provenance === undefined) {
    // A plan is only built when every read succeeded.
    throw new Error("a plan binds only successful reads");
  }
  return evidence.provenance;
}

function binding(
  kind: SourceBinding["kind"],
  key: string,
  evidence: Evidence,
  fields: Partial<
    Pick<SourceBinding, "version" | "currentVersion" | "members" | "lineage" | "recordObservedAt">
  >,
  content: unknown,
): SourceBinding {
  const read = provenance(evidence);
  return {
    kind,
    key,
    version: fields.version ?? null,
    currentVersion: fields.currentVersion ?? null,
    members: fields.members ?? null,
    lineage: fields.lineage ?? null,
    scope: read.scope,
    readAt: read.readAt,
    observedAt: read.observedAt,
    recordObservedAt: fields.recordObservedAt ?? null,
    // The scope is part of what was read, so it is part of the digest.
    contentSha256: contentSha256({ scope: read.scope, content }),
  };
}

/** Every read the plan used, with versions only where the read supplied them. */
function bindings(input: CoverageAssessmentInput): SourceBinding[] {
  const { reads } = input;
  const list: SourceBinding[] = [];
  if (reads.supplierInput.status === "ok") {
    const { identity, terms } = reads.supplierInput.data;
    list.push(
      binding(
        "supplier_input",
        `${identity.sourceSystem}/${identity.messageId}`,
        reads.supplierInput,
        { version: String(identity.inputVersion) },
        { identity, terms: normalTerms(terms) },
      ),
    );
  }
  if (reads.purchaseOrder.status === "ok") {
    const { record, currentRevision } = reads.purchaseOrder.data;
    list.push(
      binding(
        "purchase_order",
        record.poNumber,
        reads.purchaseOrder,
        {
          version: record.revision,
          currentVersion: currentRevision,
          recordObservedAt: record.observedAt,
        },
        normalPurchaseOrder(record),
      ),
    );
  }
  for (const entry of reads.stock) {
    if (entry.read.status !== "ok") continue;
    const { record, currentVersion, lineage } = entry.read.data;
    list.push(
      binding(
        "stock",
        entry.warehouse,
        entry.read,
        { version: record.version, currentVersion, lineage, recordObservedAt: record.observedAt },
        { record: normalStock(record), lineage },
      ),
    );
  }
  if (reads.demand.status === "ok") {
    const { record, currentVersion } = reads.demand.data;
    list.push(
      binding(
        "demand",
        record.organization,
        reads.demand,
        { version: record.version, currentVersion, recordObservedAt: record.observedAt },
        normalDemand(record),
      ),
    );
  }
  if (reads.item.status === "ok") {
    list.push(binding("item", reads.item.data.sku, reads.item, {}, reads.item.data));
  }
  if (reads.itemMappings.status === "ok") {
    const records = normalMappings(reads.itemMappings.data.records);
    const { selectors } = reads.itemMappings.provenance.scope;
    list.push(
      binding(
        "item_mappings",
        `${String(selectors.vendorId)}/${String(selectors.vendorItem)}/${String(selectors.sourceUom)}`,
        reads.itemMappings,
        { members: records.map((mapping) => `${mapping.mappingId}@${mapping.version}`) },
        { records, complete: true },
      ),
    );
  }
  for (const evidence of Object.values(reads.policies)) {
    if (evidence.status !== "ok") continue;
    const policy = evidence.data;
    list.push(
      binding(
        "policy",
        policy.policyId,
        evidence,
        { version: String(policy.version) },
        normalPolicy(policy),
      ),
    );
  }
  if (reads.transferOptions.status === "ok") {
    const records = normalOptions(reads.transferOptions.data.records);
    const { selectors } = reads.transferOptions.provenance.scope;
    list.push(
      binding(
        "transfer_options",
        `${String(selectors.sku)}/${String(selectors.uom)}/${String(selectors.fromWarehouse)}/${String(selectors.toWarehouse)}`,
        reads.transferOptions,
        { members: records.map((option) => option.optionId) },
        { records, complete: true },
      ),
    );
  }
  for (const entry of reads.inTransit) {
    if (entry.read.status !== "ok") continue;
    const records = normalTransit(entry.read.data.records);
    list.push(
      binding(
        "in_transit",
        entry.warehouse,
        entry.read,
        { members: records.map((record) => record.transitId) },
        { records },
      ),
    );
  }
  if (reads.priorCommitments?.status === "ok") {
    const { predecessorPlanId } = reads.priorCommitments.data;
    const records = [...reads.priorCommitments.data.records].sort((a, b) =>
      compareText(a.commitmentId, b.commitmentId),
    );
    list.push(
      binding(
        "prior_commitments",
        predecessorPlanId,
        reads.priorCommitments,
        { members: records.map((record) => record.commitmentId) },
        { predecessorPlanId, records },
      ),
    );
  }
  return list.sort((a, b) => compareText(a.kind, b.kind) || compareText(a.key, b.key));
}

function knownValue(value: { state: "known"; value: string } | { state: "unknown" }): string {
  // A plan is only built when every gap is known.
  if (value.state !== "known") throw new Error("a plan binds only known gaps");
  return value.value;
}

/** ACT-1 replaces the schedule; with a transfer, ACT-2 reserves and ACT-3 requests it. */
function actions(parts: PlanParts): ActionIntent[] {
  const { input, supplier, poLine, option } = parts;
  const list: ActionIntent[] = [
    {
      actionId: "ACT-1",
      kind: "amend_schedule",
      poNumber: input.poLine.poNumber,
      poLine: poLine.lineNumber,
      uom: poLine.uom,
      segments: parts.proposed.map((segment) => ({ ...segment })),
      preconditions: { expectedRevision: supplier.terms.baseRevision },
      predecessors: [],
    },
  ];
  if (option !== null) {
    list.push(
      {
        actionId: "ACT-2",
        kind: "reserve",
        sku: option.sku,
        warehouse: option.from,
        uom: option.uom,
        quantity: option.quantity,
        preconditions: { expectedVersion: option.basedOn, minimumEligible: option.quantity },
        predecessors: [],
      },
      {
        actionId: "ACT-3",
        kind: "create_transfer_request",
        optionId: option.optionId,
        sku: option.sku,
        uom: option.uom,
        from: option.from,
        to: option.to,
        quantity: option.quantity,
        dispatchDate: option.dispatchDate,
        arrivalDate: option.arrivalDate,
        preconditions: {
          reservationFromAction: "ACT-2",
          baseStockVersion: option.basedOn,
          stockVersionFromAction: "ACT-2",
          validUntil: option.validUntil,
          optionTermsSha256: contentSha256(option),
        },
        predecessors: ["ACT-2"],
      },
    );
  }
  return list;
}

function decisions(parts: PlanParts): RequiredDecision[] {
  const { input, option, authorization } = parts;
  const list: RequiredDecision[] = [];
  if (authorization.minimumApproverRole !== null) {
    list.push({ kind: "approval", role: authorization.minimumApproverRole, subject: input.planId });
  }
  if (option !== null) {
    // AUTH-1@1: a plan with a transfer also needs both of these.
    list.push(
      { kind: "supplier_acknowledgement", role: "supplier_contact", subject: input.proposalId },
      {
        kind: "warehouse_planner_confirmation",
        role: "warehouse_planner",
        subject: option.optionId,
      },
    );
  }
  return list;
}

/**
 * Builds the immutable proposed plan. The payload is strictly validated, its
 * canonical JSON is hashed, and the returned payload is a detached, deeply
 * frozen copy of exactly what was hashed (ADR 0007).
 */
export function buildPlan(parts: PlanParts): ProposedPlan {
  const { input, result, supplier, mapping } = parts;
  const payload: PlanPayload = planPayloadSchema.parse({
    contractVersion: PLAN_CONTRACT_VERSION,
    ruleImplementation: COVERAGE_RULES_VERSION,
    organization: input.organization,
    planId: input.planId,
    planVersion: input.planVersion,
    assessedAt: input.assessedAt,
    proposal: {
      proposalId: input.proposalId,
      vendorId: input.vendorId,
      sourceSystem: supplier.identity.sourceSystem,
      messageId: supplier.identity.messageId,
      inputVersion: supplier.identity.inputVersion,
      evidenceRef: supplier.identity.evidenceRef,
      contentSha256: supplier.identity.contentSha256,
      sender: supplier.identity.sender,
      terms: normalTerms(supplier.terms),
      conversion: {
        mappingId: mapping.mappingId,
        version: mapping.version,
        numerator: mapping.ratio.numerator,
        denominator: mapping.ratio.denominator,
      },
    },
    bindings: bindings(input),
    demand: result.demand.map((line) => ({
      salesOrder: line.salesOrder,
      line: line.line,
      sku: line.sku,
      uom: line.uom,
      priority: line.priority,
      open: line.open,
      destination: line.destination,
      receiptCutoff: line.receiptCutoff,
      supplyLinks: [...line.supplyLinks].sort((a, b) =>
        compareText(`${a.poNumber}/${a.poLine}`, `${b.poNumber}/${b.poLine}`),
      ),
    })),
    allocations: result.allocations,
    gaps: result.demand.map((line) => ({
      demandLine: { salesOrder: line.salesOrder, line: line.line },
      preTransfer: knownValue(line.preTransferGap),
      conditional: knownValue(line.conditionalGap),
    })),
    transferOptions: result.transferOptions,
    candidateOffers: result.substitutes,
    authorization: parts.authorization,
    actions: actions(parts),
    decisions: decisions(parts),
    assumptions: [...ASSUMPTIONS],
  });
  return frozenCopy({ payload, sha256: contentSha256(payload) });
}
