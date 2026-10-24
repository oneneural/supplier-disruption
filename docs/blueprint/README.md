# Common architecture for agentic use cases

Blueprint **1.0**, researched 18 October 2026. Independent pnpm monorepos, one application image per use case, and a separate PostgreSQL service. This is a documentation baseline, not an implemented or tested platform. Coding is paused by the owner.

Read the [architecture](ARCHITECTURE.md), [design language](DESIGN.md), [configuration contract](CONFIGURATION.md), [operations and verification](OPERATIONS.md), and [version/source register](VERSIONS.md) together. Each use case receives a self-contained snapshot plus its domain-specific `ARCHITECTURE.md` and repository instructions. No repository imports another use case or shared tracking records at runtime.

## Decisions

| Area | Decision | Purpose |
| --- | --- | --- |
| Workspace | One independent pnpm workspace and lockfile per use case | Separate releases, ownership and agent instances |
| Services | Next.js web, Fastify API, Node worker | Separate presentation, business authority and durable execution |
| UI | App Router, React, Tailwind v4, owned shadcn/Base UI components | A consistent, accessible operator workbench |
| Persistence | PostgreSQL, Drizzle, pg-boss, LangGraph Postgres checkpoints | Durable decisions, jobs and resumable investigations |
| Agents | LangGraph JS, LangChain adapters, direct Claude API billing | Bounded business tools and observable human review |
| Models | Sonnet 5.5 default; evaluate Haiku 5.5; explicit Opus 5.5 escalation | Choose by measured task quality, latency and cost |
| Packaging | Three supervised app processes in one image; separate database | The owner's requested Compose deployment |
| Engineering | Typed contracts, deterministic rules, permission checks, replay tests and held-out evaluation | Demonstrate dependable integration work |

## Why this blueprint suits these agentic use cases

The common foundation makes it possible to compare five distinct integrations without rebuilding delivery mechanics. Each application must still show a concrete operator workflow, source mapping, business constraints, useful model behavior, recovery after failure and measured limitations. A library list, generic chatbot, or synthetic success screen is insufficient.

The use cases deliberately differ in their authoritative records and outcomes: deployment verification, recovery-plan verification, invoice credit reconciliation, visit readiness and administrative evidence readiness. The domain specification owns those meanings. The blueprint owns implementation boundaries, not business policy.

## Current limits

Public releases and documentation have been checked. The combined dependency set, container lifecycle, browser behavior and model compatibility have not been exercised because implementation is paused. No customer workflow has been validated with a practitioner.

Future agents must start from their reviewed repository instructions after the owner resumes coding. They must preserve the recorded interrupted work and recheck dependency availability at bootstrap. Changes to this blueprint are versioned documentation changes, followed by explicit per-repository adoption.
