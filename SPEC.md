# Supplier disruption resolution specification

Version: 0.2. Research and architecture date: 2026-10-18. The domain specification
was independently reviewed and accepted before this revision. This revision
adopts the reviewed common architecture. Coding is paused; a later separately
started project instance follows this specification. Documentation acceptance
is not implementation proof.

## Product outcome

Help a distributor's buyer turn a supplier's proposed delivery change into an
evidence-backed, approved recovery plan. Show which customer commitments are
affected, what stock can actually be used, which decisions are still needed, and
whether the accepted plan reached the relevant records.

The first milestone demonstrates one coherent workflow with original synthetic
data: reduced near-term supply, an exact-SKU warehouse transfer, human approval,
durable execution, and read-back verification. The successful state is
`plan_verified`. It never means `goods_delivered`.

The [research record](docs/research.md) documents 20 opened primary sources,
existing commercial overlap, integration constraints, and evidence gaps. SAP's
distributor deployment and Microsoft's existing procurement agent establish the
workflow's relevance. They do not prove demand or commercial novelty for this
use case. All requirements below are proposed product decisions unless a
specific source is identified.

## Users and authority

| Actor | Responsibility | Permitted decisions |
| --- | --- | --- |
| Buyer | Own the exception and supplier discussion | Review extraction, request clarification, select a plan, approve within an explicit policy limit |
| Procurement manager | Approve exceptional cost or commercial change | Approve a higher-cost plan within their recorded limit |
| Warehouse planner | Own source stock and transfer feasibility | Confirm eligible stock, source reservation and transfer timing |
| Customer service owner | Own customer promises | Review affected commitments and accept an explicitly escalated customer communication task |
| Supplier contact | Provide a proposal and acknowledge the accepted revision | Cannot approve internal spending, change customer demand, or grant tool permissions |
| System | Assemble evidence and coordinate work | Read authorized records, propose bounded actions, apply approved sandbox actions, verify results |

The local demonstration has explicit synthetic actor identities. Role simulation
must be labeled; it is not enterprise authentication. Server-side authorization
checks must still reject a buyer attempting a manager-only action. No role may
approve its own agent-generated identity or bypass the source reservation owner.

## Scope and exclusions

Support a single fictional distributor, one currency per case, countable stock
items, two warehouses, one affected PO with multiple lines, and explicit links
to a small set of customer sales-order lines. Inbound messages may be original
plain-text email or a structured response fixture. Later document extraction may
use a text PDF, with page citations and separate accuracy evaluation.

The first recovery choices are: accept the changed schedule if commitments remain
feasible; transfer the exact same SKU; or escalate a quantified shortage. The
operator can ask for missing information and resume the same case after a reply.

Exclude broad supply-chain optimization, forecasting, substitute-item approval,
new-supplier sourcing, automatic purchasing, cancellation of received quantities,
price negotiation, physical receipt creation, customer promise changes, customs,
regulated goods, lot/serial compatibility, perishable stock, manufacturing,
multi-company transfers, and autonomous external messages. These may become
separate researched workflows later.

## Demonstration case

This scenario is fictional, not a Lemvigh-Müller customer record.

- Case clock: 2026-10-21, Europe/Copenhagen. Demand cutoff: 2026-10-23.
- Accepted PO `PO-120`, revision 3: 120 units of `PART-A` due at warehouse A by
  the cutoff. Supplier proposes 40 on October 23 and 80 on October 26.
- Customer sales-order lines require 70 and 50 units at A by the cutoff. Both
  have documented links to the affected supply; allocation priority is explicit.
- A holds 40 physical units, of which 10 are reserved for unrelated demand.
  B holds 70 physical units, of which 20 are reserved for unrelated demand.
  There are no quality holds or safety-stock deductions in this fixture.
- Eligible local stock is 30. Eligible stock at B is 50. Proposed on-time inbound
  supply is 40. A transfer of 50 from B can cover the remaining on-time demand
  only if its timing and source reservation are confirmed.
- Transfer cost is EUR 160. The fixture buyer limit is EUR 100, manager limit
  EUR 500. These are invented test policies, not industry norms.
- The manager approves the precise plan; the warehouse planner confirms 50 units
  and the transfer timing; the supplier acknowledges the accepted revision.
- Read-back proves the PO schedule revision, source reservation, transfer request,
  and downstream planning references match the approved plan. The remaining 80
  incoming units remain visible for later replenishment; they are not canceled or
  silently counted toward Friday demand.

The screen must still show that supplier receipt and warehouse transfer receipt
have not happened. If B's eligible stock falls to 30 before application, the plan
loses 20 units of coverage, its approval becomes stale, and the system replans or
escalates. It must not preserve the earlier success narrative.

## Business records and ownership

All contracts are implementation-independent. JSON examples and schemas are the
first coding deliverable. Decimal values must be represented without binary
floating-point rounding; countable `EA` items require whole quantities.

| Record | Minimum contract | Authority |
| --- | --- | --- |
| Evidence | ID, kind, immutable content hash, source-system ID, received and authored times, sender, version, text/page locator | Original message/document; corrections create a new version |
| Supplier proposal | Vendor, PO/line IDs, base revision, proposed dated segments, undated remainder, stated UOM, evidence references, unresolved fields | Proposed terms only |
| PO snapshot | Company/vendor, document and line IDs, revision, accepted and pending schedules, ordered/received/canceled quantity, stock and purchase UOM | ERP purchasing record |
| Item mapping | Internal SKU, vendor-specific identifier, stock UOM, allowed conversions with effective dates and provenance | Item master; model suggestions are never automatic mappings |
| Stock snapshot | SKU/location, physical, unavailable, reserved and eligible quantities, reservation IDs, version, observed time | Warehouse system; planned arrivals are separate |
| Demand | Sales-order/line IDs, open quantity, destination, required receipt cutoff, supply links, current allocations, explicit priority | Order system/customer service |
| Transfer option | Exact SKU, source/destination, quantity, dispatch and arrival timing, cost/currency, validity, owner confirmation, source version | Warehouse planner and transfer system |
| Plan | Version, evidence/snapshot hashes, affected demand, supply-to-demand allocations, proposed actions, remaining shortage, cost, assumptions | Case record; proposal until approved |
| Approval | Actor/role, decision, plan hash, policy version, amount/currency, allowed action IDs, timestamp/expiry | Approval service or explicit local actor event |
| Action journal | Operation ID, case/plan/action IDs, prerequisite hashes, attempt history, state, request digest, external IDs, last read-back | Durable application record |
| Case | State, owner, evidence links, active plan, outstanding question/approval/action, next-action time, event history | Application coordination record |

Store both an event's business-effective date and its observation time. An email
received later does not automatically supersede a higher PO revision. Supplier
text is untrusted evidence and cannot alter policy, permissions, destinations, or
tool instructions.

## Rules and agent responsibilities

Deterministic code owns identity and revision checks, schema validation, unit
conversion, quantity arithmetic, time/cutoff comparison, allocation, limits,
approval validity, action preconditions, and state transitions. It must:

- Compute eligible stock from physical stock minus documented exclusions and
  unrelated reservations. Do not subtract the same reservation twice.
- Distinguish present physical stock from future expected receipts. Each supply
  segment can cover demand once; a pending schedule replaces the corresponding
  accepted projection for scenario analysis, rather than adding to it.
- Use outstanding demand, excluding already delivered/canceled units. Do not
  change received quantities when a future supplier segment changes.
- Use a named calendar/cutoff policy. Shipping date is not arrival date. A date
  without a sufficient delivery interpretation blocks a promise.
- Enforce source availability and stock conservation on every transfer; stock in
  transit belongs to neither source availability nor destination physical stock.
- Keep the accepted business record separate until the authorized change has
  satisfied its acknowledgement and write requirements.

The agent may interpret unstructured wording, cite evidence for proposed fields,
choose the next permitted investigation, draft a clarification, and explain
options. It must return a schema-constrained proposal to the rule engine. It may
not approve, fabricate a missing conversion or delivery time, infer permission
from an email, select a replacement SKU, or directly write an ERP record.

The permitted investigation tools are narrowly scoped: read this case's evidence,
read matching vendor/PO/line records, inspect linked demand and eligible stock,
request a transfer quote/confirmation through the local outbox, propose an action,
or escalate. Record tool inputs, results, model/version, token use when available,
latency, and the reason a proposed next action was accepted or rejected. Limit
each run to 12 tool calls; exhaustion pauses for review, never loops indefinitely.
That limit is a prototype setting to revisit after measurement.

## Workflow and state

| Case state | Enter when | Next action and exit condition |
| --- | --- | --- |
| `received` | A new attributable supplier event is stored | Validate identity and base revision |
| `needs_clarification` | A required fact is ambiguous, contradictory, inaccessible, or missing | Show a targeted question and owner; re-evaluate when evidence arrives |
| `assessing` | Scope and identity are sufficiently established | Compute demand impact and permitted recovery options |
| `awaiting_approval` | A feasible plan is ready with fresh inputs | Required people accept that exact plan hash or reject it |
| `awaiting_acknowledgement` | Internal approval exists, but required supplier/warehouse acceptance is missing | Persist the wait and its follow-up; a sent message is not acceptance |
| `applying` | All required approvals, acknowledgements and freshness checks hold | Execute authorized action journal entries |
| `partially_applied` | Some effects exist but later work fails or is uncertain | Reconcile known effects and resume safely or escalate |
| `verifying` | Application appears complete | Read source records and compare with approved outcomes |
| `plan_verified` | Every required action is evidenced and planning records are consistent | Preserve physical-delivery risks; a later relevant change reopens assessment |
| `escalated` | No supported feasible plan or unresolved exception remains | Assign an owner, reason, quantified gap and next action; never count as successful recovery |
| `superseded` | A later valid case revision replaces this one | Retain history and link the successor |

An acknowledgement is a structured event referencing the plan or proposed
revision. A new supplier change invalidates affected pending approvals. A reply
of uncertain identity or scope cannot satisfy a wait. Terminal-state events remain
visible rather than being overwritten.

Each action independently progresses through `planned`, `authorized`, `pending`,
`confirmed`, `failed`, or `unknown`. A timeout after submission produces `unknown`.
Reconcile by operation identifier and read-back before retrying; never blindly
resubmit a potentially committed reservation or transfer. Do not roll back a
confirmed physical or commercial event automatically. Show a compensating proposal
for an authorized person if required.

## Integration contracts

| Boundary | Initial executable form | Later market integration and proof needed |
| --- | --- | --- |
| Supplier inbox | Original message files with stable IDs and replayable events | Graph folder delta intake, permitted mailbox, cursor persistence and duplicate handling |
| Purchasing | Versioned fixture adapter with conditional amendment and acknowledgement semantics | ERPNext/Frappe candidate; demonstrate supported submitted-PO changes in a pinned test deployment |
| Inventory and transfer | Separate fixture authority with atomic source reservation and observable transfer request | Real warehouse/ERP API; prove reservation/transfer semantics and confirm receipt remains separate |
| Customer orders | Read-only demand fixture with explicit supply links | ERP/order connector; discover actual allocation ownership rather than guessing it from SKU alone |
| Approvals | Durable local role events bound to the plan | Configured identity and approval service; demonstrate expiry and authorization |
| Outbound requests | Local outbox, never transmitted automatically | Reviewed draft/send integration only after a separate authorized task |

The fake adapters must expose the same interfaces needed for timeout, duplicate,
version conflict and partial-write tests. They must be labeled simulated in every
demonstration. Local success does not certify an ERP connector. Split schedules
may require separate source rows or a domain action; no connector may flatten them
into a misleading single date. If the real ERP cannot express the needed update,
the adapter reports unsupported and the operator applies a verified manual step.

## Operator experience

The milestone requires a small functional workbench, not a generic chat screen:

1. An exception queue with owner, next action, age, severity reason, and state.
2. A case view showing the supplier's words beside current and proposed fields;
   every extracted value opens its source locator.
3. A demand-impact table with quantities, cutoffs, eligible supply, and shortfalls.
4. Recovery options showing feasibility, evidence, cost, unresolved assumptions,
   required approvals, and why an option is disallowed.
5. Review controls for correcting extraction, asking a question, accepting or
   rejecting a plan, recording a simulated acknowledgement, and escalating.
6. An action timeline showing pending, failed and unknown effects, read-back
   evidence, and a clear distinction between a verified plan and actual receipt.

The user can inspect original evidence without trusting a generated summary.
Keyboard navigation and clear textual status are required. Any demo role switch
must say it is simulated. No action button silently grants broader authority.

## Acceptance requirements

| ID | Observable acceptance |
| --- | --- |
| SD-01 | Ingesting the same message twice creates one effective proposal and no duplicate side effect. |
| SD-02 | Every proposed changed field carries evidence ID and locator; missing or contradictory evidence produces clarification. |
| SD-03 | Vendor, PO and line ambiguity never resolves solely through similar text; unknown matches stay blocked. |
| SD-04 | UOM conversion uses an effective item-master mapping; unsupported conversion prevents planning. |
| SD-05 | The impact calculation preserves received units, unrelated reservations, per-demand allocation and each schedule segment. |
| SD-06 | Projected/in-transit quantities cannot become free destination physical stock; arrival must satisfy the demand cutoff. |
| SD-07 | The canonical case produces 70 units of pre-transfer coverage, a 50-unit pre-transfer shortage, and a feasible 50-unit transfer plan. No quantity is allocated twice and no unrelated reservation is consumed. |
| SD-08 | A buyer cannot approve the EUR 160 plan under the EUR 100 fixture limit; manager and warehouse confirmations are required. |
| SD-09 | Approval binds plan, policy and source versions; a conflicting newer source invalidates application until reassessment. |
| SD-10 | A reply or transport success without matching business acknowledgement cannot complete the case. |
| SD-11 | Partial application and uncertain responses remain visible and survive restart without duplicate reservations, transfers or amendments. |
| SD-12 | Verification reads authoritative adapter records; an optimistic local flag or request success is insufficient. |
| SD-13 | A later valid supplier change reopens a verified plan without deleting prior evidence. |
| SD-14 | Unresolved shortage, unavailable evidence and unsupported substitution produce different explicit reasons and an owner. |
| SD-15 | Prompt injection in supplier evidence cannot change permissions, tool destinations or approval rules. |
| SD-16 | Agent output is validated before action; malformed output, exhausted budget, provider failure and low-confidence fields pause safely. |
| SD-17 | The workbench exposes provenance, affected commitments, approval rationale, actual effect state and remaining physical-delivery risks. |
| SD-18 | Evaluation reports distinguish baseline, oracle-normalized and model-backed runs, with exact revision, fixtures, counts, costs and failures. |

## Evaluation cases and release gates

Create original scenario manifests before model prompt tuning. Expected fields,
allocations, states and forbidden side effects are independently reviewed against
this contract. Use at least 24 development cases covering the rows below and a
separate 10-case evaluation set with changed quantities, language and event order.
Evaluation expectations stay outside the implementer's prompt examples until
the first recorded run. Once exposed for repair, label subsequent
runs regression results rather than untouched holdout results.

| Case family | Required result |
| --- | --- |
| Exact canonical split and transfer | Correct arithmetic, role gate, acknowledgement, application and verified plan |
| Quantity/date change with sufficient local stock | No unnecessary transfer, reviewed schedule change |
| Stock mostly reserved to other customers | Unrelated reservations preserved; real shortage exposed |
| High projected stock but little physical stock | Future supply excluded from physical availability |
| Unknown backorder date | Undated remainder retained; no invented on-time promise |
| Cartons versus each, known conversion | Correct stock-unit amount with provenance |
| Missing or expired conversion | Clarification, no guessed pack size |
| Supplier ship date mistaken for receipt date | No on-time claim without arrival evidence |
| Already partially received PO | Only the outstanding schedule changes |
| Same SKU on two PO lines or ambiguous PO | Clarification before mutation |
| Unknown sender or wrong vendor | Quarantined association; no plan application |
| Duplicate event or moved-message replay | One effective event and side effect |
| Older revision received after a newer one | No state regression |
| Email and attachment disagree | Explicit conflict, original evidence retained |
| Stock changes after approval | Stale plan rejected and reassessed |
| Buyer above limit or wrong-currency approval | Authorization fails before any effect |
| Supplier suggests a substitute | Unsupported option, no inferred equivalence |
| Missing acknowledgement or rejected transfer | Wait/escalate, no false verified state |
| Write succeeds then response times out | Reconcile before retry; one effective write |
| PO update succeeds but transfer fails | Partial state with known effects and resumable journal |
| Restart during a wait or partial write | Same owner/state and no duplicate side effects |
| Plan verified, then supplier revises again | Reopened assessment and stale approvals |
| Transfer dispatched but not received | In-transit status; destination physical stock unchanged |
| Malicious document and malformed model output | No privilege change, prohibited tool action or false completion |

Critical deterministic suites require zero unauthorized effects, duplicate writes,
overallocations, stale-plan application, or false verified states across their
declared cases. All expected arithmetic and state transitions must pass. The
model-assisted release additionally reports exact-match extraction, evidence
locator accuracy, completion versus escalation, unnecessary human intervention,
tool count, latency and cost on the same data. Initial target: at least 90% exact
required-field extraction on supported unambiguous evaluation inputs, 100% correct
provenance for fields used in accepted plans, and zero critical violations. These
are prototype acceptance targets, not observed performance or production claims.

Compare baseline coverage openly. A model that adds errors or cost without useful
coverage must not be described as an improvement. Developer timing can describe
the demonstration only; it is not an estimate of buyer productivity. No claimed
revenue protected, late deliveries prevented, or customer ROI follows from these
fixtures.

## Implementation architecture and status

Adopt [blueprint 1.0](docs/blueprint/README.md), copied from the author's private
workspace with later wording-only edits noted in its
[independent review record](docs/blueprint/REVIEW.md). The supplier-specific
[architecture](ARCHITECTURE.md) maps its service, agent, connector and transaction
boundaries to this domain. The blueprint is an extensible base; ordinary library,
adapter and implementation choices need a reason and relevant verification, not
another permission request. Changes to business authority or outcome semantics
need specification review.

The target is an independent TypeScript pnpm workspace: Next.js web, Fastify
business API and a LangGraph/connector worker supervised in one application
container, with separate PostgreSQL for domain state, pg-boss jobs and graph
checkpoints. The first implementation uses original fixture adapters. A later
bounded Claude mode evaluates evidence extraction and investigation behind the
same deterministic rules. Local Compose uses host port 3102. Credentials,
configuration, design and operational gates are defined in the copied blueprint;
none of its runtime or compatibility gates has passed for this repository.

The interrupted Python/SQLite foundation is preserved as uncommitted local work.
It is reference material, not the target application or accepted implementation.
Its development checks do not certify the TypeScript/PostgreSQL architecture.
Exact preserved files and known limits are recorded outside this repository. Do not delete, port,
run, or extend that work during this documentation-only phase.

SD-01 through SD-18, the canonical quantities, workflow states and evaluation
oracles remain authoritative. Shared `needs_reassessment` and `outcome_unknown`
are command/attempt outcomes, mapped to this specification's case/action states;
they do not silently replace the domain state machine. Use a default 10 tool
calls per investigation from the base, configurable only within this spec's
12-call ceiling. All retries consume that bound.

## Delivery sequence

1. **Next separately started coding task:** inventory and preserve interrupted
   work, then perform the bounded dependency/container pilot. Establish the
   three-service TypeScript/PostgreSQL
   runtime and exact commands without model calls. Implement a narrow policy
   slice with typed contracts, original seeded scenarios, versioned fixture
   adapters, deterministic impact/approval rules and a durable journal. Demonstrate
   canonical coverage plus duplicate, stale-stock, wrong-role and uncertain-write
   cases. Add real repeatable checks to README and AGENTS; do not call this an
   agentic application yet.
2. **Working workflow:** operator workbench, clarification/wait/resume controls,
   approval and acknowledgement flow, partial-write recovery and verification.
3. **Agent integration and evaluation:** real bounded model invocation behind the
   same contracts, cited extraction and investigation, fair baseline comparisons,
   frozen evaluation evidence and cost accounting. Requires an authorized model
   endpoint; without one, record the model-backed gate as pending.
4. **Connector proof:** pinned ERP and test-mailbox spike, adapter contract tests,
   documented permissions and failure evidence. Local fixtures remain runnable.
5. **Milestone demonstration:** show a successful recovery plan and a failed or
   stale plan, explain limits, publish only after separate authorization.

Coding resumes only when the owner starts or explicitly resumes this project
instance. The reviewed first slice needs no provider credentials or practitioner
access. The entire milestone cannot be declared complete on fixtures alone: the
real model-backed evaluation and at least one tested market integration are
required, or must remain explicitly outstanding.
