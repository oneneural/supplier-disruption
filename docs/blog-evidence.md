# Article evidence index

Evidence record, updated 2026-10-24 after the final verification of this
repository's snapshot. This is a claim-to-evidence
index for possible future writing. It is not article prose or release approval.

## Problem and scope

| Item             | Evidence-backed description                                                                                                                                                | Product source                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Problem          | A supplier's proposed delivery change can affect customer commitments, stock coverage and approval requirements. Changing the PO alone does not resolve the exception.     | [Specification](../SPEC.md), [research register](research.md)                      |
| User             | A buyer owns the case; a procurement manager approves exceptional cost; a warehouse planner confirms transfer feasibility. All actors in the demo are synthetic.           | [Workbench](adr/0010-operator-workbench.md)                                        |
| Canonical story  | 120 EA demand, 30 eligible local stock, 40 on-time supplier units, 50 EA gap; 50 EA same-SKU transfer for EUR 160 requires the manager because the buyer limit is EUR 100. | [Allocation](adr/0007-coverage-allocation-plans.md), [walkthrough](demo/README.md) |
| Successful state | A recovery plan whose authoritative records matched read-back. `plan_verified` is not physical delivery.                                                                   | [Workflow](adr/0009-durable-case-workflow.md)                                      |
| Research limits  | Commercial overlap and integration constraints are documented. The research does not establish customer demand or novelty.                                                 | [Primary-source register](research.md)                                             |

Research URLs, access dates and distinctions between sourced facts and product
decisions remain in [research.md](research.md). Consult the register before
quoting a source. No external source was reopened for this draft.

## Architecture summary

| Boundary           | Implementation                                                                                                        | Source                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Runtime            | Next.js, Fastify and pg-boss worker in one supervised application image; separate PostgreSQL                          | [Architecture](../ARCHITECTURE.md), [image ADR](adr/0002-app-image-lifecycle.md)                      |
| Agent              | Fixed tools propose schema-constrained supplier terms with quotations or PO citations. Extraction runs in the API.    | [Extraction ADR](adr/0011-extraction-agent.md)                                                        |
| Business authority | Deterministic intake and coverage rules, explicit plan-bound approvals, current claim guards and source preconditions | [Intake](adr/0008-intake-identity-guards.md), [guards](adr/0013-current-policy-execution-guards.md)   |
| Durability         | PostgreSQL evidence bytes, cases, plans, events, action journal, queue, checkpoints and spend ledger                  | [Workflow](adr/0009-durable-case-workflow.md), [checkpoint recovery](adr/0019-checkpoint-recovery.md) |
| External proof     | Standalone ERPNext/Frappe sandbox connector, isolated from the app and its journal                                    | [Connector ADR](adr/0018-erpnext-sandbox-connector.md)                                                |

## Recorded implementation evidence

The [verification record](verification.md) carries commands and outcomes
without requiring private planning records. The focused rows below were
recorded at earlier development revisions, before this repository's snapshot. Application check group A
there means lint, format:check, typecheck, test, build and test:integration, each
invoked through `corepack pnpm`. Group B omits test:integration.

| Claim                                            | Recorded checks and result                                                                                                                                                                          | Evidence and limit                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Canonical demo and full container suite          | A application checks; `corepack pnpm demo`; `corepack pnpm test:container`: Clean-state demo; container 51/51; all listed application checks exit 0.                                                | [ADR 0012](adr/0012-demonstration-mode.md); scope limited to the recorded run.                  |
| Current policy and claim guards                  | A application checks; No full container rerun recorded. Decision/claim checks and focused races passed; later changes can still follow a granted claim.                                             | [ADR 0013](adr/0013-current-policy-execution-guards.md); scope limited to the recorded run.     |
| Clarification and cited correction               | A application checks; `corepack pnpm test:container clarification`: Exit 0, W4 1/1; integration db 105, API 295, worker 51.                                                                         | [ADR 0014](adr/0014-clarification-correction-resume.md); scope limited to the recorded run.     |
| Verification currency and later revisions        | A application checks; `corepack pnpm test:container revision`: Exit 0, W5 1/1; integration db 105, API 308, worker 51.                                                                              | [ADR 0015](adr/0015-verification-currency-and-revisions.md); scope limited to the recorded run. |
| Interruption and cancellation recovery           | A application checks; `corepack pnpm test:container termination domain`: Exit 0; K1–K4 process SIGKILL and K5 container kill recorded; stable effects after recovery.                               | [ADR 0016](adr/0016-workflow-interruption-recovery.md); scope limited to the recorded run.      |
| Concurrent spend admission                       | A application checks; No metered provider call. Exit 0; ten-way admission race and uncertain reservations; integration db 115, API 323, worker 51.                                                  | [ADR 0017](adr/0017-project-spend-reservations.md); scope limited to the recorded run.          |
| Mid-investigation checkpoint recovery            | A application checks; No metered provider call; local fake Messages API. Exit 0; PostgreSQL checkpoint resume after SIGKILL, incompatible-contract refusal and fresh domain evidence.               | [ADR 0019](adr/0019-checkpoint-recovery.md); scope limited to the recorded run.                 |
| Sessions and bounded stream authorization        | A application checks; `corepack pnpm test:container proxy stream browser`: Exit 0; refresh, account limits, stream revocation and bounded resume.                                                   | [ADR 0020](adr/0020-session-stream-security.md); scope limited to the recorded run.             |
| Backup restore and lifecycle                     | B application checks; `corepack pnpm test:container lifecycle restore`: Exit 0, 7/7 from a fresh clone. Integration was not rerun on this revision.                                                 | [ADR 0021](adr/0021-restore-and-lifecycle-bounds.md); scope limited to the recorded run.        |
| Earlier restore integration                      | A application checks; `corepack pnpm test:container restore`: Exit 0, 4/4; includes integration at this earlier revision.                                                                           | [ADR 0021](adr/0021-restore-and-lifecycle-bounds.md); scope limited to the recorded run.        |
| Earlier targeted container combination           | No application checks recorded here; `corepack pnpm test:container restore lifecycle readiness stream failures`: Exit 0, 25/25 from a fresh clone. This is a subset, not a full-suite result.       | [ADR 0021](adr/0021-restore-and-lifecycle-bounds.md); scope limited to the recorded run.        |
| ERPNext connector static/unit/integration checks | A application checks; No live run attributed to this row. Exit 0; connector 32 network-free unit tests; integration db 115, API 323, worker 51.                                                     | [ADR 0018](adr/0018-erpnext-sandbox-connector.md); scope limited to the recorded run.           |
| ERPNext live sandbox repeat                      | Application checks not claimed; `corepack pnpm test:sandbox`, with sandbox URL and credentials-file variables set: 9/9 against a reset local synthetic sandbox; separate from the application path. | [ADR 0018](adr/0018-erpnext-sandbox-connector.md); scope limited to the recorded run.           |

Each row describes only the revision at which that focused result was recorded.
The claim that the application was tested together rests only on the final
verification below; the earlier complete container result was 51/51.

## Recovery and refusal examples

| Example                            | Recorded behavior                                                                                                                    | Source                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Approval over limit                | Buyer approval of EUR 160 is refused; manager approval and matching acknowledgements are required.                                   | [Workbench](adr/0010-operator-workbench.md), [walkthrough](demo/README.md) |
| Committed write with lost response | Journal shows unknown; later read-back finds the existing reservation without a duplicate effect.                                    | [Demo](adr/0012-demonstration-mode.md)                                     |
| Source or policy changed           | Current claim guards refuse later unauthorized actions and preserve earlier known effects. A guard read is not a remote transaction. | [Claim guards](adr/0013-current-policy-execution-guards.md)                |
| Clarification                      | Question remains an unsent draft; a recorded reply and cited correction resume assessment with new approval binding.                 | [Clarification](adr/0014-clarification-correction-resume.md)               |
| Expired or superseded verification | Historical read-back stays inspectable; current status expires or links to a successor.                                              | [Revision semantics](adr/0015-verification-currency-and-revisions.md)      |
| Process stopped mid-graph          | Same checkpoint resumes under a matching contract and remaining cap, using a local fake provider for proof.                          | [Checkpoint recovery](adr/0019-checkpoint-recovery.md)                     |
| Restore with a pending action      | Restored journal reconciles by operation ID to one amendment, reservation and transfer request. Backup test used an idle database.   | [Restore ADR](adr/0021-restore-and-lifecycle-bounds.md)                    |

## Evaluation history

| Run                       | Outcome | Exact extraction | Violations | Recorded cost | Interpretation                 |
| ------------------------- | ------- | ---------------- | ---------- | ------------- | ------------------------------ |
| dev-1 live                | 23/25   | 16/18            | 0          | USD 0.015312  | Development set                |
| holdout-1 live            | 6/10    | 5/9              | 0          | USD 0.008955  | Original untouched result      |
| holdout-2-regression live | 7/10    | 6/9              | 0          | USD 0.005246  | Same exposed set after changes |
| holdout-1 offline rescore | 8/10    | 7/9              | 0          | No new spend  | Post-exposure replay rescore   |

Each run was made at its own earlier development revision. Sources:
[original evaluation reports](../evaluation/reports/) and
[extraction ADR](adr/0011-extraction-agent.md). Preserve original scores,
set hashes, parameters and failures. Exact extraction uses an applicable-case
denominator; it is not 5/10. Historical results are synthetic extraction
measurements, not a complete workflow or customer benchmark.

The normalized historical row injects expected outcomes. Most scenarios run
in an in-memory world; only C-01 has recorded database workflow proof in that
evaluation. Conservative pauses contribute to misses. The 90% target and full
accepted-field provenance target remain unestablished.

Later system-prompt amendment runs are recorded in the
[evaluation guide](../evaluation/README.md). After those changes, a separate
author wrote the 16-case holdout-3 set and froze it outside the repository
(`MANIFEST.sha256` SHA-256
`e18dc47b20c27f6935f646e7e3a458fac43031ffe352ef087a577c3da6e1a1c3`). It was run
once at a frozen development revision, with the model, system
prompt, tools, validator and scorer fixed before exposure. The exposure boundary
rests on that process record and the runner's set check (52 listed files, 16
cases, 16 oracles); the repository holds the report, not the set.

| Arm               | Outcome | Exact proposals | Required fields | Accepted-plan provenance | Critical violations | Cost       |
| ----------------- | ------- | --------------- | --------------- | ------------------------ | ------------------- | ---------- |
| Baseline          | 6/16    | 4/10            | 58/84           | 25/41                    | 4                   | none       |
| Oracle-normalized | 16/16   | 10/10           | 84/84           | not applicable           | 0                   | none       |
| Live model        | 16/16   | 10/10           | 84/84           | 43/43                    | 0                   | USD 0.0085 |

The live model averaged 2.6 tool calls per case and took 80.2 s for the 16
cases (3.1 s to 6.7 s per case), with no unknown usage. Its one downstream miss,
J13, is shared by the oracle-normalized arm and reflects the seeded world, not
extraction. Five model proposals reached intake on PostgreSQL; seven cases name
orders or a sender outside the seeded world and ran in memory. The runner,
`evaluation/run.mjs` in live mode with `--cases` pointing at the frozen set,
is described in [ADR 0011](adr/0011-extraction-agent.md#runner); the recorded
parameters (tool budget 10, case cap USD 0.05, run cap USD 0.50), per-case tool
calls and latency are in the
[holdout-3 report](../evaluation/reports/holdout-3-live.md). No traces beyond
that report are kept in the repository. One model, one run
and synthetic email: no variance estimate, and the set is now exposed.

## Spend record

The recorded 2026-10-22 reconciliation is USD 0.030763 (USD 0.0308 rounded):
smoke USD 0.001250, development USD 0.015312, untouched holdout USD 0.008955
and exposed-set regression USD 0.005246. The local evaluation record had 47
entries; the API database had zero metered runs at that reconciliation. The
ledger opened at 30,763 micro-USD. No provider-console check was recorded.
See [ADR 0017](adr/0017-project-spend-reservations.md).

Budget authority remains USD 20 cumulative with a mandatory pause at USD 15.
The historical amount is not a current balance; database resets do not reset
spend. Paid work needs current reconciliation and separate authorization.

On 2026-10-24 the project ledger reported a committed total of 85,003
micro-USD (USD 0.085003): the 30,763 opening plus 54,240 settled in 87 attempts,
with nothing reserved or uncertain. The ignored local evaluation record holds
134 entries with the same total. The snapshot verification made no model call.

## Architecture decisions

| ADR                                                     | Decision and evidence location                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| [0001](adr/0001-workspace-pilot-toolchain.md)           | Toolchain pins, lint compatibility and explicit auth checks          |
| [0002](adr/0002-app-image-lifecycle.md)                 | One non-root application image, supervision and lifecycle bounds     |
| [0003](adr/0003-proxy-cookies-and-streams.md)           | Same-origin proxy, cookie handling and bounded status streaming      |
| [0004](adr/0004-domain-fixture-data.md)                 | Domain contracts, exact quantity representation and canonical seed   |
| [0005](adr/0005-fixture-authority-transactions.md)      | Versioned fixture authority transactions and operation receipts      |
| [0006](adr/0006-public-reference-reads.md)              | Attributable reference reads and scoped transfer options             |
| [0007](adr/0007-coverage-allocation-plans.md)           | Pure eligibility, allocation and immutable hashed plans              |
| [0008](adr/0008-intake-identity-guards.md)              | Sender, digest, PO identity and base-revision intake guards          |
| [0009](adr/0009-durable-case-workflow.md)               | Durable cases, exact-plan decisions, journals and read-back          |
| [0010](adr/0010-operator-workbench.md)                  | Operator queue, case workbench and simulated review roles            |
| [0011](adr/0011-extraction-agent.md)                    | Bounded email extraction, evidence validation and evaluation         |
| [0012](adr/0012-demonstration-mode.md)                  | Fixed-clock recorded demonstration without model spend               |
| [0013](adr/0013-current-policy-execution-guards.md)     | Current AUTH-1 checks and guarded execution claims                   |
| [0014](adr/0014-clarification-correction-resume.md)     | Unsent questions, recorded replies and cited corrections             |
| [0015](adr/0015-verification-currency-and-revisions.md) | Verification expiry, rechecks and linked supplier revisions          |
| [0016](adr/0016-workflow-interruption-recovery.md)      | Interruption recovery, cancellation and bounded uncertainty          |
| [0017](adr/0017-project-spend-reservations.md)          | Shared model-spend admission and uncertain usage reservations        |
| [0018](adr/0018-erpnext-sandbox-connector.md)           | Isolated ERPNext sandbox HTTP proof and unsupported operations       |
| [0019](adr/0019-checkpoint-recovery.md)                 | Contract-bound recovery of unfinished PostgreSQL checkpoints         |
| [0020](adr/0020-session-stream-security.md)             | Session refresh, per-account limits and open-stream checks           |
| [0021](adr/0021-restore-and-lifecycle-bounds.md)        | Snapshot backup restore, watchdog recovery and shutdown measurements |

ADRs describe decisions at their original revisions. Later supersession notes
and [verification.md](verification.md) determine current interpretation.

## Limits and non-claims

- The main application uses fixture authorities and simulated roles. The
  isolated ERPNext proof is not an end-to-end integrated purchasing system.
- No real supplier authentication, mailbox integration, autonomous outbound
  message, production transaction, physical delivery or customer impact was proved.
- A plan and its receipts do not prove physical arrival. Stock buckets remain
  separate, and no substitute acceptance or unit conversion may be inferred.
- Current policy/demand reads and remote writes are not atomic. There is no
  purchasing attempt fence. A claimed write may land after cancellation.
- Unresolved actions need a person; the product lacks a final-confirmation
  command and revocation/compensation workbench controls.
- Provider recovery/failure proof uses local fakes; checkpoint versioning is
  manual. Some billing settlement paths and log scans remain untested.
- The restore proof uses one small idle database. Concurrent-write restore
  preparation, production backup operations and broad capacity are not established.
- Keyboard, theme and accessibility review and a narrow-screen review of every
  page remain undone. Current screenshots exist for six views.
- No production-readiness, complete SPEC compliance, commercial novelty,
  demand, savings, benchmark superiority or measured customer benefit is claimed.

The complete qualified gap list is in [verification.md](verification.md).

## Final verification evidence

| Item                           | Record                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Snapshot checks                | This repository's tree on 2026-10-24: install, lint, format:check, typecheck, test (630/630), build and test:integration (508/508, run from a disposable commit of the tree because the evaluation runner needs one), all exit 0. [Verification record](verification.md#snapshot-verification).                                            |
| Complete packaged verification | `corepack pnpm test:container` 66/66 in 16 files, exit 0, images built by the harness from a fresh clone of a disposable commit of the snapshot tree; `corepack pnpm demo` reported demonstration mode with the replay provider, then `demo:down`, both exit 0. linux/arm64.                                                               |
| Screenshot provenance          | Six captures, raw and framed, with [manifest](demo/screenshots/manifest.json): final pre-release implementation revision, routes, scenario, demonstration mode, 1280 and 390 px viewports at DPR 2, capture time, SHA-256 of each file, frame recipe hash, Playwright 1.64.1 and Chromium 156. Crops are disclosed per shot; no redaction. |
| Presentation checks            | Mermaid 12.2.0 rendered all four diagrams in Chromium (default and dark themes); 397 relative links and anchors resolved. GitHub's desktop rendering of the README was checked on the private development repository before the snapshot; phone width, keyboard, theme and accessibility checks were not done.                             |
| Reproducible public artifact   | This repository is a single-commit snapshot without planning records, task identifiers, private revision identifiers or local paths. Its gates were run locally before publication; publication itself is a separate step.                                                                                                                 |

A future article can use this index to choose a problem statement, architecture
decision, recovery example and measured evaluation result. No publication prose
or article draft is included.
