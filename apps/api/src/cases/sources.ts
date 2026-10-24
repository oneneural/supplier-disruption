import {
  ASSESSMENT_CONTRACT_VERSION,
  INTAKE_CONTRACT_VERSION,
  type Clock,
  type CoverageAssessmentInput,
  type IntakeAssessmentReads,
  type IntakeDelivery,
  type IntakeInput,
  type PriorAcceptance,
  type PurchaseOrderRevision,
  type ReadEvidence,
  type ReadScope,
  type SupplierInputIdentity,
  type SupplierProposalTerms,
} from "@supplier-disruption/contracts";
import { BusinessClockError } from "@supplier-disruption/db";
import { createDemandSource, type DemandSource } from "@supplier-disruption/db/demand";
import {
  SourceRejectedError,
  createInventorySource,
  type InventorySource,
  type TransferOptionsRead,
} from "@supplier-disruption/db/inventory";
import { createPurchasingSource, type PurchasingSource } from "@supplier-disruption/db/purchasing";
import {
  createReferenceSource,
  type CurrentPolicyRead,
  type ItemMappingsRead,
  type ItemRead,
  type PolicyRead,
  type ReadablePolicyId,
  type ReferenceSource,
  type RegisteredVendorRead,
  type SupplierInputRead,
  type VendorRead,
} from "@supplier-disruption/db/reference";
import type pg from "pg";
import { CASE_FIXTURE } from "./fixture.js";

/** The fixture authorities the case workflow reads and writes through their public modules. */
export interface CaseSources {
  purchasing: PurchasingSource;
  inventory: InventorySource;
  demand: DemandSource;
  reference: ReferenceSource;
}

export function createCaseSources(pool: pg.Pool, clock: Clock): CaseSources {
  const options = { pool, clock };
  return {
    purchasing: createPurchasingSource(options),
    inventory: createInventorySource(options),
    demand: createDemandSource(options),
    reference: createReferenceSource({ ...options, fixtureOrganization: CASE_FIXTURE.reference }),
  };
}

const UNKNOWN = { state: "unknown" } as const;
type Evidence = ReadEvidence<unknown>;
type Scope = ReadScope;

/**
 * Classifies a thrown fixture-source read failure. A missing record is attributable
 * absence; everything else is unavailable evidence, never zero or empty.
 */
function classify(scope: Scope, error: unknown): Evidence {
  if (error instanceof SourceRejectedError && error.reason === "source.not_found") {
    return { status: "not_found", scope, readAt: UNKNOWN, reason: error.reason };
  }
  const code = (error as { code?: unknown }).code;
  const reason =
    error instanceof SourceRejectedError
      ? error.reason
      : error instanceof BusinessClockError
        ? "clock_unavailable"
        : code === "ECONNREFUSED"
          ? "connection_unavailable"
          : "read_failed";
  return { status: "unavailable", scope, reason, attemptedAt: UNKNOWN };
}

/** A fixture authority read: its envelope returns no observation time, so none is stated. */
async function sourceRead<R extends { readAt: string }>(
  scope: Scope,
  read: () => Promise<R>,
  toData: (result: R) => unknown,
): Promise<Evidence> {
  try {
    const result = await read();
    return {
      status: "ok",
      provenance: { scope, readAt: result.readAt, observedAt: { state: "not_returned" } },
      data: toData(result),
    };
  } catch (error) {
    return classify(scope, error);
  }
}

type PublicRead =
  | CurrentPolicyRead
  | ItemRead
  | ItemMappingsRead
  | PolicyRead
  | VendorRead
  | RegisteredVendorRead
  | SupplierInputRead
  | TransferOptionsRead;

/**
 * A reference read outcome in the contracts' evidence shape. An invalid query
 * echoes unvalidated selectors, so the intended scope stands in for it.
 */
function publicRead(result: PublicRead, intended: object): Evidence {
  switch (result.status) {
    case "ok":
      return {
        status: "ok",
        provenance: {
          scope: result.scope as Scope,
          readAt: result.readAt,
          observedAt: result.observedAt,
        },
        data: result.data,
      };
    case "not_found":
      return {
        status: "not_found",
        scope: result.scope as Scope,
        readAt: { state: "known", value: result.readAt },
        reason: result.reason,
      };
    case "ambiguous":
      return {
        status: "ambiguous",
        scope: result.scope as Scope,
        readAt: result.readAt,
        reason: result.reason,
      };
    case "unavailable":
      if (result.reason === "invalid_query") {
        return {
          status: "unavailable",
          scope: intended as Scope,
          reason: result.reason,
          attemptedAt: UNKNOWN,
        };
      }
      return {
        status: "unavailable",
        scope: result.scope as Scope,
        reason: result.reason,
        attemptedAt:
          result.attemptedAt === undefined
            ? UNKNOWN
            : { state: "known", value: result.attemptedAt },
      };
  }
}

const organization = CASE_FIXTURE.label;
const attempted = (resource: string, selectors: object) => ({
  owner: "reference",
  resource,
  organization,
  selectors,
  binding: { state: "attempted", ...CASE_FIXTURE.reference },
});

/** The stored structured supplier input, or why it could not be read. */
export async function readStoredInput(
  sources: CaseSources,
  key: { sourceSystem: string; messageId: string; inputVersion: number },
): Promise<
  | { status: "ok"; identity: SupplierInputIdentity; terms: SupplierProposalTerms; read: Evidence }
  | { status: "not_found" | "unavailable" }
> {
  const stored = await sources.reference.readSupplierInput({ organization, ...key });
  if (stored.status === "ok") {
    return {
      status: "ok",
      identity: stored.data.identity,
      terms: stored.data.terms,
      read: publicRead(stored, attempted("supplier_input", key)),
    };
  }
  return { status: stored.status === "not_found" ? "not_found" : "unavailable" };
}

/** The delivery a stored fixture message represents: its identity, proposal and text. */
export function deliveryOf(
  identity: SupplierInputIdentity,
  terms: SupplierProposalTerms,
  supplierText: string | undefined,
): IntakeDelivery {
  return {
    identity,
    proposal: {
      contractVersion: identity.contractVersion,
      proposalId: identity.proposalId,
      terms,
      evidence: {
        sourceSystem: identity.sourceSystem,
        messageId: identity.messageId,
        inputVersion: identity.inputVersion,
      },
    },
    ...(supplierText === undefined ? {} : { supplierText }),
  };
}

function purchaseOrderRead(sources: CaseSources, poNumber: string) {
  return sourceRead(
    { owner: "purchasing", resource: "purchase_order", organization, selectors: { poNumber } },
    () => sources.purchasing.readPurchaseOrder({ organization, poNumber }),
    ({ currentRevision, record }) => ({ currentRevision, record }),
  );
}

/** The SKU and destination of the proposal's PO line, when the PO read found it. */
function lineOf(purchaseOrder: Evidence, poLine: string) {
  if (purchaseOrder.status !== "ok") return null;
  const record = (purchaseOrder.data as { record: PurchaseOrderRevision }).record;
  return record.lines.find((line) => line.lineNumber === poLine) ?? null;
}

const POLICIES = {
  calendar: "CAL-CPH-1",
  eligibility: "ELIG-1",
  allocation: "ALLOC-1",
  authorization: "AUTH-1",
} as const satisfies Record<string, ReadablePolicyId>;

/**
 * Every read the assessment needs besides the supplier input and the PO. The
 * SKU and destination come from the PO line; the other fixture warehouses are
 * transfer sources. Without a resolved line nothing is read, and each slot
 * holds unavailable evidence that a blocked intake never examines.
 */
async function assessmentReads(
  sources: CaseSources,
  context: {
    vendorId: string | null;
    terms: SupplierProposalTerms;
    line: { sku: string; destination: string } | null;
  },
): Promise<IntakeAssessmentReads> {
  const { line, terms, vendorId } = context;
  const warehouses = CASE_FIXTURE.warehouses;
  if (line === null || vendorId === null) {
    const none = (scope: object): Evidence => ({
      status: "unavailable",
      scope: scope as Scope,
      reason: "case.scope_unresolved",
      attemptedAt: UNKNOWN,
    });
    const scope = (owner: string, resource: string) => ({
      owner,
      resource,
      organization,
      selectors: {},
    });
    return {
      demand: none(scope("demand", "demand")),
      stock: warehouses.map((warehouse) => ({
        warehouse,
        read: none(scope("inventory", "stock")),
      })),
      inTransit: warehouses.map((warehouse) => ({
        warehouse,
        read: none(scope("inventory", "in_transit")),
      })),
      transferOptions: none(scope("inventory", "transfer_options")),
      item: none(scope("reference", "item")),
      itemMappings: none(scope("reference", "item_mappings")),
      policies: {
        calendar: none(scope("reference", "policy")),
        eligibility: none(scope("reference", "policy")),
        allocation: none(scope("reference", "policy")),
        authorization: none(scope("reference", "policy")),
      },
    } as IntakeAssessmentReads;
  }
  const sku = line.sku;
  const stockScope = (warehouse: string) => ({
    owner: "inventory",
    resource: "stock",
    organization,
    selectors: { sku, warehouse },
  });
  const stock = (warehouse: string) =>
    sourceRead(
      stockScope(warehouse) as Scope,
      () => sources.inventory.readStock({ organization, sku, warehouse }),
      ({ currentVersion, record, lineage }) => ({ currentVersion, record, lineage }),
    );
  const transit = (warehouse: string) =>
    sourceRead(
      { ...stockScope(warehouse), resource: "in_transit" } as Scope,
      () => sources.inventory.readInTransit({ organization, sku, warehouse }),
      ({ records }) => ({ records }),
    );
  // Each policy is assessed at its current version (ADR 0013): the head names
  // the version, and the exact read of that version is the plan's evidence.
  const policy = async (policyId: ReadablePolicyId) => {
    const current = await sources.reference.readCurrentPolicy({ organization, policyId });
    if (current.status !== "ok") {
      // A failed head read is policy evidence that could not be resolved.
      const scope = attempted("policy", { policyId });
      return { ...publicRead(current, scope), scope } as Evidence;
    }
    const version = current.data.version;
    return publicRead(
      await sources.reference.readPolicy({ organization, policyId, version }),
      attempted("policy", { policyId, version }),
    );
  };
  // The first slice has one transfer source: the fixture warehouse that is not the destination.
  const from = warehouses.find((warehouse) => warehouse !== line.destination) ?? line.destination;
  const options = { sku, uom: terms.uom, fromWarehouse: from, toWarehouse: line.destination };
  const mapping = { vendorId, vendorItem: terms.vendorItem, sourceUom: terms.uom };
  return {
    demand: await sourceRead(
      { owner: "demand", resource: "demand", organization, selectors: {} },
      () => sources.demand.readDemand({ organization }),
      ({ currentVersion, record }) => ({ currentVersion, record }),
    ),
    stock: await Promise.all(
      warehouses.map(async (warehouse) => ({ warehouse, read: await stock(warehouse) })),
    ),
    inTransit: await Promise.all(
      warehouses.map(async (warehouse) => ({ warehouse, read: await transit(warehouse) })),
    ),
    transferOptions: publicRead(
      await sources.inventory.readTransferOptions({ organization, ...options }),
      { owner: "inventory", resource: "transfer_options", organization, selectors: options },
    ),
    item: publicRead(
      await sources.reference.readItem({ organization, sku }),
      attempted("item", { sku }),
    ),
    itemMappings: publicRead(
      await sources.reference.readItemMappings({ organization, ...mapping }),
      attempted("item_mappings", mapping),
    ),
    policies: {
      calendar: await policy(POLICIES.calendar),
      eligibility: await policy(POLICIES.eligibility),
      allocation: await policy(POLICIES.allocation),
      authorization: await policy(POLICIES.authorization),
    },
  } as IntakeAssessmentReads;
}

export interface IntakeComposition {
  receiptId: string;
  caseId: string;
  planId: string;
  planVersion: number;
  assessedAt: string;
  priorAcceptance: PriorAcceptance;
  /** Only for a successor of a verified case: its predecessor's commitments (ADR 0015). */
  priorCommitments?: Evidence;
}

/**
 * The transfer commitments a verified predecessor plan made, as its own
 * journal names them: each transfer request action with the reservation its
 * reservation action created. `inheritedPlanIds` are the earlier plans of the
 * predecessor's own lineage, whose commitments it carries forward.
 */
export interface PredecessorTransfers {
  planId: string;
  inheritedPlanIds: string[];
  transfers: Array<{
    planId: string;
    commitmentId: string;
    operationId: string;
    reservationId: string;
    sku: string;
    uom: string;
    from: string;
    to: string;
    quantity: string;
    arrivalDate: string;
  }>;
}

/**
 * Reads what the warehouse records show now for each predecessor commitment
 * (ADR 0015). A request that cannot be found by its operation ID, or that no
 * longer matches the journal, is `unknown`, never assumed released. Only the
 * transfer observations decide `dispatched` or `received`; a receipt
 * observation alone never adds physical stock. A `requested` commitment also
 * needs its reservation still held for its plan at the source, or it is
 * `unknown`. A failed read makes the whole collection unavailable rather than
 * partly known.
 */
export async function readPriorCommitments(
  sources: CaseSources,
  predecessor: PredecessorTransfers,
  at: string,
): Promise<Evidence> {
  const scope = {
    owner: "inventory",
    resource: "prior_commitments",
    organization,
    selectors: { planId: predecessor.planId },
  } as Scope;
  return sourceRead(
    scope,
    async () => {
      const readTimes: string[] = [];
      const records = [];
      for (const transfer of predecessor.transfers) {
        const found = await sources.inventory.lookupOperation({
          organization,
          operationId: transfer.operationId,
        });
        const request = found !== null && "request" in found ? found.request : null;
        if (found !== null) readTimes.push(found.readAt);
        let status: "requested" | "dispatched" | "received" | "unknown" = "unknown";
        if (
          request !== null &&
          request.planId === transfer.planId &&
          request.reservation.reservationId === transfer.reservationId &&
          request.from === transfer.from &&
          request.to === transfer.to &&
          request.quantity === transfer.quantity &&
          request.arrivalDate === transfer.arrivalDate
        ) {
          const observed = await sources.inventory.readTransferObservations({
            organization,
            requestId: request.requestId,
          });
          readTimes.push(observed.readAt);
          const kinds = new Map(observed.records.map((record) => [record.kind, record]));
          // A partial observation is not modeled: anything but the whole quantity is unknown.
          const whole = observed.records.every((record) => record.quantity === request.quantity);
          status = !whole
            ? "unknown"
            : kinds.has("received")
              ? "received"
              : kinds.has("dispatched")
                ? "dispatched"
                : "requested";
          if (status === "requested") {
            const stock = await sources.inventory.readStock({
              organization,
              sku: transfer.sku,
              warehouse: transfer.from,
            });
            readTimes.push(stock.readAt);
            const held = stock.record.reservations.some(
              (reservation) =>
                reservation.reservationId === transfer.reservationId &&
                reservation.binding.kind === "plan" &&
                reservation.binding.planId === transfer.planId &&
                reservation.quantity === transfer.quantity,
            );
            if (!held) status = "unknown";
          }
        }
        records.push({
          commitmentId: transfer.commitmentId,
          planId: transfer.planId,
          reservationId: transfer.reservationId,
          requestId: request?.requestId ?? null,
          sku: transfer.sku,
          uom: transfer.uom,
          from: transfer.from,
          to: transfer.to,
          quantity: transfer.quantity,
          arrivalDate: transfer.arrivalDate,
          status,
        });
      }
      // When no operation was found, the caller's business time stands in.
      if (readTimes.length === 0) readTimes.push(at);
      const readAt = readTimes.reduce((earliest, time) =>
        Date.parse(time) < Date.parse(earliest) ? time : earliest,
      );
      return { readAt, records };
    },
    ({ records }) => ({
      predecessorPlanId: predecessor.planId,
      ...(predecessor.inheritedPlanIds.length === 0
        ? {}
        : { inheritedPlanIds: predecessor.inheritedPlanIds }),
      records,
    }),
  );
}

/**
 * Composes one intake from the public reads, each in its own transaction. The
 * vendor is read by the registered sender's vendor ID, never a supplier
 * field; the PO is a current-head read of the structured PO number.
 */
export async function composeIntake(
  sources: CaseSources,
  stored: { identity: SupplierInputIdentity; terms: SupplierProposalTerms; read: Evidence },
  delivery: IntakeDelivery,
  composition: IntakeComposition,
): Promise<IntakeInput> {
  const { identity, terms } = stored;
  const registered = await sources.reference.readRegisteredVendor({
    organization,
    sender: identity.sender,
  });
  const vendorId = registered.status === "ok" ? registered.data.vendorId : null;
  const vendor =
    vendorId === null
      ? null
      : publicRead(
          await sources.reference.readVendor({ organization, vendorId }),
          attempted("vendor", { vendorId }),
        );
  const purchaseOrder = await purchaseOrderRead(sources, terms.poNumber);
  const line = lineOf(purchaseOrder, terms.poLine);
  return {
    contractVersion: INTAKE_CONTRACT_VERSION,
    organization,
    assessedAt: composition.assessedAt,
    receiptId: composition.receiptId,
    caseId: composition.caseId,
    planId: composition.planId,
    planVersion: composition.planVersion,
    delivery,
    priorAcceptance: composition.priorAcceptance,
    reads: {
      supplierInput: stored.read,
      registeredVendor: publicRead(
        registered,
        attempted("registered_vendor", { sender: identity.sender }),
      ),
      vendor,
      purchaseOrder,
      assessment: {
        ...(await assessmentReads(sources, { vendorId, terms, line })),
        ...(composition.priorCommitments === undefined
          ? {}
          : { priorCommitments: composition.priorCommitments }),
      },
    },
    candidateOffers: [],
  } as unknown as IntakeInput;
}

/**
 * Fresh reads for reassessing an already accepted proposal under a new plan
 * version. Intake is not repeated: its receipt already exists, and a replay
 * would only report a duplicate.
 */
export async function composeReassessment(
  sources: CaseSources,
  accepted: {
    sourceSystem: string;
    messageId: string;
    inputVersion: number;
    vendorId: string;
    proposalId: string;
    terms: SupplierProposalTerms;
  },
  plan: { planId: string; planVersion: number; assessedAt: string },
  priorCommitments?: Evidence,
): Promise<CoverageAssessmentInput> {
  const stored = await readStoredInput(sources, {
    sourceSystem: accepted.sourceSystem,
    messageId: accepted.messageId,
    inputVersion: accepted.inputVersion,
  });
  const supplierInput: Evidence =
    stored.status === "ok"
      ? stored.read
      : ({
          status: stored.status === "not_found" ? "not_found" : "unavailable",
          scope: attempted("supplier_input", {
            sourceSystem: accepted.sourceSystem,
            messageId: accepted.messageId,
            inputVersion: accepted.inputVersion,
          }) as Scope,
          ...(stored.status === "not_found"
            ? { readAt: UNKNOWN, reason: "record_not_found" }
            : { reason: "read_failed", attemptedAt: UNKNOWN }),
        } as Evidence);
  const purchaseOrder = await purchaseOrderRead(sources, accepted.terms.poNumber);
  const line = lineOf(purchaseOrder, accepted.terms.poLine);
  const reads = await assessmentReads(sources, {
    vendorId: accepted.vendorId,
    terms: accepted.terms,
    line,
  });
  return {
    contractVersion: ASSESSMENT_CONTRACT_VERSION,
    organization,
    assessedAt: plan.assessedAt,
    planId: plan.planId,
    planVersion: plan.planVersion,
    vendorId: accepted.vendorId,
    poLine: { poNumber: accepted.terms.poNumber, poLine: accepted.terms.poLine },
    proposalId: accepted.proposalId,
    reads: {
      ...reads,
      supplierInput,
      purchaseOrder,
      ...(priorCommitments === undefined ? {} : { priorCommitments }),
    },
    candidateOffers: [],
  } as unknown as CoverageAssessmentInput;
}
