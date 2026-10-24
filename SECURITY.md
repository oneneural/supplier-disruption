# Security

This project is a prototype with synthetic actors and simulated source
adapters. It has not been established as production-ready. Do not use it for real
supplier messages, production purchasing transactions or sensitive customer data.

## Report a vulnerability privately

Contact the repository owner privately through an established direct channel.
If GitHub offers private vulnerability reporting on this repository, use that
instead of a public issue. This document does not establish that the feature is
enabled, and no dedicated security email address is published.

Include the affected commit, component, observed behavior and a minimal synthetic
reproduction. Explain the suspected impact without including credentials or real
business records. Do not post secrets, supplier messages, database dumps, session
cookies or unredacted logs in issues, PRs or shared transcripts. Coordinate any
disclosure with the owner. There is no promised response time or supported-release
policy.

If a credential is exposed, notify the owner privately so it can be revoked or
rotated. Redact the value from further evidence; do not paste it into a report or
rewrite Git history without explicit authority.

## Secrets and provider keys

Use [.env.example](.env.example) and
[development and operations](docs/development.md) for supported configuration.
`corepack pnpm secrets:init` creates missing local secret files without printing
or overwriting them. Keep `.secrets/`, `.env` and local spend ledgers out of Git. Never store
credentials in source.

Only the API may read the Anthropic provider key from the file configured by
`ANTHROPIC_API_KEY_FILE` (locally `.secrets/anthropic_api_key`). Do not pass it to
the browser, worker, logs or reports. Default Compose does not mount a provider
key, and host `.env` fields are not automatically injected into the app service.
Live configuration needs explicit authorization and environment/secret wiring.
Use recorded responses for routine tests.

Paid model verification requires recorded authority within the cumulative USD 20
project budget, with a mandatory pause at USD 15 across application calls and
evaluations. Reconcile database usage, the evaluation ledger and uncertain
reservations first. Never reset cumulative spend after database recreation or new work.
Recorded spend and verification limits are in [verification.md](docs/verification.md).

## Trust boundaries

The API owns sessions, authorization, business writes and provider credentials.
Browser code must not import database/provider modules or secrets. The worker
uses internal routes with a service token and matching active job; selecting a
simulated role does not authenticate an actual supplier or warehouse.

Supplier text, documents and connector responses are untrusted evidence. They
cannot grant permissions, change tool destinations or replace procurement policy.
An agent proposal must pass validation and deterministic rules before any approved
action. Preserve original evidence and reconcile uncertain writes before retrying.
Keep loopback bindings and dedicated Compose volumes/secrets. Read
[ARCHITECTURE.md](ARCHITECTURE.md) for implemented boundaries and known limits.
