# Contributing

Contributions should improve the supplier-disruption workflow without weakening
procurement boundaries or overstating evidence. Read [AGENTS.md](AGENTS.md),
[SPEC.md](SPEC.md), [ARCHITECTURE.md](ARCHITECTURE.md) and
[verification results](docs/verification.md) before changing the project.

## Scope and setup

Agree the change scope, paths and verification requirements. Inspect Git status
and preserve unrelated files. Material domain or authority changes need
specification and architecture review. Preserve the historical blueprint and
the frozen [first-slice oracle](docs/oracles/first-slice-oracles.md).

Use Node 24.22.0, Corepack, pnpm 12.14.0 and Docker with Compose v2. Run
commands from the repository root through `corepack pnpm`, without a global
pnpm installation or `corepack enable`. For a fresh checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm secrets:init
cp .env.example .env
corepack pnpm build:packages
corepack pnpm db:up
corepack pnpm db:migrate
corepack pnpm db:seed
```

Preserve an existing `.env`. Secret initialization does not overwrite files or
print values. Investigate seed conflicts before a deliberate reset. See
[development and operations](docs/development.md) for host processes, image
startup and scoped cleanup, and the [quick start](README.md#quick-start) for
the no-key demo.

## Checks and evidence

Run required checks on the final implementation revision:

```sh
corepack pnpm lint
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
```

Unit tests need no database. Integration tests need the initialized database
and Docker. Packaged browser checks also need registry access and
`corepack pnpm exec playwright install chromium-headless-shell`; run them with
`corepack pnpm test:container`. Follow the runbook before container cleanup.
Keep meaningful domain tests, one end-to-end happy path per feature and focused
risky-path tests. Never weaken a gate or change independent expectations to fit code.

Report actual commands, outcomes and exact tested SHA. Separate targeted, full,
browser, container, sandbox and live-provider evidence. Explain unrun required
checks. Documentation checks cover links, formatting, Mermaid and preserved
content; they do not establish runtime correctness.

## Code, documentation and screenshots

Use Server Components by default, adding `"use client"` only for interactivity.
Keep API authority and pure domain rules separate. Browser code must not import
database/provider modules or secrets. Follow existing imports and reuse `cn`
in `apps/web/lib/utils.ts`. Consult installed-version Next.js documentation
before framework changes and retain reviewed dependency pins.

Use the configured formatter and GitHub-flavored Markdown. Write plainly with
sentence-case headings, descriptive links and no em dashes. Label synthetic
data, model output and measured results. Document extensions in a focused ADR.

Capture the actual packaged UI with synthetic records. Retain raw captures,
framed exports, an editable recipe and a manifest with implementation SHA,
route/scenario, mode, viewport/DPR, date, raw/export hashes and crops/redactions.
Use meaningful alt text and captions and inspect GitHub desktop and narrow-width
rendering. Historical screenshots do not prove current behavior.

## Git and pull requests

Use `type(scope): summary` for commits and PR titles: optional scope, lowercase
imperative summary and no trailing period. Types: `feat`, `fix`, `content`,
`docs`, `style`, `refactor`, `perf`, `test`, `chore`. Branches use
`type/short-kebab-summary` without tool or agent prefixes. Stage only the
requested paths. Omit AI attribution, co-author trailers and generated-by notices.

A PR should explain the problem, resulting behavior, scope, exact tested
revision, useful evidence and remaining limitations. Obtain independent review
and rerun affected checks after fixes. Verify the intended remote, authenticated
identity and visibility before an authorized push. Never force-push, rewrite
history or reset away work. A merge does not authorize a release.

## Security, paid work and license

Follow [SECURITY.md](SECURITY.md). Keep secrets, local environment files,
dependencies and generated output out of Git. Only the API may read the provider
key from its local secret file. Routine tests use recordings or local fakes.
Real supplier messages and production transactions require separate authority.

Application and evaluation model use share USD 20 cumulative with a mandatory
pause at USD 15. Reconcile database usage, the evaluation record and uncertain
reservations before separately authorized paid work. A reset never resets spend.
No other paid service is authorized. The project is [MIT licensed](LICENSE);
third-party materials retain their own terms.
