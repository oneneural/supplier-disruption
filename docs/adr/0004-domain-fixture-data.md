# ADR 0004: Domain contracts, business clock and canonical fixture data

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-19

## Context

The first slice needs typed source records, injectable business time and the
exact C-01 inputs of the frozen oracle (`docs/oracles/first-slice-oracles.md`,
SHA-256 `b90368cb66fec1b3122092153bd98337292b168b68ca5a568a46878fe189e8ea`)
before the authority, policy and intake tasks can start. This record states the
representation, the persistence and seed design, the values the oracle leaves
unspecified and the responsibilities deferred to later tasks.

## Contracts

`packages/contracts/src/domain/` holds browser-safe Zod 4 schemas with inferred
types and the contract literal `supplier-domain.v1`. Every record is a strict
object, so unknown fields reject. Nothing is coerced.

| Concept                               | Representation                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business labels (`PO-120`, line `10`) | Scoped text, `^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$`. `"010"` and `"10"` are different labels                                                                                              |
| Quantities                            | Canonical nonnegative integer decimal strings, at most 18 digits, no leading zeros; positive where a segment, reservation, transit or quote needs it. JSON numbers and fractions reject |
| Database quantities                   | `numeric(18,0)`, read back as text; never JavaScript numbers                                                                                                                            |
| UOM                                   | A stated label (`EA`), so `CTN` or `BOX` can arrive as unsupported input. No conversion exists outside an effective item-master mapping                                                 |
| Mapping ratio                         | Positive integer numerator and denominator strings                                                                                                                                      |
| Money                                 | Safe integer minor units plus an ISO currency code                                                                                                                                      |
| Dates                                 | `YYYY-MM-DD`, validated as calendar days                                                                                                                                                |
| Instants                              | ISO 8601 with seconds and an offset or `Z`; offset-free instants reject                                                                                                                 |
| Unknown values                        | `{ "state": "unknown" }` or `{ "state": "known", "value": ... }`; arrivals are `dated` or `undated`. Unknown is never zero or a fabricated time                                         |
| Policies                              | A union discriminated by `policyId`, carrying only the parameters the fixture binds                                                                                                     |

Stock snapshots keep physical stock, quality holds, safety stock and
individually identified reservations as separate fields. There is no eligible
field: eligibility is derived by policy `ELIG-1`. Expected inbound is a
reference to a purchasing source identity, and in-transit records are separate
records. A supplier proposal is separate from the accepted PO revision and
never adds supply beside it. A transfer option is not a confirmation.

The supplier input's content hash is the SHA-256 of the canonical JSON (keys
sorted by code point, no whitespace) of the supplier-stated terms. It excludes
the message ID, source system and input version, so the same terms resent
under another message ID hash alike.

## Persistence

One private schema per source, each with its initialization writer under
`packages/db/src/authorities/<source>/`:

| Schema               | Tables                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixture_purchasing` | `po_revision`, `po_line`, `po_line_segment`                                                                                                                       |
| `fixture_inventory`  | `stock_snapshot`, `reservation`, `transfer_option`, `in_transit`                                                                                                  |
| `fixture_demand`     | `demand_snapshot`, `demand_line`, `supply_link`                                                                                                                   |
| `fixture_reference`  | `organization_alias`, `vendor`, `vendor_contact`, `item`, `item_mapping`, `actor`, `policy`, `supplier_input`, `scenario_timing`, `business_clock`, `seed_marker` |

Migration `0002_domain_fixture_inputs` creates them and sets the schema tag.
The migrator owns them. The API role has `USAGE` on the four schemas and
`SELECT` on the named input tables, including the business clock but not the
seed marker, which is seed bookkeeping that no API code reads. The worker role
and `PUBLIC` have nothing. No function is created. Only migration,
initialization and tests write these records; runtime authority methods belong
to the fixture source modules (ADR 0005).

Checks hold what the contracts require, so direct fixture maintenance cannot
store a value the contracts reject in these cases: quantities are
`numeric(18,0)` and positive where required, a transfer option arrives on or
after its dispatch date and goes between two warehouses, and its
`cost_minor_units` lies between 0 and 9007199254740991. That column is read as
a JavaScript number, so a larger value would read back rounded.

`ORG-NDL` is an alias row (`organization_alias`) mapping the label to a stable
application UUID. It deliberately has no `app.organization` row and no
membership: the actors are registry inputs, not sign-ins, and the pilot
organization, users, memberships and passwords are unchanged.

## Seed

`apps/api/src/seed.ts` runs pilot provisioning, then `initializeCanonicalInputs`.
It holds a session advisory lock (`hashtext('supplier-disruption:seed')`) for
the whole run, and the initialization also takes the same key as a
transaction lock, so a library caller is serialized too. In one transaction:

1. A marker that matches the manifest version, manifest hash and oracle hash
   means nothing changes. Advanced clock and maintained source rows remain.
2. A marker that does not match raises `CanonicalSeedConflictError` naming the
   stored and expected values. Nothing is repaired.
3. Without a marker, any row in a canonical table raises the same error.
4. Otherwise every input row is written, and the marker last.

A failure at any point rolls back the inputs and the marker together. Nothing
reseeds at app start. Operator reset remains the explicit named-volume
procedure in the README. Test reset recreates a disposable Compose database
(`supplier-disruption-itapi-<run>-<gate>`) and runs the normal migrate and seed.

The manifest hash is the SHA-256 of the canonical JSON of the manifest. It
changes whenever any manifest value changes, which makes an old marker
mismatch rather than silently mixing versions. The D10 and D12 gates pin the
hash of the reviewed manifest as a literal,
`57547d808324fcb2c8572295048a945aed542c9bde39f8e28ed8c60bdc78c48e`.

## Business clock

`Clock.now()` in contracts returns an offset-qualified instant. `systemClock`
(config) samples real time. `createControlledClock` (db) reads
`fixture_reference.business_clock` on every call and returns UTC with
millisecond precision; a missing row or an unusable value throws
`BusinessClockError` and never falls back to real time. The API composes the
clock from `DOMAIN_CLOCK_MODE` (`system` by default) and exposes it as
`app.businessClock`; `buildApp` also accepts an injected clock. `controlled` is
accepted only with `NODE_ENV=test` and `DATA_MODE=fixture`, otherwise startup
fails. The packaged API is started with `env -i` and a fixed variable list, so
no override reaches it; it logs its mode once at start.

Sessions, pg-boss, heartbeat, watchdog, timeout and shutdown timers keep real
time. Tests advance the clock with a direct migrator update; there is no
advance API or HTTP clock route.

## Unspecified values

The oracle does not state these. They are recorded here and listed in the D11
gate so an untraced input path fails:

| Value                                                              | Choice                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture version                                                    | `first-slice-c01.v1`                                                                                                                                                                                                                                    |
| Contract version on every record                                   | `supplier-domain.v1`                                                                                                                                                                                                                                    |
| `ORG-NDL` application UUID                                         | `ed222926-927c-460e-8d28-e22ab5620819`                                                                                                                                                                                                                  |
| Organization label on source records                               | `ORG-NDL`                                                                                                                                                                                                                                               |
| `MAP-1` version and vendor                                         | Version `1`; vendor `V-100` owns the mapped item `KF-A-01`.                                                                                                                                                                                             |
| Supplier input source system, input version and evidence reference | `fixture-supplier-mail`, `1`, `MSG-0001@1`                                                                                                                                                                                                              |
| `MSG-0001` authored and received times                             | Unknown                                                                                                                                                                                                                                                 |
| `PROP-1` unresolved fields                                         | None                                                                                                                                                                                                                                                    |
| `PO-120` observation time and effective date                       | Unknown                                                                                                                                                                                                                                                 |
| `DEM@1` observation time                                           | Unknown                                                                                                                                                                                                                                                 |
| Number of `PO-120` line `10`'s only accepted segment               | `1`                                                                                                                                                                                                                                                     |
| Organization and vendor names                                      | The oracle's quoted names with the suffix ` (fictional)`, so every stored name is labeled synthetic: `Nordlund Distribution (fictional)`, `Kestrel Fasteners ApS (fictional)`. A literal comparison with the oracle's quoted names must drop the suffix |

The proposal's vendor is not stated in its terms; intake resolves it from the
registered sender.

## Deferred responsibilities

- Worker business time: the guarded-execution task adds the worker path when it
  gains a consumer, using this same database instant. There is no worker-local
  controlled clock, and this task claims nothing about future expiry
  transitions or worker propagation.
- Evidence: original message bytes, retrieval, locators, the persistent
  evidence volume and its recreation and hash proof (BA-02) belong to intake
  and evidence work. The seeded supplier input is a normalized structured
  record awaiting intake, not accepted evidence.
- Source command, receipt and fence schemas, runtime authority methods and the
  module-ownership lint rule belong to the fixture source modules (ADR 0005). Plans, allocations, approvals,
  acknowledgements, case states and journals belong to their owning tasks.
- Organization identity: the first task to scope application records to
  `ORG-NDL` must create `app.organization` with exactly the UUID
  `ed222926-927c-460e-8d28-e22ab5620819`, or explicitly re-map the alias, and
  then add the foreign keys from `organization_alias` and from the source
  records' `organization` label columns. Until then nothing references the
  UUID, and nothing checks the label columns against the alias.
- General fractional-UOM support waits for a reviewed case that needs it.

## Verification

D1 (`packages/contracts/test/domain.test.ts`), D9
(`apps/api/test/domain-clock.test.ts` and `packages/config/test/config.test.ts`),
D10 (`apps/api/test/domain-seed.test.ts`), D11
(`apps/api/test/oracle-trace.test.ts`) and D12
(`scripts/container/domain.test.mjs`). Expectations are independently written
literals in `apps/api/test/canonical-inputs.ts`, compared with raw SQL on a
separate connection; none is imported from the seed manifest.
