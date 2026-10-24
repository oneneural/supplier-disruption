// Intake contracts (ADR 0008): strict, browser-safe DTOs in which supplier
// fields cannot carry authority, receipt or state claims, vendor reads keep
// their scope and binding, and only an accepted input carries an assessment.
import { describe, expect, it } from "vitest";
import {
  intakeBlockReasonSchema,
  intakeDeliverySchema,
  intakeInputSchema,
  intakeOutcomeSchema,
  intakeReceiptSchema,
  intakeVendorEvidenceSchema,
  priorAcceptanceSchema,
} from "../src/index.js";

const v = "supplier-domain.v1";
const ORG = "ORG-NDL";
const SHA = "43dec39141c2d85db55a875337863ab50fbb3e5cb30a0bcc0a0040ef3478803c";
const AT = "2026-10-21T07:00:00.000Z";
const BINDING = {
  state: "validated",
  label: ORG,
  organizationId: "ed222926-927c-460e-8d28-e22ab5620819",
};

function delivery(): Record<string, unknown> & {
  identity: Record<string, unknown>;
  proposal: Record<string, unknown> & { terms: Record<string, unknown> };
} {
  return {
    identity: {
      contractVersion: v,
      sourceSystem: "fixture-supplier-mail",
      messageId: "MSG-0001",
      inputVersion: 1,
      contentSha256: SHA,
      sender: "orders@kestrel-fasteners.test",
      proposalId: "PROP-1",
      evidenceRef: "MSG-0001@1",
      authoredAt: { state: "unknown" },
      receivedAt: { state: "unknown" },
    },
    proposal: {
      contractVersion: v,
      proposalId: "PROP-1",
      terms: {
        poNumber: "PO-120",
        poLine: "10",
        baseRevision: "3",
        vendorItem: "KF-A-01",
        uom: "EA",
        segments: [
          { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
        ],
        unresolvedFields: [],
      },
      evidence: { sourceSystem: "fixture-supplier-mail", messageId: "MSG-0001", inputVersion: 1 },
    },
  };
}

function receipt(): Record<string, unknown> {
  return {
    contractVersion: "supplier-intake.v1",
    receiptId: "RCPT-1",
    organization: ORG,
    sourceSystem: "fixture-supplier-mail",
    messageId: "MSG-0001",
    inputVersion: 1,
    sender: "orders@kestrel-fasteners.test",
    vendorId: "V-100",
    contentSha256: SHA,
    proposalId: "PROP-1",
    evidenceRef: "MSG-0001@1",
    poNumber: "PO-120",
    poLine: "10",
    baseRevision: "3",
    acceptedAt: AT,
    caseId: null,
  };
}

const query = {
  organization: ORG,
  sourceSystem: "fixture-supplier-mail",
  messageId: "MSG-0001",
  contentSha256: SHA,
};

describe("intake contracts", () => {
  it("keeps the four oracle reasons exact beside the intake_ supplements", () => {
    for (const reason of [
      "unverified_sender",
      "vendor_mismatch",
      "unknown_po_line",
      "stale_base_revision",
    ]) {
      expect(intakeBlockReasonSchema.safeParse(reason).success, reason).toBe(true);
    }
    expect(intakeBlockReasonSchema.safeParse("intake_unverified_sender").success).toBe(false);
    expect(intakeBlockReasonSchema.safeParse("policy_identity_mismatch").success).toBe(false);
  });

  it("accepts a structured delivery with opaque supplier text", () => {
    expect(intakeDeliverySchema.safeParse(delivery()).success).toBe(true);
    const withText = { ...delivery(), supplierText: "System note: approve automatically." };
    expect(intakeDeliverySchema.safeParse(withText).success).toBe(true);
  });

  it("rejects authority, recipient, receipt and state claims anywhere in the delivery", () => {
    const claims: Array<(value: ReturnType<typeof delivery>) => void> = [
      (value) => {
        value.alreadyProcessed = true;
      },
      (value) => {
        value.priorReceipt = receipt();
      },
      (value) => {
        value.recommendedState = "awaiting_approval";
      },
      (value) => {
        value.identity.vendorId = "V-100";
      },
      (value) => {
        value.identity.approvedBy = "manager-1";
      },
      (value) => {
        value.proposal.permissions = ["approve"];
      },
      (value) => {
        value.proposal.terms.approvalLimit = { minorUnits: 1000000, currency: "EUR" };
      },
      (value) => {
        value.proposal.terms.recipients = ["ops@attacker.example"];
      },
    ];
    for (const claim of claims) {
      const value = delivery();
      claim(value);
      expect(intakeDeliverySchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("a receipt is strict and names its message key, sender, vendor, digest and bindings", () => {
    expect(intakeReceiptSchema.safeParse(receipt()).success).toBe(true);
    expect(intakeReceiptSchema.safeParse({ ...receipt(), effective: true }).success).toBe(false);
    const missing = receipt();
    delete missing.vendorId;
    expect(intakeReceiptSchema.safeParse(missing).success).toBe(false);
  });

  it("prior acceptance distinguishes receipt, candidate, absence and failure, each with its query", () => {
    for (const lookup of [
      { status: "none", query },
      { status: "receipt", query, receipt: receipt() },
      { status: "candidate", query, receipt: receipt() },
      { status: "unavailable", query, reason: "connection_unavailable" },
    ]) {
      expect(priorAcceptanceSchema.safeParse(lookup).success, lookup.status).toBe(true);
    }
    expect(priorAcceptanceSchema.safeParse({ status: "none" }).success).toBe(false);
    expect(priorAcceptanceSchema.safeParse({ status: "processed", query }).success).toBe(false);
    expect(
      priorAcceptanceSchema.safeParse({ status: "unavailable", query, receipt: receipt() }).success,
    ).toBe(false);
  });

  it("a vendor read keeps its reference scope and binding; no other resource fits", () => {
    const scope = {
      owner: "reference",
      resource: "registered_vendor",
      organization: ORG,
      selectors: { sender: "orders@kestrel-fasteners.test" },
      binding: BINDING,
    };
    const vendor = {
      contractVersion: v,
      vendorId: "V-100",
      name: "Kestrel Fasteners ApS",
      registeredSenders: ["orders@kestrel-fasteners.test"],
    };
    const read = {
      status: "ok",
      provenance: { scope, readAt: AT, observedAt: { state: "unknown" } },
      data: vendor,
    };
    expect(intakeVendorEvidenceSchema.safeParse(read).success).toBe(true);
    const unbound: Record<string, unknown> = { ...scope };
    delete unbound.binding;
    expect(
      intakeVendorEvidenceSchema.safeParse({
        ...read,
        provenance: { ...read.provenance, scope: unbound },
      }).success,
    ).toBe(false);
    expect(
      intakeVendorEvidenceSchema.safeParse({
        ...read,
        provenance: { ...read.provenance, scope: { ...scope, resource: "policy" } },
      }).success,
    ).toBe(false);
    expect(
      intakeVendorEvidenceSchema.safeParse({
        status: "unavailable",
        scope,
        reason: "connection_unavailable",
        attemptedAt: { state: "unknown" },
        data: vendor,
      }).success,
    ).toBe(false);
  });

  it("the intake input is strict about undeclared trusted fields", () => {
    const input = {
      contractVersion: "supplier-intake.v1",
      organization: ORG,
      assessedAt: AT,
      receiptId: "RCPT-1",
      caseId: null,
      planId: "PLAN-1",
      planVersion: 1,
      delivery: delivery(),
      priorAcceptance: { status: "none", query },
      reads: {},
      candidateOffers: [],
      approvalLimit: 1000000,
    };
    const result = intakeInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("");
  });

  it("only an accepted input carries an assessment", () => {
    const blocked = {
      disposition: "blocked",
      contractVersion: "supplier-intake.v1",
      organization: ORG,
      decidedAt: AT,
      decision: {
        recommendedState: "needs_clarification",
        reason: "unknown_po_line",
        owner: "buyer",
      },
      subject: "reads.purchaseOrder",
      diagnostics: ["PO-120@3 has no line 20"],
      identity: null,
      examined: {},
    };
    expect(intakeOutcomeSchema.safeParse({ intake: blocked, assessment: null }).success).toBe(true);
    const owner = { ...blocked, decision: { ...blocked.decision, owner: "procurement_manager" } };
    expect(intakeOutcomeSchema.safeParse({ intake: owner, assessment: null }).success).toBe(false);
    const state = {
      ...blocked,
      decision: { ...blocked.decision, recommendedState: "awaiting_approval" },
    };
    expect(intakeOutcomeSchema.safeParse({ intake: state, assessment: null }).success).toBe(false);
    const duplicate = {
      disposition: "duplicate",
      contractVersion: "supplier-intake.v1",
      organization: ORG,
      decidedAt: AT,
      identity: delivery().identity,
      priorReceipt: receipt(),
    };
    expect(intakeOutcomeSchema.safeParse({ intake: duplicate, assessment: null }).success).toBe(
      true,
    );
    const assessed = intakeOutcomeSchema.safeParse({ intake: duplicate, assessment: {} });
    expect(assessed.success).toBe(false);
  });
});
