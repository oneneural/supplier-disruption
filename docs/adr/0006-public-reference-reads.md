# ADR 0006: Public reference reads and scoped transfer options

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-20

## Context

The canonical seed created the fixture reference data (organization alias, vendors and
contacts, items, item-master mappings, policies and structured supplier input)
in `fixture_reference`, and ADR 0005 gave purchasing, inventory and demand
public runtime modules (ADR 0005). The reference data had no runtime reader,
and inventory could read one transfer option by ID but not every option of a
scope. Coverage and allocation planning (ADR 0007) and intake identity guards
(ADR 0008) need attributable reads of these inputs without private SQL, seed
constants or invented read metadata, and they need to tell an authoritative
empty transfer scope apart from a missing scope or unavailable evidence.

This record states the reference module, its single-fixture binding, the read
outcomes, the inventory collection, and what these reads do not establish. No
schema, migration, grant, manifest or contract changes; the schema tag stays
`0003_source_runtime_heads`.

## Public surface

| Subpath                             | Factory                 | Methods                                                                                                 |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `@supplier-disruption/db/reference` | `createReferenceSource` | `readItem`, `readItemMappings`, `readPolicy`, `readVendor`, `readRegisteredVendor`, `readSupplierInput` |
| `@supplier-disruption/db/inventory` | `createInventorySource` | the ADR 0005 methods, unchanged, plus `readTransferOptions`                                             |

The reference entry exports only the factory and `DEFAULT_SOURCE_TIMEOUTS` as
values, plus types: the query/result types, the binding and scope types, and
the shared read-outcome types from `packages/db/src/authorities/reads.ts`.
`reads.ts` holds types only. The inventory entry re-exports the same outcome
types and adds `TransferOptionsQuery`, `TransferOptionsScope` and
`TransferOptionsRead`. No table, initializer, seed or hash helper, generic
reader, SQL callback or transaction function is exported, and the db root and
worker entries expose no reference module. Contracts are unchanged: the reads
return the existing strict `Item`, `ItemMapping`, `Policy`, `Vendor`,
`SupplierInputIdentity`, `SupplierProposalTerms` and `TransferOption`.

## Single-fixture binding

`createReferenceSource(options)` takes the ADR 0005 `SourceOptions` (a pool,
an injected `Clock`, optional timeouts) plus a required
`fixtureOrganization: { label, organizationId }`. It comes from trusted
composition (API or test wiring), never from supplier content, a sender, a
message ID or a PO. It is not an application membership check.

The reference tables are global and have no organization column. The
deployment assumption is explicit: every reference row belongs to the one
configured synthetic fixture organization (`ORG-NDL`,
`ed222926-927c-460e-8d28-e22ab5620819` in the canonical fixture). Rows do not
prove tenant ownership by themselves, and nothing joins unrelated inventory or
PO tables to infer it. Every call checks the binding again, in its own read
transaction, before reading data:

| Condition                                                       | Outcome                                    |
| --------------------------------------------------------------- | ------------------------------------------ |
| Query `organization` differs from the trusted label             | unavailable, `scope_mismatch`              |
| No alias row, or the only alias has another label               | unavailable, `binding_missing`             |
| One alias with the trusted label but another UUID               | unavailable, `scope_mismatch`              |
| Two or more alias rows (two are fetched, whichever sorts first) | ambiguous, `fixture_binding_ambiguous`     |
| Exactly one alias with the trusted label and UUID               | the read proceeds with a validated binding |

The factory refuses a malformed label or a non-lowercase UUID with a
`TypeError`. Production never imports `CANONICAL_MANIFEST` or adopts the first
alias it finds. A multi-organization reference store needs real ownership
storage and a new design before this module is reused; extra aliases block
rather than widen the scope. Application organization provisioning and foreign
keys stay deferred as in ADRs 0004 and 0005.

## Reads and selection rules

Every query includes `organization`. Selectors are validated before any read
with the contracts' label, unit, version and email schemas; an extra or
missing field, or an invalid value, is unavailable `invalid_query`, never
absence. A transfer-option query whose `fromWarehouse` equals its `toWarehouse`
is also `invalid_query`. An invalid-query result echoes the caller's
organization and selectors unvalidated, so its type declares them `unknown`;
it has no `attemptedAt`. All predicates are exact and parameterized, with
explicit ordering.

| Method                 | Selectors                                   | Successful data and rule                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readItem`             | `sku`                                       | One `Item`; none is `not_found`                                                                                                                                                                                                                                                                 |
| `readItemMappings`     | `vendorId`, `vendorItem`, `sourceUom`       | `{ records, complete: true }` with every mapping version of the exact tuple, ordered by mapping ID (byte order) then numeric version. Expired or overlapping versions are returned unchanged; no effective mapping is selected and nothing is converted. Zero matches is a successful empty set |
| `readPolicy`           | `policyId`, `version`                       | One exact version of `CAL-CPH-1`, `ELIG-1`, `ALLOC-1` or `AUTH-1`. A missing version is `not_found`, never another version. Other IDs, including `VERIFY-1`, are `invalid_query`                                                                                                                |
| `readVendor`           | `vendorId`                                  | One `Vendor` with all `registered_sender` addresses in byte order. A vendor without contacts is invalid data, not an empty vendor                                                                                                                                                               |
| `readRegisteredVendor` | `sender`                                    | The vendor registered for this exact string, with its complete contacts. Two distinct vendors are ambiguous, `registered_sender_ambiguous`. No case folding, plus-address, display-name or domain matching                                                                                      |
| `readSupplierInput`    | `sourceSystem`, `messageId`, `inputVersion` | `{ identity, terms }` for the exact key. The stored content hash is returned as stored, never recomputed or repaired; intake compares it with the returned terms. No raw message or evidence bytes                                                                                              |

Policies are rebuilt from the row's identity columns and its JSON parameters
and validated with `policySchema`. Parameters that are not a JSON object or
that contain `contractVersion`, `policyId` or `version` are invalid data, so a
stored parameter cannot overwrite the row's identity. Supplier terms are
validated strictly and cannot add fields.

A registered-sender read is a registry association. It neither authenticates a
mailbox nor accepts an intake event; reading a stored hash is not proof of the
original bytes.

## Read outcomes

The new methods return a discriminated outcome instead of throwing; the
existing ADR 0005 methods keep their results and `SourceRejectedError`.

| Status        | Fields                                                        | Meaning                                                               |
| ------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ok`          | `scope`, `readAt`, `observedAt: { state: "unknown" }`, `data` | The validated record or complete collection                           |
| `not_found`   | `scope`, `readAt`, `reason`                                   | `record_not_found`, or `scope_anchor_not_found` for transfer options  |
| `ambiguous`   | `scope`, `readAt`, `reason`                                   | `registered_sender_ambiguous` or `fixture_binding_ambiguous`; no data |
| `unavailable` | `scope`, `reason`, optional `attemptedAt`                     | The evidence could not be read; never absence or an empty set         |

`scope` names the owner, the resource, the requested organization and every
selector. Successful, absent and sender-ambiguous reference reads carry the
binding as `{ state: "validated", label, organizationId }`; an ambiguous
binding and every unavailable read carry it as `{ state: "attempted", ... }`.
The transfer-option scope carries its four selectors and `bound: 100`.

Unavailable reasons: `invalid_query`, `scope_mismatch`, `binding_missing`,
`clock_unavailable`, `connection_unavailable` (pool, connection or `BEGIN`
failed before the read ran, or SQLSTATE class 08 or 57P), `permission_denied`
(42501), `read_timeout` (lock or statement timeout, 55P03 or 57014),
`invalid_data` (a stored value the contracts cannot represent),
`read_failed` (anything else) and `collection_bound_exceeded`. Diagnostics
carry no SQL error text, credentials or supplier terms. `attemptedAt` is the
clock sample when one was obtained; an unavailable read never has `readAt`,
`observedAt` or data. The outcome is decided only after the read transaction
committed, so a commit, rollback, connection or decoding failure leaves no
partial payload.

### Bounds

Mapping collections, a vendor's contacts and transfer-option collections hold
at most **100** records. One more row is fetched; 101 makes the read
unavailable `collection_bound_exceeded`, never a truncated success or a
falsely complete empty set. The sender lookup fetches two vendor IDs. These are
local fixture bounds, not business limits; a larger legitimate scope needs a
reviewed change to the bound and its evidence semantics, not pagination.

### Time and connections

These reads inherit ADR 0005's runtime: each call samples `readAt` from the
injected `Clock` before its own `REPEATABLE READ READ ONLY` transaction on its
own pooled connection, with bounded lock and statement timeouts and ISO
DateStyle. Binding and data reads of one call share that snapshot. `readAt`
is a sampling time, not commit time, an observation or a freshness guarantee.
Separate calls, including the four policy reads, are not one atomic snapshot;
consumers bind the actual content, versions, scopes and read metadata.

Reference rows and transfer options have no stored observation time, so the
envelope's `observedAt` is explicitly unknown; authored and received times are
not observations. Supplier `authored_at`, `received_at` and option
`valid_until` are normalized from PostgreSQL text with `instantFromPostgres`,
keeping the instant, offset and up to six fractional digits; null stays
`{ state: "unknown" }`. No registry version is invented for vendors, items or
options, and an option's `basedOn` stock version is not its identity.

A database-backed controlled clock must use a pool separate from every source
pool, including a one-connection source pool (ADR 0005). The R3 gate
proves this wiring in test composition; the future API and worker composition
must keep it.

## Scoped transfer-option collection

`InventorySource.readTransferOptions({ organization, sku, uom, fromWarehouse, toWarehouse })`
reads, in one inventory read transaction:

1. The anchors: the organization's current stock heads of the SKU at both
   warehouses. Each head's snapshot must be of that organization, SKU and
   warehouse (the existing head ownership check), or the read is unavailable
   `invalid_data`. A missing head, or two heads that agree on a stock unit
   other than the query's, is `not_found`, `scope_anchor_not_found`, never a
   successful empty set. Two heads whose snapshots disagree on the SKU's stock
   unit are inconsistent evidence and unavailable `invalid_data`, whichever
   unit was asked. There is no warehouse registry; the heads define this local
   scope.
2. Every option whose own SKU, unit, source and destination equal the query and
   whose `based_on` snapshot belongs to the organization, ordered by option ID
   (byte order). An included option whose base snapshot is not of its SKU,
   source warehouse and unit is unavailable `invalid_data`; corrupt linkage is
   never dropped to manufacture absence. Options on another organization's
   base are outside the scope.

All matching options are returned with their complete terms, including expired,
late and retained-base options. Nothing is filtered by current head, quantity,
arrival cutoff, cost, expiry or confirmation, and nothing is ranked; policy
decides feasibility. With valid anchors and no match the result is
`ok`, `records: []`, `complete: true`. That absence holds only for these
predicates in that read's snapshot: it does not mean no option exists
elsewhere or later, and a missing singular `TRO-1` alone never proves the scope
empty. The singular `readTransferOption` keeps its throwing `source.not_found`.

## Grants and ownership

No grant changes. The API already has SELECT on the alias, item, mapping,
policy, vendor, contact, supplier-input, stock head, snapshot and option
tables; reference and options stay SELECT-only, the seed marker has no API
access, and the worker and PUBLIC have no fixture access. The inherited
purchasing and inventory DML of ADR 0005 is unchanged. Rerunning the migration
still removes table and column privilege drift, including a column-level
UPDATE on a reference field.

As in ADR 0005, this is record ownership, not isolation: the API role could
read these tables with its own SQL, and lint is not row-level tenant
authorization. The guards are extended, not exempted:

- The API's import allowlist gains `@supplier-disruption/db/reference`; the
  worker and web still may not import it. Reference tables, initialization and
  source files stay unimportable from the API, other authorities, the db root
  and the worker entry, and a db self-import still fails.
- The literal-SQL boundary test accepts `fixture_reference` SQL only inside the
  reference directory; `reads.ts` belongs to no owner, so any fixture SQL there
  fails. The seed, controlled-clock and Drizzle setup exceptions are unchanged.
- D2 checks structurally that no root, worker or public source entry export is
  a fixture table or schema, and that the reference entry exports only its
  factory and the timeout defaults as values.

## Downstream use

| Consumer            | Reads                                                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coverage assessment | `readItem`, `readItemMappings` (policy interprets dates, overlaps and ratios), four `readPolicy` calls at version 1, and `readTransferOptions` for the canonical scope; a complete empty option set is bindable evidence, `not_found` and `unavailable` are not |
| Intake guards       | `readSupplierInput` (compares the stored hash with the returned terms), `readRegisteredVendor` (an ambiguous sender is not a verified vendor) and `readVendor`                                                                                                  |

Both consume the actual outcomes, never a missing-data fallback or private
import, and must refresh against the merged signatures.

## Deferred responsibilities

Policy eligibility and effective-mapping selection, UOM conversion, allocation,
approval and cost checks, plan hashes, intake acceptance, quarantine and
deduplication, sender authentication, digest validation, evidence storage,
HTTP routes, worker jobs and agent tools stay with their tasks. ADR 0005's
deferred items are unchanged: option `valid_until` is enforced at claim or
execution, N-08 fencing is absent, lookup absence never proves no effect, and
transit stays single-organization fixture behavior.

## Verification

Gates R1 to R5 run in `test:integration`, each file in its own disposable
Compose project, reusing the fixture authority harness name
`supplier-disruption-itdb-<run>-<gate>` with gates `r1` to `r4`, removed also on
failure. Expected records are oracle literals or labeled supplemental rows
written with raw SQL; results are confirmed with raw SQL on separate migrator
connections, lock waits are observed in `pg_locks`, and purity is a fingerprint
of every source, reference and application row with its `xmin`. R6 extends D2
and the import-boundary test.

| Gate | File                                                                                   |
| ---- | -------------------------------------------------------------------------------------- |
| R1   | `packages/db/test/r1-reference-records.test.ts`                                        |
| R2   | `packages/db/test/r2-reference-identity.test.ts`                                       |
| R3   | `packages/db/test/r3-read-provenance.test.ts`                                          |
| R4   | `packages/db/test/r4-transfer-options.test.ts`                                         |
| R5   | bound and purity cases in R1, R2 and R4                                                |
| R6   | `packages/db/test/d2-source-grants.test.ts`, `scripts/test/import-boundaries.test.mjs` |
