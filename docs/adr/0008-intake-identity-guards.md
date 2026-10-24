# ADR 0008: Intake identity and source guards ahead of assessment

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-20

## Context

ADR 0007 assesses a supplier proposal against materialized source
reads, but its input states that the caller has already established the
sender, vendor and PO line association. ADR 0005 and ADR 0006
(ADR 0006) made the current PO, the stored supplier input and the vendor
registry readable with explicit outcomes. Nothing yet decided, before an
assessment, whether a structured input is attributable, new and associated
with the exact current PO line, or why it is not.

This record states the intake contracts, the guard order, the reasons the
frozen oracle leaves open and what intake does not establish. It adds no
table, migration, grant, route, worker job, connector or source write.

## Contracts and entry point

`packages/contracts/src/domain/intake.ts` holds strict, browser-safe DTOs,
exported from the contracts root:

| Contract                                      | Purpose                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `intakeInputSchema`                           | trusted organization, assessment instant, caller receipt, case and plan IDs, the delivery, the prior-acceptance lookup, the reads and candidate offers |
| `intakeDeliverySchema`                        | the supplier-originated part: identity, proposal and optional opaque `supplierText`                                                                    |
| `intakeVendorEvidenceSchema`                  | a `registered_vendor` or `vendor` reference read with its full scope and binding; the assessment contract has no vendor slot and is not widened        |
| `priorAcceptanceSchema`                       | the trusted lookup: `receipt`, `candidate`, `none` or `unavailable`, each with the query it answered                                                   |
| `intakeReceiptSchema`                         | the immutable acceptance receipt intake proposes                                                                                                       |
| `intakeDecisionSchema`, `intakeOutcomeSchema` | `accept`, `duplicate` or `blocked`, and the assessment, present only for `accept`                                                                      |

The supplier input and purchase order reads reuse `readEvidenceSchema` with
the existing assessment data schemas, and the other assessment reads reuse the
assessment input's `reads` shape, so intake passes them through unchanged.

`intakeAndAssess(raw)` in `packages/domain/src/intake.ts` is the single pure
composition. It evaluates intake and calls `assessCoverage` only for
`accept`, with the assessment input built from the resolved vendor, the
association and exactly the supplier input and PO reads intake checked. A
`duplicate` or `blocked` result returns without calling the assessment and
carries no new receipt, proposal, plan, approval or action intent; a duplicate
returns only the prior receipt it was given. The outcome is detached and
deeply frozen. Like the assessment, intake reads only its argument; it imports
only contracts, the assessment and the domain's stateless digest.

Parsing is staged. A trusted envelope that cannot even state organization,
time and IDs throws `IntakeInputError`, as `assessCoverage` throws
`AssessmentInputError`: it is a composition fault and nothing was decided. A
delivery that fails strict parsing blocks with `intake_invalid_input` and
subject `delivery`; strictness means no supplier field can carry a receipt,
state, recipient or authority claim. A malformed trusted context (lookup,
reads, offers) blocks with `intake_invalid_input` and subject `context`.

Diagnostics are bounded where the block is built, because supplier-controlled
text such as an unknown key name can reach them: at most 20 diagnostics plus
a count of the rest, each cut to 300 characters, and an unrecognized-keys
issue is summarized as a count and at most five names of up to 40 characters.
So an oversized or key-flooded delivery still returns the owned block instead
of failing the outcome contract.

## Guard order

The first failing guard decides the reason. Each block recommends
`needs_clarification`, names owner `buyer`, keeps the delivered identity (or
null when the delivery did not parse) and the evidence examined so far.

1. **Delivery and stored input.** Strict delivery, then the trusted context.
   The proposal must name the identity's proposal ID and evidence tuple
   (source system, message ID, input version). The terms digest is
   recomputed (ADR 0004: SHA-256 of canonical JSON of the terms, excluding
   delivery metadata) and must equal the stated `contentSha256`; a
   supplied hash is never trusted. The stored supplier input read must be
   the exact message key, carry a validated fixture binding (as the vendor
   reads must) and contain the same identity and terms.
2. **Registered sender.** The `registered_vendor` read must be for the exact
   sender string in the trusted organization. Not found is `unverified_sender`;
   a sender registered to several vendors is `intake_ambiguous_sender`. No
   case folding, plus addressing, display name, domain or name similarity.
3. **Prior acceptance.** The lookup must answer this organization, message
   key and recomputed digest. A receipt for the same key whose immutable
   bindings (input version, sender, resolved vendor, digest, proposal,
   evidence reference, PO, line, base revision) all match is a `duplicate`
   that returns the prior receipt. Any difference is
   `intake_identity_conflict`. A known receipt of a different message with
   the same digest is `intake_possible_duplicate`, never a replay. A failed
   lookup is `intake_source_unavailable`, never absence.
4. **Vendor record and current PO.** For a new input only: the vendor read
   by the resolved vendor's ID must still register the sender. The PO read
   must be for the structured PO number, and its record revision must equal
   the returned current head; a retained record is rejected even if a caller
   supplies it. A missing PO is `intake_unknown_po`. The PO's vendor must be
   the resolved vendor, else `vendor_mismatch`.
5. **Line.** Exact text match of the structured line inside that PO. None is
   `unknown_po_line` (`010` is not `10`, and item text never selects a line);
   several records for one line number are `intake_ambiguous_po_line`.
6. **Base revision.** Compared with the current revision, never with message
   times. Lower is `stale_base_revision`; higher is
   `intake_base_revision_ahead`.

Steps 1 to 4 stop at the first failure because later checks depend on them.
Steps 4 to 6, once the current PO is established, record every vendor, line
and revision failure as diagnostics and keep the first as the reason.

Sender verification precedes the duplicate check, so a familiar message ID or
digest never bypasses attribution. The duplicate check precedes every PO
check, so an exact replay after the PO has moved on returns its historical
receipt instead of being assessed or accepted again. The vendor-by-ID read is
required only after that branch.

## Reasons

The four unprefixed reasons are the frozen oracle's (N-02 to N-04). Every
`intake_` reason is an implementation contract decision recorded here, not an
oracle addition. Intake never uses `policy_` reasons, and the assessment's
own reasons are unchanged.

| Reason                         | Meaning                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unverified_sender`            | the exact sender is not registered (N-02 a)                                                                                                                                       |
| `vendor_mismatch`              | the PO belongs to another vendor than the sender's (N-02 b)                                                                                                                       |
| `unknown_po_line`              | the PO has no line with that exact label (N-03)                                                                                                                                   |
| `stale_base_revision`          | the proposal names an earlier revision than the current head (N-04)                                                                                                               |
| `intake_invalid_input`         | the delivery or trusted context fails strict parsing, or the proposal and identity disagree                                                                                       |
| `intake_content_hash_mismatch` | the recomputed terms digest differs from the stated one                                                                                                                           |
| `intake_identity_conflict`     | the stored input differs from the delivery, or a prior receipt for the same message key has different bindings                                                                    |
| `intake_ambiguous_sender`      | the sender is registered to more than one vendor                                                                                                                                  |
| `intake_scope_mismatch`        | a read or lookup answers another organization, resource, selector or record, or a source reported `scope_mismatch`                                                                |
| `intake_source_unavailable`    | required context was absent, ambiguous or unreadable, including a missing stored input or vendor record, a failed lookup, an ambiguous fixture binding and a retained PO revision |
| `intake_possible_duplicate`    | a different accepted message has the same terms digest                                                                                                                            |
| `intake_unknown_po`            | the structured PO does not exist in the trusted organization                                                                                                                      |
| `intake_ambiguous_po_line`     | the PO holds several records for the line                                                                                                                                         |
| `intake_base_revision_ahead`   | the proposal names a revision later than the current head                                                                                                                         |

`intake_ambiguous_po_line` was not among the task's proposed reasons. It is
added because an ambiguous record is neither absent nor unreadable, and a
duplicate exact line must block without associating to either record.

## Decisions the oracle leaves open

- **Duplicate key.** Organization, source system and message ID. Input version
  is a binding, not permission for another effective event. No automatic
  correction or supersession of an accepted input.
- **Same terms, different message.** Blocks as `intake_possible_duplicate`
  pending explicit association. No hash-only merge and no assumed second case.
- **Delivered and stored input.** The delivery is validated and must equal
  the stored supplier input, whose read provenance the assessment then binds.
  No alternate, unbound input is ever assessed.
- **Supplier text.** `supplierText` is opaque evidence. It is never parsed,
  is not part of the terms or digest and does not appear in any output.
  Original bytes, a separate raw-evidence digest and storage are deferred.
- **Receipt and IDs.** Receipt, case and plan IDs and the decision instant
  come from the caller; nothing is generated. The receipt binds the message
  key, input version, sender, resolved vendor, digest, proposal, evidence
  reference, PO, line, base revision, acceptance time and optional case.

## What intake does not establish

- **Durability and concurrency.** A receipt is a pure value. Two concurrent
  deliveries, a restart or a lost receipt are not handled; atomic acceptance
  uniqueness, persisted evidence, proposal, case and plan records, durable
  quarantine and runtime guard enforcement on every entry point belong to a
  later durable intake change. N-01 is not complete until those and C-01-equivalent final source
  records are shown end to end.
- **Authentication.** Registered fixture sender matching is simulated
  attribution, not mailbox or email authentication.
- **Freshness.** Read times are separate snapshots. Acceptance says nothing
  about source freshness at execution, approval, acknowledgement or TRO-1
  option validity, which later lines recheck.
- **Source lookup.** The prior-acceptance lookup is trusted application
  state. A source operation lookup is never used as an acceptance registry,
  and unfenced source absence never proves no effect (ADR 0005).
- **Scope.** Single fixture organization only. Inherited fixture authority limits
  stand: transit rows carry no organization column, and chained reservation
  labels can run out after about nine successors.
- **Authority.** Acceptance is eligibility for assessment. It is not an
  accepted PO amendment, an approval or execution permission, and an accepted
  input can still lead to an assessment without a plan.

## Verification

| Gate                           | Tests                                                                                                       | Breakage probes that fail them                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 input and hash binding      | `packages/domain/test/intake.test.ts` "I1 input and hash binding", `packages/contracts/test/intake.test.ts` | `trust-supplied-content-hash`, `skip-evidence-cross-binding`, `hash-delivery-metadata`                                                              |
| I2 N-01 sequential suppression | "I2 N-01 sequential decision and effect suppression"                                                        | `duplicate-falls-through-to-assessment`, `message-id-alone-is-duplicate`, `ignore-known-cross-message-candidate`, candidate treated as exact replay |
| I3 N-02 sender and vendor      | "I3 N-02 sender and vendor"                                                                                 | `sender-by-domain-or-name`, `skip-po-vendor-match`                                                                                                  |
| I4 N-03 exact PO and line      | "I4 N-03 exact PO and line"                                                                                 | `line-fallback-by-item`, `numeric-line-normalization`                                                                                               |
| I5 N-04 current revision       | "I5 N-04 current revision"                                                                                  | `received-time-wins`, `use-historical-po-as-current`                                                                                                |
| I6 actual-source composition   | `packages/db/test/intake-read.test.ts`                                                                      | `supplier-text-overrides-context`, `drop-intake-source-provenance`, `consumer-selects-historical-po`                                                |

Expected values are literals from the frozen oracle in the test-only
`intake-literals.ts` files; the terms digest vector was hashed independently
with Python. A narrow `vi.mock` spy wraps the real assessment to count calls.
I6 composes the merged public reads on a disposable PostgreSQL project, uses
supplemental migrator setup only for PO-120@4 (retained @3 observed later)
and MSG-0002, outside the observed brackets. For each composition, one raw-SQL
fingerprint of every purchasing, inventory, demand, reference, clock and alias
row (content and `xmin`) is taken before the public reads and compared after
intake and assessment, so a read that writes or rewrites a row fails the gate.
This covers the reads made in that test run only; it is not a proof about
other read paths or concurrent writers.
