# ADR 0013: Current AUTH-1 policy and guarded execution claims

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-22

## Context

ADR 0009 checked AUTH-1 only at the version a plan recorded, so a newer
policy version was never detected. Its freshness pass read the bound demand,
PO and stock versions once, outside the claim transaction and only before the
first claim, while each claim rechecked only the approval, the approver's role
and the pinned AUTH-1 row. A change that landed between that pass and a claim,
or between two claims, could therefore pass unseen unless the owning source
refused the write itself. The frozen oracle (N-06, N-07, N-08) requires the
claim to be granted against the current approval, policy, actor authority and
bound source versions, with policy, authority and expiry checked by the API,
never delegated to a source adapter.

## Decision

### Current AUTH-1 version

Policy versions are append-only reference records: the API role can only read
them and nothing updates or deletes a version. The current version of a policy
is therefore its highest stored version. The reference module adds
`readCurrentPolicy({ organization, policyId })`, a bound read like the others
whose scope resource is `current_policy`. An older version's row staying in the
store never makes it current again.

Assessment now reads each policy's current version and then that exact version,
so a plan's policy evidence and hash are unchanged while version 1 is current.
The first-slice rules still implement only version 1 of each policy, so a plan
assessed under AUTH-1 version 2 stops in `needs_clarification` with
`policy_unsupported_policy_version` for the buyer. That domain expectation is
unchanged.

The pure `approvalRefusal` function (`@supplier-disruption/domain`) checks one
role's approval against the current AUTH-1 record, in this order:
`stale_policy` when the plan is bound to another version or other limits,
`currency_not_permitted` when the cost is not in the policy currency (even if
the plan claims otherwise), `role_not_permitted`, then `over_approval_limit`.
The buyer's EUR 160 against EUR 100, the manager's EUR 500 limit and the
canonical arithmetic are unchanged.

### Decisions

`POST /api/cases/:id/decisions` reads the current AUTH-1 version inside the
decision transaction, after locking the case row. A stale policy records the
approval as rejected and void with `stale_policy`, marks the plan's current
decisions stale, moves the case to `needs_clarification` and reassesses in the
same transaction; the route returns 409. Other refusals keep ADR 0009's 422
and leave the case waiting. An unreadable policy returns 503 and records
nothing. Every decision and acknowledgement still locks the case row first, so
simultaneous approvals serialize: the second one finds the case no longer
`awaiting_approval` and is refused with `invalid_case_state`.

### The claim guard

The separate freshness pass is gone. Every claim runs one guard inside the
claim transaction, with the case row locked, after the existing case-state and
current-plan check:

1. a current, unexpired accepted approval whose approver still holds the role;
2. AUTH-1 at its current version through `approvalRefusal`;
3. the current demand version, then every bound PO revision and stock version,
   where a confirmed action of this plan names the expected successor (ACT-1's
   own `PO-120@4` and ACT-2's own stock version never invalidate later actions);
4. the validity and terms of every unconfirmed transfer quote.

An unreadable source makes the run retry. A conflict writes nothing and is
settled in the claim transaction:

- **Before any effect**, when every action of the plan is still `planned` or
  `authorized`: the plan's decisions become stale (or expired), its unclaimed
  actions fail with the reason, the case moves to `needs_clarification` with
  the reason and owner, and the proposal is reassessed under a new plan version.
- **After an attempt**, when an action of the plan was already submitted: the
  decisions become stale, this and every later unclaimed action fail, and the
  case is `partially_applied` with the reason, the owner and the known effects
  when one is confirmed, otherwise `needs_clarification`, as in ADR 0009.
  Nothing is reversed or reassessed automatically.

### Lock and check order

Every API command that changes a case locks its row first: decisions,
acknowledgements, escalations, notes and each claim. Inside a claim the guard
reads the case's own decisions in that transaction and locks the approver's
`app.case_actor` row `FOR SHARE`, then reads the reference, demand, purchasing
and inventory heads through their modules, each in its own read-only snapshot
on another connection. PostgreSQL allows a row lock only with UPDATE on some
column, so the API role gains `UPDATE (simulated)` on `app.case_actor`; that
column's check constraint admits only `true`, so the grant changes nothing it
could write. The guard takes no source row lock, so it never waits on a source
write, and a source write never waits on a case lock. The source write then
claims its operation identity and its head (ADR 0005). The order is always case
row, then actor row, then operation identity, then the source head; actor rows
are changed only by the seed or an administrator, never under a case lock.

### What is serialized

Only some checks are serialized with the claim commit:

- **Case state and decisions**: an escalation, decision or acknowledgement
  needs the case row, so it commits wholly before the claim (the claim then
  sees it) or wholly after the claim commits.
- **Approver authority**: a change to the actor row waits on the claim's
  `FOR SHARE` lock, so a revocation commits either before the guard read it or
  after the claim committed, never in between.
- **AUTH-1, demand, PO and stock**: the guard reads committed snapshots and
  holds no lock on them. Their decision point is the guard read, not the claim
  commit: a change that commits after that read, even before the claim
  commits, is not seen by this claim. The granted write proceeds once, and the
  next claim refuses before any write. PO and stock versions are also source
  preconditions, so purchasing or inventory refuses a write against a version
  it no longer holds (N-07). Policy and demand are not source preconditions, by
  the oracle's rule that the API checks them when granting.

An escalation committed before the claim transaction makes the claim find the
case escalated, so nothing is written (BA-06 ordering). One that arrives while
the claim holds the row waits; the claimed write then lands once, and no later
action is claimed.

### Test barriers

`CaseFaultHooks` gains `beforeClaim` (after a run's own checks, before the
claim transaction), `beforeClaimCommit` (inside it, the guard passed) and
`beforeSubmit` (after the claim committed, before the source write). Production
wiring never supplies them. `apps/api/test/policy-guards.test.ts` uses them
with independent migrator connections, one disposable database per gate
(`supplier-disruption-itapi-<run>-<gate>`). Oracle variants assert frozen
literals; extensions assert this ADR's decided behavior.

| Gate   | Kind        | Change and point                                                                             | Observed                                                                                                                                               |
| ------ | ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1     | Extension   | Two simultaneous manager approvals behind a held case row                                    | One accepted approval, one `invalid_case_state`                                                                                                        |
| G1     | N-10 a to c | "Thanks, noted" reply, `PROP-9` acknowledgement, planner confirmation with another plan hash | Three void non-matching records, still `awaiting_acknowledgement`, never `applying`                                                                    |
| G1     | N-06 c      | AUTH-1 version 2 committed before ACT-1's claim                                              | No source effect; decisions and actions `stale_policy`; reassessed to `policy_unsupported_policy_version`; the old hash cannot be approved             |
| N-06 b | N-06 b      | `DEM@2` committed before ACT-1's claim                                                       | No source effect; decisions and actions `stale_source_demand`; reassessed to `escalated`, `unresolved_shortage`, 10 EA on SO-202/10                    |
| N-06 e | N-06 e      | Clock moved past the 18:00 approval expiry before ACT-1's claim                              | No source effect; approval `expired`; reassessed to plan version 2 awaiting a fresh approval                                                           |
| BA-06  | BA-06       | Escalation committed before ACT-1's claim                                                    | No source effect, no attempt; decisions superseded; `escalated`                                                                                        |
| G2     | Extension   | `DEM@2` committed after ACT-1's claim, before its write                                      | `PO-120@4` kept; ACT-2 and ACT-3 fail `stale_source_demand`; `partially_applied`, buyer                                                                |
| G3     | Extension   | Escalation queued while ACT-1's claim transaction holds the case row                         | ACT-1 lands once, ACT-2 and ACT-3 never claimed, case `escalated`, no deadlock                                                                         |
| G4     | Extension   | AUTH-1 version 2 current when the manager approves                                           | 409 `stale_policy`, void decision, reassessed, nothing authorized                                                                                      |
| W1     | Extension   | AUTH-1 version 2 committed between the guard and the claim commit                            | ACT-1 written once; ACT-2 and ACT-3 fail `stale_policy` before any write; `partially_applied`, buyer; no lock waiter left                              |
| W2     | Extension   | `manager-1` deactivated between the guard and the claim commit                               | The revocation waits for the claim commit; ACT-1 written once; ACT-2 and ACT-3 fail `stale_authority`; `partially_applied`, buyer; no lock waiter left |

`packages/domain/test/approval.test.ts` covers the buyer and manager limits,
wrong-currency refusal for every approver (N-05 b) and the stale-policy rule.

## Consequences and limits

- A claimed action still completes its write after a later change: a
  revocation that commits after the claim, or an AUTH-1 or demand change that
  commits after the guard read. Only later claims see it. This is the oracle's
  submission boundary, not a remote transaction across authorities.
- The API (and the test stack) shares one pool of 10 connections, without a
  connection timeout, between the case store and the source modules. A claim
  holds one for its transaction and borrows others for its source reads, so
  pool exhaustion under heavier concurrency would wait rather than fail. Not
  exercised here.
- A wrong-currency plan cannot reach `awaiting_approval` through assessment,
  which already stops it with `policy_currency_not_permitted`. The approval-time
  refusal is proven by the pure function, not by a stored DKK plan.
- The N-08 revocation command, attempt keys, `submitting` state and purchasing
  fence are not implemented. Escalation is the only cancellation. After it,
  unclaimed actions stay `authorized` under superseded decisions, and an action
  left `pending` by a crash during escalation stays pending (ADR 0016).
- The highest version is current. Withdrawing a version would need an explicit
  policy head, which is a schema migration outside this task.
- AUTH-1 is the only policy rechecked at a claim. Calendar, eligibility and
  allocation versions are read current at assessment only.
- Unregistered-sender acknowledgements (N-10 d) are not tested: the fixture
  has one supplier actor, bound to its vendor.
