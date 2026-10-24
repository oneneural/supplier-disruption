// K5 (ADR 0016): the packaged app container is killed with SIGKILL
// while C-01's ACT-1 amendment has committed at purchasing but the API has
// not yet recorded it in the action journal. Row locks held by superuser psql
// sessions in the database container are the barriers: the PO head row stops
// the purchasing write, then the case row stops the journal update once the
// write is released. After `docker kill`, the dead container's database
// sessions are ended (the database would otherwise only notice the lost peer
// later), the barrier is released and the container is started again. The
// API's restart sweep and the worker's heartbeat retry must reconcile ACT-1
// by operation ID and finish C-01 with one amendment, one reservation and
// one transfer request.
//
// The project runs on the controlled business clock with NODE_ENV=test,
// like W1, because the C-01 fixture is time-bound.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_BUYER_EMAIL, passwords } from "./gates.mjs";
import {
  FIXTURE_MANAGER_EMAIL,
  FIXTURE_ORGANIZATION_ID,
  GATE_BOUNDS,
  Project,
  must,
  record,
  waitFor,
} from "./support.mjs";

const project = new Project("termination", {
  appEnvironment: { NODE_ENV: "test", DOMAIN_CLOCK_MODE: "controlled" },
});
const SCHEDULE = [
  { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
  { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
];
const barriers = [];

beforeAll(async () => {
  await project.start();
});

afterAll(async () => {
  for (const barrier of barriers) barrier.close();
  await project.remove();
});

/** A superuser psql session in the db container that holds one row lock until released. */
async function holdRow(query) {
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      project.db,
      "psql",
      "--username",
      "postgres",
      "--dbname",
      "supplier_disruption",
      "--no-psqlrc",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const barrier = {
    release() {
      child.stdin.end("ROLLBACK;\n");
    },
    close() {
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
  barriers.push(barrier);
  child.stdin.write(`BEGIN;\n${query};\nSELECT 'held';\n`);
  await waitFor("the barrier lock", async () => output.includes("held"), {
    timeoutMs: 15_000,
    intervalMs: 100,
  });
  return barrier;
}

/** Signs a fixture identity in through the app origin and returns a JSON caller. */
async function session(email, password) {
  const headers = { "content-type": "application/json", origin: project.origin };
  const signIn = await fetch(`${project.origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return async (path, body) => {
    const response = await fetch(`${project.origin}${path}`, {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

async function sqlOne(query) {
  const [row] = await project.sql(query);
  return row;
}

const lockWaiters = () =>
  sqlOne(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = 'sd-api' AND wait_event_type = 'Lock'`,
  );
const effects = () =>
  sqlOne(
    `SELECT (SELECT count(*) FROM fixture_purchasing.operation)::int AS purchasing,
            (SELECT count(*) FROM fixture_inventory.operation)::int AS inventory,
            (SELECT count(*) FROM fixture_inventory.transfer_request)::int AS requests,
            (SELECT count(*) FROM fixture_inventory.reservation WHERE plan_id = 'PLAN-1')::int AS plan_reservations,
            (SELECT revision FROM fixture_purchasing.po_head WHERE po_number = 'PO-120') AS po_revision`,
  );

describe("K5 container termination after a committed effect", () => {
  it("reconciles ACT-1 by operation ID after a SIGKILL of the app container, with one effect each", async () => {
    const buyer = await session(FIXTURE_BUYER_EMAIL, passwords.buyer());
    const manager = await session(FIXTURE_MANAGER_EMAIL, passwords.manager());
    const created = await buyer("/api/cases/ingest", {
      organizationId: FIXTURE_ORGANIZATION_ID,
      deliveryId: randomUUID(),
      sourceSystem: "fixture-supplier-mail",
      messageId: "MSG-0001",
      inputVersion: 1,
    });
    expect(created.body).toMatchObject({ disposition: "accept", state: "awaiting_approval" });
    const caseId = created.body.caseId;
    const { sha256: planSha256 } = await sqlOne(
      "SELECT p.sha256 FROM app.case_plan p JOIN app.supplier_case c ON c.current_plan_id = p.id",
    );
    const path = `/api/cases/${caseId}`;
    expect(
      (
        await manager(`${path}/decisions`, {
          actorId: "manager-1",
          decision: "approve",
          planSha256,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await manager(`${path}/acknowledgements`, {
          kind: "warehouse_planner_confirmation",
          actorId: "planner-1",
          planSha256,
          optionId: "TRO-1",
          quantity: "50",
          arrivalDate: "2026-10-23",
        })
      ).body,
    ).toMatchObject({ outcome: "accepted" });

    const poHead = await holdRow(
      "SELECT 1 FROM fixture_purchasing.po_head WHERE po_number = 'PO-120' FOR UPDATE",
    );
    const acknowledged = await buyer(`${path}/acknowledgements`, {
      kind: "supplier_acknowledgement",
      actorId: "supplier-1",
      proposalId: "PROP-1",
      poNumber: "PO-120",
      poLine: "10",
      segments: SCHEDULE,
    });
    expect(acknowledged.body).toMatchObject({ outcome: "accepted", state: "applying" });
    await waitFor(
      "ACT-1 claimed with its purchasing write waiting",
      async () =>
        (await sqlOne("SELECT state FROM app.case_action WHERE action_id = 'ACT-1'")).state ===
          "pending" && (await lockWaiters()).n > 0,
      { timeoutMs: 30_000, intervalMs: 100 },
    );
    const caseRow = await holdRow(
      `SELECT 1 FROM app.supplier_case WHERE id = '${caseId}' FOR UPDATE`,
    );
    poHead.release();
    await waitFor(
      "the amendment committed with its journal update waiting",
      async () => (await effects()).purchasing === 1 && (await lockWaiters()).n > 0,
      { timeoutMs: 30_000, intervalMs: 100 },
    );

    await must("docker", ["kill", "--signal", "KILL", project.app]);
    const ended = await sqlOne(
      `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
        WHERE application_name LIKE 'sd-%'`,
    );
    record(`K5 ended ${ended.n} sessions of the killed container`);
    caseRow.release();
    expect(await effects()).toMatchObject({ purchasing: 1, po_revision: 4 });
    expect(
      await sqlOne("SELECT state, attempts FROM app.case_action WHERE action_id = 'ACT-1'"),
    ).toEqual({
      state: "pending",
      attempts: 1,
    });

    await must("docker", ["start", project.app]);
    await project.waitReady(GATE_BOUNDS.recoveryMs);
    await waitFor(
      "plan_verified with the case job completed",
      async () => {
        const row = await sqlOne("SELECT state FROM app.supplier_case");
        const jobs = await project.sql(
          "SELECT state::text AS state FROM pgboss.job WHERE name = 'case-application'",
        );
        return row.state === "plan_verified" && jobs.every((job) => job.state === "completed");
      },
      { timeoutMs: 120_000, intervalMs: 500 },
    );

    expect(await effects()).toEqual({
      purchasing: 1,
      inventory: 2,
      requests: 1,
      plan_reservations: 1,
      po_revision: 4,
    });
    expect(
      await project.sql(
        "SELECT action_id, state, attempts, attempt_key FROM app.case_action ORDER BY sequence",
      ),
    ).toEqual([
      { action_id: "ACT-1", state: "confirmed", attempts: 1, attempt_key: "PLAN-1.v1.ACT-1#1" },
      { action_id: "ACT-2", state: "confirmed", attempts: 1, attempt_key: "PLAN-1.v1.ACT-2#1" },
      { action_id: "ACT-3", state: "confirmed", attempts: 1, attempt_key: "PLAN-1.v1.ACT-3#1" },
    ]);
    expect(
      await project.sql(
        "SELECT detail->>'actionId' AS action FROM app.case_event WHERE kind = 'action_reconciled'",
      ),
    ).toEqual([{ action: "ACT-1" }]);
  });
});
