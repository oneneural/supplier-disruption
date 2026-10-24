# ADR 0016: Workflow interruption, cancellation and queue recovery

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-22

## Context

[ADR 0009](0009-durable-case-workflow.md) made every source write claim an
operation ID first, so a replayed command applies at most once, and read an
uncertain attempt back before any retry. Several paths still broke that
promise or hid an uncertain outcome:

- An escalation while an action was `pending` or `unknown` made the run's
  next transition throw and roll back, so the action stayed in flight with
  no job to read it back.
- A claim refused by an [ADR 0013](0013-current-policy-execution-guards.md)
  guard failed every remaining action, an uncertain one included, which
  treated a possibly committed effect as absent.
- Unclaimed actions stayed `authorized` after an escalation superseded the
  decisions they were authorized under.
- A worker killed with a job active held the case's singleton job until the
  queue's 120 s expiry.
- A read-back that could never prove an outcome was retried for as long as
  the job had retries, then left the case looking in progress.
- The N-08 revocation command, attempt keys and submitting boundary were
  not implemented in the original claim guards (ADR 0013).

The claim guards of ADR 0013, the clarification flow of
[ADR 0014](0014-clarification-correction-resume.md) and the verification
currency of [ADR 0015](0015-verification-currency-and-revisions.md) are
unchanged.

## Decision

### Journal identity of an attempt

Each claim records on `app.case_action`:

| Column               | Meaning                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `command`            | The exact source command, computed once and reused by every later attempt     |
| `request_digest`     | SHA-256 of the stored command's canonical JSON, checked before every attempt  |
| `attempt_key`        | `<operation ID>#<attempt number>`, recorded with the `action_submitted` event |
| `reconcile_attempts` | Attempts and read-backs that did not prove an outcome, bounded below          |

The operation ID never changes across restarts, so a resubmission after a
read-back found nothing is the same operation to the source. Later attempts
reuse the stored command; they do not recompute it. Before each attempt the
run checks the stored command against `request_digest`. A mismatch means the
journal no longer holds the command first claimed under this operation ID, so
nothing is sent: the action becomes `unknown` with `request_digest_mismatch`,
a `request_digest_mismatch` event records both digests, a claimable case moves
to `partially_applied` with that reason, owned by the action's role, and the
job stops retrying. A person confirms at the source what the earlier attempts
did.

### Reconcile first, resubmit only while submittable

A run reads every `pending` or uncertain `unknown` action back by operation ID
before it claims anything:

- Confirmed: the action is confirmed from the source's receipt
  (`action_reconciled`) and the run continues.
- Absent: the same stored command is claimed again under a new attempt key,
  but only while the case is still submittable (`applying`, or
  `partially_applied` with `outcome_unknown`) and every ADR 0013 guard
  passes. Absence is never treated as a final outcome otherwise.
- Unreadable, or absent while the case is no longer submittable: the
  read-back counts toward the bound and the job retries later.

A guard refusal after earlier attempts fails only unclaimed actions; an
in-flight action becomes `unknown` with `reconciliation_pending` and stays
for the read-back.

#### Departure from N-08 R5

N-08 R5 makes an attempt `failed`, and allows a new attempt, only after a
purchasing `fence(attempt key)` and then a lookup that finds nothing. Absence
without a fence is not a final outcome there. Purchasing has no fence here
(see Limits), so this design deliberately resubmits after an unfenced absence
while the claim and approval are still current. K1 shows it: ACT-1's second
attempt `#2` follows a read-back that found no operation.

This is safe for duplicate effects because the resubmission is the same
operation, not a new one:

- the attempt sends the stored command under the same operation ID, and the
  run refuses to send a command whose digest differs from the recorded one;
- purchasing records each operation under the primary key
  `(organization, operation_id)` with its request digest, before any effect,
  in the same transaction as the effect. A later identical request replays
  the first receipt; a different request under that ID is refused with
  `source.operation_conflict`.

If an earlier attempt is still running when the read-back finds nothing,
whichever attempt inserts the operation ID first applies the amendment. The
other waits on that key and then replays the receipt, or applies it itself if
the first one rolled back. At most one amendment exists per operation ID.
The departure is that the action is never marked `failed` on an unfenced
absence, and an attempt cannot be withdrawn: a revocation that commits while
an attempt is in flight may still see that attempt land (R4a).

### Bounded read-back and visible unresolved outcome

`RECONCILE_ATTEMPT_LIMIT` is 8: unknown attempts and unproven read-backs of one
action together. At the bound the action is `unknown` with
`reconciliation_unresolved`, the run returns no retry and a
`reconciliation_unresolved` event is appended. A case that was applying moves
to `partially_applied` with reason `reconciliation_unresolved`, owned by the
action's role, and its next action asks a person to confirm the outcome at the
source. The same holds when the bound is reached on a submission whose
response was lost, including while a revocation waits on that attempt
(`reconciliation_pending`): the case moves to `reconciliation_unresolved`
rather than keep asking for a read-back that no job will run. A run that finds
a case still `applying` behind such an action moves it the same way. The
restart sweep no longer requeues it. Nothing presents such an action as
resolved.

### Cancellation during an in-flight action

An escalation or revocation commits in the case-row transaction that also
serializes claims. It:

1. fails every `planned` or `authorized` action of the plan with its cause
   (`manual_escalation` or `approval_revoked`), so nothing unclaimed stays
   authorized under a superseded decision;
2. if an attempt is in flight, appends `cancellation_pending` and enqueues the
   case job in the same transaction;
3. leaves confirmed effects recorded; nothing is reversed.

The job's run only reads back. Once no action is in flight or unknown it
appends `cancellation_settled` with the known effects. An escalated case stays
escalated. A revoked case with confirmed effects becomes `partially_applied`,
`canceled_after_effect`, with a `compensation_proposed` event (`reversed: false`)
for an authorized person. With no effects (N-08 R4b, purchasing definitively
refused the attempt) it becomes `awaiting_approval` with `approval_revoked`:
the refused action stays `failed` with the source's reason, and only the
actions the revocation failed unclaimed return to `planned`. A fresh approval
of the same hash authorizes the refused action again, which then runs under a
new attempt key with the same stored command and passes the ADR 0013 guards
first.

Any `unknown` action counts as a possible effect. A revocation that finds an
action with `reconciliation_unresolved` (or `request_digest_mismatch`) never
returns the plan for approval: it fails the unclaimed actions, keeps the case
`partially_applied` with `reconciliation_unresolved`, and appends
`cancellation_pending` naming the unresolved action. That cancellation stays
pending until a person establishes the outcome; no job settles it.

### Revocation command (N-08 subset)

`POST /api/cases/:id/revocations` takes `{ actorId, planSha256, note }` and
returns `201 { state, inFlight, unresolved }` with the action IDs of each. The
approver who gave the current approval or a procurement manager may revoke it
(`403 actor_not_permitted` otherwise) while the case is
`awaiting_acknowledgement`, `applying` or `partially_applied`. A different plan
hash is `409 plan_mismatch`, no current approval is `409 approval_not_current`
and another state is `409 invalid_case_state`. The approval becomes `revoked`
with `approval_revoked`.

The claim transaction is the submitting transaction, so the oracle's
orderings reduce to two: a revocation committed before an action's claim
keeps it from being submitted (R1 to R3), and one committed after it finds
the attempt in flight and waits for its read-back (R4, R5).

### Queue recovery

- The supplier acknowledgement's case transition, decision and job insert
  share one transaction; a failed insert rolls all of them back.
- `case-application` jobs carry `heartbeatSeconds: 10`. A worker that dies
  with a job active stops its heartbeat, and the supervisor retries the job
  after about 10 s instead of the 120 s expiry. The migrator corrects the
  option on an existing queue.
- Duplicate, late and reordered runs serialize on the case run lock and the
  case row; a run with nothing left to do returns the current state without
  a source call.
- The restart sweep also requeues `partially_applied` cases with
  `reconciliation_pending` and any case, an escalated one included, whose
  current plan has an action in flight.

## Consequences

- Schema tag `0008_workflow_recovery` adds the three action columns, a digest
  check and the `revoked` decision status. No grant changes.
- The case detail's next action names `reconciliation_pending`,
  `reconciliation_unresolved`, `request_digest_mismatch` and
  `canceled_after_effect`.
- The G3 and BA-06 expectations in `policy-guards.test.ts` changed: unclaimed
  actions now fail with the cancellation's cause instead of staying
  authorized, and G3 records the pending and settled cancellation.
- With the job backoff, the bound is a few minutes of retries before a person
  is asked to confirm an outcome.

## Limits

- Purchasing has no `fence(attempt key)`: a source write that is still
  running when a revocation commits can land, and is then read back and
  reported as an effect after cancellation. The fence would need changes in
  `packages/db/src/authorities/purchasing/` and a source migration, outside
  this task's paths.
- The compensating proposal is an event with the known effects. There is no
  workbench control or command to act on it, and nothing is reversed.
- The revocation command has no workbench control yet; it is API-only.
- A read-back bound reached while a source is down for longer than the
  retries leaves the action unresolved even if the source later shows the
  effect; a person confirms it. There is no command to record that
  confirmation, so a cancellation that found an unresolved action stays
  pending, and a `request_digest_mismatch` action stays open, until one
  exists.
- Lock and statement timeouts in a source write are treated as unknown
  outcomes, so a source held locked for long enough can also reach the bound.

## Verification

- `apps/api/test/workflow-recovery.test.ts`: E1 enqueue rollback with a real
  `pgboss.job` insert failure; N-08 R1, R4a, R4b (a definitive purchasing
  refusal during a revocation, then a fresh approval) and R4c with the bound;
  U1 the bound reached on a lost response while a revocation waits; U2 a
  revocation after the bound; U3 a request digest mismatch; X1 escalation
  with ACT-2 unknown; J1 duplicate and late runs with stable operation IDs,
  attempt keys and digests. U1 and U2 set `reconcile_attempts` to one below
  the bound directly instead of repeating the runs R4c drives.
- `apps/api/test/termination.test.ts`: SIGKILL of the built API or worker at
  four boundaries (K1 before the source write commits, K2 after the effect
  before the journal update, K3 before the worker gets the response, K4
  before the queue acknowledges the job), held at exact points by row-lock
  barriers.
- `scripts/container/termination.test.mjs`: K5, `docker kill` of the app
  container after the effect and before the journal update, then restart.
- The test names E1, R1, R4a, R4b, R4c, U1 to U3, X1, J1 and K1 to K5
  describe this task's scenarios. R1, R4a, R4b and R4c follow the N-08
  orderings; the others are not frozen oracle identifiers.
