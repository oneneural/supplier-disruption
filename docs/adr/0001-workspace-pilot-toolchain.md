# ADR 0001: Workspace pilot toolchain observations

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-18

## Context

The workspace pilot fixes the toolchain pins and the pilot's shape. While implementing it,
a few pinned choices did not work exactly as written, or needed a decision the
task left open. This record lists what was observed and the narrowest compliant
choice made for each. None of them weakens an acceptance gate.

## Decisions

### Next.js lint rules without eslint-config-next

The task pins ESLint 10.13.0. `eslint-config-next` 16.4.2 depends on
`eslint-plugin-react` 7.37.5, `eslint-plugin-import` 2.32.0 and
`eslint-plugin-jsx-a11y` 6.10.2, whose ESLint peer ranges stop at `^9`
(checked against the npm registry on 2026-10-18).

The web app instead uses the two plugins that carry the Next-specific rules
directly: `@next/eslint-plugin-next` 16.4.2 (its `recommended` and
`core-web-vitals` rule sets) and `eslint-plugin-react-hooks` 7.1.1. The React,
import and accessibility rule sets from `eslint-config-next` are not applied.
Import boundaries use ESLint's built-in `no-restricted-imports`, which needs no
plugin. Revisit when those plugins support ESLint 10.

### Better Auth checks are explicit

Better Auth 1.7.10 skips its origin and CSRF checks by default whenever
`NODE_ENV=test` or `TEST` is set. The API sets `advanced.disableOriginCheck` and
`advanced.disableCSRFCheck` to false explicitly, so tests exercise the same checks
as a deployment, and a test running under `NODE_ENV=test` asserts that sign-in and
sign-out from an untrusted origin get 403. `packages/config` still accepts
`NODE_ENV=test` for every service because the integration tests run the built
services with it; it enables only the worker's test hooks.

Other auth settings: `useSecureCookies` follows the `APP_ORIGIN` protocol, the
cookie cache stays off, and `autoSignIn` is off so provisioning leaves no
sessions. The cookie cache is checked by inspecting the auth options and by
asserting that sign-in sets no `session_data` cookie. The session-revocation step
in the same test is not counted as a cookie cache check.

### Formatter

Prettier 3.9.10 is the one formatter, with `printWidth: 100`. `.prettierignore`
excludes generated output, the lockfile, Drizzle migration metadata, the
preserved local reference files.

### Secret file modes

Compose file secrets are bind mounts that keep the host file's owner and mode.
PostgreSQL's init script runs as the container's `postgres` user, not the host
user. Docker Desktop on macOS read 0600 files anyway (observed), but a Linux
engine would not, because the container user is not the file's owner (expected
from bind-mount semantics, not tested on Linux here).

`scripts/init-secrets.sh` therefore writes each file as 0644 inside an
owner-only `.secrets/` directory (0700, including `.secrets/host/`). Other host
users cannot traverse the directory, and the container can read the files. The
script never overwrites an existing file and prints only file names.

### pg-boss grants are observed, not verified least privilege

`packages/db/sql/grants.sql` was derived from pg-boss 12.38.0's SQL plans and
the statements the pilot exercises. Grants found necessary in practice:

- The worker needs `INSERT` on `pgboss.job`: failing a job, whether through a
  handler error or expiry, deletes it and re-inserts it in the `retry` or
  `failed` state. Without it, a failed job stayed `active` indefinitely (observed
  during G8).
- The worker needs `UPDATE` on `pgboss.instance` although `registerInstance` is
  false. Supervision still prunes the registry, and its `FOR UPDATE SKIP LOCKED`
  requires `UPDATE` privilege.
- The worker needs `SELECT, DELETE` on `pgboss.job_dependency` for maintenance
  cleanup, and `SELECT` on `pgboss.bam`.
- Both roles need `EXECUTE` on `pgboss.job_now()`. Every other pg-boss function,
  including queue creation and deletion, is revoked from them.

The migration command also reapplies the declared queue options when they have
drifted. pg-boss cannot change a queue's policy in place, so a policy mismatch
still stops the command.

The grants script first revokes everything from `PUBLIC` and both runtime roles,
so a rerun of the migration command also removes drift. The G3 role tests cover
the boundaries the task names: the worker cannot read or write auth and business
tables, and neither runtime role can create objects, schemas, temporary tables
or roles. They do not prove that every remaining grant is necessary.

### Job expiry interval

pg-boss runs job expiry inside its monitor pass, which defaults to every 60
seconds regardless of `superviseIntervalSeconds`. The worker sets
`monitorIntervalSeconds: 5` alongside `superviseIntervalSeconds: 5`, so a job
whose worker died is redelivered within about 30 to 40 seconds of its claim
instead of up to 90. The extra cost is a small queue statistics query every 5
seconds; `persistQueueStats` stays off.

### A null send result

With the `exclusive` policy, `boss.send` returns null when a job with the same
singleton key already exists. The API never ignores it: the transaction rolls
back, and the request is resolved against whatever operation exists. If none
exists, for example because an unrelated job holds the key, the caller gets
503 `enqueue_failed` and nothing is committed. An integration test covers this.

### Other workspace choices

- `allowBuilds` permits only `esbuild`, whose install script verifies and links
  its platform binary. pnpm 12 refused to install without an explicit decision.
- The Next.js config is `next.config.mjs`. Next 16.4.2 loads `next.config.ts`
  with CommonJS resolution, which does not suit this ESM workspace.
- Drizzle Kit generates migrations from the compiled schema in `dist/`, so the
  NodeNext `.js` import specifiers resolve. Run `corepack pnpm build:packages`
  before `corepack pnpm --filter @supplier-disruption/db generate`.
- A root Vitest config is outside the allowed paths, so each tested package has
  its own `vitest.config.ts`, and workspace-level tests (lint rules, the secrets
  script) use `scripts/vitest.config.mjs`. Integration packages disable file
  parallelism because they share one database.
- `compose.dev.yaml` reads an optional `SD_DB_HOST_PORT` (default 55102) only so
  the fresh-volume test can run its disposable project beside the development one.
- `scripts/db-reset.sh` removes only the named database volume, not every volume
  of the Compose project.

## Consequences

The pinned versions install and pass lint, typecheck, unit tests, integration
tests and `next build` with these choices. The React, import and accessibility
lint rules from `eslint-config-next` are absent until the plugins support
ESLint 10. The pg-boss grants must be rechecked whenever pg-boss is upgraded.
