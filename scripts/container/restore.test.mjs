// B1 and B2 (ADR 0021): a populated database restored into a
// different, fresh volume settles its pending work without duplicate effects,
// and the restored state survives recreating the app container.
//
// The source project drives C-01 to the state K5 kills in: ACT-1's amendment
// has committed at purchasing while its journal entry is still pending. Row
// locks held by superuser psql sessions are the barriers. The app container is
// then killed, so the database holds an unfinished action and an active case
// job. scripts/backup-restore.mjs backs that database up from one exported
// snapshot and restores it into a second project's fresh volume, where its
// own manifest check must pass before the test compares message bytes, hashes
// and references independently. The restored app must reconcile ACT-1 by
// operation ID and finish C-01 with one amendment, one reservation and one
// transfer request; a forced recreation of its container must keep all of it.
//
// Both projects run on the controlled business clock with NODE_ENV=test, like
// W1 and K5, because the C-01 fixture is time-bound.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_BUYER_EMAIL, passwords } from "./gates.mjs";
import {
  FIXTURE_MANAGER_EMAIL,
  FIXTURE_ORGANIZATION_ID,
  GATE_BOUNDS,
  Project,
  context,
  freePort,
  must,
  record,
  run,
  waitFor,
} from "./support.mjs";

const clock = { NODE_ENV: "test", DOMAIN_CLOCK_MODE: "controlled" };
const source = new Project("restore-src", { appEnvironment: clock });
const target = new Project("restore-dst", { appEnvironment: clock });
const SCHEDULE = [
  { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
  { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
];
const barriers = [];
let backupDir;
let caseId;

beforeAll(async () => {
  await source.start();
});

afterAll(async () => {
  for (const barrier of barriers) barrier.close();
  await source.remove();
  await target.remove();
  // The run's work directory keeps evidence; a dump of password hashes does not stay.
  if (backupDir !== undefined) await rm(backupDir, { recursive: true, force: true });
});

/** A superuser psql session in a project's db container that holds one row lock until released. */
async function holdRow(project, query) {
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

/** Signs a fixture identity in through a project's app origin and returns a JSON caller. */
async function session(project, email, password) {
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
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

async function sqlOne(project, query) {
  const [row] = await project.sql(query);
  return row;
}

const lockWaiters = (project) =>
  sqlOne(
    project,
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = 'sd-api' AND wait_event_type = 'Lock'`,
  );
const effects = (project) =>
  sqlOne(
    project,
    `SELECT (SELECT count(*) FROM fixture_purchasing.operation)::int AS purchasing,
            (SELECT count(*) FROM fixture_inventory.operation)::int AS inventory,
            (SELECT count(*) FROM fixture_inventory.transfer_request)::int AS requests,
            (SELECT count(*) FROM fixture_inventory.reservation WHERE plan_id = 'PLAN-1')::int AS plan_reservations,
            (SELECT revision FROM fixture_purchasing.po_head WHERE po_number = 'PO-120') AS po_revision`,
  );
/** Stored message bytes rehashed by PostgreSQL beside the hash recorded at intake. */
const evidence = (project) =>
  project.sql(
    `SELECT delivery_id, message_id, disposition, octet_length(content) AS bytes,
            encode(sha256(content), 'hex') AS rehashed, content_sha256
       FROM app.supplier_message ORDER BY delivery_id`,
  );
/** The case, its current plan and message, joined through their foreign references. */
const references = (project) =>
  project.sql(
    `SELECT c.id AS case_id, c.case_number, p.plan_id, p.sha256 AS plan_sha256,
            m.delivery_id, m.content_sha256,
            (SELECT count(*) FROM app.case_action a WHERE a.plan_row_id = p.id)::int AS actions,
            (SELECT count(*) FROM app.case_decision d WHERE d.case_id = c.id)::int AS decisions,
            (SELECT count(*) FROM app.case_event e WHERE e.case_id = c.id)::int AS events
       FROM app.supplier_case c
       JOIN app.case_plan p ON p.id = c.current_plan_id
       JOIN app.supplier_message m ON m.case_id = c.id
      ORDER BY c.id, m.delivery_id`,
  );
const actions = (project) =>
  project.sql(
    "SELECT action_id, state, attempts, attempt_key, operation_id FROM app.case_action ORDER BY sequence",
  );

/** Runs the clone's backup-restore.mjs, the committed script under test. */
function backupScript(args) {
  return run("node", [join(context().sourceDir, "scripts", "backup-restore.mjs"), ...args]);
}

/** Container memory, CPU and processes, from one `docker stats` sample. */
async function stats(project) {
  const { stdout } = await must("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}} pids={{.PIDs}}",
    project.app,
    project.db,
  ]);
  return stdout.trim().split("\n").join("; ");
}

describe("B1 fresh-volume restore of a populated case with pending work", () => {
  let before;

  it("backs up a committed effect whose journal entry is still pending", async () => {
    const buyer = await session(source, FIXTURE_BUYER_EMAIL, passwords.buyer());
    const manager = await session(source, FIXTURE_MANAGER_EMAIL, passwords.manager());
    const created = await buyer("/api/cases/ingest", {
      organizationId: FIXTURE_ORGANIZATION_ID,
      deliveryId: randomUUID(),
      sourceSystem: "fixture-supplier-mail",
      messageId: "MSG-0001",
      inputVersion: 1,
    });
    expect(created.body).toMatchObject({ disposition: "accept", state: "awaiting_approval" });
    caseId = created.body.caseId;
    const { sha256: planSha256 } = await sqlOne(
      source,
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
      source,
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
        (await sqlOne(source, "SELECT state FROM app.case_action WHERE action_id = 'ACT-1'"))
          .state === "pending" && (await lockWaiters(source)).n > 0,
      { timeoutMs: 30_000, intervalMs: 100 },
    );
    const caseRow = await holdRow(
      source,
      `SELECT 1 FROM app.supplier_case WHERE id = '${caseId}' FOR UPDATE`,
    );
    poHead.release();
    await waitFor(
      "the amendment committed with its journal update waiting",
      async () => (await effects(source)).purchasing === 1 && (await lockWaiters(source)).n > 0,
      { timeoutMs: 30_000, intervalMs: 100 },
    );
    // Stop every writer: kill the app and end its sessions, as K5 does, then
    // drop the barrier. The database now holds exactly the unfinished state.
    await must("docker", ["kill", "--signal", "KILL", source.app]);
    await source.sql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE 'sd-%'`,
    );
    caseRow.release();

    before = {
      effects: await effects(source),
      actions: await actions(source),
      evidence: await evidence(source),
      references: await references(source),
      jobs: await source.sql(
        "SELECT state::text AS state FROM pgboss.job WHERE name = 'case-application'",
      ),
    };
    expect(before.effects).toMatchObject({ purchasing: 1, inventory: 0, po_revision: 4 });
    expect(before.actions.map((action) => action.action_id)).toEqual(["ACT-1", "ACT-2", "ACT-3"]);
    expect(before.actions[0]).toMatchObject({ state: "pending", attempts: 1 });
    expect(before.actions.slice(1).map((action) => action.attempts)).toEqual([0, 0]);
    expect(before.jobs).toEqual([{ state: "active" }]);
    expect(before.evidence.length).toBeGreaterThan(0);
    for (const row of before.evidence) expect(row.rehashed).toBe(row.content_sha256);

    backupDir = join(context().work, "backup-b1");
    const backedUp = await backupScript([
      "backup",
      "--project",
      source.name,
      "--output",
      backupDir,
    ]);
    expect(backedUp.code, backedUp.stderr).toBe(0);
    const dump = await stat(join(backupDir, "database.dump"));
    expect(dump.mode & 0o777).toBe(0o600);
    expect((await stat(backupDir)).mode & 0o777).toBe(0o700);
    record(`B1 backup: ${backedUp.stdout.trim().split("\n")[0]}`);
    // The source is unchanged by the backup.
    expect(await actions(source)).toEqual(before.actions);
  });

  it("restores into a different fresh volume with identical bytes, hashes and references", async () => {
    target.port = await freePort();
    await target.mustCompose(["up", "--detach", "--wait", "db"]);
    const volumes = await must("docker", [
      "volume",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${target.name}`,
      "--format",
      "{{.Name}}",
    ]);
    expect(volumes.stdout.trim()).toBe(`${target.name}_db-data`);

    const restored = await backupScript([
      "restore",
      "--input",
      backupDir,
      "--project",
      target.name,
    ]);
    expect(restored.code, restored.stderr).toBe(0);
    record(`B1 restore: ${restored.stdout.trim().split("\n")[0]}`);
    // The populated target, like any populated database, is never overwritten.
    const again = await backupScript(["restore", "--input", backupDir, "--project", target.name]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/refusing to restore: project .* already has \d+ table\(s\)/);

    expect(await evidence(target)).toEqual(before.evidence);
    expect(await references(target)).toEqual(before.references);
    expect(await actions(target)).toEqual(before.actions);
    expect(await effects(target)).toEqual(before.effects);
  });

  it("settles the restored pending action by operation ID, with one effect each", async () => {
    // Init on a restored database changes nothing it already holds, then the app starts.
    await target.mustCompose(["run", "--rm", "init"]);
    expect(await actions(target)).toEqual(before.actions);
    const startedAt = Date.now();
    await target.mustCompose(["up", "--detach", "--no-build", "app"]);
    await target.waitReady(GATE_BOUNDS.healthyMs);
    await waitFor(
      "plan_verified with the case job completed",
      async () => {
        const row = await sqlOne(target, "SELECT state FROM app.supplier_case");
        const jobs = await target.sql(
          "SELECT state::text AS state FROM pgboss.job WHERE name = 'case-application'",
        );
        return row.state === "plan_verified" && jobs.every((job) => job.state === "completed");
      },
      { timeoutMs: 180_000, intervalMs: 500 },
    );
    record(`B1 restored app reached plan_verified ${Date.now() - startedAt} ms after up`);
    expect(await effects(target)).toEqual({
      purchasing: 1,
      inventory: 2,
      requests: 1,
      plan_reservations: 1,
      po_revision: 4,
    });
    expect(
      (await actions(target)).map(({ action_id, state, attempts, attempt_key }) => ({
        action_id,
        state,
        attempts,
        attempt_key,
      })),
    ).toEqual([
      { action_id: "ACT-1", state: "confirmed", attempts: 1, attempt_key: "PLAN-1.v1.ACT-1#1" },
      { action_id: "ACT-2", state: "confirmed", attempts: 1, attempt_key: "PLAN-1.v1.ACT-2#1" },
      { action_id: "ACT-3", state: "confirmed", attempts: 1, attempt_key: "PLAN-1.v1.ACT-3#1" },
    ]);
    expect(
      await target.sql(
        "SELECT detail->>'actionId' AS action FROM app.case_event WHERE kind = 'action_reconciled'",
      ),
    ).toEqual([{ action: "ACT-1" }]);
    expect(await evidence(target)).toEqual(before.evidence);
  });
});

describe("B2 app container recreation on the restored volume", () => {
  it("keeps the verified case, its evidence and effects across a forced recreation", async () => {
    const snapshot = async () => ({
      case: await target.sql(
        "SELECT id, state, current_plan_id FROM app.supplier_case ORDER BY id",
      ),
      actions: await actions(target),
      effects: await effects(target),
      evidence: await evidence(target),
      references: await references(target),
    });
    const kept = await snapshot();
    expect(kept.case).toMatchObject([{ state: "plan_verified" }]);
    const oldContainer = (await target.inspect()).Id;
    const oldBoot = await target.bootId();

    await target.mustCompose(["up", "--detach", "--no-build", "--force-recreate", "app"]);
    await target.waitReady(GATE_BOUNDS.recoveryMs);
    expect((await target.inspect()).Id).not.toBe(oldContainer);
    expect(await target.bootId()).not.toBe(oldBoot);
    expect(await snapshot()).toEqual(kept);

    // The recreated app serves the restored case and its original bytes.
    const buyer = await session(target, FIXTURE_BUYER_EMAIL, passwords.buyer());
    const served = await buyer(`/api/cases/${caseId}`);
    expect(served.status).toBe(200);
    expect(served.body.case.state).toBe("plan_verified");
    expect(served.body.evidence.length).toBeGreaterThan(0);
    for (const message of served.body.evidence) {
      const stored = kept.evidence.find((row) => row.delivery_id === message.deliveryId);
      expect(createHash("sha256").update(message.content, "utf8").digest("hex")).toBe(
        stored.content_sha256,
      );
      expect(message.byteLength).toBe(stored.bytes);
    }

    const size = await sqlOne(
      target,
      "SELECT pg_database_size('supplier_disruption')::bigint AS bytes",
    );
    record(`B2 resources: ${await stats(target)}; database ${size.bytes} bytes`);
  });
});
