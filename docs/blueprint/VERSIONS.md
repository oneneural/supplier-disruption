# Technology choices and primary sources

Checked **2026-10-18**. These are researched starting candidates, not an installed lockfile. Use the newest stable compatible patch at the authorized bootstrap, record actual pins and re-run relevant checks. Preview features require a concrete benefit and a documented fallback. A project may extend this base without an additional approval ceremony for routine engineering decisions.

## Runtime and interface

| Component | Starting choice | Evidence and decision |
| --- | --- | --- |
| Node | 24.22.0 LTS | [Official release](https://nodejs.org/en/blog/release/v24.22.0); prefer supported LTS to Current 26 |
| Node image | `24.22.0-bookworm-slim` | [Official image manifest](https://raw.githubusercontent.com/docker-library/official-images/master/library/node); resolve and pin digest at build |
| pnpm | 12.14.0 | [Release](https://github.com/pnpm/pnpm/releases/tag/v12.14.0), [workspaces](https://pnpm.io/workspaces) |
| Next / matching tooling | 16.4.2 | [Release](https://github.com/vercel/next.js/releases/tag/v16.4.2) |
| React / React DOM | 19.3.1 | [Release](https://github.com/react/react/releases/tag/v19.3.1), match both packages |
| TypeScript | 6.0.3 temporary compatibility baseline | [Release](https://github.com/microsoft/TypeScript/releases/tag/v6.0.3); latest stable is 7.0.2, exception below |
| ESLint / typescript-eslint | 10.13.0 / 8.71.2 | [ESLint release](https://github.com/eslint/eslint/releases/tag/v10.13.0), [support matrix](https://typescript-eslint.io/users/dependency-versions/) |
| Tailwind | 4.3.3 | [Release](https://github.com/tailwindlabs/tailwindcss/releases/tag/v4.3.3) |
| shadcn CLI / Base UI | 4.22.0 / 1.9.0 | [CLI release](https://github.com/shadcn-ui/ui/releases/tag/shadcn@4.22.0), [Base UI releases](https://base-ui.com/react/overview/releases); owned `base-nova` components |
| Fastify | 5.12.7 | [Published metadata](https://registry.npmjs.org/fastify/latest), [LTS policy](https://fastify.dev/docs/latest/Reference/LTS/) |
| Better Auth | 1.7.10 | [Published metadata](https://registry.npmjs.org/better-auth/latest), [Fastify integration](https://better-auth.com/docs/integrations/fastify) |

TypeScript 7 is stable, but typed ESLint currently requires the older compiler API and declares TypeScript below 6.1. The initial choice is one TypeScript 6 compiler, not five dual-compiler setups. Microsoft's [TS7 compatibility guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) supports a dual arrangement when needed. Revisit when the lint/compiler API combination supports TS7 or a measured build benefit justifies managing both.

Next 16.4 supports ESLint 10, while some bundled plugin peer metadata can still reject a strict pnpm install. Verify the exact combination. Prefer the standard Next configuration; if blocked, use the supported direct Next plugin with compatible typed/React rules, or a narrowly justified metadata exception. Do not disable all peer checks. The ordinary Next TypeScript lint preset is not type-aware linting; explicitly configure `recommendedTypeChecked` with `projectService` and the appropriate package TSConfigs when using typed rules. [Typed linting](https://typescript-eslint.io/getting-started/typed-linting/). [Next ESLint guidance](https://nextjs.org/docs/app/api-reference/config/eslint). Next's CLI type-checker setting remains documented as not yet stable despite its tagged default; verify actual compiler resolution rather than blindly enabling settings that are not yet stable. [Configuration](https://nextjs.org/docs/app/api-reference/config/next-config-js/useTypeScriptCli).

## Data, agents and verification

| Component | Starting choice | Source |
| --- | --- | --- |
| PostgreSQL | 18.6 stable; 19 RC excluded | [Version policy](https://www.postgresql.org/support/versioning/) |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 stable | [ORM metadata](https://registry.npmjs.org/drizzle-orm/latest), [Kit metadata](https://registry.npmjs.org/drizzle-kit/latest); do not substitute 1.0 beta |
| pg-boss | 12.38.0 | [Metadata](https://registry.npmjs.org/pg-boss/latest), [documentation](https://pgboss.io/) |
| Zod | 4.6.7 | [Metadata](https://registry.npmjs.org/zod/latest) |
| LangGraph JS / core | 1.5.1 / 1.2.18 | [Graph releases](https://github.com/langchain-ai/langgraphjs/releases), [core metadata](https://registry.npmjs.org/@langchain%2Fcore/latest) |
| Anthropic LangChain adapter | 1.5.12 | [Release](https://github.com/langchain-ai/langchainjs/releases/tag/@langchain%2Fanthropic@1.5.12) |
| Checkpoint / Postgres saver | 1.2.0 / 1.1.0 | [Graph releases](https://github.com/langchain-ai/langgraphjs/releases), [Postgres release](https://github.com/langchain-ai/langgraphjs/releases/tag/@langchain%2Flanggraph-checkpoint-postgres@1.1.0) |
| LangChain high-level package | 1.5.18, optional | [Releases](https://github.com/langchain-ai/langchainjs/releases); graph/core/provider suffice unless its abstractions help |
| Vitest / Playwright | 5.0.5 / 1.64.1 | [Vitest metadata](https://registry.npmjs.org/vitest/latest), [Playwright metadata](https://registry.npmjs.org/@playwright%2Ftest/latest) |
| OpenTelemetry Node SDK | 0.223.0 | [Metadata](https://registry.npmjs.org/@opentelemetry%2Fsdk-node/latest), align API/exporter peers at bootstrap |
| s6-overlay | 3.2.3.2 | [Release](https://github.com/just-containers/s6-overlay/releases/tag/v3.2.3.2) |

Registry checks confirm the LangGraph/core/provider/checkpoint peer ranges overlap and Node 24 clears their engine floors. They do not prove runtime interoperability. The published provider depends on Anthropic SDK `^0.122.0`; the newest SDK is 0.135.0. Do not force an incompatible SDK override into the provider. If direct API use is needed, pin and test it as an explicit separate dependency. No SQLite, Redis, vector database, Temporal, hosted graph service or telemetry collector is required by this baseline. Add infrastructure only when a project has a demonstrated need.

## Models and billing

| Model ID | Initial use | Primary source |
| --- | --- | --- |
| `claude-sonnet-5-5` | Default bounded investigation | [Sonnet overview](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) |
| `claude-haiku-5-5` | Evaluated extraction/classification candidate | [Haiku overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview) |
| `claude-opus-5-5` | Explicit evaluated escalation | [Opus overview](https://platform.claude.com/docs/en/models/opus-5-5/overview) |

Current public list prices per million input/output tokens are Sonnet $2/$10, Opus $4/$20, and Haiku $0.10/$0.50 through 100,000 prompt tokens, then $0.50/$2.50 above that threshold. This is a dated budgeting reference; refresh [pricing](https://platform.claude.com/docs/en/about-claude/pricing) before spending and include applicable cache/tool charges. No user account access or balance was checked. [SDK retry behavior](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript#retries) requires disabling hidden retries or accounting for every attempt, including unknown billed outcomes.

Use the [Models API](https://platform.claude.com/docs/en/api/models/list) for account preflight and [versioning rules](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) for model lifecycle. The current dateless IDs identify pinned releases rather than automatically tracking a future model. [Console API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) also cover eligible direct Agent SDK usage; the SDK is not required to use API credits.

Sonnet/Opus 5.5 reject forced tool selection. Native JSON output uses `output_config.format`; strict tool schemas can coexist, while native citation blocks cannot. Validate refusal and truncation outcomes. [Sonnet changes](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5), [structured output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [LangChain structured output](https://docs.langchain.com/oss/javascript/langchain/structured-output). Agent SDK 0.3.302 is a researched optional extension, not a baseline dependency. [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [releases](https://github.com/anthropics/claude-agent-sdk-typescript/releases).

## Engineering evidence behind the blueprint

| Area | Primary sources | Implication |
| --- | --- | --- |
| UI boundaries and cache | [Server/client components](https://nextjs.org/docs/app/getting-started/server-and-client-components), [data security](https://nextjs.org/docs/app/guides/data-security), [Next 16.4](https://nextjs.org/blog/next-16-4), [revalidation](https://nextjs.org/docs/app/getting-started/revalidating) | Small client boundaries, server authorization and explicit freshness |
| Design | [shadcn Base UI default](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default), [monorepos](https://ui.shadcn.com/docs/monorepo), [Tailwind scanning](https://tailwindcss.com/docs/detecting-classes-in-source-files), [WCAG 2.2](https://www.w3.org/WAI/WCAG22/quickref/) | Consistent primitives, workspace styling and verified accessibility |
| Auth | [Better Auth options](https://better-auth.com/docs/reference/options), [sessions](https://better-auth.com/docs/concepts/session-management) | Explicit public URL/origins and fresh sensitive-operation checks |
| Durable agents | [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming) | Replayed nodes, persisted state and application-owned progress transport |
| Jobs | [pg-boss options](https://pgboss.io/api/constructor), [operations](https://github.com/timgit/pg-boss/blob/master/docs/api/ops.md) | Explicit migrations, transactions and bounded drain |
| Build | [Next standalone](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [pnpm Docker](https://pnpm.io/docker), [pnpm deploy](https://pnpm.io/cli/deploy), [build allowlists](https://pnpm.io/settings/build), [lockfile/scanner security](https://pnpm.io/supply-chain-security) | Complete reproducible artifacts and version-specific packaging |
| Process supervision | [Docker multi-process guidance](https://docs.docker.com/engine/containers/multi-service_container/), [s6-overlay](https://github.com/just-containers/s6-overlay), [Node signals](https://nodejs.org/api/process.html#signal-events) | Explicit child lifecycle, shutdown and failure propagation |
| Health and Compose | [Startup ordering](https://docs.docker.com/compose/how-tos/startup-order/), [restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/), [Compose services](https://docs.docker.com/reference/compose-file/services/) | Unhealthy is not restart, readiness spans the whole app |
| Secrets and storage | [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [build secrets](https://docs.docker.com/build/building/secrets/), [volumes](https://docs.docker.com/engine/storage/volumes/), [Postgres backup](https://www.postgresql.org/docs/current/backup.html) | Runtime secrets and independent recoverable data |
| Tests and telemetry | [Next Vitest](https://nextjs.org/docs/app/guides/testing/vitest), [Next Playwright](https://nextjs.org/docs/app/guides/testing/playwright), [accessibility checks](https://playwright.dev/docs/accessibility-testing), [OpenTelemetry Node](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/) | Test actual boundaries, accessible workflows and traceable failures |

## Remaining verification

At implementation: lockfile resolution and peer checks; Next proxy/auth/SSE behavior; pg-boss/Drizzle atomic enqueue; restricted-role migrations; s6 nonroot lifecycle; packaged workspace imports; model-native output compatibility; account model access; performance budgets. These are named engineering checks, not reasons to reopen settled base choices or delay documentation handoffs.
