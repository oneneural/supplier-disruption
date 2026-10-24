# Configuration and credentials contract

Blueprint 1.0, 2026-10-18. These are required configuration interfaces for implementation, not working commands or files already delivered. Each repository must turn this contract into a checked `.env.example`, typed configuration validation and exact setup instructions when its implementation starts.

## Local startup experience

The target is: copy the example configuration, initialize local secrets using the documented helper, then run `docker compose up --build`. Docker and Compose are the only host prerequisites for this path. A fresh fixture deployment seeds its own synthetic data and opens a useful work queue without any external account. Initializing a new database is explicit and repeatable; an existing volume is never silently reset.

Compose runs `app` and `db`. UI, API and worker come from the same app image. Initialization/migration uses that same image as a bounded one-off step, not an additional permanent service. Evidence and database volumes persist across container replacement. Document start, stop, logs, health, backup, restore and intentionally destructive reset separately. Reset must name the exact project and volumes it deletes.

Use unique Compose project names and host ports so all five projects can run together: vulnerability 3101, supplier 3102, invoice 3103, field service 3104, prior authorization 3105. Each has independent database and evidence volumes, secrets and budgets. Publish to `127.0.0.1` locally; the database has no host port by default. Internal app ports can remain identical across containers.

## Core configuration

| Variable | Required/default | Consumer and meaning |
| --- | --- | --- |
| `APP_ID` | Repo slug, required | All services and trace attribution |
| `APP_ORIGIN` | Local loopback URL, required | Web/API public origin, auth callbacks, trusted-origin checks |
| `APP_HOST_PORT` | Per-project port above | Compose host binding only |
| `NODE_ENV` | `production` in image | Framework runtime mode |
| `DATA_MODE` | `fixture` | `fixture`, `sandbox`, or `live`; modes beyond spec scope fail startup |
| `AGENT_MODE` | `rules` | `rules` or `claude`; never silent fallback |
| `AUTH_MODE` | `fixture` locally | `fixture` or `session`; fixture auth rejected for public/live deployments |
| `DATABASE_URL_API` | Required secret | API role with business/auth and queue-producer access |
| `DATABASE_URL_WORKER` | Required secret | Restricted queue/checkpoint/heartbeat role |
| `DATABASE_URL_MIGRATOR` | Initialization only, secret | Schema owner; not inherited by running app services |
| `BETTER_AUTH_SECRET` | Required generated secret | API auth signing/encryption, unique per repository |
| `WORKER_SERVICE_TOKEN` | Required generated secret | Scoped worker-to-API service authentication, unavailable to model tools |
| `EVIDENCE_ROOT` | `/var/lib/app/evidence` | API-owned persistent blob volume |
| `WORKER_CONCURRENCY` | `2`, lab starting value | Bound CPU, memory and model concurrency; measure before raising |
| `LOG_LEVEL` | `info` | Structured, redacted logging |
| `OTEL_SERVICE_NAME` | Derived app/service name | Trace identity |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Unset | Optional export only after deliberate configuration |

Keep the internal API loopback address fixed in the built proxy configuration initially. If runtime-configurable routing is later needed, test the packaged Next behavior explicitly rather than assuming build-time config changes at startup. `APP_ORIGIN` remains an explicit runtime auth setting. Store revision/build metadata in image labels and runtime status.

Support each secret's `_FILE` alternative, for example `ANTHROPIC_API_KEY_FILE`, using application configuration code. Reject conflicting inline/file values and report the variable name, never its secret content. Compose mounts the files; it does not automatically implement these application variables. Local `.env` files are ignored; `.env.example` contains descriptions and placeholders only.

## Claude configuration

| Variable | Default/requirement | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Required only for `AGENT_MODE=claude` | Direct Claude Console organization/workspace key |
| `CLAUDE_MODEL_PRIMARY` | `claude-sonnet-5-5` | Investigation and structured proposals |
| `CLAUDE_MODEL_FAST` | `claude-haiku-5-5` | Candidate bounded extraction, enabled only after evaluation |
| `CLAUDE_MODEL_ESCALATION` | `claude-opus-5-5` | Explicit expensive-model path, disabled initially |
| `MODEL_ESCALATION_ENABLED` | `false` | Prevent automatic cost escalation |
| `AGENT_MAX_TOOL_CALLS` | `10`, or stricter SPEC value | Total per investigation, including retries |
| `AGENT_MAX_MODEL_CALLS` | `6`, lab setting | Bound repeated reasoning/model attempts |
| `AGENT_MAX_OUTPUT_TOKENS` | `4096`, lab setting | Request-level cap, checked against model capabilities |
| `AGENT_MAX_RUN_SECONDS` | `180`, lab setting | Model investigation time, excluding human wait |
| `AGENT_RUN_BUDGET_USD` | `0` | Live calls disabled until owner configures an explicit cap |
| `AGENT_DAILY_BUDGET_USD` | `0` | Per-app aggregate admission cap, separate from shared Console limits |

The repository must explain how to obtain a Console API key, which organization/workspace it belongs to, how to store it locally, how to set account/project spend limits, and how to revoke/rotate it. Never ask for a key in chat or commit it. Reuse of an organization balance does not imply shared per-project configuration. Direct Anthropic billing uses the owner's Console credits; partner-hosted APIs may bill separately.

A later credential preflight checks configured model IDs using the authenticated Models API without exposing the key. A separately budgeted tiny model request proves actual structured output/tool compatibility; it is not run automatically on every startup. Model capability, budget and account failures appear in the UI. Usage/cost reports distinguish estimates, reservations and provider-reported token usage. Refresh the price snapshot before a live evaluation.

## Connector configuration

Only the chosen connector's keys belong in that repo's `.env.example`. Every connector entry must document provider, owning account, purpose, exact API/version, minimum scopes, read/write capability, how to obtain credentials, secret storage, callback/webhook setup if used, test procedure, rotation and mode availability. Unconfigured connectors have a visible unavailable state.

| Project | First candidate configuration | Initial authority |
| --- | --- | --- |
| Vulnerability | `GITHUB_APP_ID`, private-key file, installation ID; public OSV/KEV base URLs allowlisted | Public advisory reads and explicitly scoped repository metadata; no merge/deploy |
| Supplier | `ERPNEXT_BASE_URL`, API key/secret; optional Microsoft tenant/client credentials only when mailbox integration is selected | Sandbox read/verified test actions; external mail remains unsent without authority |
| Invoice | ERPNext base URL and API key/secret for the selected version | Sandbox invoice/evidence reads; real credit posting excluded |
| Field service | Dataverse environment URL, Microsoft tenant/client credential with chosen Dataverse role | Verified sandbox reads; actual dispatch and inventory mutation excluded |
| Prior authorization | Versioned policy manifest and approved synthetic fixture set | No payer secret or real-patient upload endpoint in the initial scope |

These are candidate interfaces from domain research, not proof of access or a mandatory integration with every provider. If a project chooses a different provider, record the evidence and replace the corresponding setup section. Do not collect unused secrets. Provider versions and permission names are verified when the actual connector is selected.

## Required documentation at implementation handoff

The implementation README must include exact tested commands, URLs, prerequisites, expected first screen, mode labels, seeded account procedure, configuration matrix, missing-key behavior, migrations, backup/restore, reset warnings, troubleshooting and the tested revision. Add `docs/connectors/<provider>.md` only for a real selected connector. Document which services are local, optional or paid and what data leaves the machine. No cloud account should be needed for fixture startup.
