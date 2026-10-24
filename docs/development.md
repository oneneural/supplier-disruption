# Development and operations

Commands below are defined in [package.json](../package.json) or the scripts
named in this guide. [Verification results](verification.md) records command
outcomes, including the latest complete snapshot, container and demo run. A result at one revision does not prove a later one.
`corepack pnpm screenshots` regenerates the README captures; see the
[screenshot index](demo/screenshots/README.md).

Start with [AGENTS](../AGENTS.md), [architecture](../ARCHITECTURE.md),
[configuration](../.env.example) and the [demo walkthrough](demo/README.md).
Live provider examples describe capabilities. Metered work needs separate
authorization and reconciliation inside the cumulative USD 20 budget with a
mandatory pause at USD 15. See [spend accounting](adr/0017-project-spend-reservations.md).
Compose passes only declared environment variables and mounts to the app;
live-container configuration requires explicit provider and secret wiring.

## Development setup

Prerequisites: Node 24.22.0, Docker with Compose v2, and Corepack. Run pnpm
through `corepack pnpm`; the repository pins pnpm 12.14.0 and does not need
`corepack enable` or a global install.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm secrets:init        # writes .secrets/ once; never overwrites or prints values
cp .env.example .env              # new checkout only; preserve an existing .env
corepack pnpm build:packages      # compiles the Node packages the commands below run
corepack pnpm db:up               # Compose project supplier-disruption, db on 127.0.0.1:55102
corepack pnpm db:migrate          # Drizzle, pg-boss schema, pilot and case queues, role grants
corepack pnpm db:seed             # synthetic organizations, buyer and manager, simulated case actors and the canonical C-01 inputs
```

Migrate and seed are safe to rerun; a rerun changes nothing. The seed writes
the canonical C-01 input records of the frozen oracle once, with a marker; it
fails without repairing anything if the marker or existing rows do not match.
Representation, the business clock and deferred work are in
[ADR 0004](adr/0004-domain-fixture-data.md). Migration
`0003_source_runtime_heads` adds explicit current versions, operation records,
receipts and transfer requests to the purchasing, inventory and demand
fixtures, and backfills the heads of a database seeded earlier without changing
its rows, clock or marker. The source modules, their transactions, grants and
limits are in [ADR 0005](adr/0005-fixture-authority-transactions.md). A
change to the canonical manifest changes its hash, so an existing volume then
fails the seed until it is explicitly recreated; nothing repairs or reseeds it.
To rebuild the development database from an empty volume (this deletes its
data):

```sh
sh scripts/db-reset.sh --delete-volume=supplier-disruption_db-data
```

Checks:

```sh
corepack pnpm lint                # builds package types, then ESLint with typed rules and import boundaries
corepack pnpm format:check        # Prettier 3.9.10
corepack pnpm typecheck
corepack pnpm test                # unit tests, lint-rule and secrets-script tests; no database
corepack pnpm test:integration    # needs the database above and Docker; about 7 minutes
corepack pnpm build               # all packages and next build
```

After pulling a commit that adds a migration, run `corepack pnpm build:packages`
and `corepack pnpm db:migrate` before `test:integration`. The G3 roles test
expects the Compose database to be current: it compares the catalog before and
after rerunning migrate and seed, so a pending migration fails it.

The integration tests run against the Compose PostgreSQL and observe results
through a separate connection. They start the API in-process and spawn the built
API and worker processes, including SIGKILL and SIGTERM cases. The fresh-volume
test starts a disposable Compose project, `supplier-disruption-fresh`, on a free
loopback port and removes it and its volume when it finishes.

The domain gates: D1 input contracts run in `corepack pnpm test`;
D9 business clock, D10 seed idempotency and D11 oracle trace run in
`test:integration`, each in its own disposable Compose database project,
`supplier-disruption-itapi-<run>-<gate>`, removed also on failure. To run them
alone after `corepack pnpm build:packages`:

```sh
corepack pnpm --filter ./packages/contracts exec vitest run test/domain.test.ts
corepack pnpm --filter ./apps/api exec vitest run test/domain-clock.test.ts test/domain-seed.test.ts test/oracle-trace.test.ts
```

The source gates D2 to D8 also run in `test:integration`, each file in
its own disposable project, `supplier-disruption-itdb-<run>-<gate>`, removed
also on failure. The import-ownership part of D2 runs in `corepack pnpm test`.
To run them alone after `corepack pnpm build:packages`, which also builds the
migrate and seed commands they run:

```sh
corepack pnpm --filter ./packages/db exec vitest run test/d2-source-grants.test.ts test/d3-purchasing.test.ts test/d4-reservation.test.ts test/d5-transfer.test.ts test/d6-identity.test.ts test/d7-separate-commits.test.ts test/d8-demand.test.ts
corepack pnpm --filter ./packages/contracts exec vitest run test/commands.test.ts
```

The reference reads are the public subpath
`@supplier-disruption/db/reference` (`createReferenceSource`) and the inventory
method `readTransferOptions`. They return explicit `ok`, `not_found`,
`ambiguous` or `unavailable` outcomes, bind every reference read to one trusted
fixture organization configured at composition, and change no schema, grant or
seed; see [ADR 0006](adr/0006-public-reference-reads.md) for the binding,
bounds and limits. Their gates R1 to R5 run in `test:integration`, each file in
its own disposable project with the same inherited
`supplier-disruption-itdb-<run>-<gate>` name (gates `r1` to `r4`); R6 extends
D2 and the import-boundary test. To run them alone after
`corepack pnpm build:packages`:

```sh
corepack pnpm --filter ./packages/db exec vitest run test/r1-reference-records.test.ts test/r2-reference-identity.test.ts test/r3-read-provenance.test.ts test/r4-transfer-options.test.ts test/d2-source-grants.test.ts
```

The policy package `@supplier-disruption/domain` turns those reads
into a deterministic coverage assessment: ELIG-1 eligibility, CAL-CPH-1
cutoffs, ALLOC-1 allocation, a conditional exact-quote transfer stage, AUTH-1
cost and required decisions, and for a feasible case an immutable plan whose
SHA-256 binds every read, version and content digest. It is pure (contracts
and `node:crypto` only), stores nothing and writes no source; see
[ADR 0007](adr/0007-coverage-allocation-plans.md) for the rules, the
`policy_` reasons and the limits. Gates P1 to P6 run in `corepack pnpm test`;
P7 composes the public reads in `test:integration`, in its own disposable
project with the same inherited name (gate `p7`). To run them alone after
`corepack pnpm build:packages`:

```sh
corepack pnpm --filter ./packages/domain test
corepack pnpm --filter ./packages/contracts exec vitest run test/assessment.test.ts
corepack pnpm --filter ./packages/db exec vitest run test/policy-read.test.ts
```

The intake guards (`intakeAndAssess` in `@supplier-disruption/domain`)
classify one structured supplier input as `accept`, `duplicate` or `blocked`
before any assessment: exact registered sender, recomputed terms digest,
trusted prior acceptance for the message key, then the exact current PO head,
line and base revision. Only an accepted input reaches the coverage assessment.
The pure intake function stores nothing; the case workflow below persists
its receipt and duplicate deliveries. The pure-stage limitation is historical. Registered-sender matching is simulated attribution,
not email authentication. See
[ADR 0008](adr/0008-intake-identity-guards.md) for the guard order, the
`intake_` reasons and the limits. Gates I1 to I5 run in `corepack pnpm test`;
I6 composes the public reads in `test:integration`, in its own disposable
project with the same inherited name (gate `i6`). To run them alone after
`corepack pnpm build:packages`:

```sh
corepack pnpm --filter ./packages/domain exec vitest run test/intake.test.ts
corepack pnpm --filter ./packages/contracts exec vitest run test/intake.test.ts
corepack pnpm --filter ./packages/db exec vitest run test/intake-read.test.ts
```

The case workflow persists cases in the `app` schema (migration
`0004_case_workflow`). The API stores each supplier message delivery with its
exact bytes and SHA-256, runs the intake guards, persists the hashed plan,
binds decisions and simulated acknowledgements to the plan hash and applies
ACT-1 to ACT-3 in a `case-application` worker job. Every write has a stable
operation ID, and an uncertain write is reconciled by read-back before any
retry. Verification reads the authoritative records back before the case is
`plan_verified`, which is not evidence of physical delivery. The synthetic pilot
organization is the case tenant, and its source records are the fixture
organization ORG-NDL; the seed binds the simulated case actors to the buyer and
manager accounts. Routes, records, freshness rules and limits are in
[ADR 0009](adr/0009-durable-case-workflow.md). Its tests run in
`test:integration`, each on its own disposable project
`supplier-disruption-itapi-<run>-<gate>` (gates `c01`, `n06`, `n06d`, `n09`
and `outage`). The guard extensions below supersede the earlier policy/freshness
behavior. To run the original workflow gates alone after
`corepack pnpm build:packages`:

```sh
corepack pnpm --filter ./apps/api exec vitest run test/c01-workflow.test.ts test/case-recovery.test.ts test/case-outage.test.ts
```

### Current policy and execution guards

[ADR 0013](adr/0013-current-policy-execution-guards.md) describes the guard
changes. Assessment reads current policy versions. Approval checks current
AUTH-1 in its case-row transaction and returns 409 `stale_policy` with reassessment
for an outdated plan; ordinary limit refusals still return 422. Every execution
claim checks approval/expiry, current AUTH-1, bound demand/PO/stock versions and
unconfirmed transfer quotes inside the claim transaction. The case row serializes
commands and an actor-row shared lock orders revocation against the claim commit.

The API integration file `test/policy-guards.test.ts` runs G1 to G4, N-06 b/e,
BA-06 and W1/W2, each with a disposable
`supplier-disruption-itapi-<run>-<gate>` database. G1 includes concurrent approvals,
non-matching acknowledgements and a new AUTH-1 before claim; G4 covers stale policy
at decision time. N-06 b/e and BA-06 prove pre-claim demand, expiry and escalation
refusals. G2/G3 and W1/W2 are project extensions that exercise after-claim demand,
queued escalation and the guard-to-commit policy/authority windows. They do not
prove a remote transaction: a policy or demand change after the guard read can
allow the already claimed action, while later claims refuse. Revocation and
cancellation during an in-flight action are in ADR 0016 below.

Wrong-currency refusal and buyer/manager limits are also checked by the pure
`test/approval.test.ts` domain tests; a wrong-currency plan is already blocked at
assessment, so this is not stored-plan approval proof. To run these existing gates
alone after `corepack pnpm build:packages`:

```sh
corepack pnpm --filter ./packages/domain exec vitest run test/approval.test.ts
corepack pnpm --filter ./apps/api exec vitest run test/policy-guards.test.ts
```

### Interruption, cancellation and queue recovery

[ADR 0016](adr/0016-workflow-interruption-recovery.md) describes the recovery
changes: stored commands with request digests and attempt keys, read-back
before any resubmission, a bound of 8 unproven attempts and read-backs before
an action is shown as `reconciliation_unresolved`, the revocation command,
cancellation of in-flight actions and a 10 s job heartbeat. The migration
`0008_workflow_recovery` needs `corepack pnpm db:migrate` on the development
database before `test:integration`, or the API readiness test reports
`schema_incompatible`.

`test/workflow-recovery.test.ts` runs E1 (enqueue rollback), the N-08
orderings R1, R4a, R4b and R4c, U1 to U3 (the read-back bound under a
revocation, revocation after the bound, a request digest mismatch), X1
(escalation with ACT-2 unknown) and J1 (duplicate and late runs). `test/termination.test.ts` spawns the built API
(`apps/api/dist/main.js`) and worker, holds row locks with a migrator
connection as barriers and ends a process with SIGKILL at K1 to K4; it needs
`corepack pnpm build` first and takes about 2 minutes, mostly heartbeat
retries. Each gate uses its own `supplier-disruption-itapi-<run>-<gate>`
project. To run them alone:

```sh
corepack pnpm --filter ./apps/api exec vitest run test/workflow-recovery.test.ts test/termination.test.ts
```

A run killed before teardown (SIGKILL, host suspend) can leave a gate project
behind. List them with `docker compose ls --all --filter name=supplier-disruption-itdb-`
or `docker compose ls --all --filter name=supplier-disruption-itapi-`
and remove only an inactive project's containers and volume by running
`docker compose -p <project> down --volumes --remove-orphans`.

### Email extraction agent (ADR 0011)

`POST /api/cases/emails` (and the "Supplier email" form on the queue page)
accepts a pasted supplier email. A bounded LangGraph run in the API proposes
structured terms with a verbatim evidence quote or PO record citation per
field; code validates them, and the existing intake and assessment run on the
result exactly as for a structured message. Any doubt pauses the case in
`needs_clarification` with an `agent_*` reason and the buyer as owner. Design,
budget, grants and limits are in
[ADR 0011](adr/0011-extraction-agent.md).

The API's default `AGENT_PROVIDER=none` makes no model call (email cases pause
`agent_provider_unavailable`). `AGENT_PROVIDER=anthropic` reads the key only
from `ANTHROPIC_API_KEY_FILE`; see `.env.example` for the model, tool budget
and per-run cost cap. `AGENT_TOTAL_COST_CAP_USD` pauses metered runs
`agent_spend_cap_reached` before any model call once the project spend total
would pass it.
Tests never call a model: `corepack pnpm test` replays the committed
development run, and `test/email-extraction.test.ts` in
`test:integration` drives the C-01 email through a recorded run to the C-01
plan.

Evaluation (after `corepack pnpm build:packages`):

```sh
node evaluation/run.mjs --set dev --label dev-1 --mode replay --replay-label dev-1   # offline
node --env-file-if-exists=.env evaluation/run.mjs --set dev --label <new-label> --mode live --run-cap-usd 0.5   # metered
```

Reports land in `evaluation/reports/`, replays in `evaluation/replays/<label>/`.
A live run admits each case through the project spend ledger with
`DATABASE_URL_API_FILE` and refuses to start if that ledger is below the
host-side record of reported live spend in the ignored
`evaluation/.spend-ledger.json`, which it still appends to. `--output-dir`
moves reports and replays but not that record. Format new
reports with `corepack pnpm exec prettier --write evaluation` before committing.

Local services: `corepack pnpm start:api` (Fastify on 127.0.0.1:3001) and
`corepack pnpm start:worker`. The web app builds with `corepack pnpm build`;
it is served and verified from the application image (below), not from the host. The seeded identities are synthetic fixtures,
not enterprise authentication, and their passwords live in `.secrets/`.

`corepack pnpm db:down` stops the database and keeps its volume. Toolchain
observations and deviations are recorded in
[ADR 0001](adr/0001-workspace-pilot-toolchain.md).

### Project spend ledger (ADR 0017)

[ADR 0017](adr/0017-project-spend-reservations.md) describes one durable
admission for every metered model run, in the tables `app.model_spend_account`
and `app.model_spend_reservation` (migrations `0009_model_spend` and
`0010_model_spend_guards`; run `corepack pnpm db:migrate`). The API and `evaluation/run.mjs --mode live` both
reserve a run's cost cap there before calling the provider and settle it with
reported usage. A refusal is a visible pause before any provider call. A
timeout after sending, missing usage or a stopped process leaves the full
reservation counted as uncertain until an operator settles it with evidence.
Replays and the demonstration mode are not metered and reserve nothing.

A new or recreated database refuses every metered run until the operator
records the reconciled project total once, as the migrator role. Before
deleting the development volume, record `status` so the total can be carried
forward. The opening is never replaced:

```sh
node --env-file-if-exists=.env packages/db/dist/cli/spend.js status
node --env-file-if-exists=.env packages/db/dist/cli/spend.js open --micro-usd <reconciled total> --evidence "<sources>"
node --env-file-if-exists=.env packages/db/dist/cli/spend.js reconcile --key <reservation key> --micro-usd <cost> --evidence "<provider console usage>"
```

`packages/db/test/spend-ledger.test.ts` in `test:integration` races ten
individually admissible reservations from two pools, checks idempotent and
conflicting settlement, uncertain usage, restart, a recreated database, the
command and the evaluation runner stopping at admission. Run it alone after
`corepack pnpm build:packages`:

```sh
corepack pnpm --filter ./packages/db exec vitest run test/spend-ledger.test.ts
corepack pnpm --filter ./apps/api exec vitest run test/email-extraction.test.ts
```

### Checkpoint recovery (ADR 0019)

[ADR 0019](adr/0019-checkpoint-recovery.md) describes how an extraction run
left unfinished by a stopped API resumes from its PostgreSQL checkpoint. The
graph state carries a checkpoint contract (version, model, evidence digest,
tool budget and cost cap); a checkpoint under another contract pauses the
case `agent_checkpoint_incompatible` for the buyer and is kept unchanged.
One delivery of a case job extracts at a time behind a session advisory lock.
A resumed attempt reserves only the run cap left after the checkpoint's cost,
while the stopped attempt stays uncertain in the spend ledger. Refusal,
unavailable model, malformed response and provider failure pause with
distinct reasons. No migration or new configuration variable is needed.

`test/checkpoint-recovery.test.ts` in `test:integration` spawns the built API
(`apps/api/dist/main.js`) and worker on disposable databases
(`supplier-disruption-itapi-<run>-ckpt` and `-ckptfresh`). The API runs
`AGENT_PROVIDER=anthropic` against a local fake Messages API through the
SDK's own `ANTHROPIC_BASE_URL`, with a placeholder key file, so no provider
is called. The fake holds a model turn while the test kills the API with
SIGKILL (M1 to M4). M5 holds intake's organization lock to commit an
escalation between the hand-off check and intake. It needs
`corepack pnpm build` first and takes about a minute. To run it alone:

```sh
corepack pnpm --filter ./apps/api exec vitest run test/checkpoint-recovery.test.ts
corepack pnpm --filter ./packages/agent exec vitest run test/graph.test.ts
```

### Session and stream security (ADR 0020)

[ADR 0020](adr/0020-session-stream-security.md) limits sign-in per account
(3 attempts per 10 s, keyed on the normalized email) under a shared ceiling of
30 per 10 s, in production only. An open pilot stream rereads the session and
membership before every event and closes with `reason=revoked` within about
one 1 s interval. Each event has `id: <operationId>:<seq>`; a reconnect with
`Last-Event-ID` resumes the same bounded sequence, and the final ID answers 204. This is not durable case-event replay. `POST /api/cases/ingest` answers
409 `invalid_case_state` when the case is no longer open to intake. No
migration or new configuration variable is needed.

`test/session-stream.test.ts` runs on the Compose database and
`test/case-leakage.test.ts` on a disposable one
(`supplier-disruption-itapi-<run>-leak`), both in `test:integration`. The
container gates P2, P3 and P9 repeat refresh, per-account limits, revocation
and resume through the proxy. To run them alone after
`corepack pnpm build:packages`:

```sh
corepack pnpm --filter ./apps/api exec vitest run test/session-stream.test.ts test/case-leakage.test.ts
corepack pnpm test:container proxy stream browser
```

### Backup, restore and lifecycle bounds (ADR 0021)

[ADR 0021](adr/0021-restore-and-lifecycle-bounds.md) adds a logical backup of
one Compose project's database from a single exported snapshot, a restore that
only goes into an empty database and checks the result against the backup's
manifest, and hung-watchdog detection. The
[backup and restore runbook](operations/backup-restore.md) covers consistency,
storage, restore steps and what is not backed up. No migration or new
configuration variable is needed:

```sh
corepack pnpm db:backup -- --output <new directory outside the checkout> [--project <name>]
corepack pnpm db:restore -- --input <backup directory> --project <new project with an empty database>
```

The container gates `restore.test.mjs` (B1 fresh-volume restore with an
unfinished action, B2 recreation of the restored app) and `lifecycle.test.mjs`
(L1 hung watchdog, L2 TERM-to-KILL escalation) run in their own disposable
projects. To run them alone:

```sh
corepack pnpm test:container restore lifecycle
```

### ERPNext sandbox connector (ADR 0018)

[ADR 0018](adr/0018-erpnext-sandbox-connector.md) describes
`packages/connector-erpnext`, a proof connector for a disposable local
ERPNext 16.52.0 sandbox. Nothing in the API, worker, demonstration or Compose
files uses it. `corepack pnpm test` runs its unit tests on recorded, redacted
sandbox responses with no network access.

The live proof needs the sandbox running on a loopback IP origin (`127.0.0.1`
or `[::1]`) and its
credentials file outside the repository. It skips unless both variables are
set, in the environment or in `.env` (see `.env.example`); relative paths
resolve from the repository root:

```sh
ERPNEXT_BASE_URL=http://127.0.0.1:18082 \
ERPNEXT_CREDENTIALS_FILE=<path to the sandbox api-user.env> \
corepack pnpm test:sandbox
```

Setting `ERPNEXT_EVIDENCE_DIR=docs/evidence/erpnext-sandbox` also writes redacted
request, response and read-back files and `results.json`; format them with
`corepack pnpm exec prettier --write docs/evidence/erpnext-sandbox` before committing.
The run writes only to the sandbox's probe records: it changes the schedule
date of the probe purchase order and adds draft PROBE-A transfers, which move
no stock. It reads the canonical C-01 records and checks them unchanged. Reset
the sandbox with its own documented steps, never with a broad Docker cleanup.

## Application image

One non-root image runs the Next.js web server, the Fastify API and the pg-boss
worker under s6-overlay, beside the separate PostgreSQL service. It starts from
the image alone: no source mount, no host Node and no installation at start.
Design, bounds, exit codes and limits are in
[ADR 0002](adr/0002-app-image-lifecycle.md).

```sh
corepack pnpm secrets:init                  # also writes .secrets/container/ URLs for db:5432
docker compose build app                    # native platform; needs the npm registry and GitHub
docker compose run --rm init                # migrations, grants, schema tag and fixture seed
docker compose up --detach --wait app       # http://127.0.0.1:3102
docker compose stop app                     # drains in-flight work, exits 0
```

Only `127.0.0.1:3102` is published; the API listens on 127.0.0.1:3001 inside the
container. The app container has a read-only root filesystem, no capabilities,
`no-new-privileges`, and only the API and worker database URLs, the Better Auth
secret and the worker token as secrets. The `init` service alone mounts the
migrator URL and fixture passwords. Docker's health status is aggregate
readiness: API readiness, the web server, and a fresh worker heartbeat from
this container boot. A dead or hung essential service makes the container exit
nonzero with a `sd-first-failure` line in `docker compose logs app`, and
`restart: unless-stopped` starts it again. The healthcheck also halts the
container with `hang:watchdog` when the watchdog itself stops beating for 20 s
(ADR 0021). `docker compose down` keeps the `db-data` volume; it is not a
backup (see the [runbook](operations/backup-restore.md)).

Container gates (C1 to C10) build the image and its build stage from a fresh
clone of `HEAD` and drive Docker in disposable projects named
`supplier-disruption-ct-<run>-<gate>` on free loopback ports. When the run
ends, also after a failed test, its teardown removes that run's projects and
every container, volume and network labelled with them, then both test images
and the clone. If the setup itself fails, it removes what it created before
reporting the error. They never touch the `supplier-disruption` project:

```sh
corepack pnpm exec playwright install chromium-headless-shell   # once; the P1, W1, W4 and W5 browser gates need it
corepack pnpm test:container      # about 15 minutes; needs Docker, the npm registry and GitHub
```

The same run includes the proxy and stream pilot gates, each in its own disposable project:
`proxy.test.mjs` (P2 cookie multiplicity and refresh, P3 authorization and
per-account sign-in limits, P4 internal boundary with raw request targets, P7
leakage), `stream.test.mjs` (P5 event flushing, P6 stream authorization and
disconnect cleanup, P9 revocation and Last-Event-ID resume, P8 a stop with a
held job and an open stream) and `browser.test.mjs` (P1, Playwright 1.64.1
driving Chromium's headless shell at the app origin, with every other origin
blocked). Pass file names to run a subset, for example
`corepack pnpm test:container proxy stream browser`. `domain.test.mjs` (D12)
checks the packaged seed: the image's init creates the canonical inputs, the
app runs with the system business clock, and repeat init and app recreation
keep them. Design and observations
are in [ADR 0003](adr/0003-proxy-cookies-and-streams.md).
`demonstration.test.mjs` (W2 and W3) drives the demonstration mode of
[ADR 0012](adr/0012-demonstration-mode.md) through the production image:
the replayed C-01 email with a stale approval that escalates, and a lost
reservation response reconciled to a verified plan with one effect.
`workbench.test.mjs` (W1) drives the C-01 case through the workbench in the
browser, from loading the fixture message to `plan_verified` with read-back
evidence. The C-01 fixture is time-bound, so W1's project alone runs the API
on the controlled business clock at the seeded instant, with `NODE_ENV=test`
and `DOMAIN_CLOCK_MODE=controlled`; the default image and Compose file keep the
system clock ([ADR 0010](adr/0010-operator-workbench.md)).
`clarification.test.mjs` (W4) runs on the same controlled clock with no model
provider. It submits an ambiguous email whose remaining quantity has no date,
saves a question that stays an unsent local draft, records the supplier
contact's reply, cites the email and the reply for every field in a correction
and checks the resumed assessment awaiting approval with the C-01 totals
([ADR 0014](adr/0014-clarification-correction-resume.md)). Run it alone with
`corepack pnpm test:container clarification`.
`revision.test.mjs` (W5) runs on the same controlled clock. It drives C-01 to
a verified plan, moves the business clock past the four-hour validity, checks
that the workbench shows the verification as expired with the earlier
read-back kept, rechecks it as the planner, then stores a later supplier
revision (MSG-0002) and follows the link from the superseded case to its
successor, whose coverage counts PLAN-1's transfer without a new request
([ADR 0015](adr/0015-verification-currency-and-revisions.md)). Run it alone
with `corepack pnpm test:container revision`.
`termination.test.mjs` (K5) runs on the same controlled clock. It holds row
locks with superuser `psql` sessions in the project's database container, kills
the app container with `docker kill` after ACT-1's amendment commits and
before its journal update, then starts it again and checks that C-01 finishes
with one amendment, one reservation and one transfer request
([ADR 0016](adr/0016-workflow-interruption-recovery.md)). Run it alone with
`corepack pnpm test:container termination`.

The operator workbench at `http://127.0.0.1:3102` signs a fixture identity in
and opens the exception queue. "Load fixture message" ingests the stored C-01
message, MSG-0001, and opens its case: the supplier's stored message with a
locator for every extracted field, current and proposed schedule, demand
impact, recovery options, review controls for simulated roles and the action
timeline with read-back evidence. Design, routes and limits are in
[ADR 0010](adr/0010-operator-workbench.md). The toolchain pilot moved to
`/pilot`: it submits the pilot operation and renders its bounded status
stream (`GET /api/pilot/operations/:id/events`: five events a second apart) as
each event arrives, then its receipt.

`SD_CT_SOURCE=worktree` tests the working tree instead of `HEAD` while
iterating (the C1 test then fails by design), and `SD_CT_KEEP_IMAGE=1` keeps
the final test image. A run killed before its teardown leaves its resources;
`node scripts/container/sweep.mjs` removes every `supplier-disruption-ct-*`
container, volume, network and test image, so run it only when no container
test run is active.
