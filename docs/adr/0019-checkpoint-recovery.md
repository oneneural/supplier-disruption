# ADR 0019: Mid-investigation checkpoint recovery

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-22
- Supersedes in part: [ADR 0011](0011-extraction-agent.md) (refusal and
  provider failure pause reasons, resume behavior) and
  [ADR 0017](0017-project-spend-reservations.md) (the admission and
  settlement of a resumed run)

## Context

ADR 0011 checkpointed the extraction graph in PostgreSQL under the run ID,
and a test showed that a finished thread returns its outcome without another
model call. Nothing showed that a run stopped between steps resumes safely.
Several gaps remained:

- A resumed run reserved a fresh full cost cap and settled the run's
  cumulative usage, so a resume counted known spend twice (ADR 0017 limits).
- Nothing recorded which graph, model or evidence a checkpoint was written
  under, so a checkpoint from another version could silently continue.
- Two deliveries of the same case job could run the same graph thread at
  once: nothing serialized extraction the way application is serialized.
- A case escalated while its run waited could still receive the proposal,
  and a run left unfinished on such a case stayed `running` forever.
- A model refusal and every provider error paused with the same reason,
  `agent_provider_failure`, and a response without usage was reported as a
  provider failure rather than a malformed response.

## Decision

### Checkpoint contract

The graph state carries a `contract`: `CHECKPOINT_CONTRACT_VERSION` (2), the
model, the evidence SHA-256, the tool budget and the run cost cap, written
with the first checkpoint. Version 1 means a checkpoint written before this
change, which carries no contract. Before running, `runExtraction` reads the
thread's checkpoint and compares the contracts field by field:

| Checkpoint                  | Behavior                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| None                        | A new run                                                                                   |
| Finished (outcome recorded) | Returns the recorded outcome; never re-invoked                                              |
| Unfinished, same contract   | Continues from the last checkpoint with its counts, usage, step sequence and messages       |
| Any other contract          | Pauses `agent_checkpoint_incompatible` with the differences; nothing is called or restarted |

There is no migration path: an incompatible checkpoint is refused, not
rewritten. The checkpoint stays as it is for an operator, and the pause
detail names every differing field.

Each step's checkpoint now commits before the next step starts (LangGraph
`durability: "sync"`), so a stopped process loses at most the step in
flight. The graph ends only once an outcome is set, so an unfinished
checkpoint is one without an outcome, including one whose last finished step
was recorded as pending writes after its checkpoint.

### Recovery in the API

`EmailExtraction.extract` takes a session advisory lock,
`case-extract:<case ID>`, on its own connection, like application's
`case-apply:<case ID>`. A second delivery of the job while the lock is held
returns `retry` without touching the run, so the queue redelivers it later.
The lock ends with the session of a process that stops.

Before any admission the API inspects the checkpoint (`inspectCheckpoint`):

- Incompatible: earlier unsettled attempts of the run become uncertain and
  stay counted, the run pauses `agent_checkpoint_incompatible` and the case
  moves to `needs_clarification` for the buyer. No reservation is made and no
  model is called.
- Unfinished: earlier unsettled attempts become uncertain, then the new
  attempt reserves the run cap less the cost already in the checkpoint. The
  graph never spends past the run cap, so that remainder bounds the attempt.
  Settlement records only what this attempt reported: the cumulative usage
  less the checkpoint's usage when it started.
- Finished, or a spent cap: no further call can happen, so nothing is
  admitted; earlier unsettled attempts become uncertain.

The stopped attempt's reservation keeps its full amount as uncertain usage
until an operator reconciles it with evidence (ADR 0017). The call that was
in flight when the process stopped is not in the checkpoint and is asked
again on resume, so its cost can be billed twice; the uncertain reservation
covers that. The tool budget and the 14-call model bound continue from the
checkpoint's counts, which do not include the lost call.

### Authority after waiting

A run is formed from reads made before any wait, so the API checks the case
again before using it:

- A case that left `received` while its run was unfinished (an escalation,
  for example) is never resumed. The next job delivery closes the run as
  `paused` with a detail naming the case state, keeps its checkpoint and
  marks its unsettled attempts uncertain. It has no pause reason: every
  agent pause reason describes the run's own outcome (`agent_escalated` is
  the model's escalation), and here a person closed the case.
- A proposal that arrives after the case left `received` is recorded on the
  run but not handed to intake. The case gets an `extraction_not_handed_off`
  event; no derived supplier input is stored.
- The hand-off check and intake are separate transactions, so intake guards
  the case itself. `CaseWorkflow.ingest` moves a case to `assessing`, or
  records a revision conflict on it, only from `received` or
  `needs_clarification` (a blocked case a later delivery may reassess). An
  escalation that commits after the check therefore makes intake throw
  `CaseStateConflict` and roll back whole: no accepted delivery, assessment
  or plan. The extraction then records
  `extraction_not_handed_off`. The derived supplier input stays in the
  insert-only reference store, because intake reads it back from there, but
  nothing uses it. If intake instead classifies the input as a duplicate or
  blocked observation of the escalated case, it records only that delivery.
- A proposal that is handed off passes the unchanged intake and assessment of
  ADR 0008 and ADR 0007, which read the current PO head, base revision,
  demand and stock. A proposal resumed after a source changed is assessed on
  the current records, not on what the run read before the stop.

The worker's job authority is unchanged: a call naming a job that is no
longer active, for example after it completed, is refused
`409 job_not_matched`.

### Distinct failure evidence

Every failed model turn now records a step whose result names the failure:

| Failure                                            | Pause reason              | Step `failure`       |
| -------------------------------------------------- | ------------------------- | -------------------- |
| Stop reason refusal                                | `agent_model_refused`     | `refusal`            |
| HTTP 404 from the API, or no configured price      | `agent_model_unavailable` | `model_unavailable`  |
| `max_tokens`, or a response without usage          | `agent_malformed_output`  | `malformed_response` |
| Any other error status, timeout or lost connection | `agent_provider_failure`  | `provider_error`     |

`agent_provider_unavailable` still means no provider is configured, and a
rejected proposal still pauses `agent_malformed_output` or
`agent_unsupported_evidence` after three attempts. `ProviderError` gains a
`kind`, `model_unavailable` or `provider_error`. A model without a price
pauses before its first call, as before, now as `agent_model_unavailable`.

## Consequences

- `CaseWorkflow.ingest` refuses to assess or mark a revision conflict on a
  case outside `received` and `needs_clarification`, so a late hand-off can
  never reopen an escalated or superseded case.
- `agentPauseReasonSchema` gains `agent_model_refused`,
  `agent_model_unavailable` and `agent_checkpoint_incompatible`. No migration
  or grant changes: `pause_reason` is plain text.
- A run started before this change and left unfinished cannot resume: its
  checkpoint has no contract and pauses for the buyer.
- A resumed run's ledger rows are the stopped attempt (uncertain, full cap)
  and the resumed attempt (settled with its own usage), so known spend is no
  longer counted twice; the stopped attempt's unknown spend still is.
- An escalated email case with an interrupted run is routed to extraction by
  its next job delivery, only to close the run.

## Limits

- A resumed proposal keeps the PO record the run read before the stop as
  its citation. Freshness is enforced by intake's base revision check and by
  assessment, not by re-reading inside the graph.
- The lost call's cost, and whether it was billed, are not known. They stay
  inside the uncertain reservation; the run's recorded usage and model-call
  count leave that call out.
- The contract binds the model, evidence, limits and a manually raised
  version number. A prompt or tool change that does not raise the version is
  not detected.
- Run and step records are still written only when a run ends; while a run
  is unfinished, its progress is visible in the checkpoint, not in
  `app.agent_step`.
- No live provider was called. The recovery gates use a local fake Messages
  API through the SDK's `ANTHROPIC_BASE_URL`; real provider refusals, 404s
  and lost connections are represented by scripted responses.

## Verification

- `packages/agent/test/graph.test.ts`: refusal, unavailable model (404 and an
  unpriced model), malformed response and provider failure pause with
  distinct reasons and step failures; an unfinished checkpoint resumes with
  only the lost turn asked again, the same request, counts, cost and step
  sequence; a checkpoint under another model, another cost cap or with no
  contract pauses `agent_checkpoint_incompatible` without a call.
- `apps/api/test/checkpoint-recovery.test.ts`, on disposable databases with
  the built API and worker processes, the PostgreSQL saver and an opened
  ledger, SIGKILL of the API while a model turn is in flight:
  - M1: the restarted API resumes the same run, sends the lost turn again
    with the same conversation, reaches the C-01 plan (70 covered, 50 short,
    50 by transfer, EUR 160) with 3 tool calls, 3 model calls and steps 1 to
    6, reserves the cap less 300 micro-USD and settles 150 while the stopped
    attempt stays uncertain at 50,000; a duplicate job delivery during
    recovery returns `retry`, and the completed job's ID is refused 409;
  - M2: a case escalated while its run waited is not resumed after a restart
    (run closed, reservation uncertain, checkpoint kept, no further call), and
    a proposal arriving after an escalation is not handed off;
  - M3: a restart with another model pauses `agent_checkpoint_incompatible`
    for the buyer with no call, no new reservation and the checkpoint kept;
  - M4: stock changed during the outage (`INV-B@2`) is what the resumed
    proposal is assessed against: the case escalates `unresolved_shortage`
    with no plan and no source effect;
  - M5: with intake held on its organization lock after the hand-off check,
    an escalation commits; intake then refuses the case, which stays
    `escalated` with only its evidence message, no assessment and no
    `assessing` step, and the run records `extraction_not_handed_off`.
