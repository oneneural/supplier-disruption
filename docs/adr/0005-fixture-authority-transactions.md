# ADR 0005: Fixture authority transactions

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-19

## Context

The canonical seed created the C-01 source inputs in four private schemas but gave them no
runtime methods, no explicit current versions and no operation records. The
first policy slice needs the purchasing, inventory/transfer and demand
authorities to expose current, attributable reads and to apply the three C-01
source actions as conditional writes that each source checks and commits on its
own (frozen oracle `docs/oracles/first-slice-oracles.md`, SHA-256
`b90368cb66fec1b3122092153bd98337292b168b68ca5a568a46878fe189e8ea`, C-01, N-06,
N-07, N-09, N-15). This record states the module boundary, storage, transaction
semantics, grants and the limits of what they prove.

## Modules and public surface

Each authority directory under `packages/db/src/authorities/` owns its Drizzle
schema, its initialization writer and its runtime module (`source.ts`). Runtime
modules use their own parameterized SQL; they never import the Drizzle tables or
initialization. Each authority has one public entry (`index.ts`), published as
a package subpath:

| Subpath                              | Runtime module           | Methods                                                                                                                          |
| ------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `@supplier-disruption/db/purchasing` | `createPurchasingSource` | `readPurchaseOrder`, `amendSchedule`, `lookupOperation`                                                                          |
| `@supplier-disruption/db/inventory`  | `createInventorySource`  | `readStock`, `readTransferOption`, `readInTransit`, `readTransferRequest`, `reserve`, `createTransferRequest`, `lookupOperation` |
| `@supplier-disruption/db/demand`     | `createDemandSource`     | `readDemand` only                                                                                                                |

Each entry also exports `SourceRejectedError` and the timeout defaults. The db
root and `./worker` entries expose no source table or runtime module. No
reference runtime module was needed: the methods validate the organization
label stored on source records, and the controlled clock already reads
`fixture_reference.business_clock`. A module takes a `pg.Pool` and a `Clock`,
never a client or transaction, and has no generic repository, SQL callback or
caller-supplied transaction.

Command and receipt schemas are added to `packages/contracts/src/domain/commands.ts`:
the three commands, the purchasing and inventory receipts, the transfer request
record and the refusal reasons.

## Storage

Migration `0003_source_runtime_heads` adds eight tables and changes no canonical input
table:

| Schema               | Table               | Purpose                                                                                     | API grant      |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------- | -------------- |
| `fixture_purchasing` | `po_head`           | Current revision per PO                                                                     | SELECT, UPDATE |
| `fixture_purchasing` | `operation`         | Operation identity: organization, operation ID, kind, request digest                        | SELECT, INSERT |
| `fixture_purchasing` | `operation_receipt` | Native receipt: plan and action, PO line, prior and successor revision, recorded time       | SELECT, INSERT |
| `fixture_inventory`  | `stock_head`        | Current stock version per organization, SKU and warehouse                                   | SELECT, UPDATE |
| `fixture_inventory`  | `operation`         | Operation identity across `reserve` and `create_transfer_request`                           | SELECT, INSERT |
| `fixture_inventory`  | `operation_receipt` | Native receipt: prior and successor version, reservation, quantity, request and its version | SELECT, INSERT |
| `fixture_inventory`  | `transfer_request`  | A `requested` transfer bound to one reservation in one stock version                        | SELECT, INSERT |
| `fixture_demand`     | `demand_head`       | The order system's current demand version per organization                                  | SELECT         |

The API also gains INSERT on the existing `po_revision`, `po_line`,
`po_line_segment`, `stock_snapshot` and `reservation` tables, because successor
revisions and snapshots are appended. It gets no UPDATE on any history,
operation or receipt table, no DELETE, TRUNCATE, REFERENCES, TRIGGER or
MAINTAIN anywhere in these schemas, and no CREATE on them. Transfer options,
in-transit records, demand and reference stay SELECT only; the seed marker has
no API access. The worker and PUBLIC have nothing. `packages/db/sql/grants.sql`
revokes everything in the four schemas first, so each migration run removes
drift. There is no function, trigger or privileged SQL routine: every check is
TypeScript inside the source transaction with ordinary row locks and
constraints.

No table name contains a plan, approval, journal, case or action term; those
records belong to the application.

### Current versions

Opaque labels such as `INV-A@1` have no order, so the current version is an
explicit head row, never chosen by observation time or label order. Heads are
initialized in the owner initializers (`initializePurchasingHeads`,
`initializeInventoryHeads`, `initializeDemandHeads`, called by the seed after
the inputs and before the marker) and backfilled by migration 0003 for a
database seeded under ADR 0004, with one rule for both paths:

- PO: the highest integer revision of each PO. Revisions are purchasing's own
  order.
- Stock: the only snapshot of each organization, SKU and warehouse.
- Demand: the only snapshot of each organization.

Several stock or demand snapshots without a stated current version stop
initialization (`AmbiguousCurrentVersionError`) or the migration (a guard that
raises before any head is written). The canonical inputs have exactly one each,
so the backfill gives `PO-120` revision 3, `INV-A@1`, `INV-B@1` and `DEM@1`. It
touches no source row, the clock or the marker; a matching marker still makes
the seed a no-op.

`CANONICAL_TABLES` in `packages/db/src/seed/initialize.ts` now lists the heads
and the runtime tables too, so any of their rows without a marker stops the seed
before initialization.

## Transactions

Every write runs in its own READ COMMITTED transaction on a connection it checks
out from the pool, with `lock_timeout` 5 s, `statement_timeout` 15 s and
`DateStyle` ISO set locally, and releases the connection afterwards; a
connection whose BEGIN or rollback failed is discarded. Reads run in a REPEATABLE READ READ ONLY transaction so one
read sees one snapshot. Source methods cannot join a caller's transaction or
each other's. There is no cross-authority transaction or lock.

The lock order is fixed: operation identity, then the owning head, then
records reached through it.

1. **Operation identity.** The first statement inserts the operation row with
   `ON CONFLICT DO NOTHING`. A new row is held by this transaction, so a
   concurrent call with the same key waits on the unique index until it
   commits or rolls back. An existing row with the same kind and request digest
   is a replay: its stored receipt is returned (`replayed: true`) before any
   precondition is checked, so a replay after the source has moved on still
   returns the original effect. Any other existing row is a reused key and is
   refused with `source.operation_conflict`. Identity is unique per
   organization within each authority, across kinds.
2. **Request digest.** SHA-256 of the canonical JSON of the validated command
   without its operation ID: contract version, kind, organization, target,
   expected version, plan and action labels and payload.
3. **Refusals.** A refused command rolls back, so it leaves no operation,
   receipt or effect, and a later identical command is evaluated afresh. The
   oracle's conflict reasons are used unqualified (`stale_base_revision`,
   `stale_source_stock`); other source errors are namespaced
   (`source.not_found`, `source.uom_mismatch`, `purchasing.unknown_po_line`,
   `purchasing.schedule_quantity_mismatch`,
   `inventory.insufficient_eligible_stock`,
   `inventory.version_label_unavailable`, `inventory.reservation_mismatch`,
   `inventory.reservation_already_linked`,
   `inventory.transfer_option_mismatch`,
   `inventory.predecessor_receipt_mismatch`).
4. **Head move.** The head moves by compare-and-set: the UPDATE names the base
   version or revision the transaction checked (and the organization), and
   anything but exactly one updated row aborts the transaction. The row lock
   already guarantees this; the condition keeps the write correct if the lock
   is ever lost in a refactor.
5. **Receipt.** Written in the same transaction as the effect. Its business
   time, `recordedAt`, is sampled from the injected clock after the head lock
   is held, so it is never earlier than the accepted change, and a replay
   returns the original time. A clock that reads the database, such as the
   controlled test clock, must use its own connections rather than the source
   pool, because the transaction holds a source connection while it samples. A
   receipt holds the values recorded at commit and is never edited. A receipt is not a business acknowledgement and not
   proof that the records still match.

### Purchasing: amend schedule

Locks the `po_head` row, requires the head to equal `expectedRevision`
(`stale_base_revision` otherwise), requires the line and its UOM, and requires
the segments to total ordered minus received minus canceled. It then appends
revision N+1: header and every line with unchanged quantities, the other lines'
segments unchanged, and the new segments for the amended line. The head moves to
N+1. Revision N stays as history. C-01 takes `PO-120` from 3 to 4 with 40 EA on
2026-10-23 and 80 EA on 2026-10-26.

### Inventory: reserve

Locks the `stock_head` row, requires it to equal `expectedVersion`
(`stale_source_stock` otherwise), requires the snapshot it names to be of the
command's SKU and warehouse (a data error otherwise) and the UOM to match, and
derives ELIG-1 once
with exact integer arithmetic: physical minus quality holds, safety stock and
each identified reservation of that version. It is the only eligibility
arithmetic here; in-transit records are separate and never subtracted. If the
eligible quantity covers the request it appends a successor snapshot with the
parent's buckets and reservations plus exactly one new plan reservation, and
moves the head.

The successor label is the parent label, a dot and the action label. The
oracle's `INV-B@1+ACT-2` is stored as `INV-B@1.ACT-2`, because `+` is not a
valid contract label. The mapping is lossless because it is never parsed: the
receipt records the parent (`prior_version`), the successor and the causing
operation, plan, action and receipt time, and `readStock` returns them as
`lineage`. A label that would exceed 64 characters or already exists is refused
(`inventory.version_label_unavailable`); see the deferred chained-label limit
below. A foreign advance, such as `INV-B@2`
from another actor's reservation, has no receipt here and never looks like a
plan's own successor.

Successor revisions and snapshots keep their parent's observation time and
effective date, because the physical observation did not change; the change time
is the receipt's `recordedAt`, also returned in the successor's `lineage`. Reservation and request IDs are synthetic
(`RSV-<uuid>`, `TRQ-<uuid>`), and receipt IDs are UUIDs.

### Inventory: create transfer request

Locks the source warehouse's `stock_head` row; every reservation change and
linkage takes this lock, so it also serializes use of the bound reservation. It
requires, in order: the head equals `expectedStockVersion`
(`stale_source_stock`); the reservation exists in that version, is bound to the
command's plan and has the command's quantity and UOM
(`inventory.reservation_mismatch`); the transfer option matches SKU, UOM,
warehouses, quantity and dates (`inventory.transfer_option_mismatch`); the named
predecessor receipt is a reservation of this plan that created this reservation
and produced the bound version from the option's `based_on` version
(`inventory.predecessor_receipt_mismatch`); and the reservation backs no request
yet (`inventory.reservation_already_linked`, also enforced by a unique
constraint). It then inserts one `requested` request, version 1, bound to the
stock version and reservation. It asks for no eligible stock: the reservation
already holds it. No stock version, physical or in-transit quantity changes, and
nothing is dispatched or received. Option validity against the clock is the
claim's business check, not a source precondition here.

### Demand

Read-only. `readDemand` returns the head version or a requested retained
version, with explicit supply links only. A link names a PO and line without a
revision, so it survives an amendment. Order-system changes are made by
migrator setup in tests, appending a version and moving the head.

### Reads and lookup

Every read returns the source's own version and records, and `readAt` sampled
from the injected clock. Observation time comes from the record and is never
replaced by read time; a null observation time, effective date, delivered
quantity or dispatch date stays `unknown`, and a null arrival is `undated`.
Dates and timestamps are read as text: PostgreSQL timestamptz text such as
`2026-10-21 07:00:00+00` is converted to an offset-qualified ISO instant with
its precision (`instantFromPostgres`) before the contracts validate it, in any
session time zone. Each source transaction sets `DateStyle` ISO locally, so a
session configured with another DateStyle reads the same values.

`lookupOperation` returns null when no committed operation has the ID; absence
alone never proves that no effect happened. Otherwise it returns the stored
receipt and the affected records as they are now: the successor PO revision and
the current revision; the reservation in the warehouse's current stock version
(null once released); or the transfer request row. A changed or missing effect
is therefore visible to the later verifier.

## Ownership limits

This is record ownership and transaction separation, not a security boundary.
The API's database role holds the DML grants above and could bypass these
modules with its own SQL, just as the image's shared-UID environment filtering
does not isolate services. Lint and the source-boundary test are engineering
guards, not row-level authorization, and local fixture behavior is not proof of
a real connector's native guarantees, which a real adapter must demonstrate. A
plan or action label in a command is attribution only, never authorization:
application procurement writes stay disabled until the API claim and approval
path exists, and no HTTP route, worker job or agent tool calls these methods
yet.

The engineering guards are:

- `no-restricted-imports` in `eslint.config.mjs`: the API may import only the db
  root and the three public subpaths; the worker and web stay restricted; no
  authority directory imports another's modules; runtime modules and entries do
  not import tables or initialization; the db root and worker entries do not
  re-export tables or runtime modules; and no db package file imports the
  package by its own name, which would bypass the path rules. A re-export
  through another file still passes lint, so D2 also checks structurally that
  no root or worker export is a Drizzle table or schema in a `fixture_` schema.
- A source-boundary test in `scripts/test/import-boundaries.test.mjs` rejects a
  literal `fixture_*` schema reference outside its owner directory. Its named
  setup exceptions are the seed's collision check, the controlled clock's
  business-clock read and the Drizzle generation config. Tests and container
  gates are independent observers and are not scanned. Migrations and
  `grants.sql` are setup.

## Manifest changes

These tables and heads do not change the canonical manifest or its hash
(`57547d808324fcb2c8572295048a945aed542c9bde39f8e28ed8c60bdc78c48e`). Any
manifest change changes the hash, so an existing volume then fails the seed with
`CanonicalSeedConflictError` until its database is explicitly recreated. Nothing
repairs a marker or reseeds silently, and no test resets the shared development
database; tests recreate only their own disposable projects.

## Deferred responsibilities

- **Fencing (N-08).** Purchasing `fence(attemptKey)`, attempt histories and
  their races move to the guarded-execution task, inside the purchasing module,
  with a migration and serialized fence and write tests. N-08 is wholly
  outstanding: no method here reports a fence, and lookup absence without a
  definitive rejection or fence never proves final no-effect. N-08 R4 and R5,
  including delayed writes and crash recovery, are not accepted by this task.
- Worker business time, application acknowledgements and outbox, the action
  journal, restart and reconciliation, automatic retries or compensation,
  verification bundles, planning and intake logic stay with their tasks.
- **Chained successor labels.** Each plan reservation appends `.<action>` to its
  parent's label, so roughly nine successive plan reservations at one warehouse
  from `INV-B@1` exceed the 64-character label limit and a valid reservation is
  then refused with `inventory.version_label_unavailable`. This is harmless for
  the first slice; a later task should derive successor labels from the
  receipt instead.
- Request versions after creation (dispatch and receipt lifecycle) belong to a
  later task; a request is created at version 1 and status `requested` only.
- The `ORG-NDL` application organization and foreign keys from the source
  `organization` labels remain deferred as in ADR 0004. Transfer options and
  in-transit records carry no organization: an option belongs to the
  organization of its `based_on` stock version, and in-transit reads are scoped
  by the queried warehouse's stock head.

## Verification

Gates D2 to D8 run in `test:integration`, each file in its own disposable
Compose database project `supplier-disruption-itdb-<run>-<gate>`, removed also
on failure. Commands and expected values are oracle literals; results are read
with raw SQL on a separate migrator connection; concurrent cases hold the owning
head from a migrator transaction and wait until PostgreSQL reports both callers
blocked (`pg_locks`), never on elapsed time. The grant matrix uses
`has_any_column_privilege` for column-grantable privileges and checks PUBLIC
in column ACLs too, so a column-level grant fails D2 and D10. A killed run
(SIGKILL, host suspend) can leave a `supplier-disruption-itdb-*` project;
README names the cleanup command.

| Gate | File                                                                                   |
| ---- | -------------------------------------------------------------------------------------- |
| D2   | `packages/db/test/d2-source-grants.test.ts`, `scripts/test/import-boundaries.test.mjs` |
| D3   | `packages/db/test/d3-purchasing.test.ts`                                               |
| D4   | `packages/db/test/d4-reservation.test.ts`                                              |
| D5   | `packages/db/test/d5-transfer.test.ts`                                                 |
| D6   | `packages/db/test/d6-identity.test.ts`                                                 |
| D7   | `packages/db/test/d7-separate-commits.test.ts`                                         |
| D8   | `packages/db/test/d8-demand.test.ts`                                                   |

The contract schemas are tested in `packages/contracts/test/commands.test.ts`.
The D10 and D12 seed gates were updated only for the new tables, grants and
schema tag.
