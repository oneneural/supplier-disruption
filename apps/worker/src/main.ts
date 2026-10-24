import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigError, loadWorkerConfig, type WorkerConfig } from "@supplier-disruption/config";
import {
  CASE_QUEUE,
  HEARTBEAT_INTERVAL_MS,
  PGBOSS_SCHEMA,
  PILOT_QUEUE,
  workerHeartbeat,
  type CaseJobData,
  type PilotJobData,
} from "@supplier-disruption/db/worker";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgBoss, type Job } from "pg-boss";
import { describeError, isAbortError } from "./errors.js";
import { heartbeatPool, isPermanentDatabaseError, writeFirstHeartbeat } from "./heartbeat.js";
import { DRAIN_TIMEOUT_MS, SHUTDOWN_DEADLINE_MS, drainAndClose } from "./shutdown.js";
import { startConsuming, type StartupSteps } from "./startup.js";

const API_CALL_TIMEOUT_MS = 10_000;
// A case run applies up to three source actions and reads them back.
const CASE_CALL_TIMEOUT_MS = 60_000;

function log(level: "info" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: "worker",
    message,
    ...fields,
  });
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

/** Test-only marker on stdout; tests wait for it before interrupting the process. */
function testMarker(name: string, job: Job<PilotJobData>): void {
  process.stdout.write(`TEST_MARKER ${name} ${job.id} ${job.data.operationId} ${job.retryCount}\n`);
}

/** Calls an internal pilot endpoint for this job with the worker service token. */
async function callApi(
  config: WorkerConfig,
  bootId: string,
  job: Job<PilotJobData>,
  action: "start" | "receipt",
): Promise<Record<string, unknown> | null> {
  const response = await fetch(
    `${config.apiInternalUrl}/internal/pilot/operations/${encodeURIComponent(job.data.operationId)}/${action}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.workerServiceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jobId: job.id, workerBootId: bootId }),
      signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS),
    },
  );
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status !== 200 && response.status !== 201) {
    // Throwing fails the attempt; pg-boss retries it under the queue's retry policy.
    throw new Error(`${action} call returned ${response.status}`);
  }
  return body;
}

/** Records the handler start through the API and returns the operation's pilot hold. */
async function postStart(config: WorkerConfig, bootId: string, job: Job<PilotJobData>) {
  const body = await callApi(config, bootId, job, "start");
  const holdMs = body?.holdMs;
  return {
    holdMs: typeof holdMs === "number" && Number.isInteger(holdMs) && holdMs > 0 ? holdMs : 0,
  };
}

async function postReceipt(config: WorkerConfig, bootId: string, job: Job<PilotJobData>) {
  const body = await callApi(config, bootId, job, "receipt");
  return { receiptId: body?.receiptId, outcome: body?.outcome };
}

/**
 * Runs one case application job through the API, which owns the action
 * journal and the source writes. An uncertain outcome fails the attempt, so
 * pg-boss retries it and the API reconciles by operation ID first.
 */
async function runCaseJob(config: WorkerConfig, bootId: string, job: Job<CaseJobData>) {
  const response = await fetch(
    `${config.apiInternalUrl}/internal/cases/${encodeURIComponent(job.data.caseId)}/apply`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.workerServiceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jobId: job.id, workerBootId: bootId }),
      signal: AbortSignal.timeout(CASE_CALL_TIMEOUT_MS),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    state?: unknown;
    retry?: unknown;
  } | null;
  if (response.status !== 200) {
    throw new Error(`case apply call returned ${response.status}`);
  }
  log("info", "case application run", {
    jobId: job.id,
    caseId: job.data.caseId,
    retryCount: job.retryCount,
    state: body?.state,
    retry: body?.retry,
  });
  if (body?.retry === true) {
    throw new Error(`case ${job.data.caseId} is ${String(body.state)}; retrying to reconcile`);
  }
  return { state: body?.state };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  // In the image the boot ID always comes from the container's boot-id file
  // (configuration requires it in production); host runs make their own.
  const bootId = config.bootId ?? randomUUID();
  const hooks = config.testHooks;

  const pool = heartbeatPool(config.databaseUrl);
  // An idle client whose connection drops (for example while the database
  // restarts) emits here. Unhandled, it would end the process.
  pool.on("error", (error) => {
    log("error", "idle database connection lost", { error: String(error) });
  });
  const db = drizzle(pool);

  // Consumer and supervisor: recovers expired jobs, but never migrates or schedules.
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schema: PGBOSS_SCHEMA,
    application_name: "sd-worker-pgboss",
    max: 4,
    migrate: false,
    supervise: true,
    schedule: false,
    superviseIntervalSeconds: 5,
    // Job expiry runs in the monitor pass, which defaults to every 60 s.
    monitorIntervalSeconds: 5,
    registerInstance: false,
    persistWarnings: false,
    persistQueueStats: false,
    reindex: false,
    monitorVacuum: false,
  });
  boss.on("error", (error: unknown) => {
    log("error", "pg-boss error", { error: String(error) });
  });

  const steps: StartupSteps = {
    start: () => boss.start(),
    work: async () => {
      await boss.work<CaseJobData>(
        CASE_QUEUE,
        { batchSize: 1, pollingIntervalSeconds: 1 },
        async ([job]) => {
          if (job === undefined) return null;
          return runCaseJob(config, bootId, job);
        },
      );
      return boss.work<PilotJobData>(
        PILOT_QUEUE,
        { batchSize: 1, pollingIntervalSeconds: 1 },
        async ([job]) => {
          if (job === undefined) return null;
          log("info", "pilot job claimed", {
            jobId: job.id,
            operationId: job.data.operationId,
            retryCount: job.retryCount,
          });
          // The start is recorded before the line is printed, so a reader of the
          // line can already observe the started attempt.
          const { holdMs } = await postStart(config, bootId, job);
          log("info", `pilot handler started operation=${job.data.operationId} boot=${bootId}`, {
            jobId: job.id,
            retryCount: job.retryCount,
            holdMs,
          });
          if (hooks !== undefined) {
            testMarker("claimed", job);
            if (hooks.handlerDelayMs > 0) await delay(hooks.handlerDelayMs);
            if (hooks.holdAt === "before-receipt") {
              testMarker("hold-before-receipt", job);
              await new Promise<never>(() => {});
            }
          }
          if (holdMs > 0) await delay(holdMs);
          let receipt: Awaited<ReturnType<typeof postReceipt>>;
          try {
            receipt = await postReceipt(config, bootId, job);
          } catch (error) {
            log("error", "pilot receipt failed; the job will be retried", {
              jobId: job.id,
              operationId: job.data.operationId,
              retryCount: job.retryCount,
              error: String(error),
            });
            throw error;
          }
          if (hooks?.holdAt === "after-receipt") {
            testMarker("hold-after-receipt", job);
            await new Promise<never>(() => {});
          }
          log("info", "pilot receipt recorded", {
            jobId: job.id,
            operationId: job.data.operationId,
            ...receipt,
          });
          if (hooks !== undefined) testMarker("handler-finished", job);
          return receipt;
        },
      );
    },
    writeFirstHeartbeat: () => writeFirstHeartbeat(db, bootId, config.buildRevision),
    // Such as a revoked grant or a missing table: fail with the driver error now
    // rather than retry until the startup bound.
    isPermanent: isPermanentDatabaseError,
    firstHeartbeatFailed: (error, attempt) => {
      log("error", "first heartbeat failed; retrying", {
        attempt,
        error: String(error),
        cause: error instanceof Error ? String(error.cause) : undefined,
      });
    },
  };
  // A shutdown request during startup aborts it: a wait between first heartbeat
  // attempts ends at once, and startup rejects without waiting for an attempt
  // in flight, although the pool's close during the stop still waits for that
  // attempt to end (at most its statement timeout).
  const startup = new AbortController();
  const starting = startConsuming(steps, { signal: startup.signal });

  let heartbeat: NodeJS.Timeout | undefined = undefined;
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    startup.abort();
    log("info", "worker stopping", { signal });
    const deadline = setTimeout(() => {
      log("error", "worker shutdown deadline exceeded");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    void (async () => {
      let code = 0;
      try {
        // An aborted startup settles at once, except that pg-boss lets a start
        // already in flight finish. A startup that failed on its own is still
        // reported; the requested stop goes on.
        await starting.catch((error: unknown) => {
          if (!isAbortError(error)) {
            log("error", "worker startup failed during shutdown", { error: describeError(error) });
          }
        });
        await drainAndClose({
          // Stops new claims, waits for in-flight handlers, then closes pg-boss's pool.
          stopQueue: () => boss.stop({ graceful: true, timeout: DRAIN_TIMEOUT_MS, close: true }),
          stopHeartbeat: () => clearInterval(heartbeat),
          closePool: () => pool.end(),
        });
        log("info", "worker stopped");
      } catch (error) {
        log("error", "worker shutdown failed", {
          error: String(error),
          ...(error instanceof AggregateError ? { causes: error.errors.map(String) } : {}),
        });
        code = 1;
      }
      // A handler abandoned at the drain timeout can still hold an open request,
      // such as a receipt call to an unresponsive API, which would keep the
      // process alive until s6 kills it. pg-boss has already failed its job, so
      // the job is retried under the queue policy (see DRAIN_TIMEOUT_MS), and a
      // receipt arriving late finds the job no longer active.
      process.exit(code);
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await starting;
  } catch (error) {
    // The shutdown above reports the error and ends the process.
    if (stopping) return;
    throw error;
  }
  if (stopping) return;

  let beating = false;
  heartbeat = setInterval(() => {
    // Skip a beat rather than queue updates while the database is slow or away.
    if (beating) return;
    beating = true;
    db.update(workerHeartbeat)
      .set({ observedAt: sql`now()` })
      .where(eq(workerHeartbeat.bootId, bootId))
      .catch((error: unknown) => {
        // Drizzle wraps the driver error; its cause says why, such as a timeout.
        log("error", "heartbeat failed", {
          error: String(error),
          cause: error instanceof Error ? String(error.cause) : undefined,
        });
      })
      .finally(() => {
        beating = false;
      });
  }, HEARTBEAT_INTERVAL_MS);

  log("info", "worker started", { bootId, buildRevision: config.buildRevision });
  process.stdout.write(`WORKER_READY ${bootId}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    error instanceof ConfigError
      ? `${error.message}\n`
      : `worker: startup failed: ${describeError(error)}\n`,
  );
  process.exit(1);
}
