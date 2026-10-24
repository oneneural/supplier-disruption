// Termination gates (ADR 0016): the built API and worker processes
// on a disposable database, ended with SIGKILL at four boundaries of the
// C-01 application. Barriers are row locks an independent migrator
// connection holds in the source and queue tables, so each process stops at
// an exact point of its real code path, with no fault hook:
//
// - K1, before the source write commits: ACT-1's claim committed, its
//   purchasing write waits on the PO head row; the API is killed;
// - K2, after the effect committed, before the journal records it: the
//   amendment committed, ACT-1's journal update waits on the case row; the
//   API is killed with the source's response;
// - K3, after the API committed every effect, before the worker got the
//   response: the worker is killed while its call is in flight;
// - K4, after the worker got the response, before the queue acknowledged
//   the job: pg-boss's completion waits on the job row; the worker is killed
//   and its sessions ended, so the completion it queued never runs.
//
// Each run must end `plan_verified` with exactly the C-01 effects (one
// amendment, one reservation, one transfer request), the stable operation
// IDs and request digests, and the queue job completed.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MSG_0001, ORG_NDL, TestWorker, rows, sourceEffects } from "./case-support.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import { APP_ORIGIN, REPO_ROOT, SECRETS, secret, signIn } from "./support.js";

const SETUP_TIMEOUT_MS = START_TIMEOUT_MS + 3 * COMPOSE_TIMEOUT_MS;
// A dead worker's job waits for the queue's 10 s heartbeat, then a retry.
const GATE_TIMEOUT_MS = 120_000;
const SCHEDULE = [
  { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
  { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
];
const C_01_EFFECTS = {
  purchasing: 1,
  inventory: 2,
  requests: 1,
  po_revision: 4,
  wh_b: "INV-B@1.ACT-2",
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function until<T>(what: string, check: () => Promise<T | null | false>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

/** The built API process on the controlled business clock, as the container runs it. */
class ApiProcess {
  private child: ChildProcess | null = null;
  readonly lines: string[] = [];

  constructor(
    private readonly db: DisposableDatabase,
    readonly port: number,
  ) {}

  get baseUrl() {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  async start(): Promise<void> {
    const child = spawn(process.execPath, ["apps/api/dist/main.js"], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        APP_ID: "supplier-disruption",
        APP_ORIGIN,
        NODE_ENV: "test",
        DATA_MODE: "fixture",
        DOMAIN_CLOCK_MODE: "controlled",
        LOG_LEVEL: "info",
        API_PORT: String(this.port),
        DATABASE_URL_API: this.db.url("api"),
        BETTER_AUTH_SECRET_FILE: `${SECRETS}/better_auth_secret`,
        WORKER_SERVICE_TOKEN_FILE: `${SECRETS}/worker_service_token`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => this.lines.push(...chunk.split("\n").filter(Boolean)));
    }
    await until("API readiness", async () => {
      if (child.exitCode !== null) throw new Error(`api exited:\n${this.lines.join("\n")}`);
      const response = await fetch(`${this.baseUrl}/internal/health/ready`).catch(() => null);
      return response?.status === 200;
    });
  }

  /** Ends the process at once with SIGKILL, as a crash would. */
  async kill(): Promise<void> {
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await done;
  }
}

/** One gate: a fresh database, the API and worker processes and lock barriers. */
function terminationGate(gate: string) {
  const db = new DisposableDatabase(gate);
  const context = {
    db,
    api: undefined as unknown as ApiProcess,
    worker: new TestWorker(),
    observer: undefined as unknown as pg.Client,
    buyer: "",
    manager: "",
  };
  beforeAll(async () => {
    await db.start();
    const migrated = await db.migrate();
    expect(migrated.code, migrated.stderr).toBe(0);
    const seeded = await db.seed();
    expect(seeded.code, seeded.stderr).toBe(0);
    context.observer = await db.client("migrator", `${gate}-observer`);
    context.api = new ApiProcess(db, await freePort());
    await context.api.start();
    await context.worker.start(db, context.api.baseUrl);
    context.buyer = (
      await signIn(context.api.baseUrl, {
        email: "buyer@fixture.local",
        password: secret("fixture_buyer_password"),
      })
    ).cookie;
    context.manager = (
      await signIn(context.api.baseUrl, {
        email: "manager@fixture.local",
        password: secret("fixture_manager_password"),
      })
    ).cookie;
  }, SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await context.worker.stop();
    await context.api?.kill();
    await db.remove();
    expect(await db.leftovers()).toBe("");
  }, COMPOSE_TIMEOUT_MS + MARGIN_MS);
  return context;
}

type Gate = ReturnType<typeof terminationGate>;

async function call(gate: Gate, cookie: string, path: string, body: unknown) {
  const response = await fetch(`${gate.api.baseUrl}${path}`, {
    method: "POST",
    headers: { cookie, origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** C-01 up to the planner's confirmation; the supplier acknowledgement then starts the job. */
async function awaitingAcknowledgement(gate: Gate) {
  const created = await call(gate, gate.buyer, "/api/cases/ingest", {
    organizationId: ORG_NDL,
    deliveryId: randomUUID(),
    ...MSG_0001,
  });
  expect(created.body).toMatchObject({ disposition: "accept", state: "awaiting_approval" });
  const caseId = created.body.caseId as string;
  const [plan] = await rows<{ sha256: string }>(
    gate.observer,
    "SELECT p.sha256 FROM app.case_plan p JOIN app.supplier_case c ON c.current_plan_id = p.id",
  );
  const planSha256 = plan?.sha256 ?? "";
  const approved = await call(gate, gate.manager, `/api/cases/${caseId}/decisions`, {
    actorId: "manager-1",
    decision: "approve",
    planSha256,
  });
  expect(approved.status).toBe(201);
  const confirmed = await call(gate, gate.manager, `/api/cases/${caseId}/acknowledgements`, {
    kind: "warehouse_planner_confirmation",
    actorId: "planner-1",
    planSha256,
    optionId: "TRO-1",
    quantity: "50",
    arrivalDate: "2026-10-23",
  });
  expect(confirmed.body).toMatchObject({ outcome: "accepted" });
  return caseId;
}

async function acknowledge(gate: Gate, caseId: string) {
  const acknowledged = await call(gate, gate.buyer, `/api/cases/${caseId}/acknowledgements`, {
    kind: "supplier_acknowledgement",
    actorId: "supplier-1",
    proposalId: "PROP-1",
    poNumber: "PO-120",
    poLine: "10",
    segments: SCHEDULE,
  });
  expect(acknowledged.body).toMatchObject({ outcome: "accepted", state: "applying" });
}

/** A row lock held by its own migrator connection until released. */
async function holdRow(gate: Gate, name: string, query: string, values: unknown[] = []) {
  const client = await gate.db.client("migrator", name);
  await client.query("BEGIN");
  const { rowCount } = await client.query(query, values);
  expect(rowCount).toBe(1);
  return {
    async release() {
      await client.query("ROLLBACK");
    },
  };
}

const holdPoHead = (gate: Gate) =>
  holdRow(
    gate,
    "barrier-po-head",
    "SELECT 1 FROM fixture_purchasing.po_head WHERE po_number = 'PO-120' FOR UPDATE",
  );

/** Backends of an application waiting for a lock, seen through pg_locks. */
async function lockWaiters(gate: Gate, application: string): Promise<number> {
  const [row] = await rows<{ n: number }>(
    gate.observer,
    `SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.application_name = $1`,
    [application],
  );
  return row?.n ?? 0;
}

async function actionState(gate: Gate, actionId: string) {
  const [row] = await rows<{
    state: string;
    attempts: number;
    attempt_key: string | null;
    request_digest: string | null;
  }>(
    gate.observer,
    "SELECT state, attempts, attempt_key, request_digest FROM app.case_action WHERE action_id = $1",
    [actionId],
  );
  return row;
}

/** ACT-1's claim committed and its purchasing write waits on the PO head lock. */
async function untilAct1WriteWaits(gate: Gate) {
  await until("ACT-1 claimed and its write waiting", async () => {
    const action = await actionState(gate, "ACT-1");
    return action?.state === "pending" && (await lockWaiters(gate, "sd-api")) > 0;
  });
}

/** The dead API's connections are gone, its case run lock with them. */
async function untilApiConnectionsGone(gate: Gate) {
  await until("the killed API's connections to end", async () => {
    const [row] = await rows<{ n: number }>(
      gate.observer,
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'sd-api%'",
    );
    return row?.n === 0;
  });
}

async function caseState(gate: Gate) {
  const [row] = await rows<{ state: string; reason: string | null }>(
    gate.observer,
    "SELECT state, reason FROM app.supplier_case",
  );
  return row;
}

async function caseJobs(gate: Gate) {
  return rows<{ state: string; retry_count: number }>(
    gate.observer,
    `SELECT state::text AS state, retry_count FROM pgboss.job
      WHERE name = 'case-application' ORDER BY created_on`,
  );
}

/** The case reaches `plan_verified` and its queue job completes. */
async function untilConverged(gate: Gate) {
  await until(
    "plan_verified with every case job completed",
    async () => {
      if ((await caseState(gate))?.state !== "plan_verified") return false;
      const jobs = await caseJobs(gate);
      return jobs.length > 0 && jobs.every((job) => job.state === "completed");
    },
    GATE_TIMEOUT_MS - 20_000,
  );
}

/** One amendment, one reservation, one transfer request; stable IDs and digests. */
async function expectSingleEffects(gate: Gate) {
  expect(await sourceEffects(gate.observer)).toEqual(C_01_EFFECTS);
  expect(
    await rows(gate.observer, `SELECT operation_id, state FROM app.case_action ORDER BY sequence`),
  ).toEqual([
    { operation_id: "PLAN-1.v1.ACT-1", state: "confirmed" },
    { operation_id: "PLAN-1.v1.ACT-2", state: "confirmed" },
    { operation_id: "PLAN-1.v1.ACT-3", state: "confirmed" },
  ]);
  expect(
    await rows(
      gate.observer,
      `SELECT count(*)::int AS n FROM fixture_inventory.reservation WHERE plan_id = 'PLAN-1'`,
    ),
  ).toEqual([{ n: 1 }]);
}

describe("K1: the API is killed after ACT-1's claim, before its source write commits", () => {
  const gate = terminationGate("k1");

  it(
    "leaves no effect, then resubmits the same command once under a new attempt key",
    async () => {
      const caseId = await awaitingAcknowledgement(gate);
      const poHead = await holdPoHead(gate);
      await acknowledge(gate, caseId);
      await untilAct1WriteWaits(gate);
      const claimed = await actionState(gate, "ACT-1");
      expect(claimed).toMatchObject({ attempts: 1, attempt_key: "PLAN-1.v1.ACT-1#1" });

      await gate.api.kill();
      await poHead.release();
      await untilApiConnectionsGone(gate);
      // The write never committed: no operation, the PO still at revision 3.
      expect(await sourceEffects(gate.observer)).toMatchObject({ purchasing: 0, po_revision: 3 });
      expect((await actionState(gate, "ACT-1"))?.state).toBe("pending");

      await gate.api.start();
      await untilConverged(gate);
      await expectSingleEffects(gate);
      // Absence was read back first; the same command went out again, once.
      expect(await actionState(gate, "ACT-1")).toEqual({
        state: "confirmed",
        attempts: 2,
        attempt_key: "PLAN-1.v1.ACT-1#2",
        request_digest: claimed?.request_digest,
      });
    },
    GATE_TIMEOUT_MS,
  );
});

describe("K2: the API is killed after ACT-1's effect committed, before its journal update", () => {
  const gate = terminationGate("k2");

  it(
    "reconciles the committed amendment by operation ID without a second write",
    async () => {
      const caseId = await awaitingAcknowledgement(gate);
      const poHead = await holdPoHead(gate);
      await acknowledge(gate, caseId);
      await untilAct1WriteWaits(gate);
      // The claim committed; now hold the case row so the journal cannot record the result.
      const caseRow = await holdRow(
        gate,
        "barrier-case",
        "SELECT 1 FROM app.supplier_case WHERE id = $1 FOR UPDATE",
        [caseId],
      );
      await poHead.release();
      await until("the amendment committed and its journal update waiting", async () => {
        const effects = await sourceEffects(gate.observer);
        return effects?.purchasing === 1 && (await lockWaiters(gate, "sd-api")) > 0;
      });

      await gate.api.kill();
      await caseRow.release();
      await untilApiConnectionsGone(gate);
      expect(await sourceEffects(gate.observer)).toMatchObject({ purchasing: 1, po_revision: 4 });
      expect((await actionState(gate, "ACT-1"))?.state).toBe("pending");

      await gate.api.start();
      await untilConverged(gate);
      await expectSingleEffects(gate);
      expect(await actionState(gate, "ACT-1")).toMatchObject({ state: "confirmed", attempts: 1 });
      expect(
        await rows(
          gate.observer,
          "SELECT detail->>'actionId' AS action FROM app.case_event WHERE kind = 'action_reconciled'",
        ),
      ).toEqual([{ action: "ACT-1" }]);
    },
    GATE_TIMEOUT_MS,
  );
});

describe("K3: the worker is killed while the API applies, before it gets the response", () => {
  const gate = terminationGate("k3");

  it(
    "lets the API finish once and retries the orphaned job as a no-op",
    async () => {
      const caseId = await awaitingAcknowledgement(gate);
      const poHead = await holdPoHead(gate);
      await acknowledge(gate, caseId);
      await untilAct1WriteWaits(gate);

      await gate.worker.kill();
      await poHead.release();
      // The API's run does not depend on the worker's connection.
      await until("plan_verified", async () => (await caseState(gate))?.state === "plan_verified");
      expect(await caseJobs(gate)).toEqual([{ state: "active", retry_count: 0 }]);

      await gate.worker.start(gate.db, gate.api.baseUrl);
      await untilConverged(gate);
      await expectSingleEffects(gate);
      // The heartbeat expired the orphaned attempt; its retry found nothing to do.
      expect(await caseJobs(gate)).toEqual([{ state: "completed", retry_count: 1 }]);
    },
    GATE_TIMEOUT_MS,
  );
});

describe("K4: the worker is killed after the response, before the queue acknowledges the job", () => {
  const gate = terminationGate("k4");

  it(
    "retries the unacknowledged job without a second effect",
    async () => {
      const caseId = await awaitingAcknowledgement(gate);
      const poHead = await holdPoHead(gate);
      await acknowledge(gate, caseId);
      await untilAct1WriteWaits(gate);
      // The worker holds the job; lock its row so pg-boss cannot complete it.
      const job = await holdRow(
        gate,
        "barrier-job",
        `SELECT 1 FROM pgboss.job WHERE name = 'case-application' AND state = 'active' FOR UPDATE`,
      );
      const seen = gate.worker.lines.length;
      await poHead.release();
      await until("the worker to receive the finished run", () =>
        Promise.resolve(
          gate.worker.lines
            .slice(seen)
            .some(
              (line) =>
                line.includes('"message":"case application run"') &&
                line.includes('"state":"plan_verified"'),
            ),
        ),
      );

      await gate.worker.kill();
      // The completion the dead worker queued behind the lock never runs.
      expect(await gate.db.terminateSessions("sd-worker-pgboss")).toBeGreaterThan(0);
      await job.release();
      expect((await caseState(gate))?.state).toBe("plan_verified");
      expect(await caseJobs(gate)).toEqual([{ state: "active", retry_count: 0 }]);

      await gate.worker.start(gate.db, gate.api.baseUrl);
      await untilConverged(gate);
      await expectSingleEffects(gate);
      expect(await caseJobs(gate)).toEqual([{ state: "completed", retry_count: 1 }]);
    },
    GATE_TIMEOUT_MS,
  );
});
