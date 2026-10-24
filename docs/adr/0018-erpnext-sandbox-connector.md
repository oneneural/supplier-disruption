# ADR 0018: ERPNext sandbox connector proof

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-22

## Context

The purchasing, inventory and demand authorities are fixture adapters
([ADR 0005](0005-fixture-authority-transactions.md)). SPEC says local success
does not certify an ERP connector, and that an ERP which cannot express an
update must report it unsupported for a verified manual step. ERPNext/Frappe
was the candidate market source.

A disposable local sandbox was prepared outside this repository: ERPNext and
Frappe 16.52.0 from the image
`frappe/erpnext:v16.52.0@sha256:4cf8379a4b94cc7b2b9f488256f2fd39944858572a876f2b8754654d0ec18a2d`,
Compose project `sd-erpnext-sandbox`, published only on `127.0.0.1:18082`.
Its synthetic fixture mirrors the C-01 records under a fictional company:
PO-120 for 120 EA of PART-A due 2026-10-23, SO-201 (70 EA) and SO-202
(50 EA), 40 EA at WH-A and 70 EA at WH-B with unrelated reservations of 10
and 20, plus separate probe items, orders and receipts. It has two dedicated
API users, each limited to that company: a reader with read access only, and
a probe writer with narrow purchase-order, stock-reservation and draft
stock-entry rights and no stock movement authority.

The preparation probes (P01 to P11) established the native semantics this
decision relies on. They ran once at preparation and again after the
documented sandbox reset before the final live proof; their summaries are kept
with the [evidence](../evidence/erpnext-sandbox/README.md).

| Probe      | Observed native behavior                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P02, P02b  | Rows have stable IDs; `modified` is the only concurrency token; no revision counter, no cancelled quantity, no effective dates on item units; the conversion helper returns 1.0 for a unit the item does not list                                                                      |
| P03        | No token 403, invalid token 401, reader writes and out-of-scope reads 403                                                                                                                                                                                                              |
| P04        | A PUT with the read `modified` applies; a stale one returns 417 `TimestampMismatchError` with no change; a PUT without `modified` built from an old snapshot is accepted and overwrites a newer date; two concurrent PUTs with one token give one 200 and one 500 `QueryDeadlockError` |
| P05b       | Update Items takes no caller token and silently reverted a second actor's change                                                                                                                                                                                                       |
| P06a, P06b | An Update Items split dropped the new row's demand link; cancel, create and submit are three separate requests, and in the first run a refused create left a cancelled original with no successor until a manual recovery (P06c)                                                       |
| P07, P09   | A reservation submit checks native capacity and the entry's own token only; two creations with one `Idempotency-Key` created two entries                                                                                                                                               |
| P10, P11   | A draft Material Transfer moves no stock and is found after a withheld response by a unique marker; the probe writer cannot submit a transfer                                                                                                                                          |

## Decision

### Package and boundary

`@supplier-disruption/connector-erpnext` (`packages/connector-erpnext`) reads
and writes the sandbox over HTTP with Node's `fetch`. It depends only on
`@supplier-disruption/contracts` and zod. The API, worker, web app,
demonstration and Compose files do not import, configure or start it: it is a
proof, not a runtime source authority. Its configuration accepts only a
loopback IP origin (`ERPNEXT_BASE_URL` on `127.0.0.1` or `[::1]`; a name
such as `localhost` is refused because it depends on resolver configuration),
reads the two principals from the file named by `ERPNEXT_CREDENTIALS_FILE`
when a principal is requested, refuses a key or secret shorter than eight
characters, and keeps the key and secret in private fields that
serialization and inspection never show. A transport sends each request once, follows no redirect and retries
nothing.

### Connector-facing source contracts

`packages/contracts/src/domain/connector.ts` adds `source-connector.v1`
records that keep what the ERP returned without translating it:

- a native reference (site origin, DocType, name, `modified` copied byte for
  byte, `docstatus`);
- purchase-order lines with row ID, unit, whole ordered, stock and received
  quantities, the row's own conversion ratio and an explicit demand link,
  with `canceled` always `unknown` and `returned` `unknown` when the source
  omits it;
- item units listed by the master, with `effectiveDates` always `unknown`;
- sales-order demand lines in the row unit;
- availability that keeps physical stock, reserved stock (reservation
  holds), planning reservations (open sales demand), ordered and projected
  quantities apart;
- submitted reservation entries with their owning demand line;
- the connector's operation record, intent, refusal reasons and states;
- mapped stock and demand snapshots that carry the native records read and,
  for stock, the caller's declared buckets with `declaredBy`, so a declared
  zero is never presented as source data.

A fractional quantity, an inexact conversion factor or a list that may be
truncated makes the read `invalid`; nothing is rounded.

### Mapping into the domain contracts

| Domain record   | Result                             | Why                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stock snapshot  | Mapped                             | Needs explicit label maps, a caller declaration of quality holds and safety stock (no native field, never assumed zero) and reservation entries that add up to the Bin's reserved stock. Each entry is `unrelated`, since nothing native binds it to a plan. The version hashes every native token read and every caller input: labels and the declared buckets with their declarer |
| Demand snapshot | Mapped with application attributes | ERPNext supplies ordered, delivered, unit and warehouse. Receipt cutoff, calendar policy, priority and supply links stay application records: one PO row links to at most one demand row (setup refused PO-120 against SO-201 with `OverAllowanceError`). The version hashes the native token and every caller input: labels, line labels and those attributes                      |
| PO revision     | Not mapped                         | `purchaseOrderGaps` reports `revision_not_native` and `canceled_quantity_not_native` rather than inventing a revision number or a zero                                                                                                                                                                                                                                              |
| Item mapping    | Not mapped                         | `masterConversion` returns a ratio only from a listed master row and never calls the helper. Without effective dates a current conversion is not the SPEC's effective-dated mapping                                                                                                                                                                                                 |

Every native name is mapped through explicit maps; an unmapped name leaves the
record unresolved.

### Response classification

| Response                                 | Outcome                                        |
| ---------------------------------------- | ---------------------------------------------- |
| 2xx                                      | Success, still subject to read-back for writes |
| 401                                      | Refused, `authentication_failed`               |
| 403                                      | Refused, `permission_denied`                   |
| 404                                      | Refused, `not_found`                           |
| 417 `TimestampMismatchError`             | Refused, `stale_source_token`                  |
| Other 417                                | Refused, `business_validation`                 |
| Other 4xx                                | Refused, `rejected`                            |
| 5xx, timeout, reset or withheld response | Unknown                                        |

### Writes, journal and reconciliation

Native idempotency is unsupported, so the connector keeps its own operation
record. It journals the intent, a SHA-256 of the intent and the expected
token before its single request. A repeated operation ID never sends anything:
the same intent returns `duplicate_operation`, a different one
`operation_conflict`. `FileJournal` stores the records in one JSON file
replaced by rename, so a new process refuses an operation an earlier one sent.

| Operation                       | Path                                                                                                               | Precondition and proof                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_schedule_date`          | `PUT /api/resource/Purchase Order/{name}` with `modified` and every row as read, one row's `schedule_date` changed | The read token is required and the connector refuses to send without it, or for the date the row already has. `applied` needs a read-back with a new token and every row as intended                                                                                                                 |
| `create_transfer_request_draft` | `POST /api/resource/Stock Entry`, `docstatus` 0, Material Transfer                                                 | No native precondition. A unique marker `sd-op:<operation ID>` in `remarks`, matched only as a whole whitespace-delimited token, so `sd-op:OP-1` never matches `sd-op:OP-10`; `applied` needs exactly one marked draft that matches the intent. A zero or invalid quantity is refused before sending |

After an unknown result the connector reads back once and `reconcile` reads
again later, but never writes. A schedule update whose token is unchanged
stays `unknown`: an absent effect after an uncertain request is not proof
that none will follow. A changed record that does not match the intent, or
two marked drafts, goes to `manual_reconciliation`. A marker search with no
match stays `unknown`.

These operations are recorded as `unsupported` and never sent:

| Operation                             | Disposition | Evidence                                                  |
| ------------------------------------- | ----------- | --------------------------------------------------------- |
| Update Items quantity change          | Manual      | P05b lost update, no caller token                         |
| Split of one line into dated segments | Manual      | P06a lost demand link, one date per row                   |
| Cancel and amend                      | Manual      | P06b partial state across three requests                  |
| Plan-bound reservation                | Unresolved  | P07 and P09: no expected stock version, duplicate entries |
| Transfer submission                   | Unresolved  | P11: posts stock at once, no movement authority           |

### Live fault injection

The live proof places a loopback proxy in front of the sandbox for the
uncertain cases. `forward_then_drop` forwards one request, reads the complete
upstream response and closes the client connection without answering, so the
source has committed and the client cannot tell. `drop` closes the connection
without forwarding. No ERP database is touched directly.

## Consequences

- At least one real market path is exercised: reads, a conditional submitted
  PO change and a marked draft creation, each with refusal and recovery
  outcomes and read-back.
- C-01's ACT-1 needs a quantity split (40 EA by the cutoff, 80 EA later). In
  ERPNext that is an unsupported operation, so it remains a manual step; the
  supported date-only change does not implement it. ACT-2's plan-bound
  reservation stays unresolved. ACT-3 maps only to a draft transfer request.
- The connector's operation record is separate from the case action journal
  ([ADR 0016](0016-workflow-interruption-recovery.md)); nothing connects them.

## Limits

- Proof against one disposable, synthetic, loopback sandbox site. No hosted,
  shared or production ERP, real supplier, purchase or message was used, and
  permission for synthetic sandbox writes is not permission for production
  writes.
- `applied` shows the current source state matches the intent; it cannot
  prove this attempt alone caused it.
- `FileJournal` is a single-host proof store. It does not lock between
  processes. An operation journalled as `dispatching` by a process that died
  is refused on restart and resolved only by `reconcile`.
- The marker search relies on `remarks` and the principal's read access.
  Remarks are not unique keys; uniqueness comes from the operation ID.
- `modified` strings have no time zone (the site uses Europe/Copenhagen) and
  are compared only for equality, never as times.
- The unit of received and returned quantity is unproven. The contract
  records them in the row unit, as `received_qty` is read, but every receipt
  in the evidence is on an EA row with factor 1; nothing shows which unit a
  receipt on a Box row with factor 10 reports.
- Declared quality holds and safety stock are caller assertions, not ERP data.
- The concurrency case shows one winner for two requests with one token; it
  is not a load or race test of every route.
- Graph mailbox delta and identity replay remain a separate access gate. Peppol
  remains a semantic reference only.

## Verification

Default checks replay recorded, redacted responses of the committed live run
(each fixture names its exchange in `docs/evidence/erpnext-sandbox/`) and open no
network connection:

```sh
corepack pnpm --filter ./packages/connector-erpnext test
```

The live proof is opt-in and skips unless the two required variables are set:

```sh
ERPNEXT_BASE_URL=http://127.0.0.1:18082 \
ERPNEXT_CREDENTIALS_FILE=<path to the sandbox api-user.env> \
ERPNEXT_EVIDENCE_DIR=docs/evidence/erpnext-sandbox \
corepack pnpm test:sandbox
```

| Step     | Demonstrates                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| L01      | Both dedicated principals and the installed Frappe and ERPNext versions                                                 |
| L02      | PO, partly received PO, item units, demand, Bins and reservation entries; C-01 eligible stock 30 at WH-A and 50 at WH-B |
| L03      | Unauthenticated, invalid-token, out-of-scope and reader-write refusals, with the PO unchanged                           |
| L04      | Conditional update applied; stale token refused (417); tokenless update refused before sending                          |
| L05, L06 | Duplicate and conflicting operation IDs send nothing, also after a restart                                              |
| L07, L08 | A withheld update and a withheld create resolved by read-back with one request each; Bins unchanged by the draft        |
| L09      | A request dropped before the source stays unknown after reconciliation                                                  |
| L10      | Two concurrent updates with one token: one applied, the other refused or handed to an operator                          |
| L11      | Unsupported operations recorded with no request                                                                         |
| L12      | The canonical PO-120 is unchanged                                                                                       |

The evidence of the final live run, with its connector revision, is in
[docs/evidence/erpnext-sandbox](../evidence/erpnext-sandbox/README.md).
