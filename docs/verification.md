# Verification results and known limits

This record lists recorded checks and their scope. The latest complete run is
the [snapshot verification](#snapshot-verification) of this repository's tree
on 2026-10-24: every application check, the integration suite, the full
container suite and the no-key demo passed. Earlier rows were recorded at
earlier development revisions, before this repository's single snapshot
commit; those revisions are not part of its history. A passing older revision
is not proof of a later one.

## Recorded commands and revisions

Application check group A consists of these existing commands, each recorded
with exit 0 where the table says A:

```sh
corepack pnpm lint
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:integration
```

Group B is A without `corepack pnpm test:integration`. Each row was recorded at
its own development revision. Counts below describe the selected run only. They do not add up to a new combined verification result.

| Scope                                                                                        | Application checks | Additional recorded command or scope                                              | Result and limit                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Canonical demo and full container suite](adr/0012-demonstration-mode.md)                    | A                  | `corepack pnpm demo`; `corepack pnpm test:container`                              | Clean-state demo; container 51/51; all listed application checks exit 0.                                     |
| [Current policy and claim guards](adr/0013-current-policy-execution-guards.md)               | A                  | No full container rerun recorded.                                                 | Decision/claim checks and focused races passed; later changes can still follow a granted claim.              |
| [Clarification and cited correction](adr/0014-clarification-correction-resume.md)            | A                  | `corepack pnpm test:container clarification`                                      | Exit 0, W4 1/1; integration db 105, API 295, worker 51.                                                      |
| [Verification currency and later revisions](adr/0015-verification-currency-and-revisions.md) | A                  | `corepack pnpm test:container revision`                                           | Exit 0, W5 1/1; integration db 105, API 308, worker 51.                                                      |
| [Interruption and cancellation recovery](adr/0016-workflow-interruption-recovery.md)         | A                  | `corepack pnpm test:container termination domain`                                 | Exit 0; K1–K4 process SIGKILL and K5 container kill recorded; stable effects after recovery.                 |
| [Concurrent spend admission](adr/0017-project-spend-reservations.md)                         | A                  | No metered provider call.                                                         | Exit 0; ten-way admission race and uncertain reservations; integration db 115, API 323, worker 51.           |
| [Mid-investigation checkpoint recovery](adr/0019-checkpoint-recovery.md)                     | A                  | No metered provider call; local fake Messages API.                                | Exit 0; PostgreSQL checkpoint resume after SIGKILL, incompatible-contract refusal and fresh domain evidence. |
| [Sessions and bounded stream authorization](adr/0020-session-stream-security.md)             | A                  | `corepack pnpm test:container proxy stream browser`                               | Exit 0; refresh, account limits, stream revocation and bounded resume.                                       |
| [Browser session refresh and stream resume](adr/0020-session-stream-security.md)             | A                  | `corepack pnpm test:container browser stream proxy`                               | Exit 0, 21/21.                                                                                               |
| [Backup restore and lifecycle](adr/0021-restore-and-lifecycle-bounds.md)                     | B                  | `corepack pnpm test:container lifecycle restore`                                  | Exit 0, 7/7 from a fresh clone. Integration was not rerun on this revision.                                  |
| [Earlier restore integration](adr/0021-restore-and-lifecycle-bounds.md)                      | A                  | `corepack pnpm test:container restore`                                            | Exit 0, 4/4; includes integration at this earlier revision.                                                  |
| [Earlier targeted container combination](adr/0021-restore-and-lifecycle-bounds.md)           | None recorded here | `corepack pnpm test:container restore lifecycle readiness stream failures`        | Exit 0, 25/25 from a fresh clone. This is a subset, not a full-suite result.                                 |
| [ERPNext connector static/unit/integration checks](adr/0018-erpnext-sandbox-connector.md)    | A                  | No live run attributed to this row.                                               | Exit 0; connector 32 network-free unit tests; integration db 115, API 323, worker 51.                        |
| [ERPNext live sandbox repeat](adr/0018-erpnext-sandbox-connector.md)                         | Not claimed        | `corepack pnpm test:sandbox`, with sandbox URL and credentials-file variables set | 9/9 against a reset local synthetic sandbox; separate from the application path.                             |

The latest complete container suite is the [snapshot run](#snapshot-verification).
Before it, the final pre-release revision passed 66/66 and an earlier revision
51/51; the focused results between them establish only their stated scope.

The restore integration result belongs to the earlier revision above. It was
not rerun at the later lifecycle revision because the intervening changes did
not affect `apps/` or `packages/`. This records the actual evidence boundary, not a new exemption.

## Demonstrated workflow

The synthetic canonical case starts with 120 EA of demand. Destination stock has
40 physical units and 10 unrelated reservations, leaving 30 eligible. The
supplier proposes 40 on-time and 80 late units. On-time coverage is 70 EA and the
gap is 50 EA. An exact-SKU transfer covers 50 EA for EUR 160, above the
buyer limit of EUR 100 and within the manager limit of EUR 500.

Recorded integration and packaged-browser paths demonstrate approval refusal,
matching simulated acknowledgements, a reservation response lost after commit,
operation-ID reconciliation and source read-back to `plan_verified`. A changed
stock version refuses the stale plan and retains the history. Clarification
questions stay unsent; recorded replies and evidence-supported corrections
produce new assessments whose decisions must bind the new plan.

Verification has a four-hour validity and a retained read-back history. A later
accepted revision can link a successor that inherits prior commitments instead
of reserving the same transfer twice. Receipt observations book no stock. See
[workflow](adr/0009-durable-case-workflow.md),
[demonstration](adr/0012-demonstration-mode.md),
[clarification](adr/0014-clarification-correction-resume.md) and
[revision semantics](adr/0015-verification-currency-and-revisions.md).

## Extraction evaluation history

Model: `claude-haiku-5-5`. All cases are fictional. Outcomes and exact extraction
have different denominators. Preserve the original reports beside later rescores.

| Run                                                                                | Correct outcomes | Exact extraction | Critical violations | Recorded cost     |
| ---------------------------------------------------------------------------------- | ---------------- | ---------------- | ------------------- | ----------------- |
| [dev-1 live](../evaluation/reports/dev-1-live.md)                                  | 23/25            | 16/18            | 0                   | USD 0.015312      |
| [Untouched holdout-1 live](../evaluation/reports/holdout-1-live.md)                | 6/10             | 5/9              | 0                   | USD 0.008955      |
| [Exposed holdout-2 regression](../evaluation/reports/holdout-2-regression-live.md) | 7/10             | 6/9              | 0                   | USD 0.005246      |
| Offline holdout-1 rescore                                                          | 8/10             | 7/9              | 0                   | No new model call |

The untouched score stays 6/10 outcomes and 5/9 exact extraction. Changes after
exposure make the rescore and holdout-2 regression evidence. Conservative pauses
contribute to misses. The historical normalized arm returns manifest expected
outcomes; it is not an execution of every deterministic workflow. Most rows use
an in-memory world. Only C-01 has the evaluation's recorded database workflow proof.

The specification's 90% required-field extraction target and full accepted-field
provenance target are not established by these results. Zero violations in a
declared extraction suite is not a guarantee about every procurement or security
path. Details and failures: [extraction ADR](adr/0011-extraction-agent.md) and
[original reports](../evaluation/reports/).

The later system-prompt amendment runs (dev-2, dev-3, holdout-amended-regression,
holdout-amended-regression-2 and smoke-2) and the single live run on the
independent external holdout-3 set are recorded in the
[evaluation guide](../evaluation/README.md) and the amendment section of the
[extraction ADR](adr/0011-extraction-agent.md). The independent holdout-3
result is summarized below.

## Independent holdout-3 evaluation

A separate author wrote the 16-case holdout-3 set after the system-prompt
change and froze it outside the repository. The runner verified all 52 files
listed in its `MANIFEST.sha256` (SHA-256
`e18dc47b20c27f6935f646e7e3a458fac43031ffe352ef087a577c3da6e1a1c3`) and ran it
once at a frozen development revision, with the model, system
prompt (SHA-256 `0f2fa624d9ae438b119729b66527e1db79098efd2960990cabb6c5f0da53ad8f`),
tools, validator and scorer fixed. Every proposal went through intake and
assessment on a disposable seeded PostgreSQL database where the seeded world
allowed. Source: [holdout-3 report](../evaluation/reports/holdout-3-live.md).

| Arm               | Outcome correct | Exact proposals | Required fields exact | Accepted-plan provenance | Critical violations | Mean tool calls | Latency, total | Cost       |
| ----------------- | --------------- | --------------- | --------------------- | ------------------------ | ------------------- | --------------- | -------------- | ---------- |
| Baseline          | 6/16            | 4/10            | 58/84                 | 25/41                    | 4                   | 0               | 0 s            | none       |
| Oracle-normalized | 16/16           | 10/10           | 84/84                 | not applicable           | 0                   | 0               | 0 s            | none       |
| Live model        | 16/16           | 10/10           | 84/84                 | 43/43                    | 0                   | 2.6             | 80.2 s         | USD 0.0085 |

The model's semantic provenance was 84/84. Its only miss is J13, where the case
pauses before intake as its manifest expects but the downstream note expects
`awaiting_acknowledgement`; the oracle-normalized arm misses it identically, so
the runner marks it a gap in the seeded world. Seven cases name orders or a
sender outside that world; for the model, J01, J02, J03, J07 and J11 were
checked in memory only. No case had unknown usage. Since that run the agent
package has changed only in comments.

This is one run of one model on synthetic email. Approval, application,
verification and real supplier or ERP integration are not part of it. The set
is now exposed: later changes make it regression evidence only.

## Recorded spend

On 2026-10-24 the project spend ledger in the development database reported the
30,763 micro-USD opening, 54,240 micro-USD settled in 87 attempts and nothing
reserved or uncertain: a committed total of **85,003 micro-USD (USD 0.085003)**.
The ignored local evaluation record holds 134 entries with the same total. The
provider console was not checked. The snapshot verification made no model call.

The ledger opening comes from the 2026-10-22 reconciliation, which recorded 47
evaluation ledger entries totaling 30,763 micro-USD: smoke 1,250; development
15,312; untouched holdout 8,955; exposed-set regression 5,246. Recorded metered
API runs were zero at that check.
The database ledger opened at **USD 0.030763**, rounded to **USD 0.0308**.
The provider console was not checked. This is historical spend, not a current
allowance. [ADR 0017](adr/0017-project-spend-reservations.md) retains the
reconciliation and accounting semantics.

API and evaluation usage share a USD 20 cumulative budget with a mandatory pause
at USD 15. Reconcile database usage, the host evaluation record and uncertain
reservations before any separately authorized metered run. Resets and restores
never reset cumulative spend. No other paid service is authorized.

## Connector evidence

[ADR 0018](adr/0018-erpnext-sandbox-connector.md) records actual HTTP reads,
permission refusals, token-conditional schedule-date changes, draft transfer
creation and uncertain-response read-back against ERPNext/Frappe 16.52.0.
The recorded exchange capture and the later repeat 9/9 result belong to two
different development revisions; keep them distinct.

The connector is isolated from the application and uses a separate journal.
Quantity changes, schedule splits and cancel/amend stay manual; plan-bound
reservation and transfer submission stay unresolved. A date-only PO update
does not implement the canonical 40/80 split. The received-quantity unit with
a conversion factor other than one remains unproven. Graph mailbox proof is absent.

## Remaining limits

- Policy and demand can change after the guard read and allow an already claimed
  write. Source version preconditions protect PO and stock at their own write
  boundary. Only AUTH-1 is rechecked per claim. There is no remote transaction.
- Purchasing has no attempt fence. The recovery design resubmits the same
  digest-checked operation after an unfenced absence while approval remains
  current. A claimed in-flight effect may land after revocation. Some distinct
  cancellation orderings and a separate reordered-job scenario remain unproved.
- Unresolved outcomes stop after a bound of eight unproven attempts/read-backs.
  There is no command to record a person's final source confirmation, and
  revocation and compensation have no workbench controls.
- One fixture organization and one PO line per case are supported. A successor
  lineage is bounded to 21 plans. Enterprise identity, real sender authentication
  and broad multi-line or partly received workflows are not established.
- Checkpoint versioning is manual. Run/step records are written when the run ends.
  Recovery and provider failures were tested with local fakes. A lost provider
  call may be billed twice and remains covered by uncertain reservation.
- Spend admission is durable and concurrent, but the API role can settle another
  reserved attempt. Live provider billing and the provider account cap are not
  verified; some evaluation settlement/failure paths remain untested.
- The browser refreshes a session only while a page is visible and used, and
  resumes the pilot stream after an interruption with bounded reconnects
  ([ADR 0020](adr/0020-session-stream-security.md)). Rate-limit state is
  per-process memory. Last-Event-ID continues a
  bounded status sequence and does not replay durable case events. Provider-key
  scans of API/worker logs are not established.
- Restore is proven for one idle synthetic database. Concurrent-write consistency
  follows from snapshot design, not a recorded test. Backups are local and logical
  with no built-in encryption, schedule, off-host copy or point-in-time recovery.
- Watchdog recovery depends on Docker healthchecks. A long suspend or pause can
  trigger a restart. A failed halt initiated by the watchdog itself lacks retry.
  The app and database have no CPU, memory or process limits beyond stated tmpfs
  and shutdown bounds. Shared-host capacity remains unmeasured.
- Recorded platform evidence is linux/arm64 on Docker Desktop for macOS.
  Keyboard, theme and accessibility conformance remain unverified. The
  phone-width screenshot shows one responsive view, not a narrow-screen review
  of every page.

These limits do not establish production readiness, physical delivery, customer
impact, savings or complete specification compliance.

## Final pre-release verification

Before this repository's snapshot was taken, a fresh clone of the final
pre-release revision passed every check on 2026-10-24 (2026-10-23T20:09Z to
20:41Z UTC): install, lint, format, typecheck, 630/630 unit tests, build,
508/508 integration tests, the full container suite at 66/66 and the no-key
demo. An earlier fresh-clone attempt had failed `corepack pnpm lint` because
`apps/web/app/cases/[id]/page.tsx` used the `PageProps` helper, which exists
only after `next typegen`, `next dev` or `next build`; the fix types the params
explicitly. That attempt was stopped and does not count.

## Snapshot verification

The snapshot is the pre-release tree after wording-only edits that remove
internal tracking references and private revision identifiers. The frozen
oracle's hash pin and some test labels changed with them; no expected outcome,
threshold or case changed. The checks below ran on that tree from
2026-10-23T21:50Z to 22:28Z UTC (2026-10-24 local time), on Docker 29.9.2,
linux/arm64 (Docker Desktop for macOS), Compose 5.6.1, Node 24.22.0 and
pnpm 12.14.0, with no model call.

The development database was a disposable Compose project, `sd-snapshot-dev`,
on loopback port 55141, with secrets newly generated by
`corepack pnpm secrets:init` and `.env` copied from `.env.example`.
The evaluation runner exercised by `test:integration`, `test:container` and the
demo all need a Git commit, so these three ran from a disposable copy of the
snapshot tree committed there for the purpose. A first `test:integration`
attempt on the uncommitted tree stopped at that `git rev-parse HEAD` call and
does not count. The install, static checks, unit tests, build, migrate and seed
ran in this tree and again, for install, migrate and seed, in the copy. That
copy's tree differs from this commit only in the documentation that
records these results (this file, README.md and docs/blog-evidence.md).

| Command                                   | Exit | Result                                                                                                                                  |
| ----------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile` | 0    | Lockfile unchanged                                                                                                                      |
| `corepack pnpm lint`                      | 0    | No warnings                                                                                                                             |
| `corepack pnpm format:check`              | 0    | All files formatted                                                                                                                     |
| `corepack pnpm typecheck`                 | 0    | All workspace projects                                                                                                                  |
| `corepack pnpm test`                      | 0    | 630/630 in 32 files: contracts 161, config 42, domain 125, agent 94, ERPNext connector 32, web 13, workspace scripts 163                |
| `corepack pnpm build`                     | 0    | Packages and the Next.js production build                                                                                               |
| `corepack pnpm db:migrate`, `db:seed`     | 0    | Migrations through `0010_model_spend_guards` and the canonical seed on the empty disposable database                                    |
| `corepack pnpm test:integration`          | 0    | 508/508 in 805 s: db 115 (16 files), API 342 (24 files), worker 51 (7 files)                                                            |
| `corepack pnpm test:container`            | 0    | 66/66 in 16 files, 1,015 s; the harness built its images from a fresh clone of the disposable commit and removed them                   |
| `corepack pnpm demo`                      | 0    | Fresh demonstration project; `/api/demonstration` reported `active: true`, business clock 2026-10-21T07:00Z and agent provider `replay` |
| `corepack pnpm demo:down`                 | 0    | Demonstration containers, network and volume removed                                                                                    |

PostgreSQL is the digest-pinned `postgres:18.6-bookworm` from
[compose.yaml](../compose.yaml).

## Presentation and publication checks

| Check                   | Method and result                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screenshots             | `corepack pnpm screenshots` at the final pre-release implementation revision: six raw captures and framed exports with a [manifest](demo/screenshots/manifest.json). The [pixel comparison](demo/screenshots/README.md#fidelity-check) found only corner differences.                                                                                           |
| Mermaid                 | All four blocks (README, two in ARCHITECTURE, blueprint) parsed and rendered with mermaid 12.2.0 in Playwright 1.64.1's Chromium, in the default and dark themes: 8 of 8 renders without errors.                                                                                                                                                                |
| Links                   | A script checked 397 relative links, image sources and heading anchors in the 62 Markdown files of the snapshot tree: no broken target. External URLs were not fetched.                                                                                                                                                                                         |
| GitHub rendering        | Before the snapshot, the README's desktop rendering on GitHub (five images and the Mermaid diagram) was checked on the private development repository. Phone-width rendering was not inspected.                                                                                                                                                                 |
| Secrets and identifiers | gitleaks 8.30.1 over the snapshot tree: three findings, all `generic-api-key` false positives (database connection labels in two tests and a path list in `evaluation/run.mjs`); values were redacted. Pattern scans found no task, milestone or epic identifiers, private commit identifiers, local home paths, terminal pane IDs or personal email addresses. |
| Licenses                | [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) from installed metadata and the image contents, flagging the LGPL libvips build in the image.                                                                                                                                                                                                               |
| Configuration           | Every variable the code reads is in [.env.example](../.env.example), active, commented or documented as an inline secret or test hook. The snapshot run used a `.env` copied unchanged from it.                                                                                                                                                                 |

Not done: keyboard, theme and accessibility review; a narrow-screen review of
every page; and inspection of GitHub's phone-width rendering.
