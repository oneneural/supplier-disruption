# ADR 0017: Project spend reservations and uncertain usage

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-22
- Supersedes in part: [ADR 0011](0011-extraction-agent.md) (provider retries,
  the run cost cap and the evaluation spend ledger) and
  [ADR 0012](0012-demonstration-mode.md) (the cumulative spend cap)

## Context

The owner's model budget is USD 20 cumulative across this application's
Anthropic calls and evaluations, with a mandatory pause at USD 15. Before this
change the API summed the recorded cost of earlier metered runs in its own
database before a run (ADR 0012), and `evaluation/run.mjs` summed its own
ignored `evaluation/.spend-ledger.json`. Neither saw the other, two runs that
checked at the same moment could both pass, a recreated database restarted the
API's total at zero, and a call whose usage never arrived counted as zero.

The graph's run cap was checked before each call against cost already spent,
so one call could take a run past its cap. The provider SDK also retried a
failed request once, and only the last attempt reported usage.

### Reconciliation before this change

Read on 2026-10-22 at the development base of this change, without printing any secret:

| Source                                | Records                                                                  | Metered cost     |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------- |
| Owner database `app.agent_run`        | 0 runs                                                                   | 0 micro-USD      |
| `evaluation/.spend-ledger.json`       | 47 entries                                                               | 30,763 micro-USD |
| Live reports in `evaluation/reports/` | smoke-1 1,250, dev-1 15,312, holdout-1 8,955, holdout-2-regression 5,246 | 30,763 micro-USD |

The ledger and the reports agree. The project total is USD 0.030763 (the
recorded checkpoint, USD 0.0308, rounded), with no uncertain request on
record. The provider console was not checked.

## Decision

### One ledger, one admission

Migration `0009_model_spend` adds two tables in the `app` schema, and
`0010_model_spend_guards` adds the insert guard and operator-only settlement
described below. The single
`model_spend_account` row holds an opening balance with its evidence: spend
recorded before this database existed. Each `model_spend_reservation` row is
one admitted provider attempt with a unique key, its source (`api` or
`evaluation`), the run it belongs to, the model, the reserved amount and a
status:

| Status      | Meaning                                                                    | Counted as          |
| ----------- | -------------------------------------------------------------------------- | ------------------- |
| `reserved`  | Admitted and not yet settled: in flight, or left by a process that stopped | The reserved amount |
| `uncertain` | Usage unknown                                                              | The reserved amount |
| `settled`   | Reported usage, or operator evidence                                       | The settled cost    |

The committed project total is the opening plus every settled cost plus every
reserved and uncertain amount. `ModelSpendLedger.admit` takes a transaction
advisory lock shared by every process and role, reads that total and inserts
the reservation only if the total plus the attempt's worst-case cost stays
within the limit. Otherwise it records nothing and returns the refusal. The
limit is the lower of the caller's application limit and the owner's USD 15
pause, so no configuration can pass the pause. Repeating a key returns its
reservation only while it is still `reserved` for the same source, reference,
model and amount; any other reuse is refused `key_in_use` with nothing
recorded.

The API (`apps/api/src/cases/extraction.ts`) and `evaluation/run.mjs` both
admit through this class. A provider whose `metered` flag is not explicitly
`false` must be admitted: replays, the recorded demonstration run and test
fakes declare `false`. A metered API run without a configured ledger pauses.

### Worst-case cost of a run

The reservation is the run's cost cap (`AGENT_RUN_COST_CAP_USD` in the API,
`--case-cap-usd` in the evaluation runner), and the graph now guarantees a run
never spends more. Before each call it computes the call's worst case and
pauses `agent_cost_cap_reached` if spent cost plus that worst case would pass
the cap:

- Input tokens are bounded by the UTF-8 byte length of the serialized request
  plus a 2,048-token allowance for the provider's tool-use prompt and framing.
  Every token covers at least one byte.
- Each input token is priced as a five-minute cache write (1.25x input), the
  dearest input rate this provider configuration uses.
- Output is bounded by `max_tokens`, which includes thinking.

The SDK's automatic retry is off (`maxRetries: 0`), so one graph call is one
request. A failed call pauses the run instead of retrying.

### Settlement and uncertain usage

After a run, its `reserved` attempt is settled with the usage the provider
reported. Settling the same key again with the same cost changes nothing; a
different cost is a `SpendLedgerConflict` and the first settlement stands. If
the attempt was meanwhile marked uncertain, for example by a later attempt
that took it for stopped, its reported usage is recorded and it stays
uncertain for the operator.

The graph marks a run's usage uncertain when a call failed after it may have
been sent (a timeout, connection error or provider error status) or when a
response reported no usage. `ProviderError` carries `usageUnknown`, true by
default; only a failure before sending sets it false. A model without a
configured price pauses before its first call. An uncertain attempt keeps
its full reservation, with any usage reported so far kept for the reconciler.
An exception from the run itself marks the attempt uncertain before it
propagates. Nothing releases an uncertain or reserved amount on a timer.

A process that dies leaves its attempt `reserved`, still counted. Before the
API admits a new attempt for the same agent run, it marks every earlier
`reserved` attempt for that run `uncertain`. A resumed run's new attempt is
settled with the run's cumulative reported usage, so a resume can count the
same known spend twice. That error is conservative.

Triggers make every new reservation start `reserved` with no settled cost or
resolution, keep each reservation's identity and amount fixed, make `settled`
final, stop `uncertain` from returning to `reserved` and let only the table
owner (the migrator, reconciling with evidence) settle an `uncertain`
attempt. The API role can read the account, insert reservations and update
only their status, settled cost, usage, detail and resolution time. It cannot
open the account, delete anything, change an amount or release unknown usage.

### Opening, recreation and the operator command

A database without an opening refuses every metered admission with a pause
before any provider call. A recreated volume therefore cannot silently
restart the project total at zero. The migrator records the opening once with
`packages/db/dist/cli/spend.js open --micro-usd <n> --evidence <text>`; an
identical repeat changes nothing and any other value is refused. The same
command prints `status` and settles a reserved or uncertain attempt with
`reconcile --key <key> --micro-usd <n> --evidence <text>`, for example from
the provider console. It prints amounts and keys only.

The evaluation runner keeps appending reported spend to the ignored
`evaluation/.spend-ledger.json` as a host-side lower bound and prints its path.
A live run refuses to start when an opened project ledger is below that
record. `--output-dir` moves only reports and replays; the record moves only
with an explicit `--spend-record <file>`, which tests use.

### Separate limits

| Limit                                                   | Owner                                 | Applies to                                                        |
| ------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| Per-run cap: `AGENT_RUN_COST_CAP_USD`, `--case-cap-usd` | The API or runner                     | One agent run; it is the reservation                              |
| Evaluation run cap: `--run-cap-usd`                     | The runner                            | One evaluation invocation; unknown usage counts the full case cap |
| Project limit: `AGENT_TOTAL_COST_CAP_USD` (default 1)   | The API, and the runner when set      | Committed project total                                           |
| Owner pause: USD 15                                     | Code constant `OWNER_PAUSE_MICRO_USD` | Every admission, whatever the configuration                       |
| Provider account limit                                  | The owner, in the provider console    | Not read or verified by this code                                 |

## Consequences

- Concurrent API and evaluation runs cannot together reserve past the limit.
- A run reserves its whole cap, so a low limit admits fewer concurrent runs
  than their eventual cost would allow.
- Unknown usage blocks budget until an operator reconciles it with evidence.
- An exhausted ledger shows the case paused `agent_spend_cap_reached` for the
  buyer, with the totals in the detail, and makes no provider call.
- The worst-case guard can pause a run earlier than the old check. The
  committed development replays keep their outcomes at the 0.05 cap.

## Limits

- The ledger lives in the database. Deleting the volume destroys it; the new
  database fails closed, and its opening is only as good as the operator's
  evidence. `scripts/db-reset.sh` does not export the total first, and API
  spend after the opening has no host-side record.
- The byte bound on input tokens assumes byte-level tokenization and the
  overhead allowance; the price table is the configured one, not live
  billing.
- Every provider error is treated as possibly billed, including those that are
  probably not, such as an authentication failure.
- The API role could still settle a `reserved` attempt it does not own, at
  any amount. The code settles only its own attempt key, but this is record
  ownership, not isolation.
- No live provider call was made. Timeouts, missing usage and crashes are
  exercised with fakes, row manipulation and fresh pools, not real provider
  failures or a killed process. Tests do not cover an exception thrown from
  the run itself, the evaluation runner's settlement and uncertain paths with
  a provider that answers, the per-run evaluation cap, or a resumed run
  counting known usage twice.

## Verification

- `packages/agent/test/graph.test.ts`: a call whose worst case would pass the
  run cap is never sent, provider failures leave usage uncertain unless the
  request was never sent, and a response without usage pauses as uncertain.
- `packages/agent/test/provider.test.ts`: against a local server answering a
  retryable 529, the provider sends exactly one request and reports the
  failure as possibly billed.
- `packages/db/test/spend-ledger.test.ts`, on a disposable database: an
  unopened ledger refuses and the API role cannot open it. Ten individually
  admissible reservations from two pools against room for one admit exactly
  one. The owner pause caps every limit. Settlement is idempotent and a
  conflicting repeat fails. A key is reused only while reserved for the same
  admission. A new row must start reserved. Uncertain usage stays counted
  until reconciled with evidence, and the API role cannot release it, even
  through a late settlement. Reservations survive new
  pools, and a recreated database refuses until reopened. The command opens
  and reports without a connection string. `evaluation/run.mjs --mode live`
  stops at admission, reads `evaluation/.spend-ledger.json` despite
  `--output-dir` without changing it, and with `--spend-record` refuses a
  ledger below that record, with the provider base URL on a closed port.
- `apps/api/test/email-extraction.test.ts`: a metered run pauses before any
  model call while the ledger is unopened or the limit is short, then is
  admitted and settled. A timed-out call and a stopped attempt keep their full
  reservations as uncertain.
