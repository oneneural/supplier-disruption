import { setTimeout as delay } from "node:timers/promises";
import { API_HOST, ConfigError, loadApiConfig } from "@supplier-disruption/config";
import { PGBOSS_SCHEMA } from "@supplier-disruption/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { loadAgentSettings } from "./agent-config.js";
import { buildApp } from "./app.js";
import { resumeInterruptedCases } from "./cases/workflow.js";
import { createAuth } from "./auth.js";
import { composeBusinessClock } from "./clock.js";
import { Demonstration } from "./demonstration/index.js";

// The API stops after the web server and worker inside the container, so its
// own shutdown is short; the s6 timeout-kill for the API is 6000 ms.
const SHUTDOWN_DEADLINE_MS = 5_000;
// While the database or queue schema is unavailable, retry the queue start at this interval.
const QUEUE_START_RETRY_MS = 2_000;
// Readiness probes fail fast instead of waiting on an unreachable database.
const HEALTH_TIMEOUT_MS = 2_000;

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    application_name: "sd-api",
  });
  const db = drizzle(pool);
  // The controlled business clock reads the database on its own connections,
  // so a source transaction never waits on its own pool for a clock sample.
  const clockPool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 2,
    application_name: "sd-api-clock",
  });
  const healthPool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 2,
    application_name: "sd-api-health",
    connectionTimeoutMillis: HEALTH_TIMEOUT_MS,
    query_timeout: HEALTH_TIMEOUT_MS,
  });

  // Producer only: never migrates, supervises or schedules.
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schema: PGBOSS_SCHEMA,
    application_name: "sd-api-pgboss",
    max: 5,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
    persistWarnings: false,
    persistQueueStats: false,
  });
  let queueStarted = false;
  const demonstration =
    config.domainClockMode === "demonstration" ? new Demonstration() : undefined;

  const app = buildApp({
    db,
    sourcePool: pool,
    auth: createAuth(db, {
      appOrigin: config.appOrigin,
      secret: config.betterAuthSecret,
      production: config.nodeEnv === "production",
      allowSignUp: false,
    }),
    boss,
    appOrigin: config.appOrigin,
    workerServiceToken: config.workerServiceToken,
    health: { pool: healthPool, bootId: config.bootId, queueStarted: () => queueStarted },
    clock: composeBusinessClock(config.domainClockMode, clockPool),
    agent: loadAgentSettings(process.env, pool, demonstration),
    ...(demonstration === undefined ? {} : { demonstration, caseFaults: demonstration.faults }),
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
  });
  app.log.info({ domainClockMode: config.domainClockMode }, "business clock");
  boss.on("error", (error: unknown) => {
    app.log.error({ err: error }, "pg-boss error");
  });
  // An idle client whose connection drops (for example while the database
  // restarts) emits here. Unhandled, it would end the process; the pool
  // replaces the client on the next query instead.
  for (const [name, idlePool] of [
    ["request", pool],
    ["health", healthPool],
    ["clock", clockPool],
  ] as const) {
    idlePool.on("error", (error) => {
      app.log.warn({ err: error, pool: name }, "idle database connection lost");
    });
  }

  // Listen before the queue starts, so a database that is not reachable yet
  // shows as not ready instead of exiting the process.
  await app.listen({ host: API_HOST, port: config.apiPort });

  let stopping = false;
  const queueStart = (async () => {
    while (!stopping) {
      try {
        await boss.start();
        queueStarted = true;
        app.log.info("api queue producer started");
        // Cases an earlier process left mid-way get a job again (ADR 0009).
        const resumed = await resumeInterruptedCases(db, boss).catch((error: unknown) => {
          app.log.error({ err: error }, "case resume sweep failed");
          return [];
        });
        if (resumed.length > 0) app.log.info({ cases: resumed }, "interrupted cases requeued");
        return;
      } catch (error) {
        app.log.error({ err: error }, "api queue producer start failed; retrying");
        await delay(QUEUE_START_RETRY_MS);
      }
    }
  })();

  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "api stopping");
    const deadline = setTimeout(() => {
      app.log.error("api shutdown deadline exceeded");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    void (async () => {
      try {
        // Stop accepting requests and wait for in-flight ones, then close the queue and pools.
        await app.close();
        await queueStart;
        await boss.stop({ graceful: true, timeout: 2_000 });
        await Promise.all([pool.end(), healthPool.end(), clockPool.end()]);
        app.log.info("api stopped");
        process.exitCode = 0;
      } catch (error) {
        app.log.error({ err: error }, "api shutdown failed");
        process.exitCode = 1;
      } finally {
        clearTimeout(deadline);
      }
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    error instanceof ConfigError ? `${error.message}\n` : `api: startup failed: ${String(error)}\n`,
  );
  process.exit(1);
}
