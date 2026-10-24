// Lifecycle observations (ADR 0021), beyond ADR 0002's limits.
//
// L1: a hung watchdog. SIGSTOP freezes the watchdog; the Docker healthcheck,
// which runs in its own process every interval, finds its beat stale, records
// hang:watchdog as the first failure and halts the container, which Compose
// restarts.
//
// L2: TERM-to-KILL escalation. s6-supervise sends SIGCONT with every SIGTERM,
// so a stopped process simply resumes and exits. Instead the worker's event
// loop is blocked: SIGUSR1 opens Node's inspector on the container's loopback
// and a client evaluates an endless loop, so the worker's SIGTERM handler
// and its own 11 s deadline can never run. A normal `docker compose stop` must
// then kill the worker at s6's timeout-kill (12 s) and still finish inside the
// 30 s budget with no failure record.
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DieWatcher, GATE_BOUNDS, Project, fields, must, record, waitFor } from "./support.mjs";

const EXIT_HANG = 70;
/** The worker's s6 timeout-kill (infra/app/rootfs/etc/s6-overlay/s6-rc.d/worker/timeout-kill). */
const WORKER_TIMEOUT_KILL_MS = 12_000;

const project = new Project("lifecycle");

beforeAll(async () => {
  await project.start();
});

afterAll(async () => {
  await project.remove();
});

const segmentOf = async (boot) => (await project.boots()).find((b) => b.bootId === boot);

describe("L1 hung watchdog", () => {
  it("halts with hang:watchdog from the healthcheck after SIGSTOP and recovers", async () => {
    await project.waitReady(GATE_BOUNDS.healthyMs);
    const boot = await project.bootId();
    const before = await project.inspect();
    const watcher = new DieWatcher(project.app);
    try {
      const faultAt = Date.now();
      await must("docker", [
        "exec",
        project.app,
        "sh",
        "-c",
        "kill -STOP $(s6-svstat -o pid /run/service/watchdog)",
      ]);
      const die = await watcher.next(0, GATE_BOUNDS.watchdogHangExitMs + 30_000);
      const exitMs = die.at - faultAt;
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
      await project.waitReady(Math.max(0, restartedAt + GATE_BOUNDS.healthyMs - Date.now()));
      expect(await project.bootId()).not.toBe(boot);

      const segment = await segmentOf(boot);
      const failures = segment.lines.filter((line) => line.text.startsWith("sd-first-failure "));
      record(
        `L1 SIGSTOP watchdog: exit ${die.exitCode} after ${exitMs} ms (bound ${GATE_BOUNDS.watchdogHangExitMs}); ` +
          `healthy ${Date.now() - restartedAt} ms after restart; ${failures[0]?.text}`,
      );
      expect(die.exitCode).toBe(EXIT_HANG);
      expect(failures).toHaveLength(1);
      expect(fields(failures[0].text)).toMatchObject({
        reason: "hang:watchdog",
        source: "healthcheck",
        "container-exit": String(EXIT_HANG),
      });
      expect(exitMs).toBeLessThan(GATE_BOUNDS.watchdogHangExitMs);
      // The beat had been stale for the whole bound before the halt.
      expect(Number(fields(failures[0].text).detail.split("=")[1])).toBeGreaterThanOrEqual(20_000);
    } finally {
      watcher.stop();
    }
  });

  it("never treats a watchdog brought down on purpose as hung", async () => {
    await project.waitReady(GATE_BOUNDS.healthyMs);
    const before = await project.inspect();
    await must("docker", ["exec", project.app, "s6-svc", "-d", "/run/service/watchdog"]);
    // Past the staleness bound plus several healthcheck rounds.
    await delay(30_000);
    const held = await project.inspect();
    expect(held.RestartCount).toBe(before.RestartCount);
    expect(held.State.StartedAt).toBe(before.State.StartedAt);
    expect(held.State.Health.Status).toBe("healthy");
    // Brought up again with a beat file older than the bound: its first beat
    // is due, not missed, for several healthcheck rounds.
    await must("docker", ["exec", project.app, "s6-svc", "-u", "/run/service/watchdog"]);
    await delay(6_000);
    const resumed = await project.inspect();
    expect(resumed.RestartCount).toBe(before.RestartCount);
    expect(resumed.State.StartedAt).toBe(before.State.StartedAt);
    const boot = await project.bootId();
    expect(
      (await segmentOf(boot)).lines.filter((line) => line.text.startsWith("sd-first-failure")),
    ).toEqual([]);
  });
});

/**
 * Blocks the worker's event loop through Node's inspector: SIGUSR1 opens it
 * on 127.0.0.1:9229 inside the container, then a detached client evaluates an
 * endless loop and stays connected. Returns once the worker has missed
 * several heartbeats, which shows the loop is really blocked.
 */
async function blockWorker(boot) {
  await must("docker", [
    "exec",
    project.app,
    "sh",
    "-c",
    "kill -USR1 $(s6-svstat -o pid /run/service/worker)",
  ]);
  const client = `
    let targets;
    for (let i = 0; i < 50 && !targets; i += 1) {
      targets = await fetch("http://127.0.0.1:9229/json/list").then((r) => r.json()).catch(() => undefined);
      if (!targets) await new Promise((r) => setTimeout(r, 100));
    }
    const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "for (;;) {}" } }));
    setInterval(() => {}, 60_000);
  `;
  await must("docker", [
    "exec",
    "--detach",
    project.app,
    "node",
    "--input-type=module",
    "-e",
    client,
  ]);
  await waitFor(
    "the worker heartbeat to stop",
    async () => {
      const [row] = await project.sql(
        `SELECT floor(extract(epoch FROM now() - observed_at) * 1000)::bigint AS age_ms
           FROM worker.heartbeat WHERE boot_id = '${boot}'`,
      );
      return Number(row?.age_ms) > 5_000;
    },
    { timeoutMs: 20_000, intervalMs: 250 },
  );
}

describe("L2 TERM-to-KILL escalation", () => {
  it("kills a worker that cannot handle SIGTERM at timeout-kill and still stops in budget", async () => {
    await project.waitReady(GATE_BOUNDS.healthyMs);
    const boot = await project.bootId();
    await blockWorker(boot);

    const stop = await project.mustCompose(["stop", "app"]);
    const info = await project.inspect();
    const segment = await segmentOf(boot);
    const texts = segment.lines.map((line) => line.text);
    const lifecycle = segment.lines
      .filter((line) => line.text.startsWith("sd-lifecycle "))
      .map((line) => ({ time: line.time.getTime(), ...fields(line.text) }));
    // The last line per service: L1 already logged one for the watchdog it brought down and up.
    const at = (service) => lifecycle.findLast((entry) => entry.service === service);
    // The watchdog exits on SIGTERM at once; s6-rc signals it and the worker
    // in the same down transition, so its line marks when SIGTERM was sent.
    const escalationMs = at("worker").time - at("watchdog").time;
    record(
      `L2: docker compose stop app took ${stop.ms} ms (budget ${GATE_BOUNDS.stopMs} ms); worker killed ` +
        `${escalationMs} ms after the watchdog's SIGTERM exit (timeout-kill ${WORKER_TIMEOUT_KILL_MS} ms); ` +
        `${lifecycle.map((entry) => `${entry.service}:exit=${entry.exit},signal=${entry.signal}`).join(" ")}`,
    );
    expect(at("worker")).toMatchObject({ exit: "256", signal: "9", wanted: "down" });
    expect(escalationMs).toBeGreaterThanOrEqual(WORKER_TIMEOUT_KILL_MS - 500);
    expect(escalationMs).toBeLessThan(WORKER_TIMEOUT_KILL_MS + 3_000);
    expect(stop.ms).toBeLessThan(GATE_BOUNDS.stopMs);
    expect(info.State.ExitCode).toBe(0);
    expect(texts.filter((text) => text.startsWith("sd-first-failure"))).toEqual([]);
    for (const service of ["api", "web", "watchdog"]) {
      expect(at(service), service).toMatchObject({ signal: "none", wanted: "down" });
    }
  });
});
