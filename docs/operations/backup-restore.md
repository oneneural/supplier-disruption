# Backup and restore runbook

This runbook covers the logical backup and restore of one Compose project's
PostgreSQL database with [scripts/backup-restore.mjs](../../scripts/backup-restore.mjs).
The design, the container gates B1 and B2 and their measured results are in
[ADR 0021](../adr/0021-restore-and-lifecycle-bounds.md). Everything here applies
to synthetic local data; it is not a production backup service.

## What a backup contains

Every durable record of the application lives in one PostgreSQL database,
`supplier_disruption`: sessions and fixture accounts, cases, original message
bytes with their SHA-256, assessments, plans, decisions, the action journal,
case events, agent runs and checkpoints, the spend ledger, the simulated source
authorities, the pg-boss queue and the worker heartbeat. There is no evidence
filesystem or object store. A backup is a `pg_dump` custom-format archive of
that database plus a manifest.

| Backed up                                                             | Not backed up                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Every table in every application schema, with ownership and grants    | `.secrets/` (role passwords, Better Auth secret, worker token, fixture passwords, provider key file) |
| Pending work: unfinished actions, active and queued jobs, checkpoints | Login roles and database-level grants (created by the target's own initdb and init)                  |
| The spend ledger as of the snapshot                                   | `.env`, the application image and Compose files (rebuild them from Git)                              |
|                                                                       | The host-side `evaluation/.spend-ledger.json` and evaluation outputs outside Git                     |
|                                                                       | Container logs, open streams, in-memory sign-in limits and other projects' volumes                   |

## Consistency

The script opens one `REPEATABLE READ READ ONLY` transaction in the source
database, exports its snapshot, runs `pg_dump --snapshot` on it and computes the
manifest in the same transaction: a row count and an order-independent digest per
table, a recheck of every stored message's bytes against its SHA-256, and the
number of foreign keys. The dump and the manifest therefore describe the same
committed state. By design this also holds while the application keeps
writing, because every read happens in that one exported snapshot; the restore
gate B1 tests only an idle database ([ADR 0021](../adr/0021-restore-and-lifecycle-bounds.md)).
Because all state is
in that one database, a committed source write whose journal entry is still
pending is captured exactly as it is; after restore, the application's read-back
before resubmission settles it ([ADR 0016](../adr/0016-workflow-interruption-recovery.md)).

A running backup takes PostgreSQL's ordinary `ACCESS SHARE` locks only. It never
stops the application, and it never needs the database's host port.

## Storage and handling

A backup holds password hashes, session tokens, synthetic case data and message
bytes. Treat it like the secrets it protects:

- The script refuses an output path inside the checkout or an existing path. It
  creates the backup directory with mode 0700 and both files with mode 0600.
- Keep backups on an encrypted disk (for example FileVault) in a directory only
  you can read, outside any synchronized or shared folder.
- The script does not encrypt. Before a backup leaves the host, encrypt the
  directory with a tool you already trust, for example
  `tar -C <parent> -cf - <backup> | age -r <recipient> > backup.tar.age`, and keep
  the key apart from the archive. Decrypt it back to a 0700 directory before a
  restore.
- Delete backups you no longer need. A backup of a database with real provider
  usage records still contains no provider key, but it does contain usage costs.

## Back up

The source project's `db` container must be running. The default project is the
development stack, `supplier-disruption`:

```sh
corepack pnpm db:backup -- --output ~/backups/supplier-disruption-$(date +%Y%m%dT%H%M%S)
```

Pass `--project <name>` for another project, such as a demonstration or a test
project. The command prints the table count, the message count and the dump's
size and SHA-256, also recorded in `manifest.json`.

## Restore

A restore only goes into a fresh volume. The script refuses any target database
that already holds a table, so it can never overwrite the development database
or any other populated one. Restore into a new project name, so the volume is new:

```sh
# 1. Start only the database of a new project; its initdb creates the login roles
#    from this checkout's .secrets/.
docker compose -p supplier-disruption-restore up --detach --wait db

# 2. Load the backup. It verifies the dump's SHA-256 first, loads it in one
#    transaction and compares row counts, digests, message hashes and foreign keys
#    with the manifest. Any difference exits 1.
corepack pnpm db:restore -- --input ~/backups/<backup> --project supplier-disruption-restore

# 3. Re-run init (migrations, grants, schema tag and seed change nothing that is
#    already current), then start the application.
docker compose -p supplier-disruption-restore run --rm init
SD_APP_HOST_PORT=<free loopback port> docker compose -p supplier-disruption-restore up --detach --wait app
```

The restored project needs the same login role names (`sd_migrator`, `sd_api`,
`sd_worker`), which every checkout creates; their passwords come from the
target's own `.secrets/`. Existing session cookies keep working only with the same
Better Auth secret; otherwise users sign in again. The PostgreSQL major version
must match the backup's.

After the application starts, unfinished actions are reconciled by operation ID
before any retry, and an active case job from the backed-up run is retried once
its pg-boss expiry or the API's restart sweep releases it. Check the workbench or
`app.case_action` until no action is `pending` or `unknown`.

Prefer restoring into a new project and checking it there. Replacing the
development database is an **owner-only step: agents and automated sessions must
never run it**, because it deletes the `supplier-disruption_db-data` volume. To
put a backup back into the development project itself, the owner first takes
and checks a fresh backup of the current database and records the spend
ledger's `status` (see
[development and operations](../development.md)). `scripts/db-reset.sh` is not
the route: it seeds the new volume, and the restore then refuses it. Instead
remove the containers and only that volume, start an empty database and restore:

```sh
docker compose -p supplier-disruption -f compose.yaml -f compose.dev.yaml down --remove-orphans
docker volume rm supplier-disruption_db-data     # owner only: deletes the development data
corepack pnpm db:up
corepack pnpm db:restore -- --input ~/backups/<backup> --project supplier-disruption
corepack pnpm db:migrate && corepack pnpm db:seed
```

Never delete a volume you have not backed up and checked.

## Spend ledger after a restore

The spend ledger is restored as of the backup. Restoring an older backup can
therefore show less spend than was actually used. Before any paid work, reconcile
the restored ledger against provider usage and the host-side
`evaluation/.spend-ledger.json`; the evaluation runner already refuses to start
when the database ledger is below that host record. Spend is never reset by a
restore.

## Remove a restored project

Remove only the project you created, with its volume:

```sh
docker compose -p supplier-disruption-restore --profile init down --volumes --remove-orphans
```
