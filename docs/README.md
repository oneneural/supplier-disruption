# Documentation

Start with the [project README](../README.md) for purpose, status and the no-key
quick start. The specification states intended outcomes; architecture and
verification evidence describe implemented behavior and its limits.

## Run and contribute

| Guide                                              | What it covers                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Demonstration walkthrough](demo/README.md)        | Synthetic recovery plan, uncertain write, stale approval and historical captures |
| [Current screenshots](demo/screenshots/README.md)  | Framed captures, raw pixels, frame recipe, manifest and the capture command      |
| [Development and operations](development.md)       | Pinned tools, configuration, setup, checks, containers and deliberate resets     |
| [Backup and restore](operations/backup-restore.md) | Snapshot backups, storage handling, fresh-volume restore and exclusions          |
| [Configuration reference](../.env.example)         | Supported variables and local secret-file paths                                  |
| [Contributing](../CONTRIBUTING.md)                 | Scope, conventions, checks and independent review                                |
| [Agent guide](../AGENTS.md)                        | Setup, conventions, procurement boundaries, testing, safety and Git              |
| [Security](../SECURITY.md)                         | Private reporting, secrets and trust boundaries                                  |
| [MIT license](../LICENSE)                          | Copyright and project permissions                                                |
| [Third-party notices](../THIRD_PARTY_NOTICES.md)   | Declared dependency licenses and items that need attention before redistribution |

## Understand the system

| Reference                                                             | What it covers                                                                     |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Specification](../SPEC.md)                                           | Product outcomes, domain rules and acceptance requirements                         |
| [Architecture and 21 ADRs](../ARCHITECTURE.md#architecture-decisions) | Runtime, data ownership, workflow, agent authority and the complete decision index |
| [Canonical first-slice oracle](oracles/first-slice-oracles.md)        | Frozen independent domain expectations and canonical case                          |
| [Research record](research.md)                                        | Primary sources, procurement context and integration assumptions                   |
| [Historical blueprint](blueprint/README.md)                           | Preserved design baseline, not current runtime proof                               |

## Verification and evidence

| Record                                                           | What it covers                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Verification record](verification.md)                           | Exact tested revisions, command outcomes and known limits                      |
| [Evaluation guide](../evaluation/README.md)                      | Evaluation sets, runner arms, the independent holdout-3 run and report index   |
| [Original evaluation reports](../evaluation/reports/)            | Synthetic live/replay results, costs and failures                              |
| [Article evidence index](blog-evidence.md)                       | Claim-to-evidence map for possible future writing, with pending results marked |
| [ERPNext connector proof](adr/0018-erpnext-sandbox-connector.md) | Isolated sandbox HTTP proof, native limits and unsupported operations          |
| [ERPNext sandbox evidence](evidence/erpnext-sandbox/README.md)   | Redacted request, response and read-back exchanges from the live sandbox run   |

The application includes clarification and reply resume, verification rechecks
and later revisions, interruption recovery, spend reservations, checkpoint
recovery, session/stream checks and backup restore. This snapshot passed every application check,
the integration suite, the full container suite and the no-key demo;
earlier focused results belong to earlier development revisions. No production-readiness or
customer-outcome claim is made. SPEC and the oracle stay frozen; the blueprint
remains a historical snapshot.
