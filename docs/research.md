# Supplier disruption research

Research date: 2026-10-18. Project: supplier disruption resolution.

This record supports [SPEC.md](../SPEC.md). All sources below were opened on the
research date. No practitioner interviews, customer systems, customer datasets,
or live integration trials were available. Proposed behavior is a design decision,
not a finding of customer demand.

## Decision

Build a buyer's workbench for a narrow distributor exception: a supplier proposes
a reduced near-term quantity or later delivery against an already confirmed
purchase order. Determine affected customer-order lines, investigate an exact-SKU
transfer from another warehouse, obtain the responsible people's decisions, and
verify that the accepted recovery plan is recorded consistently.

The initial outcome is **a verified recovery plan with explicit remaining risks**.
It is not proof that goods arrived or that a customer received an on-time delivery.
If the available evidence cannot support a plan, the correct outcome is an owned,
explained escalation. No alternative-product selection or automatic customer
promise changes belong in the first workflow.

## Why this is a real problem

SAP's June 2026 Lemvigh-Müller account describes approximately 175,000 annual POs,
with about 60% of supplier confirmations arriving unstructured. Its deployed
workflow extracts and compares supplier confirmations with ERP records. The
account also identifies master-data weaknesses and says the full effects on
customer experience, errors, and claims were still too early to measure. This is
vendor-published evidence from one distributor, not a market-size study or an ROI
target for this use case. [R01](https://news.sap.com/2026/06/lemvigh-muller-ai-agents-order-confirmations/)

Microsoft's operational documentation explains how changes to confirmed POs can
affect sales orders, service work, and production demand. It distinguishes changes
with no known demand impact from changes requiring investigation. The demand links
may come from planning, inventory marking, or project-specific purchasing. This
supports linking a supply change to identifiable commitments, rather than treating
every delay as equally urgent. [R02](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/purchase-order-changes-after-confirmation)

## What existing products already do

Dynamics 365 Procurement Agent already documents vendor-email classification,
field extraction, reviewed PO changes, downstream impact analysis, scenario
simulation, and follow-up messages. Its documentation labels this a
production-ready preview and describes human review. It recognizes that supplier
terms for dates and units can be ambiguous. This substantially overlaps the
obvious proposal for an AI purchase-order assistant. Do not claim that connecting
email to purchasing or detecting a late PO is novel.
[R03](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/procurement-agent-supplier-com-apply-email-changes),
[R04](https://learn.microsoft.com/en-us/dynamics365/supply-chain/faq-supplier-communications-agent)

The use case offers an inspectable implementation of one difficult
handoff: supplier evidence, stock reservations, transfer approval, source-system
write outcomes, and durable verification. Whether a real buyer prefers this
workbench to an existing ERP feature remains unvalidated. The evaluation must
permit the conclusion that a structured import and rules engine are sufficient
for a particular case.

## Findings that constrain the design

| Finding | Design implication | Evidence |
| --- | --- | --- |
| Supplier proposals and accepted changes are different business records. | Retain the accepted schedule and proposed revision separately; do not overwrite the agreement on ingestion. | R05, R06 |
| Split delivery and undated backorder are different. | Store dated schedule segments and an explicit undated remainder. Unknown arrival stays unknown. | R05 |
| Message arrival order is not business version order. | Bind decisions to source revisions and reject stale changes. | R05, R06 |
| A purchasing unit can differ from the stock unit. | Use item-master conversions; never infer that a carton has a particular size. | R09 |
| Projected quantity includes future supply and demand. | Do not use it as physically available inventory. | R08 |
| Stock can be reserved to another sales order. | Allocate only eligible, uncommitted stock; preserve other commitments. | R10 |
| Transfer dispatch and destination receipt are separate events. | A transfer approval or dispatch must not increment destination physical inventory. | R11 |
| Existing item alternatives concern manufacturing permissions. | A generic alternative-item record does not establish a customer's acceptance of a substituted product. Defer substitutions. | R12 |
| Submitted POs have constrained amendment behavior. | A generic REST update is not proof of a valid purchase amendment. Discover and test the supported business action for the pinned ERP version. | R07, R13 |
| Email API success does not prove delivery or supplier acceptance. | Keep transport acceptance, observed sent state, and business acknowledgement separate. | R15, R16 |

The prototype adds conservative policies where documentation does not determine a
universal answer: explicit warehouse availability snapshots, human approval for
every commitment, approval invalidation after changed evidence, and an operation
journal for partial writes. These are project requirements, not claims that
all ERPs implement those policies identically.

## Integration feasibility and honest boundaries

**ERP candidate: ERPNext through Frappe's documented API.** Frappe provides
document REST operations and user-scoped authentication. Purchase order item
source includes item identifiers, quantities, units, conversion factors,
warehouse, dates, receipt quantities, and demand references. A dedicated API user
can provide a credible permission boundary. However, submitted-document changes,
multi-date schedules, stock reservation, and transfer creation require a versioned
adapter spike. Reading a DocType and writing arbitrary fields is not an accepted
substitute for the ERP's business workflow. [R13](https://docs.frappe.io/framework/user/en/api/rest),
[R14](https://github.com/frappe/erpnext/blob/version-15/erpnext/buying/doctype/purchase_order_item/purchase_order_item.json)

**Email candidate: Microsoft Graph.** Folder delta queries can support incremental
intake. Stable identifier handling and persisted cursors matter for replay.
Graph's optional immutable IDs survive a folder move within one mailbox, but not
every archive/export operation. Its send endpoint returns acceptance before
delivery is proven. The initial implementation uses an original message fixture
and local outbox; a later connector needs a test tenant, application registration,
appropriate mailbox permissions, and explicit authorization to send.
[R15](https://learn.microsoft.com/en-us/graph/outlook-immutable-id),
[R16](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0),
[R17](https://learn.microsoft.com/en-us/graph/delta-query-messages)

**Standards reference: Peppol Advanced Ordering.** Use the identified November
2025 release to ground document semantics. The unversioned index was titled
`DEV 2026-Q2 Release` when checked; do not present it as a verified production
release or silently change the reference. No Peppol access-point connectivity or
conformance is claimed. [R05](https://docs.peppol.eu/poacc/upgrade-3/2025-Q4/profiles/65-advanced-ordering/),
[R18](https://docs.peppol.eu/poacc/upgrade-3/2025-Q4/),
[R19](https://docs.peppol.eu/poacc/upgrade-3/)

## Data availability and rights

No open dataset of linked supplier conversations, actual reservations, customer
priorities, approvals, and recovery outcomes was established in this research.
Public format examples are not customer histories. Author original fictional
organizations, SKUs, documents, policies, and event sequences. Each fixture must
declare its origin, assumptions, case author, expected outcome, and revision.

The Peppol BIS copyright notice restricts modification and redistribution of the
document without consent. Link the standard, paraphrase only what is needed, and
do not vendor its text or example bundle under the project's license. Verify
separate permission before copying any validator, code list, or example asset.
ERPNext code is GPLv3 and its documented licensing page distinguishes documentation
rights and trademarks. The initial fixtures contain no copied ERP source,
standards text, logos, or customer documents. A later deployment must preserve the
licenses of any dependencies it actually redistributes.
[R05](https://docs.peppol.eu/poacc/upgrade-3/2025-Q4/profiles/65-advanced-ordering/),
[R20](https://erpnext.com/license-trademark)

## Evaluation decision

Compare three modes on the same frozen scenarios:

1. A structured-input baseline with deterministic matching, quantity/date rules,
   and a fixed investigation checklist. It escalates unsupported free text.
2. An oracle-normalized baseline using researcher-verified message fields. This
   separates extraction quality from planning correctness.
3. An agent-assisted mode that locates supporting evidence, chooses permitted
   follow-up questions, and proposes the next action, while using the same rules
   and authority gates.

Do not handicap the baseline by giving only the agent the relevant records.
Report both coverage and correctness, since escalating every case can appear
accurate while doing no useful work. Freeze expected outcomes before coding;
have another engineer check arithmetic, evidence, and transitions independently.
That review does not constitute procurement-practitioner validation.

The first coding deliverable should implement the contracts, deterministic rules,
and meaningful failure fixtures. It establishes a trustworthy floor before a
model is connected. The milestone also requires a real model-backed mode and its
measured comparison; a scripted fixture replay is not agent evaluation.

## Gaps and decisions to revisit

- No evidence yet that the proposed UI fits a buyer's daily work or saves time.
- No real procurement authority matrix, transfer lead time, holiday calendar, or
  stock-protection policy. Defaults in the spec are fictional test policy.
- No live ERP or Graph connection was exercised. Submitted-PO schedule updates
  and source reservation actions remain a connector feasibility gate.
- No proof of independent commercial novelty, demand, customer adoption, or
  production reliability.
- No real-world delivery, margin, stock-out, or revenue impact can be measured
  from synthetic cases. Do not turn fixture success into those claims.
- Rates, versions, model selection, and deployment platform are implementation
  decisions requiring fresh checks at the relevant task, not research conclusions.

## Source register

All links were opened on 2026-10-18. Dates below are publication/update dates when
the source provides one; a relative update label is retained rather than converted
into an invented exact date.

| ID | Primary source | Date/version | Use and limits |
| --- | --- | --- | --- |
| R01 | [SAP: Lemvigh-Müller order confirmations](https://news.sap.com/2026/06/lemvigh-muller-ai-agents-order-confirmations/) | 2026-06-26 | Deployed distributor workflow and master-data caveats; vendor account, not controlled impact study. |
| R02 | [Microsoft: confirmed PO changes](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/purchase-order-changes-after-confirmation) | Current page, checked 2026-10-18 | Demand impact and planning relations; product-specific behavior. |
| R03 | [Microsoft: apply vendor-email changes](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/procurement-agent-supplier-com-apply-email-changes) | Updated 2026-08-26; preview | Existing extraction, review, units/date ambiguity; prerelease functionality can change. |
| R04 | [Microsoft: Procurement Agent FAQ](https://learn.microsoft.com/en-us/dynamics365/supply-chain/faq-supplier-communications-agent) | Updated 2026-05-13; preview | Existing impact simulation and communication capabilities; no independent performance baseline. |
| R05 | [Peppol Advanced Ordering](https://docs.peppol.eu/poacc/upgrade-3/2025-Q4/profiles/65-advanced-ordering/) | November 2025 release | Agreement, response, split/backorder and sequence semantics; copyright restrictions and profile-specific rules. |
| R06 | [Microsoft: vendor collaboration](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/vendor-collaboration-work-external-vendors) | Updated 2025-07-21 | PO versions, changes and confirmation; not a universal ERP state machine. |
| R07 | [ERPNext: Purchase Order](https://docs.frappe.io/erpnext/purchase-order) | Page said updated 3 weeks ago | Submitted document behavior and receipt links; live version still needs a probe. |
| R08 | [ERPNext: Projected Quantity](https://docs.frappe.io/erpnext/projected-quantity) | Current page, checked 2026-10-18 | Forecast quantity is not free physical stock. |
| R09 | [ERPNext: purchasing in another UoM](https://docs.frappe.io/erpnext/purchasing-in-different-unit) | Page said updated 3 weeks ago | Item-master conversion and stock-unit posting. |
| R10 | [ERPNext: Stock Reservation](https://docs.frappe.io/erpnext/stock-reservation) | Introduced v15; page said updated 8 months ago | Sales-line reservations and reservation on purchase receipt; no claim that future inbound stock is physically reserved. |
| R11 | [ERPNext: material transfers and goods in transit](https://docs.frappe.io/erpnext/how-to-manage-material-transfers-and-goods-in-transit) | Current page, checked 2026-10-18 | Outward versus inward confirmation; current UI must be rechecked against pinned deployment. |
| R12 | [ERPNext: Item Alternative](https://docs.frappe.io/erpnext/item-alternative) | Page said updated 8 months ago | Manufacturing use; does not authorize customer substitutions. |
| R13 | [Frappe REST API](https://docs.frappe.io/framework/user/en/api/rest) | Current page, checked 2026-10-18 | Document APIs and user-scoped token access; not proof of supported transactional PO amendments. |
| R14 | [ERPNext Purchase Order Item source](https://github.com/frappe/erpnext/blob/version-15/erpnext/buying/doctype/purchase_order_item/purchase_order_item.json) | Mutable version-15 branch, checked 2026-10-18 | Field feasibility only; pin an exact revision before connector work. |
| R15 | [Graph immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id) | Updated 2024-11-07 | Mailbox identity and sent-copy lookup limits. |
| R16 | [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0) | API v1.0, checked 2026-10-18 | Mail.Send permission and asynchronous acceptance; no recipient/business acknowledgement guarantee. |
| R17 | [Graph message delta](https://learn.microsoft.com/en-us/graph/delta-query-messages) | Updated 2024-11-06 | Per-folder synchronization and opaque continuation tokens. |
| R18 | [Peppol November 2025 index](https://docs.peppol.eu/poacc/upgrade-3/2025-Q4/) | November 2025 | Identified stable reference used for research, not a claim to latest certification. |
| R19 | [Peppol unversioned index](https://docs.peppol.eu/poacc/upgrade-3/) | Title: DEV 2026-Q2 Release | Reason to avoid an unpinned standard reference. |
| R20 | [ERPNext license and trademark](https://erpnext.com/license-trademark) | Current page, checked 2026-10-18 | Code/document rights differ; preserve dependency-specific notices and avoid implied endorsement. |
