# ADR 0011: Bounded email extraction agent

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-21
- Superseded in part by [ADR 0017](0017-project-spend-reservations.md): provider retries, the run cost cap and the spend ledger
- Amended 2026-10-23: system prompt, evaluation runner and results; see "Independent evaluation amendment"

## Context

Before email extraction every case started from a stored structured fixture message.
SPEC "Rules and agent responsibilities" and ARCHITECTURE "Use one bounded
LangGraph investigation" allow one model-backed step: turning an unstructured
supplier email into the existing schema-constrained supplier proposal, with an
evidence locator per field, under a tool budget, with checkpointing and safe
pauses. Deterministic intake (ADR 0008), assessment and the case workflow
(ADR 0009) must stay the authority for everything after the proposal.

## Decision

### Package and graph

`packages/agent` holds the graph, tools, prompt, providers, validation and
evaluation helpers. It depends on contracts only; it reads nothing directly.

- LangGraph JS 1.4.20 `StateGraph` with two nodes: `agent` (one model call)
  and `tools` (executes the requested tool calls). A conditional edge ends the
  graph when an outcome is set.
- Five registered tools, all strict JSON schemas: `read_case_evidence`,
  `read_purchase_order`, `inspect_demand_and_stock`, `propose_supplier_terms`
  and `escalate`. Any other tool name is rejected as "tool is not registered"
  and counted; nothing executes it. No tool writes a source record, sends a
  message, approves, converts units or selects a replacement SKU.
- Budget: 10 tool calls by default, clamped to the hard ceiling of 12,
  including rejected calls and retries. Model calls are bounded separately
  (14). Each run also has a cost cap in micro-USD checked before every model
  call. Exhausting either pauses `agent_budget_exhausted` or
  `agent_cost_cap_reached`.
- The proposal is validated in code: the zod schema, then semantic support.
  Every email field carries a verbatim quote that must occur in the stored
  evidence text (its offsets become the locator) and must state the value;
  a PO line or base revision may instead cite the PO record read in this run,
  and must equal it. The PO number and vendor item must appear as bounded
  tokens (`PO-120` is not found in `PO-1201`), with only `- _ . /` or a space
  allowed between their letter and digit runs. A quantity must appear as a
  whole number not joined to a digit separator (`200` is not found in
  `1,200` or `1.200`). A shipping-date quote without an arrival word is
  rejected. Three rejected proposals pause `agent_malformed_output` or
  `agent_unsupported_evidence`. A field the model marks low confidence pauses
  `agent_low_confidence` with the proposal kept for the buyer. Model refusal,
  provider error and truncated output pause `agent_provider_failure` or
  `agent_malformed_output`.
- Dates and years: the quote's explicit date mentions are parsed whole (ISO
  `yyyy-mm-dd`, a day and an English month name in either order, or European
  day/month digits such as `23.10.`, `23/10` or `23-10-2026`; digits are never
  read month first, digits inside an ISO date or a longer digit run are never
  read as a day and month, and a two-digit year is not a date). A proposed
  date must match a mention's day and month, and its year when the mention
  states one. When the quote states no year, the year is inferred only by
  this rule: the whole stored email states exactly one year across its
  explicit dates, and the proposed year equals it. If the email states no
  year or more than one, the field is marked low confidence and the run
  pauses `agent_low_confidence` with the proposal kept for the buyer; a
  proposed year different from the single stated year is unsupported. The
  rule never uses the receipt time or the business clock.
- The system prompt is stable and cached (`cache_control` on the system block
  and top-level automatic caching). The email is untrusted evidence passed as
  a tool result; it cannot change the tool list, the system prompt or any
  authority (SD-15). Tests assert the tools and system prompt are identical
  across an injected email and that injected tool names never execute.

### Provider

A small adapter over `@anthropic-ai/sdk` 0.131.0 (`maxRetries: 1`, 60 second
timeout, `output_config.effort: "low"`). The default model is
`claude-haiku-5-5`: the development run met the outcome target with it at a
cost far below Sonnet, so the task's Sonnet default was not needed. Prices are
configured per model and an unknown model refuses to run, so cost is never
silently zero. Errors keep only the HTTP status; headers and the key never
reach a step record, replay, log or report. The API reads the key only from
`ANTHROPIC_API_KEY_FILE`, and only when `AGENT_PROVIDER=anthropic`; the
default `none` pauses every email case `agent_provider_unavailable` without a
model call.

### Where it runs

The extraction runs in the API process as the case job, not in the worker.
The worker already has no database or provider authority (ADR 0002, ADR 0009):
it claims the `case-application` job and posts to the API's internal route.
The same job now carries an email case's extraction; the internal route calls
`CaseWorkflow.advance`, which extracts when the case is `received` with an
agent run and otherwise applies. This deviates from ARCHITECTURE's "worker
invokes Claude" wording but keeps the API as the only holder of business
authority and secrets. `resumeInterruptedCases` also requeues a `received`
email case whose run or hand-off did not finish.

### Checkpointing and records

- LangGraph's `PostgresSaver` (`@langchain/langgraph-checkpoint-postgres`
  1.0.6) checkpoints in schema `agent_checkpoint`, keyed by the run ID. The
  tables come from migration 0005 with the saver's own migration rows
  recorded, so the API role never runs DDL (`setup()` is not called). A run
  interrupted after a tool step resumes from its checkpoint; a finished run is
  never re-invoked.
- `app.agent_run` holds status, provider, model, budget, tool and model call
  counts, token counts, cost, cap, latency, pause reason and detail, the exact
  evidence text and its SHA-256, the proposal terms, locators and rationale.
  `app.agent_step` appends each model and tool step once with its input,
  result, accepted flag, reason, latency, tokens and cost.

### Hand-off to intake

Intake requires the supplier input to be read from the reference owner and to
equal the delivered identity and terms (ADR 0008). After a validated proposal
the API builds the input itself: source system `operator-email`, message ID
`EML-` plus the first 16 hex digits of the SHA-256 of the canonical email
bytes, input version 1, the envelope sender as received, proposal ID
`PROP-<message ID>` and unknown authored and received instants. It appends
that input to `fixture_reference.supplier_input` (a new insert-only grant to
the API role; no update or delete), then calls the existing structured
`ingest` with the run ID as delivery ID. Intake and assessment therefore run
unchanged, and the C-01 email reaches the same plan as the structured fixture
(70 covered, 50 short before transfer, 50 by transfer, EUR 160). The ingest
change is one condition: an email case still in `received` takes its first
intake decision instead of being treated as an already decided observation.

The email itself is stored in `app.supplier_message` with the new disposition
`evidence`; the same email again is a `duplicate` of the same case and run
(SD-01).

### Evaluation

(The independent evaluation extends this runner; see "Independent evaluation amendment".)
`evaluation/scenarios/dev` holds 25 manifests covering every SPEC case family,
with expected outcomes, expected terms and forbidden effects (`proposal`,
`dated_arrival`, `unregistered_tool_executed`). `evaluation/run.mjs` reports
three rows: a deterministic regex baseline, the oracle-normalized row and the
model row (live or replay), with the exact revision, set digest, counts, cost
and failures (SD-18). Live runs record replays without headers and append to
the ignored `evaluation/.spend-ledger.json`; each run has a run cap and a
per-case cap, and the runner refuses a case that could take the ledger past
USD 15. `corepack pnpm test` replays the committed development run offline
and fails on any outcome or request digest change.

### Results (claude-haiku-5-5, fictional fixtures)

Each run was made at its own earlier development revision.

| Run                                          | Outcome correct | Exact extraction | Critical violations | Spend      |
| -------------------------------------------- | --------------- | ---------------- | ------------------- | ---------- |
| dev-1, development set                       | 23 / 25         | 16 / 18          | 0                   | USD 0.0153 |
| holdout-1, untouched held-out set            | 6 / 10          | 5 / 9            | 0                   | USD 0.0090 |
| holdout-2-regression, same set after one fix | 7 / 10          | 6 / 9            | 0                   | USD 0.0052 |

The ten held-out cases were written independently and adapted mechanically by
`evaluation/adapt-holdout.mjs`; `evaluation/holdout-mapping.json` lists their
source digests and every expectation the scenario format cannot carry
(trusted setup, exact source span offsets, sender and sent-time metadata,
downstream arithmetic). holdout-1 found one validator bug: a base revision in
a compound word ("Basisrevision 3") was rejected, which paused H02 and H04.
After the fix every proposal in holdout-2-regression was exact. The remaining
failures are conservative pauses where the manifest expects a proposal: the
model escalates an unregistered sender (H05) and a stale base revision (H07)
instead of proposing and letting intake block, and H03 (cartons with no
conversion) paused for low confidence in one run and was proposed exactly in
the other. No run proposed on the conflicting H08 or acted on the H10
injected instructions.

An independent review (finding B1) found that the evidence check accepted values the quote does
not state: an ISO date read as day and month, an unchecked year, a quantity
inside a grouped number and identifiers matched as substrings. After the fix
every committed run was rescored offline from its replays with no
model call; the original live reports stay unchanged beside the rescored
ones (`*-rescored-replay`):

| Run rescored after fix | Outcome correct | Exact extraction | Change from the live report                                                                          |
| ---------------------- | --------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| dev-1                  | 23 / 25         | 16 / 18          | none                                                                                                 |
| holdout-1              | 8 / 10          | 7 / 9            | H02 and H04 now proposed exactly (the compound-word fix accepts the model's first recorded proposal) |
| holdout-2-regression   | 7 / 10          | 6 / 9            | none                                                                                                 |

No score in any run depended on those gaps. The holdout-1 rescore is not an
untouched held-out result: the fix that changes it was made after exposure.

## Independent evaluation amendment

### Diagnosis

The original failures were read from the committed reports and replays, not
rerun. holdout-1's citation failures (H02, H04) were the compound-word base
revision bug fixed before holdout-2-regression. Every remaining miss in dev-1, holdout-1 and
holdout-2-regression was a conservative pause on an email that states every
value, where deterministic intake owns the decision:

| Pause                                                 | Cases         | Why the model paused                                                                | Owner after the proposal                                    |
| ----------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Unregistered sender or another vendor's order         | D11, D12, H05 | `read_purchase_order` answers `not_permitted`, read as "order cannot be identified" | Intake: `unverified_sender`, `vendor_mismatch` (ADR 0008)   |
| Stated base revision older than the current one       | H07           | Read as a contradiction in the email                                                | Intake: `stale_base_revision`                               |
| Cartons with no pack size                             | H03           | Clearly stated unit marked low confidence                                           | Assessment: effective UOM mapping or a block                |
| Substitute offered beside the ordered item's schedule | D18 (dev-2)   | A date of the ordered item marked low confidence                                    | Assessment: unsupported substitute, no inferred equivalence |

Extraction versus downstream: an extraction pause stops the case in
`needs_clarification` for the buyer before intake runs, so a pause can be safe
and still differ from the manifest's intake disposition. The runner now
reports both separately (below).

### Prompt change

The system prompt (SHA-256 `0f2fa624d9ae438b119729b66527e1db79098efd2960990cabb6c5f0da53ad8f`,
committed before the dev-3 run) adds one section, "Software checks sender standing,
revision currency and unit conversion after you", with three rules: a
`not_permitted` record read is not by itself a reason to escalate when the
email states the PO number, line and base revision; a stated revision that
differs from the current one is proposed as stated; a clearly stated unit is
high confidence without a pack size. Low confidence is limited to a value the
email itself is unclear about, and an offered substitute does not make the
ordered item's values unclear. The rationale must mention such a difference.

Nothing else changed: the tools, schemas, validator, budgets, pause reasons,
forbidden effects and every intake and assessment guard are unchanged, and the
email remains untrusted evidence. Proposing in these cases moves the decision
to the deterministic check that already owned it; it never authorizes a
sender, a revision or a conversion. Every request digest changes, so the
replay tests now use dev-3 and holdout-amended-regression-2, and the
demonstration packages a new C-01 recording, smoke-2 (ADR 0012).

### Runner

`evaluation/run.mjs` takes exactly one of `--set <name|dir>` (the repository
format) or `--cases <dir>`, an external frozen set read in place and never
copied: `cases/<ID>.json` in the strict scenario format, evaluator-only
`cases/oracles/<ID>.json`, `cases/evidence/`, and a required
`case-index.json` and `MANIFEST.sha256`. `packages/agent/src/case-set.ts`
fails loudly when `MANIFEST.sha256` or `case-index.json` is missing; when a
manifest entry is missing, outside the set, listed twice or differs from its
digest; when any file under `cases/` (at any depth) or `case-index.json` is
not listed; on a case outside the strict scenario format; on an oracle
without `scenarioSha256`, or whose `scenarioSha256`, `evidenceSha256` or
`emailCanonicalBytesSha256` differs from the case, its evidence file or the
canonical bytes of the email the runner sends; on a case without an oracle
once oracles are declared, an orphan oracle, or index entries that differ
from the cases or name missing files. Unknown oracle and index fields are
tolerated. The set hash is the SHA-256 of `MANIFEST.sha256`; a listed file
outside `cases/` is verified but not required.
A difference between the index's declared required-field denominator or units
and the runner's own count is reported as a set note, never reconciled.

The three arms read the same evidence, each case's email:

- **baseline**: the deterministic regex extractor through the same validator.
- **oracle-normalized**: the manifest's declared terms as the extraction
  (proposed whenever terms are declared, even where a pause is allowed; a case
  without terms has no normalized input). It carries no locators.
- **model**: `--mode replay` from recordings or `--mode live` through the
  project ledger (ADR 0017). A live run refuses uncommitted changes under
  `packages/agent`, `packages/contracts`, `packages/domain`, `packages/db`,
  `apps/api`, `evaluation/scenarios` or the runner, so its report is evidence
  for its recorded revision. Nothing verifies that the built `dist` the runner
  and the downstream stage load was compiled from that revision: a live
  `--downstream postgres` run only refuses when a package's newest file under
  `src` is newer than its newest file under `dist` (including the build info),
  which catches a forgotten build, not a build from another checkout. Build
  with `corepack pnpm build:packages` at the recorded revision first.

`--downstream postgres` sends every arm's proposal through the real
`CaseWorkflow.ingest` (intake and assessment) on a fresh clone of a migrated,
seeded database in a disposable Compose project
(`supplier-disruption-eval-<run>`, database service only, removed on close).
Nothing computes or injects an outcome. A row is `postgres` when its order is
seeded and the sender's standing is the same in the seed and the evaluation
world; otherwise it is `in-memory-only` with the reason. A pause is
`no-intake`. The runner compares only the machine-checkable parts of the
manifest's downstream note: an `intake <disposition>`, case state names and
snake_case reason codes. Where the manifest allows a pause and the arm paused,
only the case state is compared. Each downstream miss that the
oracle-normalized arm has word for word for the same case is flagged as a
world or setup gap; the arm's other misses stay its own, and a disagreement
counts as a world or setup gap only when all its misses are flagged.

Reports carry the exact revision, the clean-tree flag, the set hash and its
source, the manifests digest, the model, the system prompt and tool digests,
the tool budget and caps, denominators, required-field exact extraction,
semantic provenance (each proposed required field: the locator's span
reproduces its quote under the evidence digest, or the cited record states
the value, and the located value is the expected one), provenance of the
fields intake accepted on PostgreSQL, every miss and critical violation per
arm, tool counts, latency and cost, and the project ledger before and after.

Before this change the runner ran `git status` from `evaluation/`, where its
pathspecs matched nothing, so every report said the tree was clean. The
first amendment runs, dev-2 and holdout-amended-regression, were made from an
uncommitted tree with an intermediate prompt; each states that provenance.
Until a later scoring fix a case's every downstream miss was flagged when the oracle
arm missed that case at all; holdout-amended-regression-2 was re-rendered from
its own recorded scores, with no model call, to flag per miss (its baseline's
H01 and H06 lost the label) and says so.

### Independent evaluation results (claude-haiku-5-5, fictional fixtures, live at one development revision)

| Run                                       | Outcome correct | Exact proposals | Required fields exact | Semantic provenance | Accepted-plan provenance | Critical violations | Spend      |
| ----------------------------------------- | --------------- | --------------- | --------------------- | ------------------- | ------------------------ | ------------------- | ---------- |
| dev-3, development set                    | 25 / 25         | 18 / 18         | 154 / 154             | 197 / 197           | 154 / 154                | 0                   | USD 0.0168 |
| holdout-amended-regression-2, exposed set | 10 / 10         | 9 / 9           | 81 / 81               | 81 / 81             | 63 / 63                  | 0                   | USD 0.0059 |

The held-out set has been exposed since holdout-1 and its diagnosis shaped
this prompt, so holdout-amended-regression-2 is regression evidence only. The
untouched result stays holdout-1: 6/10 outcomes and 5/9 exact. A new untouched
claim needs a fresh independent set run once at a frozen revision.

Downstream, the remaining misses are shared by the oracle-normalized arm
(world or setup gaps the scenario format cannot carry): D13 and H06 expect a
duplicate disposition that needs an earlier delivery, and H01 expects a plan
on changed demand the seed does not hold. In-memory-only rows: D06 (PO-123)
and D09 (PO-121) are not seeded, and D12's sender is registered to V-200 in
the evaluation world but not in the seed. D10 and D15 pause before intake.

## Consequences

- One more workspace package and five pinned dependencies (catalog).
- Migration 0005 (schema tag `0005_extraction_agent`) adds three application
  tables and the checkpoint schema, and widens the API's grant on
  `fixture_reference.supplier_input` to insert.
- The extraction is a proposal only. A verified plan from an email is still
  not evidence of physical delivery or customer impact.

## Limitations

- Evaluation scenarios run against an in-memory world (`EVALUATION_WORLD`)
  that mirrors the fixture vendors and orders. With `--downstream postgres`
  (this amendment) every proposal on PO-120 from a sender with the same standing in
  the seed runs through the database, intake and assessment; other rows stay
  in-memory only and are listed. Approval, application and verification are
  not exercised by the evaluation; only C-01 runs them in the integration
  suite.
- Only the fixture organization is served, as for structured messages.
- The PO tool reads the current revision only; an email citing an older
  revision is caught by intake's base-revision check, not by the agent.
- Live behavior is measured on fictional fixtures with one model; results are
  prototype evidence, not production accuracy.
