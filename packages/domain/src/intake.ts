import {
  ASSESSMENT_CONTRACT_VERSION,
  INTAKE_CONTRACT_VERSION,
  canonicalJson,
  intakeDeliverySchema,
  intakeEnvelopeSchema,
  intakeInputSchema,
  intakeOutcomeSchema,
  type CoverageAssessmentInput,
  type IntakeBlockReason,
  type IntakeBlocked,
  type IntakeDecision,
  type IntakeInput,
  type IntakeOutcome,
  type IntakeReceipt,
  type IntakeVendorEvidence,
  type PurchaseOrderRevision,
  type ReadEvidence,
  type SupplierInputIdentity,
  type SupplierProposal,
} from "@supplier-disruption/contracts";
import { assessCoverage } from "./assess.js";
import { contentSha256, frozenCopy } from "./digest.js";

/** The structurally invalid trusted envelope; nothing was decided. */
export class IntakeInputError extends TypeError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid supplier intake input: ${issues.join("; ")}`);
    this.name = "IntakeInputError";
    this.issues = issues;
  }
}

/** A failing guard: its reason, the input it concerns and why. */
interface Failure {
  reason: IntakeBlockReason;
  subject: string;
  diagnostics: string[];
}

type Examined = IntakeBlocked["examined"];

type Ok<E> = Extract<E, { status: "ok" }>;
type SupplierInputEvidence = IntakeInput["reads"]["supplierInput"];
type PurchaseOrderEvidence = IntakeInput["reads"]["purchaseOrder"];

const failed = (value: object): value is Failure => "reason" in value;

interface Evaluation {
  decision: IntakeDecision;
  /** Present only for an accepted input. */
  assessmentInput: CoverageAssessmentInput | null;
}

const fail = (reason: IntakeBlockReason, subject: string, ...diagnostics: string[]): Failure => ({
  reason,
  subject,
  diagnostics,
});

/**
 * Diagnostic bounds. Supplier-controlled text, such as an unknown key name,
 * can reach a diagnostic, so every one is cut to a fixed length and their
 * number is capped: a hostile delivery still yields the owned block.
 */
const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 300;
const MAX_KEY_NAMES = 5;
const MAX_KEY_LENGTH = 40;

function clip(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 3)}...`;
}

function bounded(diagnostics: readonly string[]): string[] {
  const kept = diagnostics
    .slice(0, MAX_DIAGNOSTICS)
    .map((text) => clip(text, MAX_DIAGNOSTIC_LENGTH));
  const omitted = diagnostics.length - kept.length;
  return omitted > 0 ? [...kept, `and ${String(omitted)} more`] : kept;
}

function issuesOf(error: {
  issues: ReadonlyArray<{ code: string; path: PropertyKey[]; message: string; keys?: string[] }>;
}): string[] {
  return error.issues.map((issue) => {
    const path = clip(issue.path.map(String).join("."), MAX_KEY_LENGTH * 2);
    if (issue.code === "unrecognized_keys" && issue.keys !== undefined) {
      const names = issue.keys
        .slice(0, MAX_KEY_NAMES)
        .map((key) => JSON.stringify(clip(key, MAX_KEY_LENGTH)));
      const more = issue.keys.length > MAX_KEY_NAMES ? ", ..." : "";
      return `${path}: ${String(issue.keys.length)} unrecognized key(s): ${names.join(", ")}${more}`;
    }
    return `${path}: ${issue.message}`;
  });
}

/**
 * Evaluates intake and assesses only an accepted input. Pure: it reads only
 * its argument and returns a new deeply frozen outcome. A duplicate or
 * blocked input returns without calling the assessment, and nothing here
 * creates a proposal, plan, approval, action or source write. A malformed
 * trusted envelope throws IntakeInputError; every supplier or context fault
 * is an owned block.
 */
export function intakeAndAssess(raw: unknown): IntakeOutcome {
  const { decision, assessmentInput } = evaluateIntake(raw);
  const assessment = assessmentInput === null ? null : assessCoverage(assessmentInput);
  return frozenCopy(intakeOutcomeSchema.parse({ intake: decision, assessment }));
}

function evaluateIntake(raw: unknown): Evaluation {
  const envelope = intakeEnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw new IntakeInputError(issuesOf(envelope.error));
  const base = {
    contractVersion: INTAKE_CONTRACT_VERSION,
    organization: envelope.data.organization,
    decidedAt: envelope.data.assessedAt,
  } as const;
  const examined: Examined = {};
  const blocked = (failure: Failure, identity: SupplierInputIdentity | null): Evaluation => ({
    decision: {
      disposition: "blocked",
      ...base,
      decision: {
        recommendedState: "needs_clarification",
        reason: failure.reason,
        owner: "buyer",
      },
      subject: failure.subject,
      diagnostics: bounded(failure.diagnostics),
      identity,
      examined: { ...examined },
    },
    assessmentInput: null,
  });

  // 1. The delivered identity and proposal, the trusted context, their
  // cross-binding, the recomputed terms digest and the stored input.
  const delivery = intakeDeliverySchema.safeParse(envelope.data.delivery);
  if (!delivery.success) {
    return blocked(
      {
        reason: "intake_invalid_input",
        subject: "delivery",
        diagnostics: issuesOf(delivery.error),
      },
      null,
    );
  }
  const { identity, proposal } = delivery.data;
  const parsed = intakeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return blocked(
      { reason: "intake_invalid_input", subject: "context", diagnostics: issuesOf(parsed.error) },
      identity,
    );
  }
  const input = parsed.data;
  const organization = input.organization;

  const binding = crossBinding(identity, proposal);
  if (binding !== null) return blocked(binding, identity);

  const digest = contentSha256(proposal.terms);
  if (digest !== identity.contentSha256) {
    return blocked(
      fail(
        "intake_content_hash_mismatch",
        "delivery.identity.contentSha256",
        `the terms digest is ${digest}, not the stated ${identity.contentSha256}`,
      ),
      identity,
    );
  }

  examined.supplierInput = input.reads.supplierInput;
  const supplierInput = storedInput(input, identity, proposal);
  if (failed(supplierInput)) return blocked(supplierInput, identity);

  // 2. The exact registered sender, in the trusted organization.
  examined.registeredVendor = input.reads.registeredVendor;
  const registered = registeredVendor(input.reads.registeredVendor, organization, identity.sender);
  if (failed(registered)) return blocked(registered, identity);
  const vendorId = registered.data.vendorId;

  // 3. The trusted prior acceptance for this message key, before any PO check.
  examined.priorAcceptance = input.priorAcceptance;
  const prior = priorAcceptance(input, identity, proposal, vendorId, digest);
  if (prior !== null && failed(prior)) return blocked(prior, identity);
  if (prior !== null) {
    return {
      decision: { disposition: "duplicate", ...base, identity, priorReceipt: prior },
      assessmentInput: null,
    };
  }

  // 4 to 6. A new input: the vendor record, the current PO, its exact line and revision.
  if (input.reads.vendor !== null) examined.vendor = input.reads.vendor;
  const vendor = vendorRecord(input.reads.vendor, organization, vendorId, identity.sender);
  if (failed(vendor)) return blocked(vendor, identity);

  examined.purchaseOrder = input.reads.purchaseOrder;
  const purchaseOrder = currentPurchaseOrder(input.reads.purchaseOrder, organization, proposal);
  if (failed(purchaseOrder)) return blocked(purchaseOrder, identity);
  const association = associate(purchaseOrder.data.record, vendorId, proposal);
  if (association !== null) return blocked(association, identity);

  // 7. Accepted: eligible for assessment with exactly the reads intake checked.
  const terms = proposal.terms;
  const receipt: IntakeReceipt = {
    contractVersion: INTAKE_CONTRACT_VERSION,
    receiptId: input.receiptId,
    organization,
    sourceSystem: identity.sourceSystem,
    messageId: identity.messageId,
    inputVersion: identity.inputVersion,
    sender: identity.sender,
    vendorId,
    contentSha256: digest,
    proposalId: identity.proposalId,
    evidenceRef: identity.evidenceRef,
    poNumber: terms.poNumber,
    poLine: terms.poLine,
    baseRevision: terms.baseRevision,
    acceptedAt: input.assessedAt,
    caseId: input.caseId,
  };
  return {
    decision: {
      disposition: "accept",
      ...base,
      identity,
      proposal,
      vendorId,
      association: {
        poNumber: terms.poNumber,
        poLine: terms.poLine,
        baseRevision: terms.baseRevision,
        currentRevision: purchaseOrder.data.record.revision,
      },
      contentSha256: digest,
      provenance: {
        supplierInput: supplierInput.provenance,
        registeredVendor: registered.provenance,
        vendor: vendor.provenance,
        purchaseOrder: purchaseOrder.provenance,
      },
      proposedReceipt: receipt,
    },
    assessmentInput: {
      contractVersion: ASSESSMENT_CONTRACT_VERSION,
      organization,
      assessedAt: input.assessedAt,
      planId: input.planId,
      planVersion: input.planVersion,
      vendorId,
      poLine: { poNumber: terms.poNumber, poLine: terms.poLine },
      proposalId: identity.proposalId,
      reads: { ...input.reads.assessment, supplierInput, purchaseOrder },
      candidateOffers: input.candidateOffers,
    },
  };
}

/** The proposal must name the identity's proposal and evidence tuple. */
function crossBinding(identity: SupplierInputIdentity, proposal: SupplierProposal): Failure | null {
  const conflicts: string[] = [];
  if (proposal.proposalId !== identity.proposalId) {
    conflicts.push(`proposal ${proposal.proposalId} is not the identity's ${identity.proposalId}`);
  }
  for (const field of ["sourceSystem", "messageId", "inputVersion"] as const) {
    if (proposal.evidence[field] !== identity[field]) {
      conflicts.push(
        `proposal evidence ${field} ${String(proposal.evidence[field])} is not the identity's ${String(identity[field])}`,
      );
    }
  }
  return conflicts.length === 0
    ? null
    : { reason: "intake_invalid_input", subject: "delivery.proposal", diagnostics: conflicts };
}

interface ExpectedScope {
  owner: string;
  resource: string;
  selectors: Record<string, string | number>;
}

/** Why a read's stated scope is not the one intake requires, or null. */
function scopeMismatch(
  scope: {
    owner: string;
    resource: string;
    organization: string;
    selectors: Record<string, unknown>;
    binding?: { label: string } | undefined;
  },
  organization: string,
  expected: ExpectedScope,
): string | null {
  if (scope.owner !== expected.owner || scope.resource !== expected.resource) {
    return `expected a ${expected.owner} ${expected.resource} read, got ${scope.owner} ${scope.resource}`;
  }
  if (scope.organization !== organization) {
    return `read for ${scope.organization}, not ${organization}`;
  }
  if (scope.binding !== undefined && scope.binding.label !== organization) {
    return `binding ${scope.binding.label} is not ${organization}`;
  }
  const stated = canonicalJson(scope.selectors);
  const required = canonicalJson(expected.selectors);
  return stated === required ? null : `selectors ${stated} are not ${required}`;
}

type AnyEvidence = ReadEvidence<unknown> | IntakeVendorEvidence;

function scopeOf(evidence: AnyEvidence) {
  return evidence.status === "ok" ? evidence.provenance.scope : evidence.scope;
}

function vendorScope(evidence: IntakeVendorEvidence) {
  return evidence.status === "ok" ? evidence.provenance.scope : evidence.scope;
}

/** A read that returned no usable record. Absence and failure never become acceptance. */
function unreadable(subject: string, evidence: Exclude<AnyEvidence, { status: "ok" }>): Failure {
  const detail = `${subject} ${evidence.status}: ${evidence.reason}`;
  return evidence.status === "unavailable" && evidence.reason === "scope_mismatch"
    ? fail("intake_scope_mismatch", subject, detail)
    : fail("intake_source_unavailable", subject, detail);
}

function storedInput(
  input: IntakeInput,
  identity: SupplierInputIdentity,
  proposal: SupplierProposal,
): Ok<SupplierInputEvidence> | Failure {
  const subject = "reads.supplierInput";
  const evidence = input.reads.supplierInput;
  const mismatch = scopeMismatch(scopeOf(evidence), input.organization, {
    owner: "reference",
    resource: "supplier_input",
    selectors: {
      sourceSystem: identity.sourceSystem,
      messageId: identity.messageId,
      inputVersion: identity.inputVersion,
    },
  });
  if (mismatch !== null) return fail("intake_scope_mismatch", subject, mismatch);
  if (evidence.status !== "ok") return unreadable(subject, evidence);
  if (evidence.provenance.scope.binding?.state !== "validated") {
    return fail("intake_scope_mismatch", subject, "the fixture binding was not validated");
  }
  const conflicts: string[] = [];
  if (canonicalJson(evidence.data.identity) !== canonicalJson(identity)) {
    conflicts.push("the stored identity differs from the delivered identity");
  }
  if (canonicalJson(evidence.data.terms) !== canonicalJson(proposal.terms)) {
    conflicts.push("the stored terms differ from the delivered terms");
  }
  return conflicts.length === 0
    ? evidence
    : { reason: "intake_identity_conflict", subject, diagnostics: conflicts };
}

/** The vendor registered for the exact sender string; no normalization or similarity. */
function registeredVendor(
  evidence: IntakeVendorEvidence,
  organization: string,
  sender: string,
): Ok<IntakeVendorEvidence> | Failure {
  const subject = "reads.registeredVendor";
  const scope = vendorScope(evidence);
  const mismatch = scopeMismatch(scope, organization, {
    owner: "reference",
    resource: "registered_vendor",
    selectors: { sender },
  });
  if (mismatch !== null) return fail("intake_scope_mismatch", subject, mismatch);
  switch (evidence.status) {
    case "ok":
      if (scope.binding.state !== "validated") {
        return fail("intake_scope_mismatch", subject, "the fixture binding was not validated");
      }
      if (!evidence.data.registeredSenders.includes(sender)) {
        return fail(
          "intake_scope_mismatch",
          subject,
          `vendor ${evidence.data.vendorId} does not register ${sender}`,
        );
      }
      return evidence;
    case "not_found":
      if (scope.binding.state !== "validated") return unreadable(subject, evidence);
      return fail("unverified_sender", subject, `${sender} is not a registered sender`);
    case "ambiguous":
      if (evidence.reason === "registered_sender_ambiguous") {
        return fail(
          "intake_ambiguous_sender",
          subject,
          `${sender} is registered to more than one vendor`,
        );
      }
      return unreadable(subject, evidence);
    case "unavailable":
      return unreadable(subject, evidence);
  }
}

/** The immutable bindings an exact replay must repeat. */
const REPLAY_FIELDS = [
  "inputVersion",
  "sender",
  "vendorId",
  "contentSha256",
  "proposalId",
  "evidenceRef",
  "poNumber",
  "poLine",
  "baseRevision",
] as const;

/**
 * The prior receipt of an exact replay, null for a new input, or the guard
 * failure. A familiar message ID or digest alone is never a replay.
 */
function priorAcceptance(
  input: IntakeInput,
  identity: SupplierInputIdentity,
  proposal: SupplierProposal,
  vendorId: string,
  digest: string,
): IntakeReceipt | Failure | null {
  const subject = "priorAcceptance";
  const lookup = input.priorAcceptance;
  const key = {
    organization: input.organization,
    sourceSystem: identity.sourceSystem,
    messageId: identity.messageId,
  };
  const query = canonicalJson(lookup.query);
  const required = canonicalJson({ ...key, contentSha256: digest });
  if (query !== required) {
    return fail("intake_scope_mismatch", subject, `lookup ${query} is not ${required}`);
  }
  if (lookup.status === "none") return null;
  if (lookup.status === "unavailable") {
    return fail("intake_source_unavailable", subject, `prior acceptance lookup: ${lookup.reason}`);
  }
  const receipt = lookup.receipt;
  const sameKey =
    receipt.organization === key.organization &&
    receipt.sourceSystem === key.sourceSystem &&
    receipt.messageId === key.messageId;
  const message = `${receipt.sourceSystem}/${receipt.messageId}@${String(receipt.inputVersion)}`;

  if (lookup.status === "candidate") {
    if (sameKey || receipt.organization !== key.organization || receipt.contentSha256 !== digest) {
      return fail(
        "intake_scope_mismatch",
        subject,
        `candidate ${message} is not a different message with these terms`,
      );
    }
    return fail(
      "intake_possible_duplicate",
      subject,
      `accepted message ${message} (receipt ${receipt.receiptId}) has the same terms digest`,
    );
  }

  if (!sameKey) {
    return fail("intake_scope_mismatch", subject, `receipt ${message} is for another message`);
  }
  const current = {
    inputVersion: identity.inputVersion,
    sender: identity.sender,
    vendorId,
    contentSha256: digest,
    proposalId: identity.proposalId,
    evidenceRef: identity.evidenceRef,
    poNumber: proposal.terms.poNumber,
    poLine: proposal.terms.poLine,
    baseRevision: proposal.terms.baseRevision,
  };
  const conflicts = REPLAY_FIELDS.filter((field) => receipt[field] !== current[field]).map(
    (field) =>
      `accepted ${field} ${String(receipt[field])} differs from ${String(current[field])} under the same message`,
  );
  return conflicts.length === 0
    ? receipt
    : { reason: "intake_identity_conflict", subject, diagnostics: conflicts };
}

/** The resolved vendor's own record, which must still register the sender. */
function vendorRecord(
  evidence: IntakeVendorEvidence | null,
  organization: string,
  vendorId: string,
  sender: string,
): Ok<IntakeVendorEvidence> | Failure {
  const subject = "reads.vendor";
  if (evidence === null) {
    return fail("intake_source_unavailable", subject, `vendor ${vendorId} was not read`);
  }
  const scope = vendorScope(evidence);
  const mismatch = scopeMismatch(scope, organization, {
    owner: "reference",
    resource: "vendor",
    selectors: { vendorId },
  });
  if (mismatch !== null) return fail("intake_scope_mismatch", subject, mismatch);
  if (evidence.status !== "ok") return unreadable(subject, evidence);
  if (scope.binding.state !== "validated") {
    return fail("intake_scope_mismatch", subject, "the fixture binding was not validated");
  }
  if (evidence.data.vendorId !== vendorId) {
    return fail(
      "intake_scope_mismatch",
      subject,
      `vendor record ${evidence.data.vendorId} is not ${vendorId}`,
    );
  }
  if (!evidence.data.registeredSenders.includes(sender)) {
    return fail("intake_scope_mismatch", subject, `vendor ${vendorId} does not register ${sender}`);
  }
  return evidence;
}

/** The structured PO, read at its current head. A retained revision is never current. */
function currentPurchaseOrder(
  evidence: PurchaseOrderEvidence,
  organization: string,
  proposal: SupplierProposal,
): Ok<PurchaseOrderEvidence> | Failure {
  const subject = "reads.purchaseOrder";
  const poNumber = proposal.terms.poNumber;
  const mismatch = scopeMismatch(scopeOf(evidence), organization, {
    owner: "purchasing",
    resource: "purchase_order",
    selectors: { poNumber },
  });
  if (mismatch !== null) return fail("intake_scope_mismatch", subject, mismatch);
  switch (evidence.status) {
    case "ok":
      break;
    case "not_found":
      return fail(
        "intake_unknown_po",
        subject,
        `${organization} has no purchase order ${poNumber}`,
      );
    default:
      return unreadable(subject, evidence);
  }
  const { record, currentRevision } = evidence.data;
  if (record.organization !== organization || record.poNumber !== poNumber) {
    return fail(
      "intake_scope_mismatch",
      subject,
      `the record is ${record.organization} ${record.poNumber}, not ${organization} ${poNumber}`,
    );
  }
  if (record.revision !== currentRevision) {
    return fail(
      "intake_source_unavailable",
      subject,
      `retained revision ${record.revision} is not the current head ${currentRevision}; a current read is required`,
    );
  }
  return evidence;
}

/**
 * The exact vendor, line and base revision. The first failure is the reason;
 * every failure found is a diagnostic. Item text never selects a line, and
 * a message's times never order revisions.
 */
function associate(
  record: PurchaseOrderRevision,
  vendorId: string,
  proposal: SupplierProposal,
): Failure | null {
  const subject = "reads.purchaseOrder";
  const { poLine, baseRevision } = proposal.terms;
  const failures: Array<{ reason: IntakeBlockReason; detail: string }> = [];
  if (record.vendorId !== vendorId) {
    failures.push({
      reason: "vendor_mismatch",
      detail: `${record.poNumber} belongs to ${record.vendorId}, the sender to ${vendorId}`,
    });
  }
  const lines = record.lines.filter((line) => line.lineNumber === poLine);
  if (lines.length === 0) {
    failures.push({
      reason: "unknown_po_line",
      detail: `${record.poNumber}@${record.revision} has no line ${poLine}`,
    });
  } else if (lines.length > 1) {
    failures.push({
      reason: "intake_ambiguous_po_line",
      detail: `${record.poNumber}@${record.revision} has ${String(lines.length)} records for line ${poLine}`,
    });
  }
  const base = Number(baseRevision);
  const current = Number(record.revision);
  if (base < current) {
    failures.push({
      reason: "stale_base_revision",
      detail: `the proposal is based on revision ${baseRevision}, ${record.poNumber} is at ${record.revision}`,
    });
  } else if (base > current) {
    failures.push({
      reason: "intake_base_revision_ahead",
      detail: `the proposal names revision ${baseRevision}, ahead of current ${record.revision}`,
    });
  }
  const [first] = failures;
  return first === undefined
    ? null
    : { reason: first.reason, subject, diagnostics: failures.map((failure) => failure.detail) };
}
