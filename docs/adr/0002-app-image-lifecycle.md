# ADR 0002: One s6 app image and its container lifecycle

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-18

## Context

The application image packages the pilot web, API and worker into one non-root image
supervised by s6-overlay 3.2.3.2, beside the separate PostgreSQL service. The
task fixes the stages, the s6 settings, the two readiness predicates, the
watchdog, the first-failure record and the gates C1 to C10. This record states
the declared bounds and timeouts, the choices the task left open, and what was
observed while making the image behave as specified.

## Image

- Bases are pinned by multi-platform index digest: `node:24.22.0-bookworm-slim`
  (runtime and build) and `alpine:3.22` (only to unpack the s6 archives, since
  the slim Node image has no `xz`). The image is built natively for the host;
  multi-arch is out of scope.
- s6-overlay archives come from the GitHub release through `ADD --checksum`
  with the SHA-256 values published for v3.2.3.2 (noarch, aarch64, x86_64).
- Stages: base (Corepack prefetches pnpm 12.14.0), deps (`pnpm fetch`, then an
  offline frozen install from the manifests), build, package, s6, runtime.
  Nothing is installed when the container starts.
- The build runs the root `build` script's two steps through Corepack. The
  script's nested bare `pnpm` call is not on the image's PATH, and the
  repository does not use `corepack enable`.
- `pnpm deploy --prod` produces `/opt/api` (with the compiled migrations, SQL
  grants and seed) and `/opt/worker`. Deploy re-checks the derived lockfile
  against registry metadata, which `pnpm fetch` does not cache, so the package
  stage needs the npm registry. It is not offline.
- The web app is the Next standalone output traced from the repository root,
  with `public` and `.next/static` copied beside `apps/web/server.js`. The
  server retitles its process `next-server`.
- Runtime: fixed user and group `sd` 10001:10001, `/var/run -> /run` created at
  build time (a read-only root cannot be fixed at start), `NODE_ENV=production`,
  the build revision as an OCI label and environment value.
- Size: about 1.05 GB on linux/arm64. The API deployment carries `next` and its
  SWC binary (about 300 MB) because the lockfile resolves Better Auth's optional
  `next` peer for the whole workspace. Pruning it is left as a follow-up rather
  than editing deployed dependency trees by hand.

## Services and ordering

s6-rc definitions live in `infra/app/rootfs/etc/s6-overlay/s6-rc.d` and the
user bundle lists them.

| Service    | Type    | Depends on               | Notes                                                                                                |
| ---------- | ------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `boot-id`  | oneshot | `base`                   | Writes a random UUID to `/run/sd/boot-id`; its `down` restores the first failure's exit code (below) |
| `api`      | longrun | `base`, `boot-id`        | Readiness notification on fd 3 from `s6-notifyoncheck` probing API readiness                         |
| `worker`   | longrun | `base`, `boot-id`, `api` | Starts only after API readiness                                                                      |
| `web`      | longrun | `base`, `boot-id`, `api` | Starts only after API readiness                                                                      |
| `watchdog` | longrun | `base`, `boot-id`        | Startup and hang bounds                                                                              |

Every run script uses `with-contenv` with `S6_KEEP_ENV=0` and starts its
process through `env -i` with an explicit allowlist, then `exec node`. The web
server gets no secret and no database variable. `BOOT_ID_FILE` points every
Node service at `/run/sd/boot-id`; with `NODE_ENV=production` the configuration
package requires it, so no service in the image generates its own boot ID.

`s6-notifyoncheck` runs the API probe every 250 ms until it passes, and the
probe's output reaches the container log (observed: a normal start logged
`api=no_response` and `api=ready`). One line per attempt would add four lines a
second for a start that never becomes ready, about 100 s in C3(c). The probe
therefore runs with `--log-changes` and prints a result only when it differs
from the previous attempt's, kept in `/run/sd/probe-api.last`; C3(c) asserts at
most five such lines.

Settings: `S6_READ_ONLY_ROOT=1`, `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`,
`S6_LOGGING=0`, `S6_KILL_GRACETIME=5000`, `S6_KEEP_ENV=0` and
`S6_CMD_WAIT_FOR_SERVICES_MAXTIME=100000` (see the startup deadlock below). The
non-root preinit works when `/run` is a tmpfs owned by UID 10001 and mounted
`exec`.

## Readiness

Two predicates, never one.

- API readiness (`GET /internal/health/ready` on 127.0.0.1:3001): a separate
  two-connection pool with 2 s connect and query timeouts reads
  `app.schema_tag` with the API role, compares it with `SCHEMA_TAG` compiled
  into the build, and requires the pg-boss producer to have started. Reasons:
  `database_unreachable`, `schema_missing` (undefined or not granted),
  `schema_incompatible`, `queue_unavailable`. The API listens before its queue
  starts and retries the queue start every 2 s, so readiness can report why it
  is not ready.
- Aggregate readiness (the Docker healthcheck, `/opt/sd/bin/healthcheck.mjs`):
  API readiness, the web server serving `/robots.txt` on 127.0.0.1:3000, and a
  worker heartbeat row whose boot ID equals `/run/sd/boot-id` and whose age,
  measured by the database clock, is below the freshness bound.
- The schema tag is a single-row table the migrator writes after grants
  (`0001_readiness` now). A rerun leaves `applied_at` unchanged; a drifted tag
  is corrected. The API role may only `SELECT` it.
- The worker writes its first heartbeat only after `boss.start()` and
  `boss.work()` succeed. The write is an upsert on the boot ID that refreshes
  `started_at` and `observed_at`, so a worker restarted inside one container
  boot keeps one row.
- A failed first write, such as one blocked on a lock past the worker's 5 s
  statement timeout, is retried every 2 s. No attempt starts after 90 s (the
  startup bound, counted from the first attempt), so the last one can end up
  to its own connect and statement timeouts later; the worker then exits 1.
  The watchdog counts the same bound from the container's start, before the
  worker starts, so in the container it will halt a stalled start first
  (`startup-timeout`, exit 71) and the worker's own give-up ends only host
  runs. Errors a retry cannot fix are not retried: SQLSTATE class 42 (syntax
  error or access rule violation, such as 42501 for a revoked grant or 42P01
  for a missing table) and class 3F (invalid schema name) end the worker at
  once with the driver error in its `startup failed` line, which halts the
  container as a first failure. A shutdown requested during the retry ends it
  and drains as usual; the pool's close still waits for an attempt in flight
  (at most its statement timeout). Without the startup retry one
  blocked write ended the worker, so the container halted and Compose
  restarted it under a new boot ID. Later heartbeats are not retried: a failed
  beat is logged and the next one tries again.
- Heartbeat access for the API: a narrow grant, `USAGE` on schema `worker`
  and `SELECT` on `worker.heartbeat` only. The API cannot write the heartbeat
  and gains no other table; the worker still has no business-table access.
  A view or function would add an object without narrowing access further.
- The health routes live under `/internal`, which the web server never proxies;
  only the loopback API listener answers them, and they return status words.

## Bounds

| Bound                                     | Value                                                                       | Where                                           |
| ----------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Heartbeat interval                        | 2 s                                                                         | `packages/db/src/heartbeat.ts`                  |
| Heartbeat freshness                       | 10 s                                                                        | `packages/db/src/heartbeat.ts`                  |
| First heartbeat retry                     | every 2 s, none started after 90 s; SQLSTATE 42, 3F fail fast               | `apps/worker/src/startup.ts`                    |
| Probe timeout                             | 2 s                                                                         | `infra/app/rootfs/opt/sd/lib/probes.mjs`        |
| Watchdog interval                         | 2 s                                                                         | `infra/app/rootfs/opt/sd/lib/watchdog-core.mjs` |
| Startup bound (first aggregate readiness) | 90 s                                                                        | same                                            |
| Hang bound (continuous probe failure)     | 30 s                                                                        | same                                            |
| s6-rc start transition backstop           | 100 s                                                                       | `S6_CMD_WAIT_FOR_SERVICES_MAXTIME`              |
| Healthcheck                               | interval 2 s, timeout 5 s, retries 3, start period 90 s, start interval 1 s | `compose.yaml`                                  |
| Pilot `holdMs`                            | 0 to 8000 ms                                                                | `packages/contracts`                            |

Gate bounds in `scripts/container/support.mjs` add observation slack: SIGKILL or
unexpected exit to container exit under 15 s; SIGSTOP to container exit under
60 s (30 s hang bound, plus up to 10 s for the worker's heartbeat to go stale,
probe period and timeout); startup-timeout exit under 120 s; a normal stop with
a job in flight under 30 s; return to healthy within 120 s.

## Watchdog

The watchdog probes every 2 s. Before first aggregate readiness it enforces the
startup bound and records `startup-timeout`. Afterwards it tracks, per service,
how long its probe has failed and records `hang:<service>` past the hang bound.
It skips services that `s6-svstat -o wantedup` reports as wanted down and
resets their window, so `s6-svc -d` leaves the container unhealthy without a
halt until the service is brought up again. When the API does not answer, the
worker's heartbeat cannot be read; the worker's window is then neither started
nor cleared, and the API's own window drives the halt. A database outage fails
API readiness: shorter than 30 s, the container returns to healthy in place;
longer, the watchdog halts it and Compose `restart: unless-stopped` retries.

Docker's unhealthy status alone never restarts a container, so this halt is the
recovery path. Docker can report healthy up to one watchdog interval before the
watchdog's own first readiness round; a service that hangs in that gap is
caught by the startup bound instead, as `startup-timeout`.

Measured fault-to-exit times for a dead service are about 5.2 s, although the
services stop within a few hundred milliseconds. The remainder matches
`S6_KILL_GRACETIME` (5000 ms) in s6-overlay's final stage; this was observed,
not traced in s6-linux-init's source.

## First-failure record and exit codes

Each essential service's `finish` (`/opt/sd/bin/finish-essential`) prints one
line, `sd-lifecycle service=<name> exit=<code> signal=<sig|none> wanted=<up|down|unknown>`.
If the service exited while still wanted up (any exit code, including 0; an
unreadable state counts as up), it claims `/run/sd/first-failure` with an
atomic `mkdir`, writes `record` and `exit` there and the exit code into
s6-overlay's results file, prints `sd-first-failure ...`, halts the container
and exits 125 so s6 does not restart it. A later finish finds the claim taken
and changes nothing. The watchdog claims the same directory for its reasons.

| Cause                            | Container exit code       |
| -------------------------------- | ------------------------- |
| Service killed by signal N       | 128 + N (137 for SIGKILL) |
| Service exited with code N > 0   | N                         |
| Service exited 0 while wanted up | 1                         |
| `hang:<service>`                 | 70                        |
| `startup-timeout`                | 71                        |
| Normal stop                      | 0, no record              |

## Startup deadlock and the exit code it would lose

Observed: a halt requested while s6-rc's start transition still waits for API
readiness never completes. `rc.shutdown` runs `s6-rc -bda change`, which waits
for the lock the start transition holds, and with an unbounded transition the
container hangs with its record written. The image therefore bounds the start
transition at 100 s, 10 s past the startup bound. When it times out, s6-overlay's
`rc.init` writes its own status to the results file, after the first failure
did. The `boot-id` oneshot's `down` script runs last during shutdown, because
every essential service depends on `boot-id`, and copies
`/run/sd/first-failure/exit` back. A startup-timeout therefore exits 71 about
100 s after start, and other failures during startup keep their own codes.

## Shutdown

`rc.shutdown` stops `web`, `worker` and `watchdog` before `api` (dependency
order) and has no overall timeout, so each service's s6 timeouts bound it.

| Service    | Own deadline                      | `timeout-kill` | `timeout-down` |
| ---------- | --------------------------------- | -------------- | -------------- |
| `worker`   | drain 10 s, process deadline 11 s | 12000          | 13000          |
| `web`      | Next default                      | 10000          | 11000          |
| `watchdog` | exits on SIGTERM                  | 3000           | 4000           |
| `api`      | 5 s                               | 6000           | 7000           |

After `rc.shutdown`, s6-overlay's final stage sends SIGTERM to anything left
and waits `S6_KILL_GRACETIME` (5 s) before its last SIGKILL. The measured stop
times fit this: C8 takes about 13 s with an 8 s hold in flight, and a halt
takes about 5.2 s from the fault. The worst case is therefore 13 s for the slowest of
`worker`, `web` and `watchdog`, then 7 s for `api`, then 5 s: 25 s, under the
30 s drain budget and inside Compose `stop_grace_period: 60s`. The longest pilot
hold (8 s) plus its receipt call fits the 10 s drain. A pilot handler that
cannot finish within the drain is abandoned: at the drain timeout pg-boss
12.38 fails every job still active ("pg-boss shut down while active") before
closing its pool, so the job returns under the queue's retry policy (retry
limit 3, 1 s delay) and a worker can claim it again. Only if that fail write
itself fails does the job stay active until its 30 s expiry. A receipt call
from the abandoned handler that reaches the API afterwards finds the job no
longer active and gets 409 `job_not_matched`, so it records nothing. A later
attempt can record the receipt, and the receipt endpoint is idempotent.
`scripts/test/drain-budget.test.mjs` reads these values from the image sources
and fails when the sum, with 1 s of overhead, reaches 30 s. C8 also stops a
container with the longest hold in flight and the API frozen, so the receipt
cannot complete and the worker uses its whole drain, and asserts the stop stays
under 30 s with no SIGKILL. Escalation to `timeout-kill` itself is covered only
by that arithmetic: s6-supervise sends SIGCONT with every SIGTERM, so a frozen
process resumes and exits on its own, and the image has no hook that makes a
service ignore SIGTERM. The Next server exits 143 on SIGTERM, which the finish
script reports as `exit=143 signal=none wanted=down`.

## Initialization and secrets

`scripts/init-secrets.sh` also writes `.secrets/container/database_url_*`
pointing at `db:5432`, leaving the host files unchanged. The Compose `init`
profile service runs `/opt/sd/bin/init-db` from the same image (migrations,
pg-boss schema, queue, grants, schema tag, then the fixture seed, each bounded
by `timeout 120`). Only it mounts the migrator URL and fixture passwords. The
`app` service mounts the API and worker URLs, the Better Auth secret and the
worker token, with `read_only`, `cap_drop: [ALL]`,
`no-new-privileges:true`, tmpfs `/run` (UID-owned, `exec`) and `/tmp`
(`noexec`), and publishes only `127.0.0.1:${SD_APP_HOST_PORT:-3102}:3000`. The
API listens on 127.0.0.1:3001 inside the container. Only `db-data` persists.
`SD_APP_IMAGE` and `SD_APP_HOST_PORT` exist for the disposable test projects.

## Container gate tests

`corepack pnpm test:container` clones `HEAD` into a temporary directory, writes
a distinct canary into every file `init-secrets.sh` produces, into `.env` and
into nested `apps/web/.env.local`, `apps/api/.env` and
`packages/db/.secrets/token`, builds the image and its `build` stage, and runs
each gate file in its own Compose project `supplier-disruption-ct-<run>-<gate>`
on a free loopback port. C9 searches the build stage, which received the whole
build context, and the final image's layers, history and configuration, so
dropping a `.dockerignore` exclusion fails it even when no later stage copies
the file. The teardown removes the run's projects, then every container,
volume and network carrying their Compose label, both images and the clone,
also after a failed test; a failed setup removes what it created. The observer is
`psql` as the PostgreSQL superuser inside each project's `db` container, so
gates need no host database port. Deaths use SIGKILL, hangs SIGSTOP, both sent
to the process s6 reports for the service.

C3(a) needs a probe to run while the previous boot's heartbeat is fresh and
the new boot has no row. The new worker writes its row about a second after
start, before Docker's first probe, so the test holds an `EXCLUSIVE` lock on
`worker.heartbeat` from the observer session between stop and start. The stop
takes several seconds, so the test first refreshes the previous row's
observation time, as that worker's last beat would have; probes then run with
the API up while the row is fresh, and every probe that reaches the API fails
on the worker. The lock blocks
heartbeat writes but not the API's reads, and is released once the previous
row is past the freshness bound and the worker has logged a first heartbeat
write that failed on its statement timeout, so the gate always exercises the
retry. It reads the boot ID when it observes healthy, and fails naming a
restart (a first failure, a changed `RestartCount` or start time, or a second
`sd-boot` line) rather than reporting a missing row for a boot that died.

## Limits

- A stopped or hung watchdog is not detected. Docker reports unhealthy, but
  nothing restarts the container.
- Environment filtering in the run scripts is not an access boundary. Every
  service runs as UID 10001, and every secret mounted into `app` is readable by
  that UID, so a compromised service can read the other services' secrets. The
  filtering only keeps each process's environment to what it uses. Separating
  them would need distinct UIDs or containers.
- Pseudo-filesystems and devices (`/proc`, `/sys`, `/dev`, `/dev/shm`) stay
  writable where the kernel or Docker makes them so; C2 checks the application
  directories, `/`, `/etc`, `/usr` and the home directory.
- Only linux/arm64 was built and tested. The x86_64 archive checksum is pinned
  but unexercised.
- The image build needs the npm registry and GitHub; there is no offline build.
- Docker build cache from the gate runs is shared and not removed by the tests.
