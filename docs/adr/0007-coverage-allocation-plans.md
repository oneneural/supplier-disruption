# ADR 0007: Coverage, eligibility and allocation assessment with hashed plans

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-20

## Context

ADR 0004 defined the domain input contracts and seeded the frozen oracle's
canonical records. ADR 0005 and ADR 0006 made
them readable through public source entries with explicit versions, read
times and outcomes. Nothing yet turned those reads into the C-01 arithmetic,
told a shortage apart from unavailable evidence, or produced a plan whose
content a later approval could bind to.

This record states the pure policy package, its contracts, the decisions the
frozen oracle leaves open, and what an assessment does not establish. It adds
no table, migration, grant, route, worker job or source write.

## Package and boundary

`@supplier-disruption/domain` is a private ESM workspace package whose only
runtime dependency is `@supplier-disruption/contracts`. Its functions take
materialized, strictly validated DTOs and explicit times and IDs, and return
new values. They never call a source, a clock, wall time, random IDs, the file
system, the environment, the network or storage. Stateless `node:crypto`
SHA-256 is the only Node built-in.

ESLint enforces this: domain may import only contracts among workspace
packages and only `createHash` from `node:crypto` among Node built-ins, whose
list is derived from `node:module` `builtinModules`. It may import no
persistence, framework, auth or model provider, by package name or relative
path. Domain source may not use the `process`, `fetch`, `crypto`,
`performance`, timer, `require` or `globalThis` globals, `Date.now`,
`Math.random`, `crypto.randomUUID`, or `Date()` and `new Date()` without an
argument. Lint cannot see every indirect route to a clock or I/O, so these
rules back the review of the source rather than replace it. Web may
not import domain. Database runtime code (`packages/db/src/**`) may not import
domain either, so the database package's dependency on domain is test-only and
there is no cycle. Virtual-file probes in `scripts/test/import-boundaries.test.mjs`
check each rule.

The public entry exports `assessCoverage`, `AssessmentInputError`, the
eligibility, mapping and conversion helpers, the quantity parser and
serializer, `contentSha256` and the reason constants.

## Contracts

`packages/contracts/src/domain/assessment.ts` holds the strict, browser-safe
DTOs, exported from the contracts root:

| Contract                        | Purpose                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `coverageAssessmentInputSchema` | organization, assessment instant, plan ID and version, vendor, PO line, proposal ID, reads, offers  |
| `readEvidenceSchema(data)`      | one attempted read: `ok` with provenance and data, or `not_found`, `ambiguous`, `unavailable`       |
| `coverageAssessmentSchema`      | the decision, owned issues, eligibility, demand, supply buckets, allocations, options, totals, plan |
| `planPayloadSchema`             | the immutable plan content that is hashed                                                           |
| `proposedPlanSchema`            | the payload and its SHA-256                                                                         |

The input reuses the existing source and reference schemas (`StockSnapshot`,
`DemandSnapshot`, `TransferOption`, `ItemMapping`, `Policy` and so on) and
declares no parallel source model. Database read envelopes are not imported:
the composing caller copies their fields into the contract. A read's
provenance keeps its scope, its read time and the envelope's own observation
statement, which is `unknown` for reference reads and `not_returned` for authority
envelopes that carry none; a record's own `observedAt` stays in the record.
Unavailable evidence carries scope, classification and an optional attempted
time, never data, completeness or a read time. An `ok` transfer-option or
mapping collection carries `complete: true`; only that is authoritative
absence. Optional substitutes arrive as a separate `candidateOffers`
annotation, never as proposal terms or an item mapping.

## Rules implemented

Exactly `CAL-CPH-1@1`, `ELIG-1@1`, `ALLOC-1@1` and `AUTH-1@1` are implemented.
Any other policy ID or version in a slot blocks with
`policy_unsupported_policy_version` instead of silently running version 1.

- Quantities stay canonical strings at every boundary and are BigInt only
  inside a calculation. A result outside the 18-digit quantity contract blocks
  with `policy_quantity_out_of_range`; nothing rounds or wraps. Money is a safe
  integer in one currency.
- ELIG-1: physical minus quality holds, safety stock and each unrelated
  reservation once. Transit is not an input. A repeated reservation ID or
  deductions beyond physical stock block with `policy_inconsistent_stock`; a
  plan-bound reservation blocks with `policy_plan_reservation_unsupported`.
- Mapping: exactly one item-master mapping for the vendor, vendor item, stated
  unit, SKU and stock unit, effective on the reference date with inclusive
  endpoints. None gives the oracle's `uom_conversion_unavailable`; several give
  `policy_mapping_ambiguous`; a nonzero remainder gives
  `policy_conversion_nonintegral`.
- Schedule projection: the converted proposed segments replace the selected
  line's accepted segments, which stay visible as `replaced_by_proposal`. When
  no proposal was projected (no usable mapping, a nonintegral conversion or a
  total mismatch), they are `not_projected` with
  `policy_schedule_not_projected` instead. They
  must total ordered minus received minus canceled, or the assessment blocks
  with `policy_schedule_total_mismatch`. Other lines and the received and
  canceled quantities are untouched. This is a projection, not an amendment.
- CAL-CPH-1: an arrival counts when its date at the line's destination is on
  or before the line's receipt cutoff. Dates compare as dates, so a DST change
  cannot move them; undated and dispatch-only dates never count.
- ALLOC-1: demand lines with an explicit supply link to the selected PO line,
  in ascending numeric priority; for each, present eligible stock at the
  destination, then on-time inbound by earliest arrival. Each supply unit
  covers one demand unit across the run. Confirmed transfers would be the third
  stage, but a quote is never one, and an in-transit record is never allocated
  even when it is dated on time at the destination: dispatched transit is not
  confirmed supply in this slice (N-15). Only demand linked to the selected PO
  line competes; other open demand for the SKU at the destination, linked
  elsewhere or unlinked, is not assessed and does not reduce destination stock.
- Required reads: the stock and the in-transit records of the line's
  destination must both be read; a missing read is `policy_evidence_not_found`
  for the warehouse planner. A candidate offer whose evidence reference is not
  the assessed supplier input is `policy_identity_mismatch`.
- Transfer stage: with a pre-transfer gap, each option from the complete
  collection is checked for SKU, unit, destination, owner, `validUntil`
  strictly after the assessment instant, arrival by a gap line's cutoff, the
  bound stock version equal to the source's current version, and eligible
  source stock covering the whole quoted quantity. A supported option is
  assigned whole, never resized, to gap lines in priority order, as a
  conditional allocation beside the unchanged pre-transfer gap. Unknown source
  stock leaves the option `unknown` with the source warehouse's own reason: the
  reason its read failed (`evidence_unavailable`, `policy_evidence_not_found`
  or `policy_evidence_ambiguous`), or `policy_evidence_not_found` when it was
  not read, raised once per warehouse.
- AUTH-1: the plan's cost, whether its currency is permitted, the listed
  limits and the lowest role whose limit covers the cost. A cost in another
  currency blocks with `policy_currency_not_permitted`, and a cost above every
  limit with `policy_no_approver_within_limits`, both owned by the buyer with
  no plan. A plan with a transfer also lists the supplier acknowledgement and
  the warehouse planner confirmation. Nothing is approved and no expiry is
  created.

## Decisions the oracle leaves open

1. Reason values. The oracle's `unresolved_shortage`, `evidence_unavailable`,
   `unsupported_substitution` and `uom_conversion_unavailable` are exact. Every
   other reason carries the `policy_` prefix and is listed in
   `packages/domain/src/reasons.ts`. Each issue names its input and the next
   evidence needed. Issues rank as input or policy blocks, conversion, missing
   evidence, then shortage; the first of the highest rank sets the recommended
   state (`needs_clarification`, or `escalated` for a shortage) and owner.
   Inventory evidence is owned by the warehouse planner, other evidence by the
   buyer. A cost that no AUTH-1 role may approve, by currency
   (`policy_currency_not_permitted`) or amount
   (`policy_no_approver_within_limits`), is an input or policy block owned by
   the buyer; the next evidence is a cost in the policy currency, a cheaper
   option or a reviewed approval limit. A feasible plan recommends
   `awaiting_approval`, owned by the lowest approving role; there is no
   fallback owner. No result recommends `applying` or `plan_verified`.
2. Mapping reference date: the assessment instant's Copenhagen date. Unknown
   authored and PO effective times stay unknown, and a later assessment checks
   again. Both N-14 cases block under the October fixture.
3. Quote validity: valid only strictly before `validUntil`, compared at
   millisecond precision; truncating finer digits can only reject more. The
   source does not enforce validity, so ACT-3 binds `validUntil` for the
   execution-time recheck that guarded execution owns. No maximum source age
   or cross-read skew is set; read times are recorded, not judged fresh.
4. Ties: when equal priorities or equal arrivals change which supply covers
   which line, or which line a transfer covers, the assessment blocks with
   `policy_allocation_tie` rather than inventing a winner. Allocation runs in
   the identity order, with only line ties reversed, with only supply ties
   reversed and with both reversed; any difference blocks, so a line tie and a
   supply tie cannot cancel each other. The transfer assignment runs in the
   identity and reversed line order. Several supported quotes block with
   `policy_multiple_transfer_options`.
5. Shortfalls. A pre-transfer gap that a supported quote covers is
   `policy_conditional_transfer_pending`, owned by the warehouse planner. A gap
   left after the transfer stage is `unresolved_shortage`, owned by the buyer.
   When feasibility is unknown, the pre-transfer gap carries the blocking reason
   and the conditional figures stay unknown.
6. Action intents. A plan's actions are numbered `ACT-1` to `ACT-3` within the
   caller-supplied plan ID: the schedule replacement, then the reservation at
   the quote's source against its bound version, then the transfer request
   drawing on `ACT-2`'s reservation. No successor version, receipt, operation
   ID or native identity is predicted. A plan without a transfer has only
   `ACT-1` and an approval decision. Only ACT-3 names a predecessor (ACT-2);
   the application order ACT-1, ACT-2, ACT-3 is the order of the hashed
   `actions` array, which guarded execution must follow.

## Plan binding and immutability

The payload names the plan contract and rule implementation versions, the
organization, plan ID and version, the assessment instant, the proposal and its
evidence identity, stored content hash, terms and conversion, and one binding
per read used. A binding states the kind and documented key, the record and
current versions only where the read returned them, collection members, stock
lineage, scope, read time, envelope and record observation times, and the
SHA-256 of the scope and normalized content. Options, transit and reference
records get no invented version. The payload also holds the affected demand
lines with cutoffs and links, every allocation, the gaps, the assessed options
with their full terms and digests, the substitutes, the authorization
requirements, the ordered actions with preconditions, the required decisions
and the recorded assumptions.

Unordered collections are sorted by their documented identities before
hashing; segment, action and priority order is kept. The payload is validated
by `planPayloadSchema`, serialized with contracts' `canonicalJson` and hashed
as UTF-8. The returned payload is a detached copy of exactly what was hashed,
and every nested object and array is frozen, so a returned allocation, action
precondition or decision cannot change while the hash describes the old one.
The whole assessment result is frozen the same way. The same complete input,
IDs and instants give identical bytes and hash.

A changed version, digest, quote, cutoff, allocation, action or read time
changes the hash or blocks the assessment. A new read never edits an earlier
plan. Persistence, approval binding, rechecks and stale-plan rejection belong
to later tasks; a hash alone provides none of them.

## Consumer composition

The database package's `policy-read.test.ts` composes the merged public reads
(`readPurchaseOrder`, `readStock`, `readDemand`, `readInTransit`,
`readTransferOptions`, `readItem`, `readItemMappings`, four `readPolicy` calls
and `readSupplierInput`) into the input contract with the trusted fixture
binding, and passes the actual DTOs to `assessCoverage`. A thrown fixture-source
`source.not_found` becomes `not_found` without a read time; other failures
become `unavailable` with their classification. Reference outcomes pass through;
an invalid query's echoed selectors are replaced by the intended scope, and the
reason is narrowed before the optional attempted time is read. Each read keeps
its own transaction and clock sample; no snapshot across reads is claimed. Line
4 owns the runtime composition.

## Limits

- No case, assessment or plan is stored, and no source is written. Recommended
  states are values for later API composition.
- Not covered: intake identity and duplicates, sender and vendor checks, base
  revision handling beyond blocking a mismatch, approvals, acknowledgements,
  execution claims, fencing, uncertainty, verification, multi-line, partial
  receipt and general carton or fractional families.
- A plan-bound reservation, a demand line with several supply links, a tie and
  several feasible quotes block instead of being decided.
- Reference rows and transit remain single-organization fixture behavior
  (ADR 0005, ADR 0006).

## Verification

| Gate | Test file                                                                               |
| ---- | --------------------------------------------------------------------------------------- |
| P1   | `packages/domain/test/p1-eligibility.test.ts`                                           |
| P2   | `packages/domain/test/p2-c01.test.ts`                                                   |
| P3   | `packages/domain/test/p3-transfer.test.ts`                                              |
| P4   | `packages/domain/test/p4-n12.test.ts`                                                   |
| P5   | `packages/domain/test/p5-n14.test.ts`                                                   |
| P6   | `packages/domain/test/p6-binding.test.ts`, `packages/contracts/test/assessment.test.ts` |
| P7   | `packages/db/test/policy-read.test.ts`, `scripts/test/import-boundaries.test.mjs`       |

P1 to P6 run in `corepack pnpm test`; their expected values are hand-written
oracle literals in `packages/domain/test/literals.ts` and the test files,
plus separately labeled boundary literals. P6 checks the plan hash with a
test-only canonicalizer and `node:crypto` against a fixed vector hashed
outside the code. P7 runs in `test:integration` in a disposable Compose
project with the inherited `supplier-disruption-itdb-<run>-p7` name, removed
also on failure, with expectations in `packages/db/test/policy-literals.ts` and
a raw-SQL fingerprint of every source and reference row before and after each
assessment.
