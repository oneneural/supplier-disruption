import type {
  CandidateOffer,
  DemandSnapshot,
  InTransitRecord,
  ItemMapping,
  Policy,
  PurchaseOrderRevision,
  StockSnapshot,
  SupplierProposalTerms,
  TransferOption,
} from "@supplier-disruption/contracts";
import { compareText } from "./eligibility.js";

// Unordered collections are sorted by their documented identities before a
// digest, so equivalent input order never changes a hash. Ordered data
// (segments by sequence, actions, priorities) keeps its meaning.

const by =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) =>
    compareText(key(a), key(b));

const bySequence = (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence;

export function normalTerms(terms: SupplierProposalTerms): SupplierProposalTerms {
  return {
    ...terms,
    segments: [...terms.segments].sort(bySequence),
    unresolvedFields: [...terms.unresolvedFields].sort(compareText),
  };
}

export function normalPurchaseOrder(record: PurchaseOrderRevision): PurchaseOrderRevision {
  return {
    ...record,
    lines: [...record.lines]
      .sort(by((line) => line.lineNumber))
      .map((line) => ({ ...line, acceptedSegments: [...line.acceptedSegments].sort(bySequence) })),
  };
}

export function normalStock(record: StockSnapshot): StockSnapshot {
  return { ...record, reservations: [...record.reservations].sort(by((r) => r.reservationId)) };
}

const linkKey = (link: { poNumber: string; poLine: string }) => `${link.poNumber}/${link.poLine}`;

export function normalDemand(record: DemandSnapshot): DemandSnapshot {
  return {
    ...record,
    lines: [...record.lines]
      .sort(by((line) => `${line.salesOrder}/${line.line}`))
      .map((line) => ({ ...line, supplyLinks: [...line.supplyLinks].sort(by(linkKey)) })),
  };
}

export function normalMappings(records: readonly ItemMapping[]): ItemMapping[] {
  return [...records].sort(
    (a, b) => compareText(a.mappingId, b.mappingId) || a.version - b.version,
  );
}

export function normalOptions(records: readonly TransferOption[]): TransferOption[] {
  return [...records].sort(by((option) => option.optionId));
}

export function normalTransit(records: readonly InTransitRecord[]): InTransitRecord[] {
  return [...records].sort(by((record) => record.transitId));
}

export function normalPolicy(policy: Policy): Policy {
  if (policy.policyId !== "AUTH-1") return policy;
  return { ...policy, limits: [...policy.limits].sort(by((limit) => limit.role)) };
}

export function normalOffers(offers: readonly CandidateOffer[]): CandidateOffer[] {
  return [...offers].sort(by((offer) => offer.offerId));
}

export { linkKey };
