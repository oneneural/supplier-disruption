import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PILOT_QUEUE } from "@supplier-disruption/db/worker";
import pg from "pg";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SECRETS = `${REPO_ROOT}.secrets`;
export const APP_ORIGIN = "http://127.0.0.1:3102";
export const FIXTURE_ORG_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

export function secret(relative: string): string {
  try {
    return readFileSync(`${SECRETS}/${relative}`, "utf8").trim();
  } catch {
    throw new Error(`Missing .secrets/${relative}. Run: sh scripts/init-secrets.sh`);
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address !== null ? address.port : 0),
      );
    });
  });
}

/** Configuration through _FILE indirection only, as in a deployed container. */
export function baseEnv(apiPort: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    APP_ID: "supplier-disruption",
    APP_ORIGIN,
    DATA_MODE: "fixture",
    AGENT_MODE: "rules",
    AUTH_MODE: "fixture",
    NODE_ENV: "test",
    LOG_LEVEL: "warn",
    API_PORT: String(apiPort),
    BUILD_REVISION: "test",
    DATABASE_URL_API_FILE: `${SECRETS}/host/database_url_api`,
    DATABASE_URL_WORKER_FILE: `${SECRETS}/host/database_url_worker`,
    BETTER_AUTH_SECRET_FILE: `${SECRETS}/better_auth_secret`,
    WORKER_SERVICE_TOKEN_FILE: `${SECRETS}/worker_service_token`,
  };
}

/** A spawned service with its output captured line by line. */
export class Service {
  readonly lines: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly child: ChildProcess;
  private waiters: Array<() => void> = [];

  constructor(
    readonly name: string,
    script: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.child = spawn(process.execPath, [script], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      let buffered = "";
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        buffered += chunk;
        const parts = buffered.split("\n");
        buffered = parts.pop() ?? "";
        this.lines.push(...parts);
        for (const notify of this.waiters) notify();
      });
    }
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        for (const notify of this.waiters) notify();
        resolve({ code, signal });
      });
    });
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Waits for an output line matching `pattern` and returns it. */
  async waitForLine(pattern: RegExp, timeoutMs = 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.find((line) => pattern.test(line));
      if (found !== undefined) return found;
      if (!this.running)
        throw new Error(`${this.name} exited before printing ${pattern}:\n${this.output()}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(`${this.name} did not print ${pattern}:\n${this.output()}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 1000));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.waiters = [];
    }
  }

  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.child.kill("SIGTERM");
    const result = await Promise.race([this.exited, delay(30_000).then(() => null)]);
    if (result === null) {
      this.child.kill("SIGKILL");
      await this.exited;
    }
  }

  output(): string {
    return this.lines.slice(-40).join("\n");
  }
}

export async function startApi(apiPort: number): Promise<Service> {
  const api = new Service("api", "apps/api/dist/main.js", baseEnv(apiPort));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/session`);
      if (response.status === 401) return api;
    } catch {
      // Not listening yet.
    }
    if (!api.running || Date.now() > deadline) {
      await api.stop();
      throw new Error(`api did not become ready:\n${api.output()}`);
    }
    await delay(200);
  }
}

export interface WorkerHooks {
  holdAt?: "before-receipt" | "after-receipt";
  handlerDelayMs?: number;
}

export async function startWorker(
  apiPort: number,
  hooks: WorkerHooks = {},
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ worker: Service; bootId: string }> {
  const env = { ...baseEnv(apiPort), ...extraEnv };
  if (hooks.holdAt !== undefined) env.PILOT_TEST_HOLD_AT = hooks.holdAt;
  if (hooks.handlerDelayMs !== undefined)
    env.PILOT_TEST_HANDLER_DELAY_MS = String(hooks.handlerDelayMs);
  const worker = new Service("worker", "apps/worker/dist/main.js", env);
  const ready = await worker.waitForLine(/^WORKER_READY /, 30_000);
  return { worker, bootId: ready.split(" ")[1] ?? "" };
}

/** Independent observation connection (migrator role). */
export class Observer {
  private readonly pool = new pg.Pool({
    connectionString: secret("host/database_url_migrator"),
    max: 3,
    application_name: "test-observer",
  });

  async query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(text, values)).rows;
  }

  async operation(operationId: string) {
    return this.query<{
      state: string;
      job_id: string | null;
      receipt_id: string | null;
      receipt_job_id: string | null;
    }>(
      `SELECT state, job_id, receipt_id, receipt_job_id FROM app.pilot_operation WHERE operation_id = $1`,
      [operationId],
    );
  }

  async jobs(operationId: string) {
    return this.query<{ id: string; state: string; retry_count: number }>(
      `SELECT id, state::text, retry_count FROM pgboss.job
        WHERE name = $1 AND (singleton_key = $2 OR data->>'operationId' = $2)`,
      [PILOT_QUEUE, operationId],
    );
  }

  async attempts(operationId: string) {
    return this.query<{
      outcome: string;
      receipt_id: string;
      job_id: string;
      job_retry_count: number;
      worker_boot_id: string;
    }>(
      `SELECT outcome, receipt_id, job_id, job_retry_count, worker_boot_id
         FROM app.pilot_receipt_attempt WHERE operation_id = $1 ORDER BY observed_at, id`,
      [operationId],
    );
  }

  /** Pilot jobs that are still waiting or running. */
  async pendingJobCount(): Promise<number> {
    const [row] = await this.query<{ count: string }>(
      `SELECT count(*) FROM pgboss.job WHERE name = $1 AND state IN ('created', 'retry', 'active')`,
      [PILOT_QUEUE],
    );
    return Number(row?.count ?? 0);
  }

  async waitFor<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
      await delay(250);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function signInManager(apiPort: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({
      email: "manager@fixture.local",
      password: secret("fixture_manager_password"),
    }),
  });
  if (response.status !== 200) throw new Error(`manager sign-in returned ${response.status}`);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

export async function submit(
  apiPort: number,
  cookie: string,
  operationId: string = randomUUID(),
  note = "pilot",
  payloadExtra: Record<string, unknown> = {},
): Promise<{ status: number; operationId: string }> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/pilot/operations`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie },
    body: JSON.stringify({
      contractVersion: "pilot-operation.v1",
      operationId,
      organizationId: FIXTURE_ORG_ID,
      payload: { note, ...payloadExtra },
    }),
  });
  await response.arrayBuffer();
  return { status: response.status, operationId };
}

/**
 * Processes jobs left by earlier test files (which run without a worker) so
 * the fault-injecting workers below claim only the job under test.
 */
export async function drainBacklog(apiPort: number, observer: Observer): Promise<void> {
  if ((await observer.pendingJobCount()) === 0) return;
  const { worker } = await startWorker(apiPort);
  try {
    // Expired or orphaned jobs need supervision passes and retries to settle.
    await observer.waitFor(
      () => observer.pendingJobCount(),
      (count) => count === 0,
      120_000,
      "backlog to drain",
    );
  } finally {
    await worker.stop();
  }
}
