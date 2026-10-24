// Shared wiring for the case workflow tests: the real Fastify app on
// a disposable database with the controlled business clock, an optional real
// worker process, and an independent migrator observer. Expected values in
// the tests are oracle literals written by hand, never read from the code.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGBOSS_SCHEMA, createControlledClock } from "@supplier-disruption/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { expect } from "vitest";
import { buildApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import type { AgentSettings } from "../src/cases/extraction.js";
import { CaseWorkflow, type CaseFaultHooks } from "../src/cases/workflow.js";
import type { DisposableDatabase } from "./disposable.js";
import { APP_ORIGIN, REPO_ROOT, SECRETS, secret, signIn } from "./support.js";

/** The synthetic application organization whose source records are `ORG-NDL`. */
export const ORG_NDL = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const MSG_0001 = {
  sourceSystem: "fixture-supplier-mail",
  messageId: "MSG-0001",
  inputVersion: 1,
};

export interface CaseStack {
  baseUrl: string;
  /** Stops the HTTP API (an outage); the queue client and pools stay up. */
  stopApi(): Promise<void>;
  /** Starts a fresh API on the same port, as a restarted process would. */
  startApi(): Promise<void>;
  boss: PgBoss;
  db: NodePgDatabase;
  /** A workflow on the same database, for driving application runs directly. */
  workflow: CaseWorkflow;
  observer: pg.Client;
  buyer: string;
  manager: string;
  close(): Promise<void>;
}

/** Migrates and seeds the disposable database, then starts the API on it. */
export async function startCaseStack(
  db: DisposableDatabase,
  options: { faults?: CaseFaultHooks; agent?: (pool: pg.Pool) => AgentSettings } = {},
): Promise<CaseStack> {
  const migrated = await db.migrate();
  expect(migrated.code, migrated.stderr).toBe(0);
  const seeded = await db.seed();
  expect(seeded.code, seeded.stderr).toBe(0);

  const pool = new pg.Pool({
    connectionString: db.url("api"),
    max: 10,
    application_name: "case-api",
  });
  const clockPool = new pg.Pool({
    connectionString: db.url("api"),
    max: 2,
    application_name: "case-clock",
  });
  for (const each of [pool, clockPool]) each.on("error", () => undefined);
  const boss = new PgBoss({
    connectionString: db.url("api"),
    schema: PGBOSS_SCHEMA,
    max: 4,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  await boss.start();
  const drizzleDb = drizzle(pool);
  const clock = createControlledClock(clockPool);
  const agent = options.agent?.(pool);
  const build = (): FastifyInstance =>
    buildApp({
      db: drizzleDb,
      sourcePool: pool,
      auth: createAuth(drizzleDb, {
        appOrigin: APP_ORIGIN,
        secret: secret("better_auth_secret"),
        production: false,
        allowSignUp: false,
      }),
      boss,
      appOrigin: APP_ORIGIN,
      workerServiceToken: secret("worker_service_token"),
      health: { pool, bootId: undefined, queueStarted: () => true },
      logger: false,
      clock,
      ...(options.faults === undefined ? {} : { caseFaults: options.faults }),
      ...(agent === undefined ? {} : { agent }),
    });
  let app: FastifyInstance | null = build();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const workflow = new CaseWorkflow({
    db: drizzleDb,
    sourcePool: pool,
    clock,
    boss,
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    ...(agent === undefined ? {} : { agent }),
  });
  const observer = await db.client("migrator", "case-observer");
  const buyer = (
    await signIn(baseUrl, {
      email: "buyer@fixture.local",
      password: secret("fixture_buyer_password"),
    })
  ).cookie;
  const manager = (
    await signIn(baseUrl, {
      email: "manager@fixture.local",
      password: secret("fixture_manager_password"),
    })
  ).cookie;
  return {
    baseUrl,
    async stopApi() {
      await app?.close();
      app = null;
    },
    async startApi() {
      app = build();
      await app.listen({ host: "127.0.0.1", port });
    },
    boss,
    db: drizzleDb,
    workflow,
    observer,
    buyer,
    manager,
    async close() {
      await app?.close();
      await boss.stop({ graceful: false });
      await Promise.allSettled([pool.end(), clockPool.end()]);
    },
  };
}

/** One JSON call to the API as a signed-in user, from the application origin. */
export async function call(
  stack: CaseStack,
  cookie: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers: {
      cookie,
      origin: APP_ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Raw rows from the independent migrator connection. */
export async function rows<T extends pg.QueryResultRow = Record<string, unknown>>(
  observer: pg.Client,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await observer.query<T>(text, values)).rows;
}

/** Counts of every fixture source operation, receipt and request. */
export async function sourceEffects(observer: pg.Client) {
  const [counts] = await rows(
    observer,
    `SELECT (SELECT count(*) FROM fixture_purchasing.operation)::int AS purchasing,
            (SELECT count(*) FROM fixture_inventory.operation)::int AS inventory,
            (SELECT count(*) FROM fixture_inventory.transfer_request)::int AS requests,
            (SELECT revision FROM fixture_purchasing.po_head WHERE po_number = 'PO-120') AS po_revision,
            (SELECT version FROM fixture_inventory.stock_head WHERE warehouse = 'WH-B') AS wh_b`,
  );
  return counts;
}

/** The real worker process, configured like a deployed one but against this database. */
export class TestWorker {
  private child: ChildProcess | null = null;
  private readonly dir = mkdtempSync(join(tmpdir(), "sd-case-worker-"));
  readonly lines: string[] = [];

  async start(db: DisposableDatabase, apiBaseUrl: string): Promise<void> {
    const urlFile = join(this.dir, "database_url_worker");
    writeFileSync(urlFile, db.url("worker"), { mode: 0o600 });
    const child = spawn(process.execPath, ["apps/worker/dist/main.js"], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        APP_ID: "supplier-disruption",
        APP_ORIGIN,
        DATA_MODE: "fixture",
        AGENT_MODE: "rules",
        AUTH_MODE: "fixture",
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        API_PORT: new URL(apiBaseUrl).port,
        BUILD_REVISION: "test",
        DATABASE_URL_WORKER_FILE: urlFile,
        WORKER_SERVICE_TOKEN_FILE: `${SECRETS}/worker_service_token`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (ready = resolve));
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        for (const line of chunk.split("\n").filter(Boolean)) {
          this.lines.push(line);
          if (line.startsWith("WORKER_READY")) ready();
        }
      });
    }
    const exited = new Promise<never>((_, reject) =>
      child.once("exit", (code) =>
        reject(new Error(`worker exited ${String(code)}:\n${this.lines.join("\n")}`)),
      ),
    );
    await Promise.race([started, exited]);
  }

  /** Ends the process at once with SIGKILL, as a crash would; no drain runs. */
  async kill(): Promise<void> {
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await done;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      const done = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 20_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Polls the case until it reaches `state`, failing with the last detail. */
export async function waitForState(
  stack: CaseStack,
  cookie: string,
  caseId: string,
  state: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = (await call(stack, cookie, "GET", `/api/cases/${caseId}`)).body;
    if ((last.case as { state?: string } | undefined)?.state === state) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`case did not reach ${state}: ${JSON.stringify(last.case)}`);
}
