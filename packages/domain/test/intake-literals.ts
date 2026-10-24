// Test-only literal inputs for the intake gates (I1 to I5), written
// by hand from the frozen oracle (docs/oracles/first-slice-oracles.md,
// "Canonical base fixture", C-01 and N-01 to N-04). The assessment reads
// reuse the hand-written coverage assessment test literals; nothing is imported from the
// seed manifest, production reason constants, serializer or hash code.
// Supplemental records (V-200, ambiguous senders, other organizations) are
// labeled where they are built. Every call returns a fresh object.
import { createHash } from "node:crypto";
import { c01Input } from "./literals.js";

const v = "supplier-domain.v1";
export const ORG = "ORG-NDL";
export const ORG_ID = "ed222926-927c-460e-8d28-e22ab5620819";
/** 2026-10-21T09:00 Europe/Copenhagen, the controlled clock's start. */
export const ASSESSED_AT = "2026-10-21T07:00:00.000Z";
const READ_AT = "2026-10-21T07:00:00.000Z";
const VALIDATED = { state: "validated", label: ORG, organizationId: ORG_ID } as const;

export const SOURCE_SYSTEM = "fixture-supplier-mail";
export const SENDER = "orders@kestrel-fasteners.test";
/** N-02 a: the same content from an unregistered address. */
export const UNREGISTERED = "sales@kestrel-fasteners.example";
/** N-02 b, supplemental fixture: the registered sender of vendor V-200. */
export const V200_SENDER = "orders@harbor-bolts.test";

/**
 * The canonical JSON bytes of MSG-0001's terms, authored by hand from the
 * oracle, and their SHA-256 computed independently with Python hashlib
 * (ADR 0008, independent hash fixture).
 */
export const MSG_0001_TERMS_BYTES =
  '{"baseRevision":"3","poLine":"10","poNumber":"PO-120","segments":[{"arrival":{"date":"2026-10-23","state":"dated"},"quantity":"40","sequence":1},{"arrival":{"date":"2026-10-26","state":"dated"},"quantity":"80","sequence":2}],"unresolvedFields":[],"uom":"EA","vendorItem":"KF-A-01"}';
export const MSG_0001_SHA256 = "43dec39141c2d85db55a875337863ab50fbb3e5cb30a0bcc0a0040ef3478803c";

/**
 * A test-only digest for supplemental terms: key-sorted JSON hashed here,
 * independent of the production serializer. It builds inputs whose stated
 * hash is correct; it never computes an expected result.
 */
export function testDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (typeof item === "object" && item !== null) {
      const keys = Object.keys(item).sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

const segment = (sequence: number, quantity: string, date: string) => ({
  sequence,
  quantity,
  arrival: { state: "dated", date },
});

export function msg0001Terms() {
  return {
    poNumber: "PO-120",
    poLine: "10",
    baseRevision: "3",
    vendorItem: "KF-A-01",
    uom: "EA",
    segments: [segment(1, "40", "2026-10-23"), segment(2, "80", "2026-10-26")],
    unresolvedFields: [] as string[],
  };
}

export type Terms = ReturnType<typeof msg0001Terms>;

export function msg0001Identity() {
  return {
    contractVersion: v,
    sourceSystem: SOURCE_SYSTEM,
    messageId: "MSG-0001",
    inputVersion: 1,
    contentSha256: MSG_0001_SHA256,
    sender: SENDER,
    proposalId: "PROP-1",
    evidenceRef: "MSG-0001@1",
    authoredAt: { state: "unknown" } as { state: string; value?: string },
    receivedAt: { state: "unknown" } as { state: string; value?: string },
  };
}

export type Identity = ReturnType<typeof msg0001Identity>;

export const V100 = {
  contractVersion: v,
  vendorId: "V-100",
  name: "Kestrel Fasteners ApS",
  registeredSenders: [SENDER],
};

/** Supplemental fixture vendor for N-02 b. */
export const V200 = {
  contractVersion: v,
  vendorId: "V-200",
  name: "Harbor Bolts A/S",
  registeredSenders: [V200_SENDER],
};

const referenceScope = (resource: string, selectors: Record<string, unknown>) => ({
  owner: "reference",
  resource,
  organization: ORG,
  selectors,
  binding: VALIDATED,
});

export const ok = (scope: unknown, data: unknown, observedAt: unknown = { state: "unknown" }) => ({
  status: "ok",
  provenance: { scope, readAt: READ_AT, observedAt },
  data,
});

export function registeredVendorRead(sender: string, vendor: unknown) {
  return ok(referenceScope("registered_vendor", { sender }), structuredClone(vendor));
}

export function unregisteredRead(sender: string) {
  return {
    status: "not_found",
    scope: referenceScope("registered_vendor", { sender }),
    readAt: { state: "known", value: READ_AT },
    reason: "record_not_found",
  };
}

export function vendorRead(vendor: { vendorId: string }) {
  return ok(referenceScope("vendor", { vendorId: vendor.vendorId }), structuredClone(vendor));
}

export const poScope = (poNumber: string) => ({
  owner: "purchasing",
  resource: "purchase_order",
  organization: ORG,
  selectors: { poNumber },
});

/** PO-120 at a revision: line 10 only, 120 EA to WH-A, one segment on 2026-10-23, received and canceled 0. */
export function po120(revision: string) {
  return {
    contractVersion: v,
    organization: ORG,
    poNumber: "PO-120",
    revision,
    vendorId: "V-100",
    observedAt: { state: "unknown" },
    effectiveDate: { state: "unknown" },
    lines: [
      {
        lineNumber: "10",
        sku: "PART-A",
        uom: "EA",
        destination: "WH-A",
        ordered: "120",
        received: "0",
        canceled: "0",
        acceptedSegments: [segment(1, "120", "2026-10-23")],
      },
    ],
  };
}

export function poRead(record: ReturnType<typeof po120>, currentRevision = record.revision) {
  return ok(poScope(record.poNumber), { currentRevision, record }, { state: "not_returned" });
}

export function supplierInputRead(identity: Identity, terms: Terms) {
  return ok(
    referenceScope("supplier_input", {
      sourceSystem: identity.sourceSystem,
      messageId: identity.messageId,
      inputVersion: identity.inputVersion,
    }),
    { identity: structuredClone(identity), terms: structuredClone(terms) },
  );
}

/** The C-01 assessment reads other than supplier input and PO, from the coverage assessment literals. */
function assessmentReads() {
  const reads: Partial<ReturnType<typeof c01Input>["reads"]> = c01Input().reads;
  delete reads.supplierInput;
  delete reads.purchaseOrder;
  return reads as Omit<ReturnType<typeof c01Input>["reads"], "supplierInput" | "purchaseOrder">;
}

/** The canonical MSG-0001 intake with no prior acceptance. */
export function canonicalIntake() {
  const identity = msg0001Identity();
  const terms = msg0001Terms();
  return {
    contractVersion: "supplier-intake.v1",
    organization: ORG,
    assessedAt: ASSESSED_AT,
    receiptId: "RCPT-1",
    caseId: "CASE-1" as string | null,
    planId: "PLAN-1",
    planVersion: 1,
    delivery: {
      identity,
      proposal: {
        contractVersion: v,
        proposalId: "PROP-1",
        terms,
        evidence: { sourceSystem: SOURCE_SYSTEM, messageId: "MSG-0001", inputVersion: 1 },
      },
    } as Record<string, unknown> & {
      identity: Identity;
      proposal: {
        contractVersion: string;
        proposalId: string;
        terms: Terms;
        evidence: { sourceSystem: string; messageId: string; inputVersion: number };
      } & Record<string, unknown>;
      supplierText?: string;
    },
    priorAcceptance: none(MSG_0001_SHA256) as Record<string, unknown>,
    reads: {
      supplierInput: supplierInputRead(identity, terms) as Record<string, unknown>,
      registeredVendor: registeredVendorRead(SENDER, V100) as Record<string, unknown>,
      vendor: vendorRead(V100) as Record<string, unknown> | null,
      purchaseOrder: poRead(po120("3")) as Record<string, unknown>,
      assessment: assessmentReads(),
    },
    candidateOffers: [] as unknown[],
  };
}

export type Intake = ReturnType<typeof canonicalIntake>;

export function none(contentSha256: string, messageId = "MSG-0001") {
  return {
    status: "none",
    query: { organization: ORG, sourceSystem: SOURCE_SYSTEM, messageId, contentSha256 },
  };
}

/**
 * Rewrites the delivered identity or terms and keeps everything that names
 * them consistent: the stated hash, the stored input read and its scope, the
 * proposal's evidence tuple and the prior-acceptance query. Tests that need
 * an inconsistency make it after calling this.
 */
export function revise(
  input: Intake,
  change: { identity?: Partial<Identity>; terms?: Partial<Terms>; keepHash?: boolean },
): Intake {
  const identity = { ...input.delivery.identity, ...change.identity };
  const terms = { ...input.delivery.proposal.terms, ...change.terms };
  if (change.keepHash !== true) identity.contentSha256 = testDigest(terms);
  input.delivery.identity = identity;
  input.delivery.proposal.terms = terms;
  input.delivery.proposal.proposalId = identity.proposalId;
  input.delivery.proposal.evidence = {
    sourceSystem: identity.sourceSystem,
    messageId: identity.messageId,
    inputVersion: identity.inputVersion,
  };
  input.reads.supplierInput = supplierInputRead(identity, terms);
  const query = { ...(input.priorAcceptance.query as object) } as Record<string, unknown>;
  query.messageId = identity.messageId;
  query.sourceSystem = identity.sourceSystem;
  query.contentSha256 = identity.contentSha256;
  input.priorAcceptance = { ...input.priorAcceptance, query };
  return input;
}
