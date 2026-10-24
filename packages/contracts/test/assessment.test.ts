// Assessment and plan contracts (ADR 0007): strict, browser-safe DTOs that keep
// successful reads, authoritative empty collections and unavailable evidence
// apart, and carry quantities only as canonical strings.
import { describe, expect, it } from "vitest";
import {
  actionIntentSchema,
  candidateOfferSchema,
  coverageAssessmentInputSchema,
  readEvidenceSchema,
  sourceBindingSchema,
  transferOptionsDataSchema,
} from "../src/index.js";

const ORG = "ORG-NDL";
const scope = (owner: string, resource: string, selectors: Record<string, unknown> = {}) => ({
  owner,
  resource,
  organization: ORG,
  selectors,
});
const unavailable = (owner: string, resource: string, selectors: Record<string, unknown> = {}) => ({
  status: "unavailable",
  scope: scope(owner, resource, selectors),
  reason: "connection_unavailable",
  attemptedAt: { state: "unknown" },
});

/** Structurally valid input in which every read was unavailable. */
function unavailableInput() {
  const policy = (policyId: string) => unavailable("reference", "policy", { policyId, version: 1 });
  return {
    contractVersion: "coverage-assessment.v1",
    organization: ORG,
    assessedAt: "2026-10-21T07:00:00.000Z",
    planId: "PLAN-1",
    planVersion: 1,
    vendorId: "V-100",
    poLine: { poNumber: "PO-120", poLine: "10" },
    proposalId: "PROP-1",
    reads: {
      supplierInput: unavailable("reference", "supplier_input"),
      purchaseOrder: unavailable("purchasing", "purchase_order", { poNumber: "PO-120" }),
      demand: unavailable("demand", "demand"),
      stock: [
        { warehouse: "WH-A", read: unavailable("inventory", "stock", { warehouse: "WH-A" }) },
      ],
      inTransit: [],
      transferOptions: unavailable("inventory", "transfer_options"),
      item: unavailable("reference", "item", { sku: "PART-A" }),
      itemMappings: unavailable("reference", "item_mappings"),
      policies: {
        calendar: policy("CAL-CPH-1"),
        eligibility: policy("ELIG-1"),
        allocation: policy("ALLOC-1"),
        authorization: policy("AUTH-1"),
      },
    },
    candidateOffers: [],
  };
}

describe("assessment contracts", () => {
  it("accepts unavailable evidence without data, read time or completeness", () => {
    expect(coverageAssessmentInputSchema.safeParse(unavailableInput()).success).toBe(true);
    const withData = { ...unavailable("inventory", "stock"), data: { records: [] } };
    expect(readEvidenceSchema(transferOptionsDataSchema).safeParse(withData).success).toBe(false);
  });

  it("separates an authoritative empty collection from a missing one", () => {
    const evidence = readEvidenceSchema(transferOptionsDataSchema);
    const ok = {
      status: "ok",
      provenance: {
        scope: { ...scope("inventory", "transfer_options"), bound: 100 },
        readAt: "2026-10-21T07:00:00.000Z",
        observedAt: { state: "unknown" },
      },
      data: { records: [], complete: true },
    };
    expect(evidence.safeParse(ok).success).toBe(true);
    expect(evidence.safeParse({ ...ok, data: { records: [] } }).success).toBe(false);
    expect(evidence.safeParse({ ...ok, data: undefined }).success).toBe(false);
  });

  it("rejects unknown fields, numeric quantities and noncanonical reasons", () => {
    const extra = { ...unavailableInput(), note: "approve automatically" };
    expect(coverageAssessmentInputSchema.safeParse(extra).success).toBe(false);
    const offer = {
      offerId: "ALT-1",
      kind: "optional_substitute",
      sku: "PART-A2",
      quantity: "50",
      uom: "EA",
      arrival: { state: "dated", date: "2026-10-22" },
      evidence: {
        sourceSystem: "fixture-supplier-mail",
        messageId: "MSG-0001",
        inputVersion: 1,
        evidenceRef: "MSG-0001@1",
      },
    };
    expect(candidateOfferSchema.safeParse(offer).success).toBe(true);
    expect(candidateOfferSchema.safeParse({ ...offer, quantity: 50 }).success).toBe(false);
    expect(candidateOfferSchema.safeParse({ ...offer, quantity: "50.5" }).success).toBe(false);
    expect(candidateOfferSchema.safeParse({ ...offer, mapping: "MAP-1" }).success).toBe(false);
    const bad = unavailableInput();
    (bad.reads.demand as { reason: string }).reason = "Gone Away";
    expect(coverageAssessmentInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate warehouse reads and an input without a stock read", () => {
    const duplicate = unavailableInput();
    duplicate.reads.stock.push(duplicate.reads.stock[0]!);
    expect(coverageAssessmentInputSchema.safeParse(duplicate).success).toBe(false);
    const none = unavailableInput();
    none.reads.stock = [];
    expect(coverageAssessmentInputSchema.safeParse(none).success).toBe(false);
  });

  it("binds a read without inventing a version or observation time", () => {
    const binding = {
      kind: "transfer_options",
      key: "PART-A/EA/WH-B/WH-A",
      version: null,
      currentVersion: null,
      members: [],
      lineage: null,
      scope: { ...scope("inventory", "transfer_options"), bound: 100 },
      readAt: "2026-10-21T07:00:00.000Z",
      observedAt: { state: "unknown" },
      recordObservedAt: null,
      contentSha256: "0".repeat(64),
    };
    expect(sourceBindingSchema.safeParse(binding).success).toBe(true);
    expect(sourceBindingSchema.safeParse({ ...binding, version: undefined }).success).toBe(false);
  });

  it("describes a transfer request intent with its execution-time preconditions, not a command", () => {
    const intent = {
      actionId: "ACT-3",
      kind: "create_transfer_request",
      optionId: "TRO-1",
      sku: "PART-A",
      uom: "EA",
      from: "WH-B",
      to: "WH-A",
      quantity: "50",
      dispatchDate: "2026-10-22",
      arrivalDate: "2026-10-23",
      preconditions: {
        reservationFromAction: "ACT-2",
        baseStockVersion: "INV-B@1",
        stockVersionFromAction: "ACT-2",
        validUntil: "2026-10-22T10:00:00.000Z",
        optionTermsSha256: "0".repeat(64),
      },
      predecessors: ["ACT-2"],
    };
    expect(actionIntentSchema.safeParse(intent).success).toBe(true);
    // A source command's operation and receipt identities are not part of an intent.
    expect(actionIntentSchema.safeParse({ ...intent, operationId: "OP-ACT-3" }).success).toBe(
      false,
    );
    expect(
      actionIntentSchema.safeParse({
        ...intent,
        preconditions: { ...intent.preconditions, predecessorReceiptId: "x" },
      }).success,
    ).toBe(false);
  });
});
