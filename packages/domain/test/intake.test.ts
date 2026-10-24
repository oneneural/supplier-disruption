// I1 to I5 intake identity and source guards (ADR 0008). Expected
// reasons, owners, states, digests and quantities are literals from the
// frozen oracle (N-01 to N-04, C-01), never computed by the code under test.
// Every case runs the production composition; a narrow spy on the assessment
// module observes whether the real coverage assessment was called.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assessCoverage } from "../src/assess.js";
import { IntakeInputError, contentSha256, intakeAndAssess } from "../src/index.js";
import * as L from "./intake-literals.js";

vi.mock(import("../src/assess.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, assessCoverage: vi.fn(actual.assessCoverage) };
});

const assessments = vi.mocked(assessCoverage);
beforeEach(() => {
  assessments.mockClear();
});

const known = (value: string) => ({ state: "known", value });
const clarification = (reason: string) => ({
  recommendedState: "needs_clarification",
  reason,
  owner: "buyer",
});

type Outcome = ReturnType<typeof intakeAndAssess>;

/** The block decision, failing the test if the input was not blocked. */
function blockOf(outcome: Outcome) {
  expect(outcome.intake.disposition).toBe("blocked");
  if (outcome.intake.disposition !== "blocked") throw new Error("not blocked");
  return outcome.intake;
}

/** A blocked outcome with no assessment, plan, receipt or action intent anywhere. */
function expectBlocked(outcome: Outcome, reason: string) {
  const block = blockOf(outcome);
  expect(block.decision).toEqual(clarification(reason));
  expect(outcome.assessment).toBeNull();
  expect(assessments).not.toHaveBeenCalled();
  expect(
    keysOf(outcome).filter((key) => /^(plan|actions|proposedReceipt|approval)/.test(key)),
  ).toEqual([]);
  return block;
}

/** Every property name anywhere in a JSON value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]);
}

function receiptOf(outcome: Outcome) {
  if (outcome.intake.disposition !== "accept") throw new Error("not accepted");
  return outcome.intake.proposedReceipt;
}

/** The trusted prior-acceptance state after MSG-0001 was accepted. */
function priorReceipt(receipt: unknown, status: "receipt" | "candidate" = "receipt") {
  return { status, query: L.none(L.MSG_0001_SHA256).query, receipt: structuredClone(receipt) };
}

describe("I1 input and hash binding", () => {
  it("hashes the literal canonical terms bytes to the literal digest", () => {
    expect(createHash("sha256").update(L.MSG_0001_TERMS_BYTES, "utf8").digest("hex")).toBe(
      L.MSG_0001_SHA256,
    );
    expect(contentSha256(L.msg0001Terms())).toBe(L.MSG_0001_SHA256);
    expect(contentSha256(JSON.parse(L.MSG_0001_TERMS_BYTES))).toBe(L.MSG_0001_SHA256);
  });

  it("accepts the canonical input and binds the recomputed digest", () => {
    const outcome = intakeAndAssess(L.canonicalIntake());
    expect(outcome.intake.disposition).toBe("accept");
    if (outcome.intake.disposition !== "accept") return;
    expect(outcome.intake.contentSha256).toBe(L.MSG_0001_SHA256);
    expect(outcome.intake.proposedReceipt.contentSha256).toBe(L.MSG_0001_SHA256);
  });

  it("key-order variation of the terms and identity preserves the digest", () => {
    const input = L.canonicalIntake();
    const reverse = (value: object) => Object.fromEntries(Object.entries(value).reverse());
    const terms = reverse({
      ...input.delivery.proposal.terms,
      segments: input.delivery.proposal.terms.segments.map((item) => reverse(item)),
    });
    input.delivery.proposal.terms = terms as L.Terms;
    input.delivery.identity = reverse(input.delivery.identity) as L.Identity;
    const outcome = intakeAndAssess(input);
    expect(outcome.intake.disposition).toBe("accept");
    if (outcome.intake.disposition === "accept") {
      expect(outcome.intake.contentSha256).toBe(L.MSG_0001_SHA256);
    }
  });

  it("a term change under the old stated digest blocks before assessment", () => {
    // The stored record carries the same changed terms and stale digest.
    const input = L.revise(L.canonicalIntake(), {
      terms: {
        segments: [
          L.msg0001Terms().segments[0]!,
          { ...L.msg0001Terms().segments[1]!, quantity: "81" },
        ],
      },
      keepHash: true,
    });
    expect(input.delivery.identity.contentSha256).toBe(L.MSG_0001_SHA256);
    const block = expectBlocked(intakeAndAssess(input), "intake_content_hash_mismatch");
    expect(block.subject).toBe("delivery.identity.contentSha256");
  });

  it("a message ID change alone leaves the terms digest unchanged", () => {
    const input = L.revise(L.canonicalIntake(), {
      identity: { messageId: "MSG-0009", evidenceRef: "MSG-0009@1" },
    });
    expect(input.delivery.identity.contentSha256).toBe(L.MSG_0001_SHA256);
    const outcome = intakeAndAssess(input);
    expect(outcome.intake.disposition).toBe("accept");
    if (outcome.intake.disposition !== "accept") return;
    expect(outcome.intake.contentSha256).toBe(L.MSG_0001_SHA256);
    expect(outcome.intake.proposedReceipt.messageId).toBe("MSG-0009");
  });

  it("a mismatched proposal ID blocks as invalid input", () => {
    const input = L.canonicalIntake();
    input.delivery.proposal.proposalId = "PROP-2";
    const block = expectBlocked(intakeAndAssess(input), "intake_invalid_input");
    expect(block.subject).toBe("delivery.proposal");
  });

  it("a mismatched evidence message or input version blocks as invalid input", () => {
    for (const evidence of [
      { messageId: "MSG-0002" },
      { inputVersion: 2 },
      { sourceSystem: "other-mail" },
    ]) {
      const input = L.canonicalIntake();
      Object.assign(input.delivery.proposal.evidence, evidence);
      const block = expectBlocked(intakeAndAssess(input), "intake_invalid_input");
      expect(block.subject, JSON.stringify(evidence)).toBe("delivery.proposal");
    }
  });

  it("extra authority fields and forged prior-receipt fields in the supplier envelope block", () => {
    const forgeries: Array<(input: L.Intake) => void> = [
      (input) => {
        (input.delivery.proposal.terms as Record<string, unknown>).approvalLimit = {
          minorUnits: 1000000,
          currency: "EUR",
        };
      },
      (input) => {
        (input.delivery.identity as Record<string, unknown>).role = "procurement_manager";
      },
      (input) => {
        input.delivery.proposal.recipients = ["ops@attacker.example"];
      },
      (input) => {
        input.delivery.alreadyProcessed = true;
      },
      (input) => {
        input.delivery.priorReceipt = { receiptId: "RCPT-0", status: "accepted" };
      },
      (input) => {
        input.delivery.state = "awaiting_approval";
      },
    ];
    for (const forge of forgeries) {
      const input = L.canonicalIntake();
      forge(input);
      const block = expectBlocked(intakeAndAssess(input), "intake_invalid_input");
      expect(block.subject).toBe("delivery");
      expect(block.identity).toBeNull();
    }
  });

  it("a malformed trusted context blocks; a malformed trusted envelope throws", () => {
    const input = L.canonicalIntake();
    input.priorAcceptance = { status: "processed", query: input.priorAcceptance.query };
    expect(expectBlocked(intakeAndAssess(input), "intake_invalid_input").subject).toBe("context");

    const envelope = L.canonicalIntake() as Record<string, unknown>;
    envelope.organization = "not a label";
    expect(() => intakeAndAssess(envelope)).toThrow(IntakeInputError);
    expect(assessments).not.toHaveBeenCalled();
  });

  it("a stored input that differs from the delivery blocks as an identity conflict", () => {
    const input = L.canonicalIntake();
    const stored = L.supplierInputRead(
      { ...L.msg0001Identity(), evidenceRef: "MSG-0001@9" },
      L.msg0001Terms(),
    );
    input.reads.supplierInput = stored;
    expectBlocked(intakeAndAssess(input), "intake_identity_conflict");
  });

  it("an absent stored input is unavailable context, never acceptance or an unknown sender", () => {
    const input = L.canonicalIntake();
    const scope = (input.reads.supplierInput.provenance as { scope: unknown }).scope;
    input.reads.supplierInput = {
      status: "not_found",
      scope,
      readAt: known(L.ASSESSED_AT),
      reason: "record_not_found",
    };
    const block = expectBlocked(intakeAndAssess(input), "intake_source_unavailable");
    expect(block.diagnostics).toEqual(["reads.supplierInput not_found: record_not_found"]);
  });
});

describe("I2 N-01 sequential decision and effect suppression", () => {
  it("accepts MSG-0001 once, assesses it with the real policy, and suppresses the replay", () => {
    const first = intakeAndAssess(L.canonicalIntake());
    expect(first.intake.disposition).toBe("accept");
    expect(assessments).toHaveBeenCalledTimes(1);
    const assessment = first.assessment;
    if (assessment === null) throw new Error("accepted input must be assessed");
    expect(assessment.totals).toMatchObject({
      preTransferCoverage: known("70"),
      preTransferShortage: known("50"),
      conditionalTransfer: known("50"),
    });
    expect(assessment.decision).toEqual({
      recommendedState: "awaiting_approval",
      reason: "policy_plan_ready_for_approval",
      owner: "procurement_manager",
    });
    expect(assessment.proposalId).toBe("PROP-1");
    const receipt = receiptOf(first);
    expect(receipt).toEqual({
      contractVersion: "supplier-intake.v1",
      receiptId: "RCPT-1",
      organization: "ORG-NDL",
      sourceSystem: "fixture-supplier-mail",
      messageId: "MSG-0001",
      inputVersion: 1,
      sender: "orders@kestrel-fasteners.test",
      vendorId: "V-100",
      contentSha256: L.MSG_0001_SHA256,
      proposalId: "PROP-1",
      evidenceRef: "MSG-0001@1",
      poNumber: "PO-120",
      poLine: "10",
      baseRevision: "3",
      acceptedAt: L.ASSESSED_AT,
      caseId: "CASE-1",
    });

    // The caller retains the receipt and replays the exact MSG-0001 delivery.
    const replay = L.canonicalIntake();
    replay.receiptId = "RCPT-2";
    replay.priorAcceptance = priorReceipt(receipt);
    const second = intakeAndAssess(replay);
    expect(second.intake).toEqual({
      disposition: "duplicate",
      contractVersion: "supplier-intake.v1",
      organization: "ORG-NDL",
      decidedAt: L.ASSESSED_AT,
      identity: L.msg0001Identity(),
      priorReceipt: receipt,
    });
    expect(second.assessment).toBeNull();
    expect(assessments).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second)).not.toContain("RCPT-2");

    // PO-120 has since moved to revision 4: still no reassessment or fresh acceptance.
    const later = L.canonicalIntake();
    later.priorAcceptance = priorReceipt(receipt);
    later.reads.purchaseOrder = L.poRead(L.po120("4"));
    const third = intakeAndAssess(later);
    expect(third.intake.disposition).toBe("duplicate");
    if (third.intake.disposition === "duplicate") {
      expect(third.intake.priorReceipt.proposalId).toBe("PROP-1");
      expect(third.intake.priorReceipt.caseId).toBe("CASE-1");
    }
    expect(third.assessment).toBeNull();
    expect(assessments).toHaveBeenCalledTimes(1);
  });

  it("a known receipt never lets an unregistered sender bypass the sender guard", () => {
    const receipt = receiptOf(intakeAndAssess(L.canonicalIntake()));
    assessments.mockClear();
    const input = L.revise(L.canonicalIntake(), { identity: { sender: L.UNREGISTERED } });
    input.reads.registeredVendor = L.unregisteredRead(L.UNREGISTERED);
    input.priorAcceptance = priorReceipt(receipt);
    expectBlocked(intakeAndAssess(input), "unverified_sender");
  });

  it("an unavailable prior-acceptance lookup blocks; it is never fresh acceptance", () => {
    const input = L.canonicalIntake();
    input.priorAcceptance = {
      status: "unavailable",
      query: input.priorAcceptance.query,
      reason: "connection_unavailable",
    };
    const block = expectBlocked(intakeAndAssess(input), "intake_source_unavailable");
    expect(block.subject).toBe("priorAcceptance");
  });

  it("the same message ID with changed terms or bindings is a conflict, not a duplicate", () => {
    const receipt = receiptOf(intakeAndAssess(L.canonicalIntake()));
    assessments.mockClear();
    const changes: Array<Parameters<typeof L.revise>[1]> = [
      {
        terms: {
          segments: [
            L.msg0001Terms().segments[0]!,
            { ...L.msg0001Terms().segments[1]!, quantity: "81" },
          ],
        },
      },
      { identity: { inputVersion: 2 } },
      { identity: { evidenceRef: "MSG-0001@2" } },
      { identity: { proposalId: "PROP-9" } },
    ];
    for (const change of changes) {
      const input = L.revise(L.canonicalIntake(), change);
      input.priorAcceptance = { ...priorReceipt(receipt), query: input.priorAcceptance.query };
      const block = expectBlocked(intakeAndAssess(input), "intake_identity_conflict");
      expect(block.subject, JSON.stringify(change)).toBe("priorAcceptance");
    }
  });

  it("a different message with the identical terms digest and a known candidate blocks", () => {
    const receipt = receiptOf(intakeAndAssess(L.canonicalIntake()));
    assessments.mockClear();
    const input = L.revise(L.canonicalIntake(), {
      identity: { messageId: "MSG-0002", evidenceRef: "MSG-0002@1", proposalId: "PROP-2" },
    });
    expect(input.delivery.identity.contentSha256).toBe(L.MSG_0001_SHA256);
    input.priorAcceptance = {
      status: "candidate",
      query: input.priorAcceptance.query,
      receipt: structuredClone(receipt),
    };
    const outcome = intakeAndAssess(input);
    const block = expectBlocked(outcome, "intake_possible_duplicate");
    expect(block.subject).toBe("priorAcceptance");
    expect(outcome.intake.disposition).not.toBe("duplicate");
  });
});

describe("I3 N-02 sender and vendor", () => {
  it("resolves the canonical registered sender to V-100", () => {
    const outcome = intakeAndAssess(L.canonicalIntake());
    expect(outcome.intake.disposition).toBe("accept");
    if (outcome.intake.disposition === "accept") expect(outcome.intake.vendorId).toBe("V-100");
  });

  it("the same content from an unregistered address is unverified_sender, owner buyer", () => {
    const input = L.revise(L.canonicalIntake(), { identity: { sender: L.UNREGISTERED } });
    input.reads.registeredVendor = L.unregisteredRead(L.UNREGISTERED);
    const snapshot = structuredClone(input);
    const block = expectBlocked(intakeAndAssess(input), "unverified_sender");
    expect(block.subject).toBe("reads.registeredVendor");
    expect(input).toEqual(snapshot);
  });

  it("the registered sender of V-200 referencing PO-120 is vendor_mismatch, owner buyer", () => {
    const input = L.revise(L.canonicalIntake(), { identity: { sender: L.V200_SENDER } });
    input.reads.registeredVendor = L.registeredVendorRead(L.V200_SENDER, L.V200);
    input.reads.vendor = L.vendorRead(L.V200);
    const snapshot = structuredClone(input);
    const block = expectBlocked(intakeAndAssess(input), "vendor_mismatch");
    expect(block.subject).toBe("reads.purchaseOrder");
    expect(input).toEqual(snapshot);
  });

  it("supplemental: a sender registered to two vendors is ambiguous and chooses neither", () => {
    const input = L.canonicalIntake();
    const scope = (input.reads.registeredVendor.provenance as { scope: unknown }).scope;
    input.reads.registeredVendor = {
      status: "ambiguous",
      scope,
      readAt: L.ASSESSED_AT,
      reason: "registered_sender_ambiguous",
    };
    expectBlocked(intakeAndAssess(input), "intake_ambiguous_sender");
  });

  it("supplemental: cross-organization and unreadable sender lookups never verify a sender", () => {
    const variants: Array<[string, (input: L.Intake) => void]> = [
      [
        "intake_scope_mismatch",
        (input) => {
          const read = input.reads.registeredVendor as {
            provenance: { scope: { organization: string } };
          };
          read.provenance.scope.organization = "ORG-OTH";
        },
      ],
      [
        "intake_scope_mismatch",
        (input) => {
          const { scope } = (input.reads.registeredVendor as { provenance: { scope: object } })
            .provenance;
          input.reads.registeredVendor = {
            status: "unavailable",
            scope: {
              ...scope,
              binding: { state: "attempted", label: L.ORG, organizationId: L.ORG_ID },
            },
            reason: "scope_mismatch",
            attemptedAt: known(L.ASSESSED_AT),
          };
        },
      ],
      [
        "intake_source_unavailable",
        (input) => {
          const { scope } = (input.reads.registeredVendor as { provenance: { scope: object } })
            .provenance;
          input.reads.registeredVendor = {
            status: "ambiguous",
            scope: {
              ...scope,
              binding: { state: "attempted", label: L.ORG, organizationId: L.ORG_ID },
            },
            readAt: L.ASSESSED_AT,
            reason: "fixture_binding_ambiguous",
          };
        },
      ],
      [
        "intake_source_unavailable",
        (input) => {
          const { scope } = (input.reads.registeredVendor as { provenance: { scope: object } })
            .provenance;
          input.reads.registeredVendor = {
            status: "unavailable",
            scope: {
              ...scope,
              binding: { state: "attempted", label: L.ORG, organizationId: L.ORG_ID },
            },
            reason: "connection_unavailable",
            attemptedAt: { state: "unknown" },
          };
        },
      ],
    ];
    for (const [reason, change] of variants) {
      const input = L.canonicalIntake();
      change(input);
      expectBlocked(intakeAndAssess(input), reason);
    }
  });

  it("supplemental: a missing or disagreeing vendor record blocks a new input", () => {
    const missing = L.canonicalIntake();
    missing.reads.vendor = null;
    expect(expectBlocked(intakeAndAssess(missing), "intake_source_unavailable").subject).toBe(
      "reads.vendor",
    );
    const other = L.canonicalIntake();
    other.reads.vendor = L.vendorRead(L.V200);
    expectBlocked(intakeAndAssess(other), "intake_scope_mismatch");
  });
});

describe("I4 N-03 exact PO and line", () => {
  it("PO-120 line 20 is unknown_po_line, owner buyer, despite matching item text", () => {
    const input = L.revise(L.canonicalIntake(), { terms: { poLine: "20" } });
    const block = expectBlocked(intakeAndAssess(input), "unknown_po_line");
    expect(block.diagnostics).toEqual(["PO-120@3 has no line 20"]);
  });

  it("supplemental: line 010 is not line 10", () => {
    const input = L.revise(L.canonicalIntake(), { terms: { poLine: "010" } });
    expectBlocked(intakeAndAssess(input), "unknown_po_line");
  });

  it("supplemental: an unknown PO, a PO read for another PO and another organization's record block", () => {
    const unknown = L.revise(L.canonicalIntake(), { terms: { poNumber: "PO-999" } });
    unknown.reads.purchaseOrder = {
      status: "not_found",
      scope: L.poScope("PO-999"),
      readAt: { state: "unknown" },
      reason: "source.not_found",
    };
    expectBlocked(intakeAndAssess(unknown), "intake_unknown_po");

    const wrongPo = L.revise(L.canonicalIntake(), { terms: { poNumber: "PO-999" } });
    expectBlocked(intakeAndAssess(wrongPo), "intake_scope_mismatch");

    const wrongOrg = L.canonicalIntake();
    wrongOrg.reads.purchaseOrder = L.poRead({ ...L.po120("3"), organization: "ORG-OTH" });
    expectBlocked(intakeAndAssess(wrongOrg), "intake_scope_mismatch");
  });

  it("supplemental: duplicate exact line records never associate to either", () => {
    const input = L.canonicalIntake();
    const record = L.po120("3");
    record.lines.push(structuredClone(record.lines[0]!));
    input.reads.purchaseOrder = L.poRead(record);
    expectBlocked(intakeAndAssess(input), "intake_ambiguous_po_line");
  });
});

describe("I5 N-04 current revision", () => {
  it("base 2 against current PO@3 is stale_base_revision and leaves PO@3 unchanged", () => {
    const input = L.revise(L.canonicalIntake(), { terms: { baseRevision: "2" } });
    const block = expectBlocked(intakeAndAssess(input), "stale_base_revision");
    expect(block.diagnostics).toEqual(["the proposal is based on revision 2, PO-120 is at 3"]);
    const po = block.examined.purchaseOrder;
    if (po?.status !== "ok") throw new Error("the PO read must be retained");
    expect(po.data.currentRevision).toBe("3");
    expect(po.data.record.lines).toEqual([
      expect.objectContaining({
        lineNumber: "10",
        ordered: "120",
        received: "0",
        canceled: "0",
        acceptedSegments: [
          { sequence: 1, quantity: "120", arrival: { state: "dated", date: "2026-10-23" } },
        ],
      }),
    ]);
  });

  it("a later received or authored time never makes the message supersede revision 3", () => {
    const input = L.revise(L.canonicalIntake(), {
      terms: { baseRevision: "2" },
      identity: {
        authoredAt: known("2026-10-21T08:30:00.000Z"),
        receivedAt: known("2026-10-21T08:45:00.000Z"),
      },
    });
    const block = expectBlocked(intakeAndAssess(input), "stale_base_revision");
    expect(block.identity?.receivedAt).toEqual(known("2026-10-21T08:45:00.000Z"));
  });

  it("unknown message times stay unknown", () => {
    const input = L.revise(L.canonicalIntake(), { terms: { baseRevision: "2" } });
    const block = expectBlocked(intakeAndAssess(input), "stale_base_revision");
    expect(block.identity?.authoredAt).toEqual({ state: "unknown" });
    expect(block.identity?.receivedAt).toEqual({ state: "unknown" });
  });

  it("a retained @2 record supplied where the current @3 is required is not a current read", () => {
    const input = L.revise(L.canonicalIntake(), { terms: { baseRevision: "2" } });
    input.reads.purchaseOrder = L.poRead(L.po120("2"), "3");
    const block = expectBlocked(intakeAndAssess(input), "intake_source_unavailable");
    expect(block.diagnostics).toEqual([
      "retained revision 2 is not the current head 3; a current read is required",
    ]);
  });

  it("supplemental: a base revision ahead of the current one blocks", () => {
    const input = L.revise(L.canonicalIntake(), { terms: { baseRevision: "4" } });
    expectBlocked(intakeAndAssess(input), "intake_base_revision_ahead");
  });

  it("base 3 on a genuinely current @3 is accepted and assessed", () => {
    const outcome = intakeAndAssess(L.canonicalIntake());
    expect(outcome.intake.disposition).toBe("accept");
    if (outcome.intake.disposition !== "accept") return;
    expect(outcome.intake.association).toEqual({
      poNumber: "PO-120",
      poLine: "10",
      baseRevision: "3",
      currentRevision: "3",
    });
    expect(assessments).toHaveBeenCalledTimes(1);
  });

  it("several faults keep the first guard's reason and record the others", () => {
    const input = L.revise(L.canonicalIntake(), { terms: { poLine: "20", baseRevision: "2" } });
    const block = expectBlocked(intakeAndAssess(input), "unknown_po_line");
    expect(block.diagnostics).toEqual([
      "PO-120@3 has no line 20",
      "the proposal is based on revision 2, PO-120 is at 3",
    ]);
  });
});

describe("intake outcome", () => {
  it("is detached and deeply frozen", () => {
    const input = L.canonicalIntake();
    const outcome = intakeAndAssess(input);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.intake)).toBe(true);
    if (outcome.intake.disposition !== "accept") throw new Error("not accepted");
    expect(Object.isFrozen(outcome.intake.proposal.terms.segments)).toBe(true);
    expect(outcome.intake.proposal.terms).not.toBe(input.delivery.proposal.terms);
  });
});

describe("bounded diagnostics", () => {
  /** Every diagnostic of a block stays well inside the contract's 2000-character bound. */
  function expectBounded(block: { diagnostics: string[] }) {
    expect(block.diagnostics.length).toBeLessThanOrEqual(21);
    for (const text of block.diagnostics) expect(text.length).toBeLessThanOrEqual(300);
  }

  it("one 2,100-character unknown key still yields the owned invalid-input block", () => {
    const input = L.canonicalIntake();
    input.delivery["k".repeat(2100)] = true;
    const block = expectBlocked(intakeAndAssess(input), "intake_invalid_input");
    expect(block.subject).toBe("delivery");
    expectBounded(block);
    expect(block.diagnostics[0]).toMatch(/^: 1 unrecognized key\(s\): "k+\.\.\."$/);
  });

  it("about 150 unknown keys are summarized as a count and a few truncated names", () => {
    const input = L.canonicalIntake();
    for (let index = 0; index < 150; index += 1) {
      input.delivery[`forged${String(index).padStart(6, "0")}`] = index;
    }
    const block = expectBlocked(intakeAndAssess(input), "intake_invalid_input");
    expectBounded(block);
    expect(block.diagnostics).toEqual([
      ': 150 unrecognized key(s): "forged000000", "forged000001", "forged000002", "forged000003", "forged000004", ...',
    ]);
  });

  it("many separate issues are capped with a count of the rest", () => {
    const input = L.canonicalIntake();
    input.delivery.proposal.terms.segments = Array.from({ length: 40 }, (_, index) => ({
      sequence: index + 1,
      quantity: "-1",
      arrival: { state: "dated", date: "2026-10-23" },
    }));
    const block = expectBlocked(intakeAndAssess(input), "intake_invalid_input");
    expectBounded(block);
    expect(block.diagnostics).toHaveLength(21);
    expect(block.diagnostics[20]).toBe("and 20 more");
  });
});

describe("stored supplier input binding", () => {
  it("a stored input read without a validated binding is a scope mismatch", () => {
    for (const binding of [
      { state: "attempted", label: L.ORG, organizationId: L.ORG_ID },
      undefined,
    ]) {
      const input = L.canonicalIntake();
      const scope = (input.reads.supplierInput.provenance as { scope: Record<string, unknown> })
        .scope;
      if (binding === undefined) delete scope.binding;
      else scope.binding = binding;
      const block = expectBlocked(intakeAndAssess(input), "intake_scope_mismatch");
      expect(block.subject).toBe("reads.supplierInput");
      expect(block.diagnostics).toEqual(["the fixture binding was not validated"]);
    }
  });
});
