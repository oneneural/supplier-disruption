# ADR 0009: Durable case workflow from intake to plan verification

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-20

## Context

ADR 0005 made the fixture purchasing and inventory authorities
writable with idempotent operation IDs. ADR 0007 and ADR 0008
(ADR 0008) turn a stored supplier input into an immutable, hashed plan, but
nothing persisted a case, bound a decision to that plan or applied it. This
record states how the API and worker carry C-01 from a stored message to
`plan_verified`, with the boundaries SPEC.md and the frozen oracle require.
It adds no model, connector, browser screen or image change.

## Records

Migration `0004_case_workflow` adds application tables in the `app` schema.
The API role may read and insert all of them and may update only the three
mutable ones; the worker role has no access.

| Table              | Holds                                                                                     | Mutability                            |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| `supplier_message` | every delivery: exact bytes, SHA-256, message and delivery IDs, disposition               | append-only                           |
| `supplier_case`    | one case per organization and message key, its SPEC state, reason, owner and current plan | updated under a row lock              |
| `case_event`       | every transition, decision, attempt, reconciliation and verification, numbered per case   | append-only                           |
| `case_assessment`  | each intake and assessment run, numbered per case                                         | append-only                           |
| `case_plan`        | the immutable plan payload and its SHA-256                                                | append-only                           |
| `case_decision`    | approvals, rejections, simulated acknowledgements and escalations bound to one plan       | only status and invalidation columns  |
| `case_action`      | the action journal: one row per plan action with a stable operation ID                    | state, command, receipt and read-back |
| `case_actor`       | the simulated actors a signed-in user may act as, by role and, for a supplier, vendor     | seed-owned, read by the API           |

The stored message content is the UTF-8 canonical JSON of the delivered
identity, proposal and optional text. Fixture messages arrive through the
reference source's stored supplier input, so these are the bytes the case was
assessed from, not a mail transport's raw bytes.

## Intake and assessment

`POST /api/cases/ingest` names an organization, a delivery ID and a message
key. Under a per-organization advisory lock the API reads the stored input,
records the delivery and runs `intakeAndAssess`:

- The same delivery ID replays the earlier response.
- A later delivery of an accepted message is a `duplicate`: it is stored and
  recorded as an event on the existing case, with no new case, plan or effect.
- A blocked input opens a case in `needs_clarification` with intake's reason
  and owner.
- An accepted input opens `CASE-<n>` with plan `PLAN-<n>` version 1, stores
  the assessment and plan, and creates one `planned` journal row per action
  with operation ID `PLAN-<n>.v<version>.<ACT-n>`.

## Tenant

The case workflow serves one organization: the synthetic pilot organization
the seed already creates. Server configuration binds it to the source label
`ORG-NDL` and the reference alias ID of the frozen oracle, never a request or
supplier content. Reusing it adds no organization or membership row, so the
existing session, pilot and browser behaviour is unchanged.

## Decisions

Decisions bind to the exact plan SHA-256; a request with another hash is
refused. The request names an actor, and the API checks a `case_actor` row
binding that actor to the signed-in user and the organization membership. The
fixture binds the buyer account to `buyer-1`, `cs-1` and the simulated supplier
contact `supplier-1` (vendor V-100), and the manager account to `manager-1` and
the simulated planner `planner-1`. Every response labels these as simulated.

An approval is checked against AUTH-1 as the plan records it. The buyer's
approval of EUR 160 over its EUR 100 limit, a role below the minimum or a
currency the policy does not permit is stored as a rejected, void decision and
returns 422 with the reason; nothing is authorized. An accepted approval binds
the plan hash, policy version, amount, limit, allowed actions, source versions
and an expiry of 18:00 Copenhagen time on the business date of approval. The
oracle does not state an approval lifetime; this is the project's choice.

The supplier acknowledgement must match vendor, proposal, PO line and every
segment; the planner confirmation must match plan hash, option, quantity and
arrival. A non-matching submission is recorded as void and changes nothing.
With approval and every required acknowledgement current, the case moves to
`applying` and a `case-application` job is queued in the same transaction.
Rejection or an explicit escalation moves the case to `escalated`. Escalation
is allowed in every non-terminal state, `applying` included: a running
application stops at its next claim or transition, and an effect it already
has stays recorded and is never reversed.

## Application

The worker consumes `case-application` and calls
`POST /internal/cases/:id/apply` with its service token; the API owns the
journal and the source writes. A run takes a per-case session advisory lock.

1. Before the first claim the API rechecks the approval's expiry, the
   approver's role binding, AUTH-1, every bound PO, stock and demand version,
   the transfer option's `valid_until` and its terms hash. A conflict marks the
   plan's decisions `stale` (or `expired`), fails its unclaimed actions with no
   source write, records `needs_clarification` with the reason and owner and
   reassesses under a new plan version. For N-06 a this ends in `escalated`
   with `unresolved_shortage`, and the old plan stays in history only.
2. ACT-1 to ACT-3 run in order. Each claim, in the transaction that marks the
   row `pending`, rechecks that the case is still applying this plan, that the
   approval is current and unexpired, that the approver still holds the role,
   that AUTH-1 at the pinned version is unchanged and that the quote is valid.
   A conflict marks the decisions `stale` (or `expired`), fails this and every
   later unclaimed action with no write and settles as in step 3. Otherwise the
   API submits the exact
   command through the fixture authority module with the row's operation ID. ACT-3 uses
   ACT-2's receipt for its reservation and stock version.
3. A source refusal is `failed`; the case goes to `partially_applied` when an
   earlier action has an effect, otherwise `needs_clarification`. Nothing is
   reversed and no later action is claimed.
4. Any other error after submission is `unknown`, the case is
   `partially_applied` with `outcome_unknown`, and the job retries. The next
   run first looks the operation up by ID; a found effect is confirmed from the
   read-back. Only when no committed operation has that ID does it resubmit the
   identical command under the same ID, which the source applies at most once.

Every state change on the application path names the states it may leave, so
a concurrent change such as an escalation is never overwritten; the run stops
instead. A case job retries with exponential backoff capped at five minutes
and no practical limit, so an outage delays a case without stranding it. When
the API's queue client starts, it also queues a job for every case left in
`applying`, `verifying` or `partially_applied` with `outcome_unknown`; the
exclusive queue's singleton key deduplicates a case that already has one.

## Verification

With every action confirmed the case is `verifying`. The API reads back the PO
current revision and segments, the reservation, the stock version and the
unchanged unrelated reservations and physical stock, the transfer request and
its linked reservation, the demand supply links, and builds the planning
references from the plan's allocations and the receipts. Every check matching
makes the case `plan_verified`, with a bundle time (earliest read) and a
validity of four hours. A missing record or mismatch is `partially_applied`
with `verification_missing_record`, `verification_mismatch` or
`planning_reference_mismatch`. A failed read leaves the case `verifying` and
retries. The response always states that no supplier or transfer receipt is
recorded: a verified plan is not physical delivery or customer impact.

## Routes

| Route                                  | Purpose                                                               |
| -------------------------------------- | --------------------------------------------------------------------- |
| `GET /api/cases?organizationId=`       | case list with state, reason, owner, next action and age              |
| `GET /api/cases/:id`                   | evidence, intake, impact, options, plan, decisions, actions, timeline |
| `POST /api/cases/ingest`               | ingest a stored fixture message                                       |
| `POST /api/cases/:id/decisions`        | approve or reject the exact plan hash                                 |
| `POST /api/cases/:id/acknowledgements` | simulated supplier acknowledgement or planner confirmation            |
| `POST /api/cases/:id/escalations`      | explicit escalation with a note                                       |

Every route needs a session and a fresh membership read; commands also need
the application origin. A non-member sees another organization's case as
missing.

## Limitations

- Fixture-only: one tenant mapped to ORG-NDL, stored fixture messages and
  simulated actors; no mail transport, connector, model or browser screen.
- Historical policy/claim freshness behavior is superseded by
  [ADR 0013](0013-current-policy-execution-guards.md), which checks current AUTH-1
  at decision time and guards every execution claim; its concurrency limits apply.
- The application job runs inside one API request; a very slow source could
  exceed the worker's call timeout, which then retries and reconciles.
