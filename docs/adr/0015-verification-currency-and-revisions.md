# ADR 0015: Verification currency and later supplier revisions

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-22

## Context

Before this task `plan_verified` was permanent: once the read-back matched, the
workbench showed the plan as verified forever, even after the four-hour
VERIFY-1@1 validity or a later change to the source records. A later supplier
message for the same PO line opened an unrelated case, whose assessment saw
PLAN-1's reservation as an unsupported plan reservation and would have asked
for the same transfer again. SPEC requires that a later valid supplier change
reopens a verified plan without deleting prior evidence (SD-13), that a
superseded case keeps its history and links its successor, that approval binds
the exact plan and source versions, and that physical, reserved, expected
inbound and in-transit stock stay separate.

This ADR keeps the claim guards of [ADR 0013](0013-current-policy-execution-guards.md)
and the clarification flow of [ADR 0014](0014-clarification-correction-resume.md)
unchanged. It does not amend [ADR 0007](0007-coverage-allocation-plans.md);
the prior-commitment stage below is an extension recorded here.

## Decision

### Verification currency

`supplier_case.verified_until` holds the end of the current read-back's
validity: the read-back bundle time plus four hours. It is set when a
read-back matches and cleared when a read-back fails. The case detail's
`verificationStatus` derives the current status from the case and its
`verification` and `verification_unavailable` events, at the business clock:

| Status        | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| `current`     | The last read-back matched and its validity has not ended                       |
| `expired`     | The last matching read-back is past its validity; nothing confirms the plan now |
| `mismatch`    | The latest completed read-back found a missing or different record              |
| `unavailable` | The latest attempt could not read a source and no matching read-back is valid   |
| `superseded`  | A later supplier revision replaced the case                                     |
| `none`        | The plan was never read back                                                    |

Expiry is derived, not written: the case stays `plan_verified`, but the queue
and detail `nextAction` say the verification expired and ask for a recheck,
and the workbench no longer shows the plan as verified. Every earlier
read-back, with its bundle time, validity and failed checks, stays in
`verificationStatus.history` and in the case history.

`POST /api/cases/:id/verifications` takes `{ actorId }` from a buyer,
procurement manager or warehouse planner (`403 actor_not_permitted`
otherwise). It reads the plan's records back exactly as the first
verification does, outside any transaction, then locks the case and records
the outcome only if the state and plan are unchanged (`409 invalid_case_state`
otherwise):

- A match appends a `verification` event with `recheck: true` and renews
  `verified_until`.
- A missing record, a changed record or a planning-reference mismatch moves
  `plan_verified` to `partially_applied` with the same reasons as the first
  read-back and clears `verified_until`.
- An unreadable source appends `verification_unavailable` and changes neither
  the state nor the validity. It is never recorded as a mismatch.

A recheck writes no source. It is allowed on `plan_verified`, or on
`partially_applied` after a read-back mismatch while every plan action is
still confirmed, so a later match can restore `plan_verified` but a recheck can
never stand in for a write. A recheck that finds a record missing marks that
action `unknown` with `verification_missing_record`, exactly as the first
read-back does, so a later read that finds the record again cannot restore the
plan before the action is reconciled. The case detail reports the API's own
answer as `verificationStatus.recheckable`, which the workbench uses to offer
the control.

### Later supplier revision as a linked successor

A supplier input for a PO line whose case is `plan_verified` and has no
successor is a candidate successor. Intake and assessment run as for any input
(ADR 0008): a base revision older than the PO's current revision is
`stale_base_revision` and links nothing. When intake accepts the input, the
new case and the predecessor are linked both ways
(`predecessor_case_id`, `successor_case_id`, unique self-references), the
predecessor moves `plan_verified` to `superseded` with reason
`later_supplier_revision`, and both cases get a history event. The
predecessor's plan, decisions, action IDs, receipts and effects are not
changed. The same applies when an ADR 0014 correction is accepted.

Only cases of the same PO line are locked for this check (the PO number and
line are filtered in SQL), so unrelated verified cases are not held.

A second input for the same PO line while a linked successor is still open
(not `plan_verified`, `escalated` or `superseded`) is a `revision_conflict`:
its message is stored as blocked and its case waits in `needs_clarification`
for the buyer. A repeated delivery of the successor's message is a duplicate of
that case, as before.

The successor gets its own plan, hash and decisions. A PLAN-1 approval sent to
the successor is `409 plan_mismatch`, and any decision on the superseded case
is `409 invalid_case_state`, so an old approval can never authorize the new
plan.

### Prior commitments before new allocations

For a successor, the API reads the transfer commitments of the predecessor
plan and of every earlier plan in the predecessor's own lineage, and passes
them to assessment as `reads.priorCommitments`, owned by inventory, scoped to
the predecessor plan ID. The earlier plans are listed as `inheritedPlanIds`,
so a second consecutive revision carries PLAN-1's transfer forward instead of
refusing its reservation. Each record keeps its own plan ID and names the
action ID, the reservation and transfer request it created, the route,
quantity and arrival date, and a status from the inventory records:

| Status       | Source                                                                   | Counted as coverage          |
| ------------ | ------------------------------------------------------------------------ | ---------------------------- |
| `requested`  | Request matches the journal, its reservation is held, no observation     | Yes                          |
| `dispatched` | A dispatch observation of the whole quantity                             | Yes                          |
| `received`   | A receipt observation of the whole quantity                              | No: the case needs a planner |
| `unknown`    | No or a different request, a released reservation, a partial observation | No: the case needs a planner |

The domain rules in `packages/domain` extend ADR 0007 as follows:

- Only a reservation bound to the named predecessor plan, or to a plan in its
  `inheritedPlanIds`, and listed by one of their commitments is deducted once
  from source eligibility and reported as `commitmentReservations`. Any other
  plan reservation is still refused as before, and a record of another plan or
  another item, unit or destination is `policy_prior_commitment_mismatch`.
- A new `prior_commitment` stage runs after the pre-transfer stage and before
  the conditional transfer. It assigns each counted commitment whole, in
  priority order, to demand lines whose cutoff it meets; it is never resized,
  and any surplus is reported. The conditional transfer is assessed only for
  the remaining gap.
- An `unknown` commitment, a `requested` one whose reservation is not held at
  a source warehouse that was read, and a `received` one all raise
  `policy_prior_commitment_unknown` for the warehouse planner. Its
  reservation, if present, stays deducted and is never released, no new
  transfer is assessed and no plan is built. A receipt observation books no
  stock: while the reservation is still deducted at the source and the
  destination stock does not show the receipt, counting the transfer either
  way would cover the demand twice or not at all. No source in this system
  books a receipt into a destination stock version, so a received commitment
  always needs reconciliation here.
- A commitment creates no action. A successor plan never reserves or requests
  again what its predecessor already committed.
- Without `reads.priorCommitments` the output is unchanged, so P1 to P6, the
  intake and approval tests and the frozen C-01 results are byte-identical.

The plan binds the prior-commitment read as a `prior_commitments` source
binding. The commitments are re-read through the lineage at two more points,
and only a `requested` commitment whose reservation is still held, or a
`dispatched` one, for the same request, holds:

- The claim guard of ADR 0013 adds a fifth check for a plan with that
  binding. If any commitment of the lineage no longer holds, or a counted one
  is gone, the claim is refused with `stale_prior_commitment` (owner warehouse
  planner): the approval is marked stale, no action is attempted and the case
  is reassessed. An unreadable read leaves the claim for a retry.
- Each read-back, first or recheck, checks every `prior_commitment`
  allocation against the re-read commitment as a planning reference. A
  commitment that stopped holding is `planning_reference_mismatch`, so a
  successor cannot be or stay verified on an earlier transfer that is gone.

### Observations are evidence only

`fixture_inventory.transfer_observation` records dispatch and receipt
observations of a transfer request, unique per request and kind. The API may
read it but never write it. An observation changes no stock version, physical
quantity, reservation, transfer request, in-transit record or PO line; a
receipt affects coverage only through a stock snapshot of the destination
that a separate source would record. This task creates no physical receipt.

## Consequences

- The workbench shows current versus historical verification, a recheck
  control, links between predecessor and successor, and the coverage already
  committed by the predecessor.
- A verified plan whose read-back stopped matching is `partially_applied`;
  a later supplier message for it opens an ordinary case, not a successor.
- Successor lineage covers one PO line per case and one open successor at a
  time. Multi-line PO evidence is assessed per line, with distinct line IDs.
- A lineage is read up to 21 plans; a longer one fails rather than being read
  partly.
- Schema tag `0007_revision_verification` adds the three case columns and the
  observation table; the API role gains `SELECT` on the table only.

## Limits

- Cases verified before schema tag `0007_revision_verification` have no
  `verified_until`. Their detail derives expiry from the recorded read-back,
  but the queue's next action does not say the verification expired until a
  recheck sets the column.
- An ADR 0014 correction accepted for a successor uses the same lineage, link
  and commitment code as an ingested revision but has no integration test of
  its own. A successor's reassessment is exercised only through the claim
  refusal in `revision-chain.test.ts`.
- The test names `p7`, `revision-verification` and `revision-chain` describe
  this task's scenarios; they are not frozen oracle identifiers.

## Verification

- `packages/domain/test/p7-prior-commitments.test.ts`: requested, dispatched,
  received (refused while unbooked), unknown, unread source, inherited,
  surplus, mismatched and partially received multi-line commitments.
- `apps/api/test/revision-verification.test.ts`: expiry, unavailable evidence,
  recheck, stale, accepted, conflicting and repeated revisions, a source change
  after verification, observations, a commitment that stops holding after
  verification, a record missing on recheck and an API restart, on a
  disposable database with the worker.
- `apps/api/test/revision-chain.test.ts`: a second consecutive revision that
  inherits PLAN-1's transfer, and an approved successor refused at its claim
  after a partial dispatch observation.
- `scripts/container/revision.test.mjs` (W5): the browser path through
  expiry, recheck and the linked successor on the packaged image.
