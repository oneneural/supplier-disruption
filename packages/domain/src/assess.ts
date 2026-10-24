import {
  COVERAGE_RULES_VERSION,
  ASSESSMENT_CONTRACT_VERSION,
  coverageAssessmentInputSchema,
  coverageAssessmentSchema,
  type ActorRole,
  type Allocation,
  type AssessmentIssue,
  type AuthorizationRequirement,
  type CoverageAssessment,
  type CoverageAssessmentInput,
  type DemandAssessment,
  type DemandSnapshot,
  type ItemMapping,
  type Policy,
  type PriorCommitment,
  type ReadScope,
  type RecommendedState,
  type Shortfall,
  type SubstituteAssessment,
  type SupplyBucket,
  type TransferOption,
  type TransferOptionAssessment,
} from "@supplier-disruption/contracts";
import {
  TIE_ORDERS,
  allocate,
  lineKey,
  sameOutcome,
  type DemandInput,
  type SupplyInput,
} from "./allocation.js";
import { arrivesBy, copenhagenDate, strictlyBefore } from "./calendar.js";
import { convertQuantity, selectMapping } from "./conversion.js";
import { contentSha256, frozenCopy } from "./digest.js";
import {
  compareText,
  deriveEligibility,
  type CommitmentReservation,
  type Eligibility,
} from "./eligibility.js";
import { linkKey, normalOffers } from "./normalize.js";
import { buildPlan } from "./plan.js";
import { QuantityRangeError, formatQuantity, min, parseQuantity, sum } from "./quantity.js";
import { REASONS } from "./reasons.js";

/** The structurally invalid input; nothing was assessed. */
export class AssessmentInputError extends TypeError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid coverage assessment input: ${issues.join("; ")}`);
    this.name = "AssessmentInputError";
    this.issues = issues;
  }
}

/** Supported policy implementations, by the input slot that carries each. */
const SUPPORTED_POLICIES = {
  calendar: { policyId: "CAL-CPH-1", version: 1 },
  eligibility: { policyId: "ELIG-1", version: 1 },
  allocation: { policyId: "ALLOC-1", version: 1 },
  authorization: { policyId: "AUTH-1", version: 1 },
} as const;

/** Issue ranks: input/policy blocks, conversion, missing evidence, then shortage. */
type Rank = 0 | 1 | 2 | 3;
interface RankedIssue extends AssessmentIssue {
  rank: Rank;
}

type Known<T> = { state: "known"; value: T } | { state: "unknown" };
const known = <T>(value: T): Known<T> => ({ state: "known", value });
const UNKNOWN = { state: "unknown" } as const;

type Evidence<T> =
  | { status: "ok"; provenance: { scope: ReadScope }; data: T }
  | { status: "not_found" | "ambiguous" | "unavailable"; scope: ReadScope };

/** The scope a read asked for, whatever its outcome. */
export function scopeOf(evidence: Evidence<unknown>): ReadScope {
  return evidence.status === "ok" ? evidence.provenance.scope : evidence.scope;
}

/**
 * Assesses one normalized supplier proposal against materialized source reads.
 * Pure: it reads only its argument, calls no source, clock, network or
 * storage, and returns a new deeply frozen result. Structurally invalid input
 * throws AssessmentInputError; every business-level inconsistency, missing or
 * unavailable evidence and shortage is an owned result instead.
 */
export function assessCoverage(raw: unknown): CoverageAssessment {
  const parsed = coverageAssessmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AssessmentInputError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  let result: CoverageAssessment;
  try {
    result = new Assessment(parsed.data).run();
  } catch (error) {
    if (!(error instanceof QuantityRangeError)) throw error;
    result = rangeBlocked(parsed.data, error);
  }
  return frozenCopy(coverageAssessmentSchema.parse(result));
}

function ownerOf(scope: ReadScope): ActorRole {
  return scope.owner === "inventory" ? "warehouse_planner" : "buyer";
}

class Assessment {
  private readonly issues: RankedIssue[] = [];

  constructor(private readonly input: CoverageAssessmentInput) {}

  private issue(rank: Rank, reason: string, owner: ActorRole, subject: string, next: string) {
    this.issues.push({ rank, reason, owner, subject, nextEvidence: next });
  }

  private mismatch(subject: string, detail: string) {
    this.issue(0, REASONS.identityMismatch, "buyer", subject, detail);
  }

  /** The data of a successful read of the expected scope, or an attributable issue. */
  private read<T>(
    subject: string,
    evidence: Evidence<T>,
    expected: { owner: ReadScope["owner"]; resource: ReadScope["resource"] },
  ): T | null {
    const scope = scopeOf(evidence);
    if (scope.owner !== expected.owner || scope.resource !== expected.resource) {
      this.mismatch(subject, `expected a ${expected.owner} ${expected.resource} read`);
      return null;
    }
    if (scope.organization !== this.input.organization) {
      this.mismatch(subject, `read for ${scope.organization}, not ${this.input.organization}`);
      return null;
    }
    if (scope.binding !== undefined && scope.binding.label !== this.input.organization) {
      this.mismatch(subject, `binding ${scope.binding.label} is not ${this.input.organization}`);
      return null;
    }
    const owner = ownerOf(scope);
    switch (evidence.status) {
      case "ok":
        return evidence.data;
      case "not_found":
        this.issue(
          2,
          REASONS.evidenceNotFound,
          owner,
          subject,
          "the record must exist in its owning source",
        );
        return null;
      case "ambiguous":
        this.issue(2, REASONS.evidenceAmbiguous, owner, subject, "exactly one record must match");
        return null;
      default:
        this.issue(
          2,
          REASONS.evidenceUnavailable,
          owner,
          subject,
          "a successful read of this source is required",
        );
        return null;
    }
  }

  private policy<K extends keyof typeof SUPPORTED_POLICIES>(slot: K): Policy | null {
    const subject = `reads.policies.${slot}`;
    const policy = this.read(subject, this.input.reads.policies[slot], {
      owner: "reference",
      resource: "policy",
    });
    if (policy === null) return null;
    const supported = SUPPORTED_POLICIES[slot];
    if (policy.policyId !== supported.policyId || policy.version !== supported.version) {
      this.issue(
        0,
        REASONS.unsupportedPolicy,
        "buyer",
        subject,
        `only ${supported.policyId}@${supported.version} is implemented; got ${policy.policyId}@${policy.version}`,
      );
      return null;
    }
    return policy;
  }

  run(): CoverageAssessment {
    const { input } = this;
    const reads = input.reads;

    const policies = {
      calendar: this.policy("calendar"),
      eligibility: this.policy("eligibility"),
      allocation: this.policy("allocation"),
      authorization: this.policy("authorization"),
    };

    // Supplier input, PO line, item and the effective mapping.
    const supplier = this.read("reads.supplierInput", reads.supplierInput, {
      owner: "reference",
      resource: "supplier_input",
    });
    if (supplier !== null) {
      if (supplier.identity.proposalId !== input.proposalId) {
        this.mismatch(
          "reads.supplierInput",
          `proposal ${supplier.identity.proposalId} is not ${input.proposalId}`,
        );
      }
      if (
        supplier.terms.poNumber !== input.poLine.poNumber ||
        supplier.terms.poLine !== input.poLine.poLine
      ) {
        this.mismatch("reads.supplierInput", "the terms name a different PO line");
      }
    }

    const po = this.read("reads.purchaseOrder", reads.purchaseOrder, {
      owner: "purchasing",
      resource: "purchase_order",
    });
    const poLine = po?.record.lines.find((line) => line.lineNumber === input.poLine.poLine) ?? null;
    if (po !== null) {
      if (
        po.record.poNumber !== input.poLine.poNumber ||
        po.record.organization !== input.organization
      ) {
        this.mismatch("reads.purchaseOrder", "the PO read is not the selected PO");
      } else if (po.record.revision !== po.currentRevision) {
        this.mismatch(
          "reads.purchaseOrder",
          `revision ${po.record.revision} is not current ${po.currentRevision}`,
        );
      } else if (po.record.vendorId !== input.vendorId) {
        this.mismatch(
          "reads.purchaseOrder",
          `vendor ${po.record.vendorId} is not ${input.vendorId}`,
        );
      } else if (poLine === null) {
        this.mismatch(
          "reads.purchaseOrder",
          `PO ${po.record.poNumber} has no line ${input.poLine.poLine}`,
        );
      }
      if (supplier !== null && supplier.terms.baseRevision !== po.record.revision) {
        this.issue(
          0,
          REASONS.baseRevisionMismatch,
          "buyer",
          "reads.supplierInput",
          `the proposal is based on revision ${supplier.terms.baseRevision}, the PO is at ${po.record.revision}`,
        );
      }
    }

    const item = this.read("reads.item", reads.item, { owner: "reference", resource: "item" });
    if (
      item !== null &&
      poLine !== null &&
      (item.sku !== poLine.sku || item.stockUom !== poLine.uom)
    ) {
      this.mismatch("reads.item", `item ${item.sku} ${item.stockUom} does not match the PO line`);
    }

    const mappings = this.read("reads.itemMappings", reads.itemMappings, {
      owner: "reference",
      resource: "item_mappings",
    });
    let mapping: ItemMapping | null = null;
    if (mappings !== null && supplier !== null && poLine !== null && item !== null) {
      const selectors = scopeOf(reads.itemMappings).selectors;
      if (
        selectors.vendorId !== input.vendorId ||
        selectors.vendorItem !== supplier.terms.vendorItem ||
        selectors.sourceUom !== supplier.terms.uom
      ) {
        this.mismatch(
          "reads.itemMappings",
          "the mapping read is not for the proposal's vendor item and unit",
        );
      } else {
        const selected = selectMapping(mappings.records, {
          vendorId: input.vendorId,
          vendorItem: supplier.terms.vendorItem,
          sourceUom: supplier.terms.uom,
          sku: poLine.sku,
          stockUom: item.stockUom,
          onDate: copenhagenDate(input.assessedAt),
        });
        if (selected.ok) mapping = selected.mapping;
        else {
          const rank = selected.reason === REASONS.uomConversionUnavailable ? 1 : 0;
          this.issue(rank, selected.reason, "buyer", "reads.itemMappings", selected.detail);
        }
      }
    }

    // The proposed schedule in stock units, replacing the line's accepted projection.
    let proposed: Array<{
      sequence: number;
      quantity: bigint;
      arrival: SupplyInput["arrival"];
    }> | null = null;
    if (mapping !== null && supplier !== null && poLine !== null) {
      const converted = supplier.terms.segments.map((segment) => ({
        sequence: segment.sequence,
        quantity: convertQuantity(segment.quantity, mapping),
        arrival: segment.arrival,
      }));
      const outstanding =
        parseQuantity(poLine.ordered) -
        parseQuantity(poLine.received) -
        parseQuantity(poLine.canceled);
      if (converted.some((segment) => segment.quantity === null)) {
        this.issue(
          0,
          REASONS.conversionNonintegral,
          "buyer",
          "reads.supplierInput",
          `a segment does not convert to whole ${poLine.uom} under ${mapping.mappingId}@${mapping.version}`,
        );
      } else {
        const segments = converted.map((segment) => ({
          ...segment,
          quantity: segment.quantity ?? 0n,
        }));
        if (sum(segments.map((segment) => segment.quantity)) !== outstanding) {
          this.issue(
            0,
            REASONS.scheduleTotalMismatch,
            "buyer",
            "reads.supplierInput",
            `the proposed schedule must total the outstanding ${outstanding < 0n ? "quantity" : formatQuantity(outstanding)} ${poLine.uom}`,
          );
        } else {
          proposed = segments.sort((a, b) => a.sequence - b.sequence);
        }
      }
    }

    // Demand linked to the selected PO line.
    const demand = this.read("reads.demand", reads.demand, { owner: "demand", resource: "demand" });
    const selectedLink = linkKey(input.poLine);
    let lines: DemandInput[] | null = null;
    let demandRecords: DemandSnapshot["lines"] = [];
    if (demand !== null) {
      if (
        demand.record.organization !== input.organization ||
        demand.record.version !== demand.currentVersion
      ) {
        this.mismatch(
          "reads.demand",
          `demand ${demand.record.version} is not the current ${demand.currentVersion}`,
        );
      } else {
        demandRecords = demand.record.lines.filter((line) =>
          line.supplyLinks.some((link) => linkKey(link) === selectedLink),
        );
        lines = [];
        for (const line of demandRecords) {
          const subject = `reads.demand[${lineKey(line)}]`;
          if (line.supplyLinks.length !== 1) {
            this.issue(
              0,
              REASONS.supplyLinksUnsupported,
              "buyer",
              subject,
              "only a single supply link is supported",
            );
          }
          if (
            poLine !== null &&
            (line.sku !== poLine.sku ||
              line.uom !== poLine.uom ||
              line.destination !== poLine.destination)
          ) {
            this.mismatch(
              subject,
              "the demand line's SKU, unit or destination differs from the PO line",
            );
          }
          if (
            policies.calendar !== null &&
            (line.calendar.policyId !== policies.calendar.policyId ||
              line.calendar.version !== policies.calendar.version)
          ) {
            this.issue(
              0,
              REASONS.unsupportedPolicy,
              "buyer",
              subject,
              `calendar ${line.calendar.policyId}@${line.calendar.version} is not the read calendar`,
            );
          }
          lines.push({
            salesOrder: line.salesOrder,
            line: line.line,
            priority: line.priority,
            open: parseQuantity(line.open),
            destination: line.destination,
            receiptCutoff: line.receiptCutoff,
          });
        }
      }
    }
    const destination = poLine?.destination ?? null;

    // A verified predecessor plan's transfer commitments (ADR 0015). Every
    // reservation they name is deducted where it is held; only the records
    // that pass these checks can cover demand.
    const prior =
      reads.priorCommitments === undefined
        ? null
        : this.read("reads.priorCommitments", reads.priorCommitments, {
            owner: "inventory",
            resource: "prior_commitments",
          });
    const commitments: PriorCommitment[] = [];
    const commitmentReservations: CommitmentReservation[] = [];
    if (prior !== null && reads.priorCommitments !== undefined) {
      const predecessor = prior.predecessorPlanId;
      // The predecessor carries forward what its own predecessors committed.
      const lineage = new Set([predecessor, ...(prior.inheritedPlanIds ?? [])]);
      if (
        scopeOf(reads.priorCommitments).selectors.planId !== predecessor ||
        lineage.has(input.planId)
      ) {
        this.mismatch("reads.priorCommitments", `the read is not of predecessor ${predecessor}`);
      } else {
        for (const record of [...prior.records].sort(
          (a, b) => compareText(a.planId, b.planId) || compareText(a.commitmentId, b.commitmentId),
        )) {
          if (!lineage.has(record.planId)) {
            this.issue(
              0,
              REASONS.priorCommitmentMismatch,
              "warehouse_planner",
              `reads.priorCommitments[${record.commitmentId}]`,
              `the commitment belongs to ${record.planId}, not the predecessor ${predecessor} or its lineage`,
            );
            continue;
          }
          commitmentReservations.push({
            reservationId: record.reservationId,
            planId: record.planId,
            quantity: record.quantity,
          });
          if (
            poLine !== null &&
            (record.sku !== poLine.sku ||
              record.uom !== poLine.uom ||
              record.to !== poLine.destination)
          ) {
            this.issue(
              0,
              REASONS.priorCommitmentMismatch,
              "warehouse_planner",
              `reads.priorCommitments[${record.commitmentId}]`,
              "the commitment's SKU, unit or destination differs from the PO line",
            );
            continue;
          }
          commitments.push(record);
        }
      }
    }

    // Stock eligibility at every warehouse read.
    const eligibility: CoverageAssessment["eligibility"] = [];
    const eligible = new Map<string, Eligibility>();
    for (const entry of [...reads.stock].sort((a, b) => compareText(a.warehouse, b.warehouse))) {
      const subject = `reads.stock[${entry.warehouse}]`;
      if (scopeOf(entry.read).selectors.warehouse !== entry.warehouse) {
        this.mismatch(subject, "the read's scope names another warehouse");
        eligibility.push({
          state: "unknown",
          warehouse: entry.warehouse,
          reason: REASONS.identityMismatch,
        });
        continue;
      }
      const stock = this.read(subject, entry.read, { owner: "inventory", resource: "stock" });
      if (stock === null) {
        eligibility.push({
          state: "unknown",
          warehouse: entry.warehouse,
          reason: this.lastReason(),
        });
        continue;
      }
      const record = stock.record;
      if (
        record.organization !== input.organization ||
        record.warehouse !== entry.warehouse ||
        record.version !== stock.currentVersion ||
        (poLine !== null && (record.sku !== poLine.sku || record.uom !== poLine.uom))
      ) {
        this.mismatch(
          subject,
          `stock ${record.version} is not the current ${poLine?.sku ?? ""} stock at ${entry.warehouse}`,
        );
        eligibility.push({
          state: "unknown",
          warehouse: entry.warehouse,
          reason: REASONS.identityMismatch,
        });
        continue;
      }
      const derived = deriveEligibility(record, commitmentReservations);
      if (!derived.ok) {
        this.issue(0, derived.reason, "warehouse_planner", subject, derived.detail);
        eligibility.push({ state: "unknown", warehouse: entry.warehouse, reason: derived.reason });
        continue;
      }
      eligible.set(entry.warehouse, derived.value);
      eligibility.push({ state: "known", ...derived.value });
    }
    if (destination !== null && !reads.stock.some((entry) => entry.warehouse === destination)) {
      this.issue(
        2,
        REASONS.evidenceNotFound,
        "warehouse_planner",
        `reads.stock[${destination}]`,
        "the destination stock must be read",
      );
    }

    if (destination !== null && !reads.inTransit.some((entry) => entry.warehouse === destination)) {
      this.issue(
        2,
        REASONS.evidenceNotFound,
        "warehouse_planner",
        `reads.inTransit[${destination}]`,
        "the in-transit records of the destination must be read",
      );
    }

    // Dispatched transfers: never stock, never on-time supply.
    const transit = new Map<string, SupplyBucket>();
    const transitDigests = new Map<string, string>();
    for (const entry of reads.inTransit) {
      const subject = `reads.inTransit[${entry.warehouse}]`;
      if (scopeOf(entry.read).selectors.warehouse !== entry.warehouse) {
        this.mismatch(subject, "the read's scope names another warehouse");
        continue;
      }
      const records = this.read(subject, entry.read, {
        owner: "inventory",
        resource: "in_transit",
      });
      for (const record of records?.records ?? []) {
        const digest = contentSha256(record);
        const seen = transitDigests.get(record.transitId);
        if (seen !== undefined && seen !== digest) {
          this.mismatch(subject, `${record.transitId} differs between reads`);
        }
        transitDigests.set(record.transitId, digest);
        transit.set(record.transitId, {
          supply: { kind: "in_transit", transitId: record.transitId },
          destination: record.to,
          quantity: record.quantity,
          uom: record.uom,
          arrival: record.arrival,
          allocated: "0",
          disposition: "not_stock",
          reason: REASONS.inTransitNotStock,
        });
      }
    }

    const options = this.read("reads.transferOptions", reads.transferOptions, {
      owner: "inventory",
      resource: "transfer_options",
    });
    if (options !== null && poLine !== null) {
      const selectors = scopeOf(reads.transferOptions).selectors;
      if (
        selectors.sku !== poLine.sku ||
        selectors.uom !== poLine.uom ||
        selectors.toWarehouse !== poLine.destination
      ) {
        this.mismatch(
          "reads.transferOptions",
          "the option collection is not scoped to this SKU, unit and destination",
        );
      }
    }

    if (supplier !== null) {
      for (const offer of input.candidateOffers) {
        const { identity } = supplier;
        if (
          offer.evidence.sourceSystem !== identity.sourceSystem ||
          offer.evidence.messageId !== identity.messageId ||
          offer.evidence.inputVersion !== identity.inputVersion ||
          offer.evidence.evidenceRef !== identity.evidenceRef
        ) {
          this.mismatch(
            `candidateOffers[${offer.offerId}]`,
            `the offer's evidence ${offer.evidence.evidenceRef} is not the assessed supplier input ${identity.evidenceRef}`,
          );
        }
      }
    }

    const substitutes: SubstituteAssessment[] = normalOffers(input.candidateOffers).map(
      (offer) => ({
        offerId: offer.offerId,
        sku: offer.sku,
        quantity: offer.quantity,
        uom: offer.uom,
        arrival: offer.arrival,
        status: "unsupported",
        reason: REASONS.unsupportedSubstitution,
        owner: "buyer",
        evidence: offer.evidence,
      }),
    );

    // Pre-transfer allocation (ALLOC-1 stages one and two).
    const supply: SupplyBucket[] = [];
    const allocations: Allocation[] = [];
    const preCovered = new Map<string, bigint>();
    let allocated = false;
    const destinationStock = destination === null ? undefined : eligible.get(destination);
    const canAllocate =
      lines !== null &&
      proposed !== null &&
      destinationStock !== undefined &&
      po !== null &&
      poLine !== null &&
      policies.allocation !== null &&
      policies.calendar !== null &&
      policies.eligibility !== null &&
      !this.issues.some((issue) => issue.rank === 0);
    if (
      canAllocate &&
      lines !== null &&
      proposed !== null &&
      destinationStock !== undefined &&
      po !== null &&
      poLine !== null
    ) {
      const stockKey = `stock:${destinationStock.warehouse}`;
      const inputs: SupplyInput[] = [
        {
          key: stockKey,
          supply: {
            kind: "stock",
            warehouse: destinationStock.warehouse,
            stockVersion: destinationStock.stockVersion,
          },
          destination: destinationStock.warehouse,
          quantity: parseQuantity(destinationStock.eligible),
          arrival: null,
        },
        ...proposed.map((segment) => ({
          key: `segment:${String(segment.sequence).padStart(9, "0")}`,
          supply: {
            kind: "po_segment" as const,
            poNumber: po.record.poNumber,
            revision: po.record.revision,
            poLine: poLine.lineNumber,
            sequence: segment.sequence,
            projection: "proposed" as const,
          },
          destination: poLine.destination,
          quantity: segment.quantity,
          arrival: segment.arrival,
        })),
      ];
      const [run, ...alternatives] = TIE_ORDERS.map((ties) => allocate(lines, inputs, ties));
      if (run === undefined || alternatives.some((other) => !sameOutcome(run, other))) {
        this.issue(
          0,
          REASONS.allocationTie,
          "buyer",
          "reads.demand",
          "equal priorities or arrivals change the allocation; a tie policy is required",
        );
      } else {
        allocated = true;
        for (const entry of run.allocations) {
          allocations.push({
            demandLine: { salesOrder: entry.salesOrder, line: entry.line },
            stage: "pre_transfer",
            supply: entry.supply,
            quantity: formatQuantity(entry.quantity),
            uom: poLine.uom,
          });
        }
        for (const [key, value] of run.covered) preCovered.set(key, value);
        const latestCutoff = lines
          .map((line) => line.receiptCutoff)
          .sort(compareText)
          .at(-1);
        for (const bucket of inputs) {
          const used = run.used.get(bucket.key) ?? 0n;
          let disposition: SupplyBucket["disposition"] =
            used === 0n
              ? "unallocated"
              : used === bucket.quantity
                ? "allocated"
                : "partially_allocated";
          let reason: string | null = null;
          if (used === 0n && bucket.arrival !== null) {
            if (bucket.arrival.state === "undated") {
              disposition = "undated";
              reason = REASONS.arrivalUndated;
            } else if (latestCutoff === undefined || !arrivesBy(bucket.arrival, latestCutoff)) {
              disposition = "late";
              reason = REASONS.arrivalAfterCutoff;
            }
          }
          supply.push({
            supply: bucket.supply,
            destination: bucket.destination,
            quantity: formatQuantity(bucket.quantity),
            uom: poLine.uom,
            arrival: bucket.arrival,
            allocated: formatQuantity(used),
            disposition,
            reason,
          });
        }
      }
    }
    if (po !== null && poLine !== null) {
      for (const segment of [...poLine.acceptedSegments].sort((a, b) => a.sequence - b.sequence)) {
        supply.push({
          supply: {
            kind: "po_segment",
            poNumber: po.record.poNumber,
            revision: po.record.revision,
            poLine: poLine.lineNumber,
            sequence: segment.sequence,
            projection: "accepted",
          },
          destination: poLine.destination,
          quantity: segment.quantity,
          uom: poLine.uom,
          arrival: segment.arrival,
          allocated: "0",
          // Without a projected proposal the accepted schedule was not assessed at all.
          ...(proposed === null
            ? { disposition: "not_projected" as const, reason: REASONS.scheduleNotProjected }
            : { disposition: "replaced_by_proposal" as const, reason: REASONS.replacedByProposal }),
        });
      }
    }
    supply.push(...[...transit.values()].sort((a, b) => compareText(supplyId(a), supplyId(b))));

    // Conditional transfer stage: a quote is assessed, never treated as confirmed supply.
    const ordered =
      lines === null
        ? []
        : [...lines].sort((a, b) => a.priority - b.priority || compareText(lineKey(a), lineKey(b)));
    const preGap = new Map<string, bigint>(
      ordered.map((line) => [lineKey(line), line.open - (preCovered.get(lineKey(line)) ?? 0n)]),
    );
    const totalGap = sum(preGap.values());

    // Prior commitments cover what they can before any new transfer is
    // considered, whole and in priority order, and are never resized.
    const committed = new Map<string, bigint>();
    const residual = new Map(preGap);
    let commitmentsKnown = reads.priorCommitments === undefined || prior !== null;
    if (allocated && poLine !== null) {
      for (const commitment of [...commitments].sort(
        (a, b) =>
          compareText(a.arrivalDate, b.arrivalDate) ||
          compareText(a.planId, b.planId) ||
          compareText(a.commitmentId, b.commitmentId),
      )) {
        const outcome = this.commitmentStage(commitment, ordered, residual, eligible, poLine.uom);
        commitmentsKnown &&= outcome.ok;
        supply.push(outcome.bucket);
        for (const [key, quantity] of outcome.assigned) {
          residual.set(key, (residual.get(key) ?? 0n) - quantity);
          committed.set(key, (committed.get(key) ?? 0n) + quantity);
          const [salesOrder = "", line = ""] = key.split("/");
          allocations.push({
            demandLine: { salesOrder, line },
            stage: "prior_commitment",
            supply: outcome.bucket.supply,
            quantity: formatQuantity(quantity),
            uom: poLine.uom,
          });
        }
      }
    }
    const residualTotal = sum(residual.values());
    const transferOptions: TransferOptionAssessment[] = [];
    const conditional = new Map<string, bigint>();
    let conditionalKnown = false;
    let usedOption: TransferOption | null = null;
    if (allocated && commitmentsKnown && options !== null && poLine !== null) {
      const assessed = [...options.records]
        .sort((a, b) => compareText(a.optionId, b.optionId))
        .map((option) =>
          this.assessOption(
            option,
            poLine,
            ordered,
            residual,
            residualTotal,
            eligible,
            eligibility,
          ),
        );
      const supported = assessed.filter((entry) => entry.status === "supported");
      const unknownOption = assessed.some((entry) => entry.status === "unknown");
      conditionalKnown = !unknownOption;
      if (supported.length > 1) {
        this.issue(
          0,
          REASONS.multipleTransferOptions,
          "buyer",
          "reads.transferOptions",
          "choosing among several feasible quotes needs a reviewed policy",
        );
        conditionalKnown = false;
      } else if (supported.length === 1 && !unknownOption) {
        const [only] = supported;
        const option = options.records.find((record) => record.optionId === only?.optionId) ?? null;
        if (option !== null) {
          const assignment = assignTransfer(option, ordered, residual);
          if (assignment === null) {
            this.issue(
              0,
              REASONS.allocationTie,
              "buyer",
              "reads.demand",
              "equal priorities change which line the transfer covers",
            );
            conditionalKnown = false;
          } else {
            usedOption = option;
            for (const [key, quantity] of assignment) {
              conditional.set(key, quantity);
              const [salesOrder = "", line = ""] = key.split("/");
              allocations.push({
                demandLine: { salesOrder, line },
                stage: "conditional_transfer",
                supply: {
                  kind: "transfer_option",
                  optionId: option.optionId,
                  basedOn: option.basedOn,
                },
                quantity: formatQuantity(quantity),
                uom: poLine.uom,
              });
            }
          }
        }
      }
      for (const entry of assessed) {
        transferOptions.push({
          ...entry,
          assigned: formatQuantity(
            entry.optionId === usedOption?.optionId ? sum(conditional.values()) : 0n,
          ),
        });
      }
    }

    // Demand results and shortfalls.
    const demandResults: DemandAssessment[] = [];
    for (const line of ordered) {
      const record = demandRecords.find((candidate) => lineKey(candidate) === lineKey(line));
      if (record === undefined) continue;
      const key = lineKey(line);
      const gap = preGap.get(key) ?? 0n;
      const transfer = conditional.get(key) ?? 0n;
      const byCommitment = committed.get(key) ?? 0n;
      demandResults.push({
        salesOrder: record.salesOrder,
        line: record.line,
        sku: record.sku,
        uom: record.uom,
        priority: record.priority,
        open: record.open,
        destination: record.destination,
        receiptCutoff: record.receiptCutoff,
        supplyLinks: record.supplyLinks,
        preTransferCovered: allocated ? known(formatQuantity(preCovered.get(key) ?? 0n)) : UNKNOWN,
        preTransferGap: allocated ? known(formatQuantity(gap)) : UNKNOWN,
        ...(reads.priorCommitments === undefined
          ? {}
          : {
              priorCommitment:
                allocated && commitmentsKnown ? known(formatQuantity(byCommitment)) : UNKNOWN,
            }),
        conditionalTransfer:
          allocated && conditionalKnown ? known(formatQuantity(transfer)) : UNKNOWN,
        conditionalGap:
          allocated && conditionalKnown
            ? known(formatQuantity(gap - byCommitment - transfer))
            : UNKNOWN,
      });
    }
    const conditionalShortage =
      allocated && conditionalKnown
        ? sum(
            ordered.map(
              (line) =>
                (residual.get(lineKey(line)) ?? 0n) - (conditional.get(lineKey(line)) ?? 0n),
            ),
          )
        : null;
    if (conditionalShortage !== null && conditionalShortage > 0n) {
      for (const line of ordered) {
        const remaining =
          (residual.get(lineKey(line)) ?? 0n) - (conditional.get(lineKey(line)) ?? 0n);
        if (remaining > 0n) {
          this.issue(
            3,
            REASONS.unresolvedShortage,
            "buyer",
            `demand[${lineKey(line)}]`,
            `${formatQuantity(remaining)} ${poLine?.uom ?? ""} by ${line.receiptCutoff} has no supported recovery option`,
          );
        }
      }
    }

    // Authorization requirements for the cost of the used option.
    const authorization = this.authorization(policies.authorization, usedOption);
    if (authorization !== null && !authorization.currencyPermitted) {
      this.issue(
        0,
        REASONS.currencyNotPermitted,
        "buyer",
        "reads.policies.authorization",
        `the cost is in ${authorization.cost.currency}, which AUTH-1 does not permit; a cost in the policy currency is required`,
      );
    } else if (authorization !== null && authorization.minimumApproverRole === null) {
      this.issue(
        0,
        REASONS.noApproverWithinLimits,
        "buyer",
        "reads.policies.authorization",
        `no AUTH-1 role may approve ${authorization.cost.minorUnits} minor units of ${authorization.cost.currency}; a cheaper option or a reviewed approval limit is required`,
      );
    }

    const decision = this.decide(authorization);
    const shortfalls: Shortfall[] = [];
    if (allocated && poLine !== null) {
      for (const line of ordered) {
        const key = lineKey(line);
        const gap = preGap.get(key) ?? 0n;
        if (gap === 0n) continue;
        const transfer = conditional.get(key) ?? 0n;
        const covered = (committed.get(key) ?? 0n) + transfer;
        const reason =
          decision.recommendedState === "awaiting_approval" && covered === gap
            ? {
                reason:
                  transfer === 0n
                    ? REASONS.priorCommitmentCovered
                    : REASONS.conditionalTransferPending,
                owner: "warehouse_planner" as const,
              }
            : decision.recommendedState === "awaiting_approval"
              ? { reason: REASONS.unresolvedShortage, owner: "buyer" as const }
              : { reason: decision.reason, owner: decision.owner };
        shortfalls.push({
          stage: "pre_transfer",
          demandLine: { salesOrder: line.salesOrder, line: line.line },
          quantity: formatQuantity(gap),
          uom: poLine.uom,
          receiptCutoff: line.receiptCutoff,
          ...reason,
        });
        if (conditionalKnown && gap - covered > 0n) {
          shortfalls.push({
            stage: "conditional",
            demandLine: { salesOrder: line.salesOrder, line: line.line },
            quantity: formatQuantity(gap - covered),
            uom: poLine.uom,
            receiptCutoff: line.receiptCutoff,
            reason: REASONS.unresolvedShortage,
            owner: "buyer",
          });
        }
      }
    }

    const totals: CoverageAssessment["totals"] = {
      uom: poLine?.uom ?? item?.stockUom ?? null,
      demandOpen:
        lines === null ? UNKNOWN : known(formatQuantity(sum(lines.map((line) => line.open)))),
      preTransferCoverage: allocated ? known(formatQuantity(sum(preCovered.values()))) : UNKNOWN,
      preTransferShortage: allocated ? known(formatQuantity(totalGap)) : UNKNOWN,
      ...(reads.priorCommitments === undefined
        ? {}
        : {
            priorCommitment:
              allocated && commitmentsKnown
                ? known(formatQuantity(sum(committed.values())))
                : UNKNOWN,
          }),
      conditionalTransfer:
        allocated && conditionalKnown ? known(formatQuantity(sum(conditional.values()))) : UNKNOWN,
      conditionalShortage:
        conditionalShortage === null ? UNKNOWN : known(formatQuantity(conditionalShortage)),
    };

    const result: CoverageAssessment = {
      contractVersion: ASSESSMENT_CONTRACT_VERSION,
      ruleImplementation: COVERAGE_RULES_VERSION,
      organization: input.organization,
      assessedAt: input.assessedAt,
      proposalId: input.proposalId,
      decision,
      issues: this.issues.map(({ rank: _rank, ...issue }) => issue),
      eligibility,
      demand: demandResults,
      supply,
      allocations,
      transferOptions,
      substitutes,
      shortfalls,
      totals,
      authorization,
      plan: null,
    };
    if (
      decision.recommendedState === "awaiting_approval" &&
      allocated &&
      conditionalKnown &&
      authorization !== null &&
      mapping !== null &&
      supplier !== null &&
      po !== null &&
      poLine !== null &&
      proposed !== null
    ) {
      result.plan = buildPlan({
        input,
        result,
        mapping,
        supplier,
        poLine,
        proposed: proposed.map((segment) => ({
          sequence: segment.sequence,
          quantity: formatQuantity(segment.quantity),
          arrival: segment.arrival ?? { state: "undated" },
        })),
        option: usedOption,
        authorization,
      });
    }
    return result;
  }

  /**
   * One prior commitment's contribution. `requested` needs its reservation
   * still held at a source warehouse that was read; `dispatched` may already
   * have left it. A `received` observation books no stock, so the reservation
   * stays deducted at the source while the destination stock does not show
   * the receipt: counting either side would cover the demand twice or not at
   * all. A received, `unknown` or requested-but-unreserved commitment is an
   * unreconciled effect: it covers nothing, blocks any new transfer and is
   * never released or replaced.
   */
  private commitmentStage(
    commitment: PriorCommitment,
    ordered: readonly DemandInput[],
    residual: ReadonlyMap<string, bigint>,
    eligible: ReadonlyMap<string, Eligibility>,
    uom: string,
  ): { ok: boolean; bucket: SupplyBucket; assigned: Map<string, bigint> } {
    const subject = `reads.priorCommitments[${commitment.commitmentId}]`;
    const bucket = (
      allocated: bigint,
      disposition: SupplyBucket["disposition"],
      reason: string | null,
    ): SupplyBucket => ({
      supply: {
        kind: "prior_commitment",
        planId: commitment.planId,
        commitmentId: commitment.commitmentId,
        requestId: commitment.requestId,
      },
      destination: commitment.to,
      quantity: commitment.quantity,
      uom,
      arrival: { state: "dated", date: commitment.arrivalDate },
      allocated: formatQuantity(allocated),
      disposition,
      reason,
    });
    const source = eligible.get(commitment.from);
    // Fail closed: a source warehouse that was not read holds nothing known.
    const held =
      source !== undefined &&
      (source.commitmentReservations ?? []).some(
        (entry) =>
          entry.reservationId === commitment.reservationId && entry.planId === commitment.planId,
      );
    if (
      commitment.status === "unknown" ||
      commitment.status === "received" ||
      (commitment.status === "requested" && !held)
    ) {
      this.issue(
        2,
        REASONS.priorCommitmentUnknown,
        "warehouse_planner",
        subject,
        commitment.status === "received"
          ? `${commitment.requestId ?? "the transfer request"} is observed received but no stock record books it, and reservation ${commitment.reservationId} at ${commitment.from} is not released; reconcile before any new allocation`
          : `reconcile ${commitment.requestId ?? "the transfer request"} and reservation ${commitment.reservationId} at ${commitment.from}; an unknown effect is never released or replaced`,
      );
      return {
        ok: false,
        bucket: bucket(0n, "unallocated", REASONS.priorCommitmentUnknown),
        assigned: new Map(),
      };
    }
    const quantity = parseQuantity(commitment.quantity);
    const assigned = assignWhole(quantity, commitment.arrivalDate, ordered, residual);
    if (assigned === null) {
      this.issue(
        0,
        REASONS.allocationTie,
        "buyer",
        "reads.demand",
        "equal priorities change which line a prior commitment covers",
      );
      return { ok: false, bucket: bucket(0n, "unallocated", null), assigned: new Map() };
    }
    const used = sum(assigned.values());
    const late =
      used === 0n &&
      ordered.every(
        (line) =>
          (residual.get(lineKey(line)) ?? 0n) === 0n || commitment.arrivalDate > line.receiptCutoff,
      ) &&
      ordered.some((line) => (residual.get(lineKey(line)) ?? 0n) > 0n);
    const [disposition, reason]: [SupplyBucket["disposition"], string | null] =
      used === quantity
        ? ["allocated", null]
        : late
          ? ["late", REASONS.arrivalAfterCutoff]
          : used === 0n
            ? ["unallocated", REASONS.priorCommitmentSurplus]
            : ["partially_allocated", REASONS.priorCommitmentSurplus];
    return { ok: true, bucket: bucket(used, disposition, reason), assigned };
  }

  private lastReason(): string {
    return this.issues.at(-1)?.reason ?? REASONS.evidenceUnavailable;
  }

  private assessOption(
    option: TransferOption,
    poLine: { sku: string; uom: string; destination: string },
    ordered: readonly DemandInput[],
    preGap: ReadonlyMap<string, bigint>,
    totalGap: bigint,
    eligible: ReadonlyMap<string, Eligibility>,
    eligibility: CoverageAssessment["eligibility"],
  ): Omit<TransferOptionAssessment, "assigned"> {
    const reasons: Array<{ reason: string; owner: ActorRole }> = [];
    let blocked = false;
    const block = (reason: string) => {
      blocked = true;
      reasons.push({ reason, owner: "warehouse_planner" });
    };
    let unknown = false;
    if (totalGap === 0n) {
      reasons.push({ reason: REASONS.transferNotNeeded, owner: "warehouse_planner" });
    } else {
      if (option.sku !== poLine.sku) block(REASONS.transferSkuMismatch);
      if (option.uom !== poLine.uom) block(REASONS.transferUomMismatch);
      if (option.to !== poLine.destination) block(REASONS.transferDestinationMismatch);
      if (option.owner !== "warehouse_planner") block(REASONS.transferOwnerUnsupported);
      if (!strictlyBefore(this.input.assessedAt, option.validUntil))
        block(REASONS.transferQuoteExpired);
      const coversALine = ordered.some(
        (line) =>
          (preGap.get(lineKey(line)) ?? 0n) > 0n && option.arrivalDate <= line.receiptCutoff,
      );
      if (!coversALine) block(REASONS.transferArrivalAfterCutoff);
      const source = eligible.get(option.from);
      if (source === undefined) {
        unknown = true;
        // The source warehouse's own reason: why its read failed or was unusable,
        // or that it was never read. A failed read already has its issue.
        const entry = eligibility.find((candidate) => candidate.warehouse === option.from);
        const subject = `reads.stock[${option.from}]`;
        if (entry?.state === "unknown") {
          reasons.push({ reason: entry.reason, owner: "warehouse_planner" });
        } else {
          reasons.push({ reason: REASONS.evidenceNotFound, owner: "warehouse_planner" });
          const raised = this.issues.some(
            (issue) => issue.subject === subject && issue.reason === REASONS.evidenceNotFound,
          );
          if (!raised) {
            this.issue(
              2,
              REASONS.evidenceNotFound,
              "warehouse_planner",
              subject,
              `the stock at ${option.from}, the source of a transfer option, must be read`,
            );
          }
        }
      } else {
        if (option.basedOn !== source.stockVersion) block(REASONS.transferStockVersionMismatch);
        if (parseQuantity(source.eligible) < parseQuantity(option.quantity)) {
          block(REASONS.transferInsufficientStock);
        }
      }
    }
    return {
      optionId: option.optionId,
      status:
        totalGap === 0n ? "not_needed" : blocked ? "blocked" : unknown ? "unknown" : "supported",
      reasons,
      terms: option,
      termsSha256: contentSha256(option),
    };
  }

  private authorization(
    policy: Policy | null,
    option: TransferOption | null,
  ): AuthorizationRequirement | null {
    if (policy?.policyId !== "AUTH-1") return null;
    const cost = option === null ? { minorUnits: 0, currency: policy.currency } : option.cost;
    if (!Number.isSafeInteger(cost.minorUnits))
      throw new QuantityRangeError("cost is not a safe integer");
    const currencyPermitted = cost.currency === policy.currency;
    const limits = [...policy.limits].sort(
      (a, b) => a.maxMinorUnits - b.maxMinorUnits || compareText(a.role, b.role),
    );
    const approver = currencyPermitted
      ? limits.find((limit) => cost.minorUnits <= limit.maxMinorUnits)
      : undefined;
    return {
      policy: { policyId: policy.policyId, version: policy.version },
      cost,
      currencyPermitted,
      limits,
      minimumApproverRole: approver?.role ?? null,
    };
  }

  private decide(authorization: AuthorizationRequirement | null): {
    recommendedState: RecommendedState;
    reason: string;
    owner: ActorRole;
  } {
    const first = [...this.issues].sort((a, b) => a.rank - b.rank)[0];
    if (first !== undefined) {
      return {
        recommendedState: first.rank === 3 ? "escalated" : "needs_clarification",
        reason: first.reason,
        owner: first.owner,
      };
    }
    // Without an issue the authorization policy was read and a role's limit covers the cost.
    const approver = authorization?.minimumApproverRole;
    if (approver === undefined || approver === null) {
      throw new Error("an assessment without issues must have an approver within AUTH-1 limits");
    }
    return {
      recommendedState: "awaiting_approval",
      reason: REASONS.planReadyForApproval,
      owner: approver,
    };
  }
}

function supplyId(bucket: SupplyBucket): string {
  return bucket.supply.kind === "in_transit" ? bucket.supply.transitId : "";
}

/**
 * The whole quoted quantity, assigned to lines with a remaining gap in
 * priority order, only where it arrives by the line's cutoff. Never resized.
 * Null when equal priorities would change which line it covers.
 */
function assignTransfer(
  option: TransferOption,
  ordered: readonly DemandInput[],
  preGap: ReadonlyMap<string, bigint>,
): Map<string, bigint> | null {
  return assignWhole(parseQuantity(option.quantity), option.arrivalDate, ordered, preGap);
}

/** A whole quantity arriving on one date, assigned as `assignTransfer` describes. */
function assignWhole(
  quantity: bigint,
  arrivalDate: string,
  ordered: readonly DemandInput[],
  preGap: ReadonlyMap<string, bigint>,
): Map<string, bigint> | null {
  const run = (lines: readonly DemandInput[]) => {
    let left = quantity;
    const assigned = new Map<string, bigint>();
    for (const line of lines) {
      const gap = preGap.get(lineKey(line)) ?? 0n;
      if (left === 0n || gap === 0n || arrivalDate > line.receiptCutoff) continue;
      const take = min(left, gap);
      assigned.set(lineKey(line), take);
      left -= take;
    }
    return assigned;
  };
  const forward = run(ordered);
  const reversed = run(
    [...ordered].sort((a, b) => a.priority - b.priority || compareText(lineKey(b), lineKey(a))),
  );
  const text = (map: Map<string, bigint>) =>
    [...map]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join(",");
  return text(forward) === text(reversed) ? forward : null;
}

function rangeBlocked(
  input: CoverageAssessmentInput,
  error: QuantityRangeError,
): CoverageAssessment {
  return {
    contractVersion: ASSESSMENT_CONTRACT_VERSION,
    ruleImplementation: COVERAGE_RULES_VERSION,
    organization: input.organization,
    assessedAt: input.assessedAt,
    proposalId: input.proposalId,
    decision: {
      recommendedState: "needs_clarification",
      reason: REASONS.quantityOutOfRange,
      owner: "buyer",
    },
    issues: [
      {
        reason: REASONS.quantityOutOfRange,
        owner: "buyer",
        subject: "input",
        nextEvidence: error.message,
      },
    ],
    eligibility: [],
    demand: [],
    supply: [],
    allocations: [],
    transferOptions: [],
    substitutes: [],
    shortfalls: [],
    totals: {
      uom: null,
      demandOpen: UNKNOWN,
      preTransferCoverage: UNKNOWN,
      preTransferShortage: UNKNOWN,
      conditionalTransfer: UNKNOWN,
      conditionalShortage: UNKNOWN,
    },
    authorization: null,
    plan: null,
  };
}
