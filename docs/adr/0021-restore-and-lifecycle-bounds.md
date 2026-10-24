# ADR 0021: Backup restore, hung-watchdog detection and lifecycle bounds

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-22
- Extends: [ADR 0002](0002-app-image-lifecycle.md) (its "stopped or hung
  watchdog is not detected" limit and its arithmetic-only TERM-to-KILL
  escalation), which stays unchanged as the historical record

## Context

The original image tests proved that the `db-data` volume persists across container
recreation, not that a backup restores. Nothing backed up the database, and
no gate restored one into a fresh volume with pending work in it. ADR 0002
recorded two lifecycle limits: a stopped or hung watchdog was not detected
(Docker reported unhealthy and nothing restarted the container), and s6's
TERM-to-KILL escalation was covered only by arithmetic, because s6-supervise
sends SIGCONT with every SIGTERM and no service ignores SIGTERM. Three
container gates were also sensitive to host load: the P5 clock-skew guard,
the C3(a) probe-time comparison and the C4 recovery bound (a reserved
lifecycle follow-up).

## Decisions

### Logical backup from one exported snapshot

All durable state is in one PostgreSQL database, so a logical dump of that
database is the whole backup. `scripts/backup-restore.mjs` (`db:backup`,
`db:restore`) runs `pg_dump` and `pg_restore` inside the project's own `db`
container as its superuser, so no host client or published database port is
needed.

- Backup opens a `REPEATABLE READ READ ONLY` transaction, exports its
  snapshot and runs `pg_dump --format custom --snapshot` on it. In the same
  transaction it computes the manifest: per table a row count and an
  order-independent digest (MD5 over the sorted MD5 of each row's text, with
  UTC, ISO dates and fixed float digits), the count of stored messages whose
  bytes no longer match their SHA-256, and the foreign-key count. The dump
  and its manifest therefore describe one committed state. That this holds
  while the application keeps writing follows from the design (an exported
  `REPEATABLE READ` snapshot, `pg_dump --snapshot` and the manifest in the
  same transaction); B1 backs up an idle database and does not test it. MD5 here detects accidental differences between
  two copies, not tampering; the dump file itself is checked with SHA-256.
- Restore checks the dump's SHA-256, refuses a target database that already
  holds any table, a different PostgreSQL major version or missing login
  roles, loads the dump with `--single-transaction --exit-on-error` and
  compares the restored state with the manifest. Any difference exits 1.
  There is no default restore target and no overwrite option, so the
  development database cannot be restored over.
- Roles, their passwords and database-level grants are not in a
  single-database dump. The target's own initdb creates the fixed role names
  from its secrets; ownership and grants inside the database are restored.
- The script writes owner-only files outside the checkout and does not
  encrypt; the [runbook](../operations/backup-restore.md) states storage,
  encryption and what is not backed up.

### Pending work after restore

The restored database carries unfinished actions and active jobs. No restore
step edits them. The application's existing read-back before resubmission
([ADR 0016](0016-workflow-interruption-recovery.md)) settles a committed
effect whose journal entry was still pending, and the active job from the
backed-up run is retried after its pg-boss expiry or the API's restart sweep.

### Hung-watchdog detection from the healthcheck

The watchdog rewrites `/run/sd/watchdog-beat` (its clock, written then
renamed) at the start of every round. Docker runs the healthcheck in its own
process every 2 s, independent of the watchdog, so the healthcheck now checks
the beat before its probes. When the beat is at least 20 s old
(`watchdogStaleMs`, ten watchdog intervals) and s6 reports the watchdog up,
wanted up and in that state for at least 20 s, the healthcheck claims the
first failure `reason=hang:watchdog detail=beat_age_ms=<n> source=healthcheck`
with container exit 70 and halts the container, which Compose restarts. The
record line is also written to PID 1's output so it reaches the container log.

A watchdog brought down on purpose, one just brought up again whose first
beat is still due, a container that is stopping, a missing beat file or an
unreadable s6 state decides nothing, so a normal stop is never recorded as a
failure. The first-failure claim is shared with the watchdog
(`opt/sd/lib/first-failure.mjs`), so only one record can win.

### TERM-to-KILL observation without an image hook

The image keeps no test hook. L2 blocks the worker's event loop through Node's
inspector, opened by SIGUSR1 on the container's loopback: a client evaluates
an endless loop and stays connected, so neither the worker's SIGTERM handler
nor its own 11 s deadline can run. A normal `docker compose stop` then shows
s6's real escalation.

### Load-sensitive gates

- P5 samples the host/container clock skew up to ten times, stopping once a
  bracket is under 100 ms, instead of three times. The 250 ms guard and every
  timing assertion are unchanged.
- C3(a) compares probes by their End timestamps. Docker stamps Start before a
  probe reads the heartbeat; only End is certain to follow the read. A probe
  that started before the new row became visible may legitimately read it and
  pass; the earlier intake test's run 2 failure (a first passing probe stamped 38 ms
  before the commit) is consistent with such a probe, though it was not traced. Every probe that
  ended before the new row was visible, while the previous row was fresh,
  must still fail, at least one of them with the API up; the first passing
  probe must end after the row became visible.
- C4 (and C5, C6) recover in two bounded phases: Compose restarts the
  container within `restartMs` (15 s) of its exit, and the restarted boot
  must be healthy within `healthyMs` (120 s) of its own start, the same bound
  as a first start. Before, one 120 s bound ran from the exit and included
  the restart. The total can now reach 135 s; each phase keeps its own bound.

## Gates and measurements

Container gates (each in its own disposable `supplier-disruption-ct-<run>-<gate>`
project, removed by the run's teardown):

| Gate                      | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1 (`restore.test.mjs`)   | C-01 with ACT-1's amendment committed and its journal pending, app killed, the now idle database backed up by the script; restored into a second project's fresh volume; manifest check, then independent equality of message bytes rehashed by PostgreSQL, references, actions and effects; refusal to restore into the now populated target; init, start, reconciliation of ACT-1 by operation ID and `plan_verified` with one amendment, one reservation and one transfer request |
| B2 (`restore.test.mjs`)   | A forced recreation of the restored app container (new container and boot ID) keeps case, actions, effects, evidence and references, and the recreated app serves the case's original bytes                                                                                                                                                                                                                                                                                          |
| L1 (`lifecycle.test.mjs`) | SIGSTOP to the watchdog exits 70 with `hang:watchdog` from the healthcheck and recovers; a watchdog brought down and up again on purpose is never treated as hung                                                                                                                                                                                                                                                                                                                    |
| L2 (`lifecycle.test.mjs`) | A worker that cannot handle SIGTERM is killed by s6 at its 12 s timeout-kill during a normal stop, which still exits 0 inside the 30 s budget with no failure record                                                                                                                                                                                                                                                                                                                 |

Measured on 2026-10-22 from the working tree before the final commit
(`SD_CT_SOURCE=worktree`). The final-revision results are in the
[verification record](../verification.md). Host: Apple M4 Max, 14 cores, 36 GiB, macOS 27.0.1;
Docker Desktop engine 29.9.2 (linuxkit 7.0.14, aarch64) with 14 CPUs and
11.67 GiB for its VM; Compose 5.6.1; about 19 unrelated containers of other
projects running; one-minute load average 2.3 to 6.7 during the runs.

| Observation                                                | Value                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| B1 backup of the populated source                          | 73 tables, 1 message, 56 foreign keys; dump 210,026 bytes                         |
| B1 restore and manifest comparison                         | All row counts, digests, the message hash and foreign keys equal                  |
| B1 restored app start to `plan_verified`, ACT-1 reconciled | 9.3 s after `up`                                                                  |
| B2 restored app after recreation                           | app 538.8 MiB, 50 processes; db 66.2 MiB, 23 processes; database 12,375,743 bytes |
| L1 SIGSTOP watchdog to container exit 70                   | 25.9 s in both runs (beat age 21.0 s; bound 45 s); healthy 2.5 s after restart    |
| L2 worker SIGTERM to SIGKILL                               | 12.03 s (timeout-kill 12 s); whole stop 17.3 s (budget 30 s), exit 0              |
| Application image                                          | linux/arm64, 1,168,890,171 bytes; build 38 s with a warm cache                    |

The app and database containers have no CPU, memory or process limits. The
only configured bounds are the tmpfs sizes, the s6 timeouts of ADR 0002, the
healthcheck and the 60 s stop grace period.

## Limits

- The backup is logical and local. There is no point-in-time recovery, WAL
  archiving, off-host copy, retention or scheduled backup. Restore time grows
  with the database; only this small synthetic database was measured.
- A restore needs the same PostgreSQL major version and login role names.
  Session cookies survive only with the same Better Auth secret.
- Restoring an older backup rolls the spend ledger back to that backup. It
  must be reconciled before paid work (the runbook's spend section).
- Hung-watchdog detection depends on Docker running the healthcheck. A Docker
  daemon that stops running healthchecks, or a host suspend longer than the
  bound, halts or misses accordingly; a suspend is followed by a restart.
  Docker runs no healthcheck while a container is paused, so after a
  `docker pause` longer than the bound the first healthcheck after
  `docker unpause` can record `hang:watchdog` and restart the container
  before the watchdog's next beat.
- B1 backs up an idle database (the source app is killed first). Consistency
  of a backup taken while the application commits writes rests on the
  snapshot design above, not on a test.
- L2 relies on Node's SIGUSR1 inspector, which any process with the
  container's UID can open; ADR 0002 already notes that UID 10001 can read
  every secret in the container.
- No resource limits are set for the app or database containers beyond the
  tmpfs sizes (`/run` 16 MB, `/tmp` 64 MB) and the 60 s stop grace period.
- BA-14, the simultaneous operation of all five independent Compose projects
  on one documented host, remains unproven: this task ran only this
  repository's disposable projects.
