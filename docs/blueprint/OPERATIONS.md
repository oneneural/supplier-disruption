# Operations and verification

Blueprint 1.0, 2026-10-18. Proposed acceptance gates. None has been executed in the architecture phase.

## One application image

Use a multi-stage build based on the verified Node LTS Debian slim image. Pin image digests when implementing and record platform manifests. Install from the frozen pnpm lockfile with explicit dependency build-script allowlists. Build Next standalone, API and worker; package only needed runtime files. Include Next public/static assets, migrations and required fixture manifests. Test the image without source bind mounts, host Node or runtime package installation.

Use s6-overlay as PID 1 to supervise all three essential services. Do not stack a second init system or use a shell command that hides child failure. Startup dependencies are database readiness and successful schema initialization, then API/worker/web readiness. Configuration or migration failure exits clearly. An essential process exiting unexpectedly terminates the application container so its restart policy can recover the coherent unit. A bounded hang watchdog is needed as well; Docker's unhealthy status alone does not restart it.

Run application services as an unprivileged user, drop capabilities, prohibit privilege escalation, and use a read-only root filesystem where compatible. s6 runtime directories and evidence/temp paths need explicit writable ownership. Verify the exact nonroot initialization arrangement rather than assuming `USER` alone makes s6 work. Never mount the host Docker socket. Package browser test tools in test stages, not the runtime image. Shared-container processes are not security sandboxes from one another.

## Lifecycle and persistence

On shutdown, stop accepting new commands and job claims, mark readiness false, drain bounded in-flight work, persist/checkpoint and flush telemetry, then close database connections and exit. Proposed limits are a 30-second application drain inside a 60-second Compose grace period; reserve the remainder for queue cleanup and supervisor termination. Verify pg-boss stop behavior with the pinned version. A timeout after a remote action is recorded as uncertain for later reconciliation.

Container readiness requires API and web responsiveness, database connectivity with compatible schema, and a recent worker heartbeat from this boot/build. A stale heartbeat from a prior process is insufficient. Liveness is separate from readiness and provider capability. Model quota or a missing optional connector does not make an otherwise useful fixture application unhealthy. Startup health checks use bounded retries and a startup allowance.

Use named volumes for PostgreSQL and evidence. Verify the mounted data directory for the selected official PostgreSQL image, especially across major versions. Backups include database records and the exact content-addressed blobs they reference. Demonstrate restore into fresh volumes and verify evidence hashes, pending runs, roles and completed actions. A volume surviving a restart is not a backup. Destructive migrations or resets require an explicit operator action and a recovery plan.

For later public hosting, document TLS ingress, public origin, trusted proxy chain, session-cookie settings, secret injection, resource limits, backups, retention and update/rollback steps. Keep the current single-instance assumption explicit. Multiple instances require shared cache/action-key considerations, job concurrency proof and shared blob storage. Do not claim production readiness from Compose success.

## Verification layers

| Layer | What it proves |
| --- | --- |
| Policy tests | Named SPEC scenarios, boundaries, arithmetic, state transitions and contradictory evidence |
| Contract tests | Schema/error compatibility, source identities, permission and revision behavior |
| PostgreSQL integration | Real transaction rollback, unique operations, migration permissions, concurrent approvals and persistent replay |
| Browser flows | Production-build queue, evidence review, approval/conflict, recovery and mode labels |
| Accessibility | Automated checks plus keyboard and screen-reader review on the principal workflow |
| Agent evaluation | Actual model behavior against rules/oracle baselines, held-out cases, citations, abstention, cost and latency |
| Container tests | Complete packaged runtime, supervised failure, persistence, shutdown and clean restore |

Use Vitest for deterministic policies and suitable components, Playwright for the actual application, and a real PostgreSQL test service for persistence. Test asynchronous Server Components through browser behavior where unit tooling does not support them. Do not write tests that merely mirror implementation branches. Author oracles from the SPEC independently; keep holdout expectations unavailable to agent tools and prompt tuning. An independently reviewed holdout in the same workspace is not a cryptographic blind trial.

Required implementation commands should cover formatting, linting, type checking, domain/integration tests, production build, critical browser flows and local evaluation. Their final names and commands go in the repository README once they exist. CI uses the same frozen dependency set, checks for secrets and vulnerable dependencies, and records build provenance/SBOM for distributable images. Verify the scanner understands pnpm 12's two-document lockfile and produces a nonempty dependency inventory; zero findings from an empty parse is a failed check. No CI publication or paid model run is enabled merely by this blueprint.

## Cross-project acceptance gates

| ID | Observable gate |
| --- | --- |
| BA-01 | Fresh checkout starts with Compose in fixture/rules mode without host Node or provider keys; useful seeded case visible |
| BA-02 | One application image contains web/API/worker; separate database and persistent evidence survive recreation |
| BA-03 | Browser cannot bypass case authorization or reach worker command endpoints using guessed IDs or forged headers |
| BA-04 | Login/logout/refresh, multiple cookies, CSRF rejection and scoped SSE replay work through the packaged Next proxy; revoking session/scope closes an open stream |
| BA-05 | Business mutation and enqueue commit together or roll back together; result receipt is idempotent across queue-ack loss |
| BA-06 | Duplicate/reordered events, concurrent approval, changed payload and stale evidence cannot create a false domain outcome; cancellation between validation and execution claim prevents the effect |
| BA-07 | Timeout after remote success and forced process death reconcile without blind duplicate action; unsupported native guarantees stay manual |
| BA-08 | Worker crash/hang, API crash, database outage and restart preserve explicit state; whole-app health never hides a missing essential service |
| BA-09 | Agent interrupt/resume reruns safely, stale approval is rejected, and an incompatible checkpoint version cannot silently resume |
| BA-10 | Actual Claude run records model/config/usage; refusal, budget exhaustion and unavailable models are distinguishable from rules mode; retries consume budget and unknown usage retains its reservation |
| BA-11 | No secret, unauthorized evidence or private reasoning appears in browser bundles, normal logs, progress streams or image history |
| BA-12 | Source-backed case, uncertain result, keyboard review, dark/light themes and small-screen layout pass recorded design review |
| BA-13 | Fresh-volume restore recovers records and referenced evidence hashes; pending outcomes remain correctly unresolved |
| BA-14 | All five Compose projects can use independent ports/volumes; resource contention is measured on a documented test host |

These gates supplement domain acceptance. They are implemented in stages, not all prerequisites for a first policy slice. A finished use-case milestone needs its UI, real agent comparison and any integration proof required by its SPEC. Report deferred gates clearly. No tested metric becomes a customer savings or safety claim without supporting evidence.

## Delivery sequence

After the owner starts a separate project instance, that agent inventories preserved work, performs a small toolchain/container pilot and records resolved dependencies. It then implements a narrow domain slice under the reviewed SPEC, followed by a working review flow, bounded agent behavior, selected connector proof and the full demonstration. It may add a needed library, service or adapter with a brief reason and the relevant verification. Routine design choices do not require new owner permission.

Cross-repository tracking is owned outside each project. Each project has one writer, its own branch and its own data. Independent review may inspect concurrently. No agent edits another repository or shared tracking records. Code changes await independent review before merge. Publication, external messages, real business actions and spending beyond recorded authority remain separate actions.
