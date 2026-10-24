# ADR 0012: Demonstration mode

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-21
- Superseded in part by [ADR 0017](0017-project-spend-reservations.md): the cumulative spend cap below

## Context

SPEC "Milestone path" item 5 asks for a demonstration that shows a successful
recovery plan and a failed or stale one and explains its limits. The C-01
fixture is time-bound: an approval expires at 18:00 Copenhagen time on the day
it is given (ADR 0009) and the TRO-1 quote is valid until 2026-10-22T10:00Z,
so the packaged app on the system clock cannot demonstrate C-01 on most days
(ADR 0010, limitations). A stale approval and an uncertain write need a source
change or a lost response at a precise moment, which a person cannot cause in
a live session. The agent path must run without model spend.

## Decision

### One explicit mode

`DOMAIN_CLOCK_MODE=demonstration` is a third business clock mode. Config
accepts it in any `NODE_ENV`, so the production image runs it unchanged, and
only with `DATA_MODE=fixture`; the default stays `system`, and nothing selects
the mode implicitly. The image's API service script already forwards
`DOMAIN_CLOCK_MODE` only when the container sets it (ADR 0010), so no image or
s6 change is needed. In this mode the API:

- reads the business clock from the fixture clock row, as the controlled test
  clock does. The init seeds it at 2026-10-21T09:00:00+02:00, inside the C-01
  window, and nothing advances it. Operational timers keep real time.
- serves `GET /api/demonstration` with the notice, the clock instant, the
  agent provider and the controls. It is public, like the sign-in page that
  shows it, and carries no case or identity data; outside the mode it answers
  `{ "active": false }`. The workbench shows "Simulated business clock" and the
  notice on every signed-in page and on the sign-in page.
- replays the recorded C-01 email run for email extraction (below) and refuses
  to start if `AGENT_PROVIDER` is set.
- accepts the two demonstration controls (below).

### Recorded agent run

`RecordedRunProvider` in `packages/agent` answers each model request with the
recorded response whose request digest matches, stateless and offline. The
API packages the committed C-01 recording
(`evaluation/replays/smoke-2/D01.json`, recorded live at a development revision under the
amended system prompt (ADR 0011); it replaced `smoke-1`, which stays unchanged, because
a prompt change alters every request digest) as
`apps/api/src/demonstration/c01-recorded-run.ts`, because the image packages
only `dist`; an integration test keeps the two equal. Before relying on
digests, a local run of the integration flow confirmed that the API's requests
for the C-01 email match the recording with zero mismatches. Any other email
reaches a request the recording does not hold and pauses
`agent_provider_failure` for the buyer. The run is recorded with provider
`replay` and its recorded usage, which the workbench labels "Recorded replay,
no model call" and "Recorded cost (replay, no new spend)".

### Demonstration controls

`POST /api/demonstration/cases/:id/controls` with `{ "control": ... }` needs
the session, the application origin and membership of the fixture
organization, and answers 404 outside the mode. Each control is recorded as a
`demonstration_control` case event labelled simulated. Neither decides,
acknowledges or applies anything.

- `foreign_reservation`: another order reserves 20 EA of PART-A at WH-B
  through the inventory authority, conditional on the current stock version,
  with the fixed operation ID `DEMO-FOREIGN-ORDER-1`, so a repeat is a no-op.
  The SPEC's example: WH-B's eligible stock falls from 50 to 30 EA after the
  plan. The existing `reserve` binds its reservation to a plan, which ELIG-1
  correctly refuses as `policy_plan_reservation_unsupported` when another
  case reads it. The inventory source therefore gains `reserveUnrelated`: the
  same conditional, idempotent write and receipt, but the reserved row carries
  no plan binding, as the fixture's seeded reservations for other orders do,
  and its request digest differs from a plan reservation's. Only this control
  calls it. A plan approved before the change is then refused at its first
  claim (`stale_source_stock`) with no write, and reassessment escalates
  `unresolved_shortage` because TRO-1 was quoted on the earlier stock version.
- `uncertain_reservation_write`: allowed while the case awaits approval or
  acknowledgement and its plan reserves stock. It arms the case's next ACT-2
  write to lose its response once, after the source commits it, through the
  existing `afterSourceWrite` fault hook, which `main.ts` now passes only in
  this mode. The workflow records ACT-2 `unknown`, the case
  `partially_applied` with `outcome_unknown`, and the next run reconciles it
  by operation ID and read-back without resubmitting (ADR 0009).

### One command

`corepack pnpm demo` (`scripts/demo/demo.mjs up`) runs the Compose project
`supplier-disruption-demo` with `compose.yaml` plus
`scripts/demo/compose.demo.yaml`, which adds only
`DOMAIN_CLOCK_MODE: demonstration`, and the image tag
`supplier-disruption-app:demo`. It runs `scripts/init-secrets.sh` (which
keeps existing files), removes the demo project's earlier containers and
volume, refuses to continue if 127.0.0.1:3102 is in use, builds or reuses the
image, runs the init, starts the app, checks `GET /api/demonstration` and
prints the identities, the password file paths (never the values) and the next
steps. `corepack pnpm demo:down` removes that project's containers, network and
volume and keeps the image. `compose.yaml` and the default stack are
unchanged.

### Spend cap for live extraction

Independently of the mode, the API now caps cumulative metered agent spend:
`AGENT_TOTAL_COST_CAP_USD` (default 1, at most 15). Before a run with a
provider other than `replay`, the API sums the recorded cost of every earlier
non-replay run in its database; if that plus the run's own cap would pass the
total, the run pauses `agent_spend_cap_reached` for the buyer without a model
call.

## Verification

- `packages/config` tests: the mode is accepted in production, development and
  test with fixture data and refused otherwise; unknown values are refused
  without echoing them.
- `packages/agent` tests: the recorded run provider replays the C-01 email to
  its proposal twice from one instance and pauses another email.
- `apps/api/test/email-extraction.test.ts`: the packaged recording equals the
  committed one, and the spend cap pauses a run before any model call while a
  run within the cap proceeds.
- `scripts/container/demonstration.test.mjs`: W2 and W3, described in
  [docs/demo](../demo/README.md), through the packaged image.

## Limitations

- The mode is a demonstration aid. The clock never moves, so expiry and
  elapsed-time behaviour are not shown, and case ages read 0 s.
- Each run of `corepack pnpm demo` deletes the demonstration data. Part 1
  changes PO-120 and WH-B, so part 2 needs fresh data.
- The uncertain-write arming lives in the API process and is lost on restart.
- The spend cap sums recorded costs before a run starts; two metered runs
  started at the same moment can each pass the check. Concurrent live runs are
  not part of the prototype.
- The recorded run covers one synthetic email. Simulated actors and fixture
  adapters remain; no ERP or mailbox connector is exercised.
