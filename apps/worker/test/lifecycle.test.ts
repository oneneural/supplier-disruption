import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  Observer,
  Service,
  baseEnv,
  secret,
  drainBacklog,
  freePort,
  signInManager,
  startApi,
  startWorker,
  submit,
} from "./support.js";
import {
  DB_STATEMENT_TIMEOUT_MS,
  heartbeatPool,
  isPermanentDatabaseError,
  writeFirstHeartbeat,
} from "../src/heartbeat.js";
import { DRAIN_TIMEOUT_MS, SHUTDOWN_DEADLINE_MS } from "../src/shutdown.js";
import { FIRST_HEARTBEAT_RETRY_MS, startConsuming } from "../src/startup.js";

let apiPort: number;
let api: Service;
let observer: Observer;
let cookie: string;
let dir: string;
const workers: Service[] = [];

beforeAll(async () => {
  observer = new Observer();
  apiPort = await freePort();
  api = await startApi(apiPort);
  cookie = await signInManager(apiPort);
  dir = await mkdtemp(join(tmpdir(), "sd-worker-boot-"));
  await drainBacklog(apiPort, observer);
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

afterAll(async () => {
  await api?.stop();
  await observer?.close();
  await rm(dir, { recursive: true, force: true });
});

/** A worker that reads its boot ID from a file, as in the container image. */
async function workerWithBootId(bootId: string) {
  const file = join(dir, `boot-${bootId}`);
  await writeFile(file, `${bootId}\n`);
  const started = await startWorker(apiPort, {}, { BOOT_ID_FILE: file });
  workers.push(started.worker);
  return started;
}

/**
 * A worker that reads its boot ID from a file, started without waiting for
 * WORKER_READY, for a start whose first heartbeat is held back.
 */
async function spawnWorkerWithBootId(bootId: string) {
  const file = join(dir, `boot-${bootId}`);
  await writeFile(file, `${bootId}\n`);
  const worker = new Service("worker", "apps/worker/dist/main.js", {
    ...baseEnv(apiPort),
    BOOT_ID_FILE: file,
  });
  workers.push(worker);
  return worker;
}

/**
 * Holds an EXCLUSIVE lock on worker.heartbeat from a separate session, which
 * blocks heartbeat writes (not reads) until `release()`.
 */
async function lockHeartbeats() {
  const locker = new pg.Client({ connectionString: secret("host/database_url_migrator") });
  await locker.connect();
  await locker.query("BEGIN");
  await locker.query("LOCK TABLE worker.heartbeat IN EXCLUSIVE MODE");
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await locker.query("ROLLBACK");
      await locker.end();
    },
  };
}

const FIRST_HEARTBEAT_RETRY = /"message":"first heartbeat failed; retrying"/;

async function heartbeats(bootId: string) {
  return observer.query<{ started_at: Date; observed_at: Date; build_revision: string }>(
    `SELECT started_at, observed_at, build_revision FROM worker.heartbeat WHERE boot_id = $1`,
    [bootId],
  );
}

describe("worker heartbeat and boot identity", () => {
  it("uses the boot ID from BOOT_ID_FILE and has a heartbeat row once ready", async () => {
    const bootId = randomUUID();
    const started = await workerWithBootId(bootId);
    expect(started.bootId).toBe(bootId);
    const rows = await heartbeats(bootId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.build_revision).toBe("test");
  });

  it("upserts the same boot's row when a worker restarts inside one container boot", async () => {
    const bootId = randomUUID();
    const first = await workerWithBootId(bootId);
    const [before] = await heartbeats(bootId);
    await first.worker.stop();

    await workerWithBootId(bootId);
    const rows = await heartbeats(bootId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.started_at.getTime()).toBeGreaterThan(before?.started_at.getTime() ?? Infinity);
    expect(rows[0]?.observed_at.getTime()).toBeGreaterThan(
      before?.observed_at.getTime() ?? Infinity,
    );
  });
});

describe("heartbeat timeouts", () => {
  it("fails a blocked heartbeat within its statement timeout and resumes afterwards", async () => {
    const bootId = randomUUID();
    const { worker } = await workerWithBootId(bootId);
    const locker = new pg.Client({ connectionString: secret("host/database_url_migrator") });
    await locker.connect();
    try {
      // Blocks the worker's heartbeat UPDATE (not reads) for longer than the
      // 5 s statement timeout. Without the timeout the update would wait for
      // the lock and nothing would report the stalled heartbeat.
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE worker.heartbeat IN EXCLUSIVE MODE");
      const lockedAt = Date.now();
      const failed = await worker.waitForLine(/"message":"heartbeat failed"/, 9_000);
      expect(Date.now() - lockedAt).toBeLessThan(9_000);
      expect(failed).toContain("statement timeout");
    } finally {
      await locker.query("ROLLBACK");
      await locker.end();
    }
    const releasedAt = Date.now();
    await observer.waitFor(
      () => heartbeats(bootId),
      (rows) => (rows[0]?.observed_at.getTime() ?? 0) > releasedAt - 1_000,
      15_000,
      "a heartbeat after the lock",
    );
  });
});

describe("first heartbeat retry", () => {
  it("stays up while its first heartbeat is blocked past the statement timeout, then writes it", async () => {
    const bootId = randomUUID();
    const lock = await lockHeartbeats();
    let worker: Service;
    let releasedAt: number;
    try {
      worker = await spawnWorkerWithBootId(bootId);
      // Throws if the worker exits instead of retrying.
      const retry = await worker.waitForLine(FIRST_HEARTBEAT_RETRY, 20_000);
      expect(JSON.parse(retry)).toMatchObject({ level: "error", attempt: 1 });
      expect(retry).toContain("statement timeout");
      expect(worker.lines.some((line) => line.startsWith("WORKER_READY"))).toBe(false);
      expect(await heartbeats(bootId)).toEqual([]);
    } finally {
      releasedAt = Date.now();
      await lock.release();
    }
    await worker.waitForLine(/^WORKER_READY /, 15_000);
    const readyAt = Date.now();
    expect(worker.running).toBe(true);
    // One successful write, for this boot, once the lock was released.
    const rows = await heartbeats(bootId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.build_revision).toBe("test");
    // A blocked attempt proceeds at the release; otherwise the next one starts
    // within the retry interval.
    expect(readyAt - releasedAt).toBeLessThan(FIRST_HEARTBEAT_RETRY_MS + 1_000);
    expect(worker.lines.filter((line) => line.includes("startup failed"))).toEqual([]);
    // Periodic heartbeats follow as usual.
    await observer.waitFor(
      () => heartbeats(bootId),
      (r) => (r[0]?.observed_at.getTime() ?? 0) > (rows[0]?.observed_at.getTime() ?? Infinity),
      10_000,
      "a periodic heartbeat after the first",
    );
  });

  it("stops promptly and cleanly on SIGTERM during the retry", async () => {
    const bootId = randomUUID();
    const lock = await lockHeartbeats();
    try {
      const worker = await spawnWorkerWithBootId(bootId);
      await worker.waitForLine(FIRST_HEARTBEAT_RETRY, 20_000);
      // After the retry interval the second attempt is blocked on the lock.
      await delay(2_500);
      const stoppedAt = Date.now();
      worker.signal("SIGTERM");
      const exit = await Promise.race([worker.exited, delay(20_000).then(() => null)]);
      const elapsed = Date.now() - stoppedAt;
      expect(exit, "worker still running 20 s after SIGTERM").toEqual({ code: 0, signal: null });
      // The abandoned attempt, started about 0.5 s before the signal, ends at its
      // statement timeout, which bounds the pool's close; the stop never waits
      // out the startup deadline or reaches the shutdown deadline.
      expect(elapsed).toBeLessThan(DB_STATEMENT_TIMEOUT_MS + 1_000);
      expect(worker.lines.some((line) => line.includes('"message":"worker stopped"'))).toBe(true);
      expect(worker.lines.some((line) => line.startsWith("WORKER_READY"))).toBe(false);
      expect(await heartbeats(bootId)).toEqual([]);
    } finally {
      await lock.release();
    }
  });

  it("fails at once on a permanent database error, without retrying", async () => {
    const pool = heartbeatPool(secret("host/database_url_worker"));
    const db = drizzle(pool);
    const reported: unknown[] = [];
    try {
      const startedAt = Date.now();
      const failure = await startConsuming(
        {
          start: () => Promise.resolve(),
          work: () => Promise.resolve(),
          // A real driver error under Drizzle's wrapper: 42P01 undefined_table.
          writeFirstHeartbeat: async () => {
            await db.execute(sql`INSERT INTO worker.no_such_heartbeat VALUES (1)`);
          },
          isPermanent: isPermanentDatabaseError,
          firstHeartbeatFailed: (error) => reported.push(error),
        },
        { firstHeartbeatRetryMs: 50 },
      ).catch((error: unknown) => error);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(reported).toEqual([]);
      expect(((failure as Error).cause as { code?: string }).code).toBe("42P01");
    } finally {
      await pool.end();
    }
  });

  it("gives up at an injected deadline when the lock is never released", async () => {
    const bootId = randomUUID();
    const pool = heartbeatPool(secret("host/database_url_worker"));
    const db = drizzle(pool);
    const lock = await lockHeartbeats();
    const reported: string[] = [];
    try {
      const startedAt = Date.now();
      const failure = await startConsuming(
        {
          start: () => Promise.resolve(),
          work: () => Promise.resolve(),
          writeFirstHeartbeat: () => writeFirstHeartbeat(db, bootId, "test"),
          firstHeartbeatFailed: (error) => {
            reported.push(String((error as Error).cause));
          },
        },
        // Attempts at 0 s and 7 s each wait 5 s on the lock; no third one fits.
        { firstHeartbeatDeadlineMs: 8_000 },
      ).catch((error: unknown) => error);
      const elapsed = Date.now() - startedAt;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "first heartbeat not written within 8000 ms (2 attempts)",
      );
      expect(String(((failure as Error).cause as Error).cause)).toContain("statement timeout");
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("statement timeout");
      expect(elapsed).toBeGreaterThanOrEqual(2 * DB_STATEMENT_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(2 * DB_STATEMENT_TIMEOUT_MS + 4_000);
      expect(await heartbeats(bootId)).toEqual([]);
    } finally {
      await lock.release();
      await pool.end();
    }
  });
});

describe("pilot hold and handler start record", () => {
  it("records the handler start before waiting holdMs and then the receipt", async () => {
    const bootId = randomUUID();
    const { worker } = await workerWithBootId(bootId);
    const { status, operationId } = await submit(apiPort, cookie, randomUUID(), "hold", {
      holdMs: 3_000,
    });
    expect(status).toBe(202);

    const line = await worker.waitForLine(
      new RegExp(`pilot handler started operation=${operationId} boot=${bootId}`),
      30_000,
    );
    const lineAt = Date.now();
    expect(JSON.parse(line)).toMatchObject({ holdMs: 3_000 });
    // The start is visible as soon as the line is, and the receipt is not.
    const starts = await observer.query<{ worker_boot_id: string; job_retry_count: number }>(
      `SELECT worker_boot_id, job_retry_count FROM app.pilot_handler_attempt WHERE operation_id = $1`,
      [operationId],
    );
    expect(starts).toEqual([{ worker_boot_id: bootId, job_retry_count: 0 }]);
    expect((await observer.operation(operationId))[0]?.receipt_id).toBeNull();

    await observer.waitFor(
      () => observer.operation(operationId),
      (rows) => rows[0]?.receipt_id !== null,
      30_000,
      "the receipt",
    );
    // The handler waited out its hold before recording the receipt.
    expect(Date.now() - lineAt).toBeGreaterThanOrEqual(2_500);
  });
});

describe("stop with an abandoned handler", () => {
  it("exits after the drain even while a handler still waits on an unresponsive API", async () => {
    const { worker } = await workerWithBootId(randomUUID());
    const { status, operationId } = await submit(apiPort, cookie, randomUUID(), "stuck", {
      holdMs: 8_000, // PILOT_MAX_HOLD_MS
    });
    expect(status).toBe(202);
    await worker.waitForLine(new RegExp(`pilot handler started operation=${operationId}`), 20_000);
    // The frozen API accepts the receipt connection but never answers, so the
    // handler's request stays open past the drain timeout.
    api.signal("SIGSTOP");
    try {
      const stoppedAt = Date.now();
      worker.signal("SIGTERM");
      const exit = await Promise.race([worker.exited, delay(20_000).then(() => null)]);
      const elapsed = Date.now() - stoppedAt;
      expect(exit, "worker still running 20 s after SIGTERM").not.toBeNull();
      // A clean exit after the drain, before the process deadline and so well
      // inside the image's s6 timeout-kill: s6 never needs SIGKILL.
      expect(exit).toEqual({ code: 0, signal: null });
      expect(elapsed).toBeGreaterThanOrEqual(DRAIN_TIMEOUT_MS - 500);
      expect(elapsed).toBeLessThan(SHUTDOWN_DEADLINE_MS);
    } finally {
      api.signal("SIGCONT");
    }
  });
});
