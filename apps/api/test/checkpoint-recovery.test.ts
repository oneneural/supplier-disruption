// Checkpoint recovery gates (ADR 0019): the built API and worker
// processes on a disposable database, with the real Anthropic adapter pointed
// at a local fake Messages API (fake-anthropic.ts), the real PostgreSQL
// checkpoint saver and the project spend ledger. The fake holds one model
// turn unanswered, so the API is stopped with SIGKILL while that call is in
// flight and the graph is unfinished:
//
// - M1: the restarted API resumes the same run from its checkpoint, asks only
//   the lost turn again with the same conversation, keeps the tool and model
//   counts, step sequence and cost, admits only the cap left over and keeps
//   the stopped attempt's reservation uncertain. A duplicate delivery of the
//   job during recovery is refused with a retry, and the job's authority is
//   refused once it completed;
// - M2: a case escalated while its run waited is not resumed after a restart,
//   and a proposal formed while it waited is never handed to intake;
// - M3: a restart under another model refuses the checkpoint, keeps it and
//   pauses the case for the buyer without a model call or a new reservation;
// - M4: stock that changed while the API was down is read fresh: the resumed
//   proposal is assessed against it, not against what the run read before;
// - M5: an escalation that commits after the hand-off check, while intake
//   waits on its lock, still wins: intake refuses to assess the case. It runs
//   before M4, whose accepted C-01 input would make intake treat the same
//   terms as a possible duplicate instead.
//
// No live provider is called: the fake answers on loopback only.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelSpendLedger } from "@supplier-disruption/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_NDL, TestWorker, rows, sourceEffects } from "./case-support.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import { FakeAnthropic, TURN_COST_MICRO_USD } from "./fake-anthropic.js";
import { APP_ORIGIN, REPO_ROOT, SECRETS, secret, signIn } from "./support.js";

const SETUP_TIMEOUT_MS = START_TIMEOUT_MS + 3 * COMPOSE_TIMEOUT_MS;
// A restarted API waits for the worker's job retry, which backs off while it is down.
const GATE_TIMEOUT_MS = 120_000;
/** AGENT_RUN_COST_CAP_USD 0.05 in micro-USD. */
const RUN_CAP = 50_000;
/** The reconciled project total carried into each disposable database (ADR 0017). */
const OPENING = 30_763;

const C01 = JSON.parse(
  readFileSync(join(REPO_ROOT, "evaluation/scenarios/dev/D01.json"), "utf8"),
) as { email: { sender: string; subject: string; text: string } };

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

async function until<T>(what: string, check: () => Promise<T | null | false>, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
}

/** The built API process with the Anthropic provider, on the controlled business clock. */
class ApiProcess {
  private child: ChildProcess | null = null;
  readonly lines: string[] = [];

  constructor(
    private readonly db: DisposableDatabase,
    private readonly fake: FakeAnthropic,
    private readonly keyFile: string,
    readonly port: number,
  ) {}

  get baseUrl() {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  async start(model = "claude-haiku-5-5"): Promise<void> {
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
        AGENT_PROVIDER: "anthropic",
        AGENT_MODEL: model,
        AGENT_RUN_COST_CAP_USD: "0.05",
        ANTHROPIC_API_KEY_FILE: this.keyFile,
        // Read by the SDK itself: every request goes to the local fake.
        ANTHROPIC_BASE_URL: this.fake.baseUrl,
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

/** One gate: a fresh database with an opened ledger, the fake, the API and worker processes. */
function recoveryGate(gate: string) {
  const db = new DisposableDatabase(gate);
  const fake = new FakeAnthropic();
  const dir = mkdtempSync(join(tmpdir(), "sd-ckpt-"));
  const context = {
    db,
    fake,
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
    await new ModelSpendLedger(db.pool("migrator", `${gate}-spend`)).open(
      OPENING,
      "checkpoint recovery test opening",
    );
    await fake.start();
    const keyFile = join(dir, "anthropic_api_key");
    writeFileSync(keyFile, "placeholder, never a real key", { mode: 0o600 });
    context.api = new ApiProcess(db, fake, keyFile, await freePort());
    await context.api.start();
    await context.worker.start(db, context.api.baseUrl);
    for (const role of ["buyer", "manager"] as const) {
      context[role] = (
        await signIn(context.api.baseUrl, {
          email: `${role}@fixture.local`,
          password: secret(`fixture_${role}_password`),
        })
      ).cookie;
    }
  }, SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await context.worker.stop();
    await context.api?.kill();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
    await db.remove();
    expect(await db.leftovers()).toBe("");
  }, COMPOSE_TIMEOUT_MS + MARGIN_MS);
  return context;
}

type Gate = ReturnType<typeof recoveryGate>;

async function call(
  gate: Gate,
  cookie: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${gate.api.baseUrl}${path}`, {
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

/** Stores the C-01 email under `subject` and returns its case. */
async function ingestEmail(gate: Gate, subject: string): Promise<string> {
  const created = await call(gate, gate.buyer, "POST", "/api/cases/emails", {
    organizationId: ORG_NDL,
    deliveryId: randomUUID(),
    ...C01.email,
    subject,
  });
  expect(created.body).toMatchObject({ disposition: "evidence", state: "received" });
  return created.body.caseId as string;
}

/** A worker's call for the case job, as the worker would make it. */
async function internalApply(gate: Gate, caseId: string, jobId: string) {
  const response = await fetch(`${gate.api.baseUrl}/internal/cases/${caseId}/apply`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret("worker_service_token")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jobId, workerBootId: randomUUID() }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function runOf(gate: Gate, caseId: string) {
  const [run] = await rows<{
    id: string;
    status: string;
    model: string;
    tool_calls: number;
    model_calls: number;
    cost_micro_usd: number;
    pause_reason: string | null;
    pause_detail: string | null;
  }>(
    gate.observer,
    `SELECT id, status, model, tool_calls, model_calls, cost_micro_usd, pause_reason, pause_detail
       FROM app.agent_run WHERE case_id = $1`,
    [caseId],
  );
  if (run === undefined) throw new Error("the email case has no run");
  return run;
}

const reservations = (gate: Gate, runId: string) =>
  rows<{ status: string; reserved: number; settled: number | null }>(
    gate.observer,
    `SELECT status, reserved_micro_usd::int AS reserved, settled_micro_usd::int AS settled
       FROM app.model_spend_reservation WHERE reference = $1 ORDER BY reserved_at, key`,
    [runId],
  );

async function checkpoints(gate: Gate, runId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(
    gate.observer,
    "SELECT count(*)::int AS n FROM agent_checkpoint.checkpoints WHERE thread_id = $1",
    [runId],
  );
  return row?.n ?? 0;
}

async function caseRow(gate: Gate, caseId: string) {
  const [row] = await rows<{
    state: string;
    reason: string | null;
    owner: string | null;
    message_id: string;
    current_plan_id: string | null;
  }>(
    gate.observer,
    "SELECT state, reason, owner, message_id, current_plan_id FROM app.supplier_case WHERE id = $1",
    [caseId],
  );
  if (row === undefined) throw new Error("no such case");
  return row;
}

const waitForState = (gate: Gate, caseId: string, state: string) =>
  until(`case ${state}`, async () => {
    const row = await caseRow(gate, caseId);
    return row.state === state ? row : null;
  });

async function caseJob(gate: Gate, caseId: string) {
  const [job] = await rows<{ id: string; state: string }>(
    gate.observer,
    `SELECT id, state FROM pgboss.job
      WHERE name = 'case-application' AND data->>'caseId' = $1
      ORDER BY created_on DESC LIMIT 1`,
    [caseId],
  );
  return job ?? null;
}

async function derivedInputs(gate: Gate, messageId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(
    gate.observer,
    "SELECT count(*)::int AS n FROM fixture_reference.supplier_input WHERE message_id = $1",
    [messageId],
  );
  return row?.n ?? 0;
}

async function escalate(gate: Gate, caseId: string) {
  const escalated = await call(gate, gate.manager, "POST", `/api/cases/${caseId}/escalations`, {
    actorId: "manager-1",
    note: "Handled by phone while the extraction waited",
  });
  expect(escalated.status, JSON.stringify(escalated.body)).toBeLessThan(300);
}

describe("checkpoint recovery after SIGKILL", () => {
  const gate = recoveryGate("ckpt");

  it(
    "M1 resumes the unfinished checkpoint with its counts, cost and step sequence",
    async () => {
      const subject = C01.email.subject;
      gate.fake.hold(3);
      const caseId = await ingestEmail(gate, subject);
      const lost = await gate.fake.heldTurn(3);
      const run = await runOf(gate, caseId);
      expect(run.status).toBe("running");
      expect(await reservations(gate, run.id)).toEqual([
        { status: "reserved", reserved: RUN_CAP, settled: null },
      ]);
      const job = await caseJob(gate, caseId);
      expect(job?.state).toBe("active");
      const before = await checkpoints(gate, run.id);
      expect(before).toBeGreaterThan(0);

      await gate.api.kill();
      // Nothing settled the stopped attempt: its reservation is still counted.
      expect(await reservations(gate, run.id)).toEqual([
        { status: "reserved", reserved: RUN_CAP, settled: null },
      ]);
      expect((await runOf(gate, caseId)).status).toBe("running");

      gate.fake.hold(3);
      await gate.api.start();
      const again = await gate.fake.heldTurn(3);
      // Only the lost turn is asked again, with the same conversation and tool IDs.
      expect(again.body.messages).toEqual(lost.body.messages);
      expect([1, 2, 3].map((turn) => gate.fake.turns(turn).length)).toEqual([1, 1, 2]);
      // The resumed attempt reserved only what the cap had left after two turns.
      expect(await reservations(gate, run.id)).toEqual([
        { status: "uncertain", reserved: RUN_CAP, settled: null },
        { status: "reserved", reserved: RUN_CAP - 2 * TURN_COST_MICRO_USD, settled: null },
      ]);

      // A duplicate delivery of the job while the resumed run holds the extraction.
      const active = await caseJob(gate, caseId);
      expect(active?.state).toBe("active");
      expect(await internalApply(gate, caseId, active?.id ?? "")).toEqual({
        status: 200,
        body: { state: "received", retry: true },
      });
      expect(gate.fake.requests).toHaveLength(4);

      gate.fake.release();
      await waitForState(gate, caseId, "awaiting_approval");
      const detail = (await call(gate, gate.buyer, "GET", `/api/cases/${caseId}`)).body;
      expect((detail.impact as { totals: unknown }).totals).toMatchObject({
        preTransferCoverage: { state: "known", value: "70" },
        preTransferShortage: { state: "known", value: "50" },
        conditionalTransfer: { state: "known", value: "50" },
      });
      expect(
        (detail.plan as { payload: { authorization: { cost: unknown } } }).payload.authorization
          .cost,
      ).toEqual({ minorUnits: 16_000, currency: "EUR" });
      const agentRun = detail.agentRun as {
        status: string;
        toolCalls: number;
        modelCalls: number;
        costMicroUsd: number;
        steps: { sequence: number; kind: string; tool: string | null }[];
      };
      expect(agentRun).toMatchObject({
        status: "proposed",
        toolCalls: 3,
        modelCalls: 3,
        costMicroUsd: 3 * TURN_COST_MICRO_USD,
      });
      expect(agentRun.steps.map((step) => [step.sequence, step.tool ?? step.kind])).toEqual([
        [1, "model"],
        [2, "read_case_evidence"],
        [3, "model"],
        [4, "read_purchase_order"],
        [5, "model"],
        [6, "propose_supplier_terms"],
      ]);
      expect(await checkpoints(gate, run.id)).toBeGreaterThan(before);
      expect(await reservations(gate, run.id)).toEqual([
        { status: "uncertain", reserved: RUN_CAP, settled: null },
        {
          status: "settled",
          reserved: RUN_CAP - 2 * TURN_COST_MICRO_USD,
          settled: TURN_COST_MICRO_USD,
        },
      ]);
      const ledger = await new ModelSpendLedger(gate.db.pool("migrator", "ckpt-status")).status();
      expect(ledger.uncertainMicroUsd).toBe(RUN_CAP);
      expect(ledger.committedMicroUsd).toBe(OPENING + RUN_CAP + TURN_COST_MICRO_USD);
      expect(await sourceEffects(gate.observer)).toMatchObject({ purchasing: 0, inventory: 0 });

      // The job's authority ends with it: a late call with its ID is refused.
      await until("case job completed", async () =>
        (await caseJob(gate, caseId))?.state === "completed" ? true : null,
      );
      expect(await internalApply(gate, caseId, job?.id ?? "")).toEqual({
        status: 409,
        body: { error: "job_not_matched" },
      });
      expect(gate.fake.requests).toHaveLength(4);
      expect((await caseRow(gate, caseId)).state).toBe("awaiting_approval");
    },
    GATE_TIMEOUT_MS,
  );

  it(
    "M2 never resumes or hands off a run whose case was escalated while it waited",
    async () => {
      // Escalated while the second turn is in flight, then the API is killed.
      const stopped = "PO-120 line 10: escalated, then the API stopped";
      gate.fake.hold(2);
      const stoppedCase = await ingestEmail(gate, stopped);
      await gate.fake.heldTurn(2);
      await escalate(gate, stoppedCase);
      const stoppedRun = await runOf(gate, stoppedCase);
      const kept = await checkpoints(gate, stoppedRun.id);
      await gate.api.kill();
      await gate.api.start();
      const closed = await until("the interrupted run closed", async () => {
        const run = await runOf(gate, stoppedCase);
        return run.status === "paused" ? run : null;
      });
      expect(closed.pause_reason).toBeNull();
      expect(closed.pause_detail).toContain("escalated before this interrupted run resumed");
      expect(await reservations(gate, stoppedRun.id)).toEqual([
        { status: "uncertain", reserved: RUN_CAP, settled: null },
      ]);
      expect(gate.fake.turns(2, stopped)).toHaveLength(1);
      expect(gate.fake.turns(3, stopped)).toHaveLength(0);
      expect(await checkpoints(gate, stoppedRun.id)).toBe(kept);
      expect(await caseRow(gate, stoppedCase)).toMatchObject({
        state: "escalated",
        reason: "manual_escalation",
        current_plan_id: null,
      });

      // Escalated while the third turn is in flight; the proposal then arrives.
      const waited = "PO-120 line 10: escalated before the proposal";
      gate.fake.hold(3);
      const waitedCase = await ingestEmail(gate, waited);
      await gate.fake.heldTurn(3);
      await escalate(gate, waitedCase);
      gate.fake.release();
      await until("the proposal recorded", async () =>
        (await runOf(gate, waitedCase)).status === "proposed" ? true : null,
      );
      const [event] = await until("the hand-off refused", async () => {
        const found = await rows<{ detail: { state: string } }>(
          gate.observer,
          "SELECT detail FROM app.case_event WHERE case_id = $1 AND kind = 'extraction_not_handed_off'",
          [waitedCase],
        );
        return found.length > 0 ? found : null;
      });
      expect(event?.detail.state).toBe("escalated");
      const waitedRow = await caseRow(gate, waitedCase);
      expect(waitedRow).toMatchObject({ state: "escalated", current_plan_id: null });
      expect(await derivedInputs(gate, waitedRow.message_id)).toBe(0);
    },
    GATE_TIMEOUT_MS,
  );

  it(
    "M3 refuses a checkpoint under another model, keeps it and pauses for the buyer",
    async () => {
      const subject = "PO-120 line 10: model changed during recovery";
      gate.fake.hold(2);
      const caseId = await ingestEmail(gate, subject);
      await gate.fake.heldTurn(2);
      const run = await runOf(gate, caseId);
      const kept = await checkpoints(gate, run.id);
      await gate.api.kill();
      await gate.api.start("claude-sonnet-5-5");

      const paused = await waitForState(gate, caseId, "needs_clarification");
      expect(paused).toMatchObject({ reason: "agent_checkpoint_incompatible", owner: "buyer" });
      const refused = await runOf(gate, caseId);
      expect(refused).toMatchObject({
        status: "paused",
        pause_reason: "agent_checkpoint_incompatible",
        model: "claude-haiku-5-5",
      });
      expect(refused.pause_detail).toContain("model claude-haiku-5-5 is not claude-sonnet-5-5");
      expect(refused.pause_detail).toContain("no model was called");
      // No call and no new reservation; the stopped attempt stays counted.
      expect(gate.fake.turns(2, subject)).toHaveLength(1);
      expect(gate.fake.turns(3, subject)).toHaveLength(0);
      expect(await reservations(gate, run.id)).toEqual([
        { status: "uncertain", reserved: RUN_CAP, settled: null },
      ]);
      expect(await checkpoints(gate, run.id)).toBe(kept);
    },
    GATE_TIMEOUT_MS,
  );
});

describe("fresh domain evidence after recovery", () => {
  const gate = recoveryGate("ckptfresh");

  it(
    "M5 refuses intake when an escalation commits after the hand-off check",
    async () => {
      const subject = "PO-120 line 10: escalated during intake";
      gate.fake.hold(3);
      const caseId = await ingestEmail(gate, subject);
      await gate.fake.heldTurn(3);
      // Intake serializes on this organization lock; holding it stops the
      // hand-off after its case check, inside the ingest it then calls.
      const barrier = await gate.db.client("migrator", "ckpt-barrier-ingest");
      await barrier.query("BEGIN");
      await barrier.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`case-ingest:${ORG_NDL}`]);
      gate.fake.release();
      await until("intake waiting on its lock", async () => {
        const [row] = await rows<{ n: number }>(
          gate.observer,
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE NOT l.granted AND l.locktype = 'advisory' AND a.application_name = 'sd-api'`,
        );
        return (row?.n ?? 0) > 0 ? true : null;
      });
      expect((await runOf(gate, caseId)).status).toBe("proposed");
      await escalate(gate, caseId);
      await barrier.query("ROLLBACK");

      const [event] = await until("the hand-off refused", async () => {
        const found = await rows<{ detail: { state: string } }>(
          gate.observer,
          "SELECT detail FROM app.case_event WHERE case_id = $1 AND kind = 'extraction_not_handed_off'",
          [caseId],
        );
        return found.length > 0 ? found : null;
      });
      expect(event?.detail.state).toBe("escalated");
      expect(await caseRow(gate, caseId)).toMatchObject({
        state: "escalated",
        reason: "manual_escalation",
        current_plan_id: null,
      });
      // The ingest rolled back whole: no accepted delivery, assessment or assessing step.
      expect(
        await rows(
          gate.observer,
          `SELECT disposition FROM app.supplier_message WHERE case_id = $1 ORDER BY disposition`,
          [caseId],
        ),
      ).toEqual([{ disposition: "evidence" }]);
      expect(
        await rows(
          gate.observer,
          `SELECT
             (SELECT count(*)::int FROM app.case_assessment WHERE case_id = $1) AS assessments,
             (SELECT count(*)::int FROM app.case_event WHERE case_id = $1 AND to_state = 'assessing') AS assessing`,
          [caseId],
        ),
      ).toEqual([{ assessments: 0, assessing: 0 }]);
      expect(await sourceEffects(gate.observer)).toMatchObject({ purchasing: 0, inventory: 0 });
    },
    GATE_TIMEOUT_MS,
  );
  it(
    "M4 assesses the resumed proposal against stock that changed while the API was down",
    async () => {
      gate.fake.hold(3);
      const caseId = await ingestEmail(gate, C01.email.subject);
      await gate.fake.heldTurn(3);
      await gate.api.kill();
      // Another actor's reservation moves WH-B to INV-B@2 (eligible 30) during the outage.
      await gate.observer.query(`
        INSERT INTO fixture_inventory.stock_snapshot
          (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
        SELECT 'INV-B@2', organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock
          FROM fixture_inventory.stock_snapshot WHERE version = 'INV-B@1';
        INSERT INTO fixture_inventory.reservation (snapshot_version, reservation_id, quantity, plan_id)
        VALUES ('INV-B@2', 'RES-B-31', 20, NULL), ('INV-B@2', 'RES-B-40', 20, NULL);
        UPDATE fixture_inventory.stock_head SET version = 'INV-B@2' WHERE warehouse = 'WH-B';`);
      await gate.api.start();

      const escalated = await waitForState(gate, caseId, "escalated");
      expect(escalated).toMatchObject({
        reason: "unresolved_shortage",
        owner: "buyer",
        current_plan_id: null,
      });
      expect((await runOf(gate, caseId)).status).toBe("proposed");
      expect(gate.fake.turns(3, C01.email.subject)).toHaveLength(2);
      expect(await sourceEffects(gate.observer)).toEqual({
        purchasing: 0,
        inventory: 0,
        requests: 0,
        po_revision: 3,
        wh_b: "INV-B@2",
      });
    },
    GATE_TIMEOUT_MS,
  );
});
