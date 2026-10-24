// C4 essential death, C5 unexpected clean exit, C6 hang and C7 database
// outage, each followed by recovery through Compose's restart policy.
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DieWatcher, GATE_BOUNDS, Project, fields, must, waitFor, record } from "./support.mjs";

const HANG_MS = 30_000;
const EXIT_HANG = 70;

const project = new Project("failures");
let operationId;

beforeAll(async () => {
  await project.start();
  const submitted = await project.submitOperation({ note: "survives failures" });
  expect(submitted.status).toBe(202);
  operationId = submitted.operationId;
  await waitFor(
    "the receipt",
    async () => (await project.operation(operationId))?.receipt_id ?? undefined,
    {
      timeoutMs: 30_000,
    },
  );
});

afterAll(async () => {
  await project.remove();
});

/** Seeded users and the earlier operation's receipt, read independently. */
async function dataIntact() {
  const [row] = await project.sql(
    `SELECT (SELECT count(*) FROM auth."user")::int AS users,
            (SELECT receipt_id FROM app.pilot_operation WHERE operation_id = '${operationId}') AS receipt`,
  );
  expect(row.users).toBe(2);
  expect(row.receipt).not.toBeNull();
}

/**
 * Applies a fault to a healthy container and returns the evidence: the exit
 * code Docker recorded, the time to exit and to healthy again, and the
 * single first-failure record of the failed boot.
 */
async function failAndRecover(label, fault, exitBoundMs) {
  await project.waitReady(GATE_BOUNDS.recoveryMs);
  const boot = await project.bootId();
  const before = await project.inspect();
  const watcher = new DieWatcher(project.app);
  try {
    const faultAt = Date.now();
    await fault();
    const die = await watcher.next(0, exitBoundMs + 30_000);
    // Recovery is two bounded phases: Compose restarts the container, then the
    // restarted boot must become healthy within the same bound as a first
    // start, counted from its own start rather than from the exit.
    const restarted = await waitFor(
      "the restarted container",
      async () => {
        const info = await project.inspect();
        return info.RestartCount > before.RestartCount && info.State.Status === "running"
          ? info
          : undefined;
      },
      { timeoutMs: GATE_BOUNDS.restartMs, intervalMs: 100 },
    );
    const restartedAt = Date.parse(restarted.State.StartedAt);
    await project.waitHealthy(Math.max(0, restartedAt + GATE_BOUNDS.healthyMs - Date.now()));
    const healthyAt = Date.now();
    const after = await project.inspect();
    expect(after.RestartCount).toBe(before.RestartCount + 1);
    expect(after.State.StartedAt).toBe(restarted.State.StartedAt);
    expect(await project.bootId()).not.toBe(boot);

    const segment = (await project.boots()).find((b) => b.bootId === boot);
    const failures = segment.lines.filter((line) => line.text.startsWith("sd-first-failure "));
    expect(failures).toHaveLength(1);
    const exitMs = die.at - faultAt;
    record(
      `${label}: exit ${die.exitCode} after ${exitMs} ms (bound ${exitBoundMs}); restarted ${restartedAt - die.at} ms after exit; ` +
        `healthy ${healthyAt - restartedAt} ms after restart (bound ${GATE_BOUNDS.healthyMs}); ${failures[0].text}`,
    );
    expect(exitMs).toBeLessThan(exitBoundMs);
    await dataIntact();
    return {
      exitCode: die.exitCode,
      record: fields(failures[0].text),
      lifecycle: segment.lines.map((l) => l.text),
    };
  } finally {
    watcher.stop();
  }
}

const signal = (name, service) => () =>
  must("docker", [
    "exec",
    project.app,
    "sh",
    "-c",
    `kill -${name} $(s6-svstat -o pid /run/service/${service})`,
  ]);

describe("C4 essential death", () => {
  for (const service of ["api", "worker", "web"]) {
    it(`exits nonzero on SIGKILL to ${service}, records it first and recovers`, async () => {
      const result = await failAndRecover(
        `C4 SIGKILL ${service}`,
        signal("KILL", service),
        GATE_BOUNDS.deathExitMs,
      );
      expect(result.exitCode).toBe(137);
      expect(result.record).toMatchObject({ reason: "exit", service, exit: "256", signal: "9" });
      expect(result.lifecycle).toContain(
        `sd-lifecycle service=${service} exit=256 signal=9 wanted=up`,
      );
    });
  }
});

describe("C5 unexpected clean exit", () => {
  it("treats the worker draining and exiting 0 while wanted up as a failure", async () => {
    const result = await failAndRecover(
      "C5 SIGTERM worker",
      signal("TERM", "worker"),
      GATE_BOUNDS.deathExitMs,
    );
    expect(result.exitCode).toBe(1);
    expect(result.record).toMatchObject({
      reason: "exit",
      service: "worker",
      exit: "0",
      signal: "none",
    });
    expect(result.lifecycle).toContain("sd-lifecycle service=worker exit=0 signal=none wanted=up");
  });
});

describe("C6 hang", () => {
  for (const service of ["api", "web", "worker"]) {
    it(`halts on SIGSTOP to ${service} with hang:${service} and recovers`, async () => {
      const result = await failAndRecover(
        `C6 SIGSTOP ${service}`,
        signal("STOP", service),
        GATE_BOUNDS.hangExitMs,
      );
      expect(result.exitCode).toBe(EXIT_HANG);
      expect(result.record.reason).toBe(`hang:${service}`);
    });
  }
});

describe("C7 database outage", () => {
  it("returns to healthy in place after an outage shorter than the hang bound", async () => {
    await project.waitReady(GATE_BOUNDS.recoveryMs);
    const before = await project.inspect();
    const watcher = new DieWatcher(project.app);
    try {
      const stoppedAt = Date.now();
      await project.mustCompose(["stop", "db"]);
      await waitFor(
        "unhealthy during the outage",
        async () => (await project.health()).health === "unhealthy",
        {
          timeoutMs: 20_000,
          intervalMs: 250,
        },
      );
      const unhealthyAt = Date.now();
      // Total outage of about 15 s, well inside the 30 s hang bound.
      await delay(Math.max(0, 15_000 - (Date.now() - stoppedAt)));
      await project.mustCompose(["start", "db"]);
      const restoredAt = Date.now();
      expect(restoredAt - stoppedAt).toBeLessThan(HANG_MS - 5_000);
      await project.waitHealthy(60_000);
      const after = await project.inspect();
      record(
        `C7 short outage: down ${restoredAt - stoppedAt} ms, unhealthy after ${unhealthyAt - stoppedAt} ms, healthy ${Date.now() - restoredAt} ms after db start`,
      );
      expect(after.State.StartedAt).toBe(before.State.StartedAt);
      expect(after.RestartCount).toBe(before.RestartCount);
      expect(watcher.events).toEqual([]);
      await dataIntact();
    } finally {
      watcher.stop();
    }
  });

  it("exits nonzero after a longer outage, retries and recovers once the database returns", async () => {
    await project.waitReady(GATE_BOUNDS.recoveryMs);
    const before = await project.inspect();
    const boot = await project.bootId();
    const watcher = new DieWatcher(project.app);
    try {
      const stoppedAt = Date.now();
      await project.mustCompose(["stop", "db"]);
      const die = await watcher.next(0, HANG_MS + 30_000);
      // Compose retries while the database is still away.
      await waitFor(
        "a restarted container",
        async () => {
          const info = await project.inspect();
          return info.RestartCount > before.RestartCount && info.State.Status === "running";
        },
        { timeoutMs: 30_000 },
      );
      expect((await project.health()).health).not.toBe("healthy");
      await project.mustCompose(["start", "db"]);
      const restoredAt = Date.now();
      await project.waitHealthy(GATE_BOUNDS.recoveryMs);
      const segment = (await project.boots()).find((b) => b.bootId === boot);
      const failures = segment.lines.filter((line) => line.text.startsWith("sd-first-failure "));
      record(
        `C7 long outage: exit ${die.exitCode} after ${die.at - stoppedAt} ms, db down ${restoredAt - stoppedAt} ms, healthy ${Date.now() - restoredAt} ms after db start; ${failures[0]?.text}`,
      );
      expect(die.exitCode).not.toBe(0);
      expect(failures).toHaveLength(1);
      expect(fields(failures[0].text).reason).toBe("hang:api");
      await dataIntact();
    } finally {
      watcher.stop();
    }
  });
});
