// C3 readiness and boot identity: aggregate readiness follows this boot's
// worker heartbeat only, a worker brought down on purpose is not a hang, and
// an incompatible schema never becomes healthy and trips the startup bound.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DieWatcher, GATE_BOUNDS, Project, fields, must, waitFor, record } from "./support.mjs";

// Image bounds (ADR 0002): heartbeat freshness, hang bound, startup bound and
// the s6-rc start transition backstop.
const FRESHNESS_MS = 10_000;
const HANG_MS = 30_000;
const STARTUP_EXIT_MS = 120_000;

const project = new Project("readiness");

beforeAll(async () => {
  await project.start();
});

afterAll(async () => {
  await project.remove();
});

/** Docker timestamps carry nanoseconds; Date keeps milliseconds. */
const ms = (stamp) => Date.parse(stamp.replace(/(\.\d{3})\d*/, "$1"));

/**
 * Accumulates Docker's healthcheck results (it keeps only the last five) by
 * polling inspect, so a test sees every probe with its start time.
 */
class ProbeLog {
  constructor() {
    this.entries = new Map();
  }

  async poll() {
    const info = await project.inspect();
    for (const entry of info.State.Health?.Log ?? []) {
      // A probe reads the heartbeat some time after Docker stamps its Start;
      // only its End is certain to follow what it read.
      this.entries.set(entry.Start, {
        start: ms(entry.Start),
        end: ms(entry.End),
        passed: entry.ExitCode === 0,
        output: entry.Output.trim(),
      });
    }
    return info;
  }

  since(time) {
    return [...this.entries.values()]
      .filter((entry) => entry.start >= time)
      .sort((a, b) => a.start - b.start);
  }
}

async function heartbeat(bootId) {
  return project.sql(
    `SELECT boot_id,
            floor(extract(epoch FROM started_at) * 1000)::bigint AS started_ms,
            floor(extract(epoch FROM observed_at) * 1000)::bigint AS observed_ms,
            floor(extract(epoch FROM now() - observed_at) * 1000)::bigint AS age_ms
       FROM worker.heartbeat WHERE boot_id = '${bootId}'`,
  );
}

const dbNow = async () =>
  Number(
    (await project.sql("SELECT floor(extract(epoch FROM now()) * 1000)::bigint AS now"))[0].now,
  );

/** The worker logs this when its first heartbeat write fails and it tries again. */
const FIRST_HEARTBEAT_RETRY = /"message":"first heartbeat failed; retrying"/;

/**
 * Holds an EXCLUSIVE lock on worker.heartbeat from a separate superuser
 * session until `release()`, which resolves with the database clock (epoch
 * milliseconds) just before COMMIT. It blocks heartbeat writes but not the
 * API's reads. `end()` closes the session, rolling back if still held.
 */
function lockHeartbeats() {
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
      "--tuples-only",
      "--no-align",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  child.stdin.write("BEGIN;\nLOCK TABLE worker.heartbeat IN EXCLUSIVE MODE;\nSELECT 'locked';\n");
  let output = "";
  child.stdout.setEncoding("utf8");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const acquired = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("locked")) resolve();
    });
    exited.then(() => reject(new Error("lock session ended before the lock was held")));
  });
  return {
    acquired,
    async release() {
      child.stdin.end(
        "SELECT 'released ' || (extract(epoch FROM clock_timestamp()) * 1000)::bigint;\nCOMMIT;\n",
      );
      const code = await exited;
      const match = /released (\d+)/.exec(output);
      if (code !== 0 || match === null) throw new Error(`lock session exited ${code}`);
      return Number(match[1]);
    },
    end() {
      if (!child.stdin.writableEnded) child.stdin.end();
    },
  };
}

/** Container boots whose sd-boot line was logged at or after `since` (epoch ms). */
async function bootsSince(since) {
  return (await project.boots()).filter((boot) => boot.lines[0].time.getTime() >= since);
}

/**
 * Throws naming the restart when the container is no longer the run that
 * `started` (an inspect result) describes: a first failure halted it, Compose
 * restarted it, or a second boot began. A restarted container would otherwise
 * show up only as a missing row for the boot that died. Returns the current
 * boot's log segment, or undefined before its sd-boot line is logged.
 */
async function expectNoRestart(started, info) {
  const since = ms(started.State.StartedAt);
  const boots = await bootsSince(since);
  const failure = boots
    .flatMap((boot) => boot.lines)
    .find((line) => line.text.startsWith("sd-first-failure "));
  const restarted =
    info.RestartCount !== started.RestartCount ||
    info.State.StartedAt !== started.State.StartedAt ||
    info.State.Status !== "running" ||
    boots.length > 1 ||
    failure !== undefined;
  if (!restarted) return boots[0];
  const lifecycle = boots
    .flatMap((boot) => boot.lines)
    .filter((line) => /^(sd-(boot|lifecycle|first-failure)|worker:) /.test(line.text))
    .map((line) => line.text);
  throw new Error(
    `the container halted or restarted during the gate: RestartCount ${started.RestartCount} -> ${info.RestartCount}, ` +
      `started ${started.State.StartedAt} -> ${info.State.StartedAt}, status ${info.State.Status}, ` +
      `${boots.length} boot(s) since the start; lifecycle: ${lifecycle.join(" | ")}`,
  );
}

describe("C3 readiness and boot identity", () => {
  it("(a) never reports healthy on the previous boot's still-fresh heartbeat", async () => {
    const oldBoot = await project.bootId();
    const probes = new ProbeLog();
    await project.mustCompose(["stop", "app"]);
    // The stop takes several seconds, which would leave the previous row fresh
    // for only a moment after the start, possibly before the API answers.
    // Refreshing it, as that worker's last beat would have, lets probes run
    // with the API up for the whole freshness bound.
    await project.execSql(
      `UPDATE worker.heartbeat SET observed_at = now() WHERE boot_id = '${oldBoot}'`,
    );
    const [{ observed_ms: oldObservedMs }] = await heartbeat(oldBoot);
    const oldFreshUntil = Number(oldObservedMs) + FRESHNESS_MS;

    // The new boot's worker would otherwise write its row within about a second
    // of starting, before Docker's first probe. An observer lock that blocks
    // heartbeat writes, but not the API's reads, holds that row back until the
    // previous boot's row is past the freshness bound and the worker's first
    // write has failed on its statement timeout, so the worker must retry.
    const lock = lockHeartbeats();
    let started;
    let startedAt;
    let retry;
    let releasedMs;
    try {
      await lock.acquired;
      await project.mustCompose(["start", "app"]);
      started = await project.inspect();
      startedAt = ms(started.State.StartedAt);
      for (;;) {
        const boot = await expectNoRestart(started, await probes.poll());
        retry ??= boot?.lines.find((line) => FIRST_HEARTBEAT_RETRY.test(line.text));
        if (retry !== undefined && (await dbNow()) > oldFreshUntil + 3_000) break;
        if (Date.now() - startedAt > GATE_BOUNDS.healthyMs)
          throw new Error("the worker's first heartbeat write never failed on the lock");
        await delay(250);
      }
      releasedMs = await lock.release();
    } finally {
      lock.end();
    }

    // The boot ID is read when healthy is observed, so a boot that died
    // earlier cannot stand in for the one that is serving.
    let newBoot;
    for (;;) {
      const info = await probes.poll();
      await expectNoRestart(started, info);
      if (info.State.Health?.Status === "healthy") {
        newBoot = await project.bootId();
        // Any healthy observation must already see this boot's row. A restart
        // just after the observation is reported as one, not as a missing row.
        const rows = await heartbeat(newBoot);
        if (rows.length === 0) await expectNoRestart(started, await project.inspect());
        expect(rows).toHaveLength(1);
        break;
      }
      if (Date.now() - startedAt > GATE_BOUNDS.healthyMs)
        throw new Error("not healthy after restart");
      await delay(100);
    }
    const after = await probes.poll();
    await expectNoRestart(started, after);
    const boots = await bootsSince(startedAt);
    expect(boots.map((boot) => boot.bootId)).toEqual([newBoot]);
    expect(newBoot).not.toBe(oldBoot);
    expect(after.RestartCount).toBe(started.RestartCount);
    expect(after.State.StartedAt).toBe(started.State.StartedAt);
    // The first write waited on the lock past the statement timeout.
    expect(retry.text).toContain("statement timeout");

    const [newRow] = await heartbeat(newBoot);
    // started_at is the blocked insert's transaction start; the row became
    // visible only when the observer's lock was released.
    const visibleAt = Math.max(Number(newRow.started_ms), releasedMs);
    const boot = probes.since(startedAt);
    const firstPass = boot.find((entry) => entry.passed);
    // Docker stamps a probe's Start before the probe reads the heartbeat, and
    // its End after; only End is certain to follow what it read. A probe that
    // started before the new row became visible may legitimately read it and
    // pass, so probe times are compared by End: every probe that finished
    // before the row was visible, while the previous row was fresh, failed.
    const whileOldFresh = boot.filter(
      (entry) => entry.start < oldFreshUntil && entry.end < visibleAt,
    );
    const straddling = boot.filter((entry) => entry.start < visibleAt && entry.end >= visibleAt);
    const withApi = whileOldFresh.filter((entry) => entry.output.includes("api=ready"));
    const retries = boots[0].lines.filter((line) => FIRST_HEARTBEAT_RETRY.test(line.text));
    record(
      `C3(a): previous row fresh until ${oldFreshUntil - startedAt} ms after start; first heartbeat retried ` +
        `${retries.length} time(s), first after ${retry.time.getTime() - startedAt} ms; lock released after ` +
        `${releasedMs - startedAt} ms; new row visible after ${visibleAt - startedAt} ms; first healthy probe after ` +
        `${firstPass.start - startedAt} ms, ended after ${firstPass.end - startedAt} ms; ` +
        `probes straddling visibility: ${straddling.map((e) => (e.passed ? "pass" : "fail")).join(",") || "none"}; ` +
        `RestartCount ${after.RestartCount}; ` +
        `probes while only the previous row was fresh: ${whileOldFresh.length}, with the API up ${withApi.length} (${whileOldFresh.map((e) => e.output).join(" | ")})`,
    );
    // Every probe failed while the previous boot's row was fresh and this
    // boot's row was not visible yet. Non-vacuous: once the API answered, they
    // failed on the worker, and at least one did.
    expect(withApi.length).toBeGreaterThan(0);
    for (const entry of whileOldFresh) expect(entry.passed).toBe(false);
    for (const entry of withApi) expect(entry.output).toContain("worker=no_current_boot_row");
    expect(firstPass.end).toBeGreaterThanOrEqual(visibleAt);
  });

  it("(b) follows the current boot's row when the worker is brought down and up", async () => {
    await project.waitReady(GATE_BOUNDS.healthyMs);
    const boot = await project.bootId();
    await waitFor("this boot's heartbeat row", async () => (await heartbeat(boot)).length === 1, {
      timeoutMs: 30_000,
    });
    const before = await project.inspect();
    await must("docker", ["exec", project.app, "s6-svc", "-d", "/run/service/worker"]);

    await waitFor(
      "a stale current-boot heartbeat",
      async () => Number((await heartbeat(boot))[0].age_ms) > FRESHNESS_MS,
      {
        timeoutMs: FRESHNESS_MS + 10_000,
      },
    );
    await waitFor("unhealthy", async () => (await project.health()).health === "unhealthy", {
      timeoutMs: 20_000,
    });

    // A fresh row from another boot must not make this container healthy, and
    // a worker that is wanted down is not a hang: hold past the hang bound.
    const foreign = randomUUID();
    await project.execSql(
      `INSERT INTO worker.heartbeat (boot_id, build_revision) VALUES ('${foreign}', 'ct-foreign')`,
    );
    const holdUntil = Date.now() + HANG_MS + 15_000;
    while (Date.now() < holdUntil) {
      await project.execSql(
        `UPDATE worker.heartbeat SET observed_at = now() WHERE boot_id = '${foreign}'`,
      );
      const { status, health } = await project.health();
      expect(status).toBe("running");
      expect(health).toBe("unhealthy");
      await delay(1_000);
    }
    const held = await project.inspect();
    expect(held.RestartCount).toBe(before.RestartCount);
    expect(held.State.StartedAt).toBe(before.State.StartedAt);
    const watchdogLines = (await project.boots())
      .find((b) => b.bootId === boot)
      .lines.map((l) => l.text);
    expect(watchdogLines.filter((line) => line.startsWith("sd-first-failure"))).toEqual([]);
    expect(watchdogLines).toContain("sd-lifecycle service=worker exit=0 signal=none wanted=down");

    const probes = new ProbeLog();
    const upAt = await dbNow();
    await must("docker", ["exec", project.app, "s6-svc", "-u", "/run/service/worker"]);
    await waitFor(
      "healthy after s6-svc -u",
      async () => (await probes.poll()).State.Health.Status === "healthy",
      { timeoutMs: 30_000, intervalMs: 200 },
    );
    const rows = await heartbeat(boot);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].started_ms)).toBeGreaterThanOrEqual(upAt);
    const afterUp = probes.since(upAt);
    // A passing probe read this boot's committed row, so it ended after the
    // row's start. Both sides are truncated to the millisecond.
    for (const entry of afterUp.filter((e) => e.passed)) {
      expect(entry.end).toBeGreaterThanOrEqual(Number(rows[0].started_ms));
    }
    const after = await project.inspect();
    expect(after.RestartCount).toBe(before.RestartCount);
    expect(after.State.StartedAt).toBe(before.State.StartedAt);
    record(
      `C3(b): healthy again ${Date.now() - upAt} ms (approx.) after s6-svc -u; row refreshed ${Number(rows[0].started_ms) - upAt} ms after it`,
    );
    await project.execSql(`DELETE FROM worker.heartbeat WHERE boot_id = '${foreign}'`);
  });

  it("(c) never becomes healthy on an incompatible schema and halts at the startup bound", async () => {
    await project.waitHealthy(GATE_BOUNDS.healthyMs);
    const [{ tag }] = await project.sql("SELECT tag FROM app.schema_tag");
    await project.execSql("UPDATE app.schema_tag SET tag = 'ct-incompatible'");
    await project.mustCompose(["restart", "app"]);
    // Watch only exits after the restart; the restart's own stop is a normal exit.
    const watcher = new DieWatcher(project.app);
    try {
      const startedAt = ms((await project.inspect()).State.StartedAt);
      const boot = await waitFor(
        "the new boot ID",
        async () =>
          (await project.exec("cat /run/sd/boot-id 2>/dev/null")).stdout.trim() || undefined,
        { timeoutMs: 20_000, intervalMs: 200 },
      );
      const readiness = new Set();
      const healthStates = new Set();
      while (watcher.events.length === 0) {
        const { health } = await project.health();
        healthStates.add(health);
        expect(health).not.toBe("healthy");
        readiness.add((await project.exec("node /opt/sd/bin/probe.mjs api")).stdout.trim());
        if (Date.now() - startedAt > STARTUP_EXIT_MS + 30_000) break;
        await delay(500);
      }
      const die = await watcher.next(0, 1_000);
      const elapsed = die.at - startedAt;
      record(
        `C3(c): startup-timeout exit ${die.exitCode} after ${elapsed} ms; health seen: ${[...healthStates].join(",")}; API probe: ${[...readiness].join(",")}`,
      );
      // Before the API listens the probe gets no response; once it answers it
      // reports the incompatible schema, and it is never ready.
      expect(readiness).toContain("api=schema_incompatible");
      expect(readiness).not.toContain("api=ready");
      expect(die.exitCode).toBe(71);
      expect(elapsed).toBeLessThan(STARTUP_EXIT_MS);
      const segment = (await project.boots()).find((b) => b.bootId === boot);
      const failures = segment.lines.filter((line) => line.text.startsWith("sd-first-failure "));
      expect(failures).toHaveLength(1);
      expect(fields(failures[0].text).reason).toBe("startup-timeout");
      // s6-notifyoncheck probed about every 250 ms for the whole start; the log
      // holds only the changes, not one line per attempt.
      const probeLines = segment.lines.map((l) => l.text).filter((t) => t.startsWith("api="));
      record(`C3(c): start probe lines in the container log: ${probeLines.join(" | ")}`);
      expect(probeLines).toContain("api=schema_incompatible");
      expect(probeLines.length).toBeLessThanOrEqual(5);
    } finally {
      watcher.stop();
      await project.execSql(`UPDATE app.schema_tag SET tag = '${tag}'`);
    }
    // Compose restarts it; with the schema tag restored it becomes healthy.
    await project.waitHealthy(GATE_BOUNDS.recoveryMs + STARTUP_EXIT_MS);
  });
});
