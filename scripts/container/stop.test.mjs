// C8 graceful stop: a normal stop drains an in-flight pilot job with no
// SIGKILL, no timeout escalation and no failure record, and even a stop where
// every service must be killed by its s6 timeout stays inside the 30 s budget.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATE_BOUNDS, Project, fields, must, waitFor, record } from "./support.mjs";

// PILOT_MAX_HOLD_MS in packages/contracts: the longest hold the drain must cover.
const HOLD_MS = 8_000;
const ESSENTIAL = ["api", "watchdog", "web", "worker"];
// Exit codes on SIGTERM (ADR 0002): the Next server exits 143, the others 0.
const STOP_EXIT = { api: "0", watchdog: "0", web: "143", worker: "0" };

const project = new Project("stop");

beforeAll(async () => {
  await project.start();
});

afterAll(async () => {
  await project.remove();
});

/** Submits a held pilot job and waits until its handler has started. */
async function holdInFlight(boot, note) {
  const submitted = await project.submitOperation({ note, holdMs: HOLD_MS });
  expect(submitted.status).toBe(202);
  const started = `pilot handler started operation=${submitted.operationId} boot=${boot}`;
  await waitFor(
    "the handler start line",
    async () => (await project.logLines()).some((line) => line.text.includes(started)),
    { timeoutMs: 30_000, intervalMs: 100 },
  );
  return submitted;
}

async function lifecycleLines(boot) {
  const segment = (await project.boots()).find((b) => b.bootId === boot);
  const texts = segment.lines.map((line) => line.text);
  const lifecycle = texts.filter((text) => text.startsWith("sd-lifecycle ")).map(fields);
  expect(lifecycle.map((entry) => entry.service).sort()).toEqual(ESSENTIAL);
  expect(texts.filter((text) => text.startsWith("sd-first-failure"))).toEqual([]);
  return { texts, lifecycle };
}

describe("C8 graceful stop", () => {
  it("drains an in-flight job and stops every service on request", async () => {
    const boot = await project.bootId();
    const submitted = await holdInFlight(boot, "graceful stop");
    // Unfinished-work barrier: the attempt has started and has no receipt yet.
    const inFlight = await project.operation(submitted.operationId);
    expect(inFlight.attempts).toBeGreaterThanOrEqual(1);
    expect(inFlight.receipt_id).toBeNull();
    const [{ now: stopRequested }] = await project.sql("SELECT now() AS now");

    const stop = await project.mustCompose(["stop", "app"]);
    record(
      `C8: docker compose stop app took ${stop.ms} ms (budget ${GATE_BOUNDS.stopMs} ms, hold ${HOLD_MS} ms)`,
    );
    expect(stop.ms).toBeLessThan(GATE_BOUNDS.stopMs);

    const info = await project.inspect();
    expect(info.State.Status).toBe("exited");
    expect(info.State.ExitCode).toBe(0);
    expect(info.State.OOMKilled).toBe(false);

    const { texts, lifecycle } = await lifecycleLines(boot);
    for (const entry of lifecycle) {
      expect(entry, entry.service).toMatchObject({
        wanted: "down",
        signal: "none",
        exit: STOP_EXIT[entry.service],
      });
    }
    expect(texts.filter((text) => /timed out|SIGKILL|sending KILL/i.test(text))).toEqual([]);

    const done = await project.operation(submitted.operationId);
    expect(done.receipt_id).not.toBeNull();
    // The receipt was recorded during the drain, after the stop was requested.
    expect(Date.parse(done.receipt_recorded_at)).toBeGreaterThan(Date.parse(stopRequested));
  });

  it("stays inside the 30 s budget when the longest hold cannot finish its receipt", async () => {
    await project.mustCompose(["start", "app"]);
    await project.waitReady(GATE_BOUNDS.healthyMs);
    const boot = await project.bootId();
    const submitted = await holdInFlight(boot, "stuck stop");
    // With the API frozen, the handler's receipt call cannot complete, so the
    // worker uses its whole drain. s6 sends SIGCONT with SIGTERM, so the API
    // resumes only when its own turn to stop comes, after the worker.
    await must("docker", [
      "exec",
      project.app,
      "sh",
      "-c",
      "kill -STOP $(s6-svstat -o pid /run/service/api)",
    ]);

    const stop = await project.mustCompose(["stop", "app"]);
    const info = await project.inspect();
    const { texts, lifecycle } = await lifecycleLines(boot);
    const workerLines = texts.filter((t) => t.includes('"service":"worker"')).slice(-8);
    record(`C8 stuck receipt worker log:\n${workerLines.join("\n")}`);
    record(
      `C8 stuck receipt: docker compose stop app took ${stop.ms} ms (budget ${GATE_BOUNDS.stopMs} ms); ` +
        `container exit ${info.State.ExitCode}; ` +
        lifecycle.map((e) => `${e.service} exit=${e.exit} signal=${e.signal}`).join(", "),
    );
    expect(stop.ms).toBeLessThan(GATE_BOUNDS.stopMs);
    expect(info.State.Status).toBe("exited");
    for (const entry of lifecycle) {
      // Every service ends within its own deadline; none needs s6's SIGKILL.
      expect(entry, entry.service).toMatchObject({ wanted: "down", signal: "none" });
    }
    // The drain ran out rather than finishing: pg-boss failed the still-active
    // job at the drain timeout, so the receipt request the API reads when it
    // resumes is answered 409 job_not_matched (the job is no longer active) and
    // records nothing. The job is retried under the queue policy after restart.
    expect((await project.operation(submitted.operationId)).receipt_id).toBeNull();
  });
});
