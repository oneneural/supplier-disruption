import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FIRST_HEARTBEAT_DEADLINE_MS,
  FIRST_HEARTBEAT_RETRY_MS,
  startConsuming,
  type StartupSteps,
} from "../src/startup.js";

/** Steps that record when each one begins and finishes. */
function steps(failAt?: "start" | "work") {
  const events: string[] = [];
  const step = (name: "start" | "work") => async () => {
    events.push(`${name} begins`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (failAt === name) throw new Error(`${name} failed`);
    events.push(`${name} done`);
  };
  return {
    events,
    steps: {
      start: step("start"),
      work: step("work"),
      writeFirstHeartbeat: () => {
        events.push("heartbeat");
        return Promise.resolve();
      },
    },
  };
}

describe("worker startup order", () => {
  it("writes the first heartbeat only after pg-boss starts and the handler is registered", async () => {
    const { events, steps: s } = steps();
    await startConsuming(s);
    expect(events).toEqual(["start begins", "start done", "work begins", "work done", "heartbeat"]);
  });

  it.each(["start", "work"] as const)("writes no heartbeat when %s fails", async (failAt) => {
    const { events, steps: s } = steps(failAt);
    await expect(startConsuming(s)).rejects.toThrow(`${failAt} failed`);
    expect(events).not.toContain("heartbeat");
  });
});

/** Steps whose first heartbeat attempts fail `failures` times (always when Infinity). */
function failingHeartbeat(failures: number, attemptMs = 0) {
  const attempts: number[] = [];
  const reported: number[] = [];
  const s: StartupSteps = {
    start: () => Promise.resolve(),
    work: () => Promise.resolve(),
    writeFirstHeartbeat: async () => {
      attempts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, attemptMs));
      if (attempts.length <= failures) throw new Error(`attempt ${attempts.length} timed out`);
    },
    firstHeartbeatFailed: (_error, attempt) => {
      reported.push(attempt);
    },
  };
  return { steps: s, attempts, reported };
}

describe("first heartbeat retry", () => {
  it("retries a failed first heartbeat until a write succeeds", async () => {
    const { steps: s, attempts, reported } = failingHeartbeat(2);
    await startConsuming(s, { firstHeartbeatRetryMs: 50 });
    expect(attempts).toHaveLength(3);
    expect(reported).toEqual([1, 2]);
    // Each retry waits the retry interval after the failed attempt.
    for (let i = 1; i < attempts.length; i += 1) {
      expect((attempts[i] ?? 0) - (attempts[i - 1] ?? 0)).toBeGreaterThanOrEqual(45);
    }
  });

  it("gives up at the deadline with the last failure as the cause", async () => {
    const { steps: s, attempts } = failingHeartbeat(Infinity, 30);
    const startedAt = Date.now();
    const failure = await startConsuming(s, {
      firstHeartbeatDeadlineMs: 400,
      firstHeartbeatRetryMs: 50,
    }).catch((error: unknown) => error);
    const elapsed = Date.now() - startedAt;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `first heartbeat not written within 400 ms (${attempts.length} attempts)`,
    );
    expect((failure as Error).cause).toEqual(new Error(`attempt ${attempts.length} timed out`));
    // Attempts every 80 ms or so; none starts after the deadline.
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect((attempts.at(-1) ?? 0) - startedAt).toBeLessThan(400);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(400 + 200);
  });

  it("fails at once with the error itself on a permanent failure", async () => {
    const { steps: s, attempts, reported } = failingHeartbeat(Infinity);
    s.isPermanent = () => true;
    await expect(startConsuming(s, { firstHeartbeatRetryMs: 10_000 })).rejects.toThrow(
      "attempt 1 timed out",
    );
    expect(attempts).toHaveLength(1);
    expect(reported).toEqual([]);
  });

  it("retries failures that are not permanent", async () => {
    const { steps: s, attempts, reported } = failingHeartbeat(2);
    const judged: unknown[] = [];
    s.isPermanent = (error) => {
      judged.push(error);
      return false;
    };
    await startConsuming(s, { firstHeartbeatRetryMs: 20 });
    expect(attempts).toHaveLength(3);
    expect(judged).toHaveLength(2);
    expect(reported).toEqual([1, 2]);
  });

  it("stops promptly when aborted between attempts", async () => {
    const { steps: s, reported } = failingHeartbeat(Infinity);
    const controller = new AbortController();
    s.firstHeartbeatFailed = (_error, attempt) => {
      reported.push(attempt);
      controller.abort();
    };
    const startedAt = Date.now();
    await expect(
      startConsuming(s, { signal: controller.signal, firstHeartbeatRetryMs: 10_000 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(reported).toEqual([1]);
  });

  it("stops promptly when aborted during an attempt, without waiting for it", async () => {
    const { steps: s, attempts } = failingHeartbeat(Infinity, 10_000);
    const controller = new AbortController();
    const starting = startConsuming(s, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attempts).toHaveLength(1);
    const abortedAt = Date.now();
    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - abortedAt).toBeLessThan(200);
  });

  it("registers no handler and writes nothing when aborted while pg-boss starts", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const starting = startConsuming(
      {
        start: async () => {
          calls.push("start");
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
        work: () => {
          calls.push("work");
          return Promise.resolve();
        },
        writeFirstHeartbeat: () => {
          calls.push("heartbeat");
          return Promise.resolve();
        },
      },
      { signal: controller.signal },
    );
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["start"]);
  });

  it("keeps the production retry at 2 s and the deadline at the watchdog's startup bound", () => {
    const watchdog = readFileSync(
      new URL("../../../infra/app/rootfs/opt/sd/lib/watchdog-core.mjs", import.meta.url),
      "utf8",
    );
    const startupMs = /startupMs:\s*([\d_]+)/.exec(watchdog)?.[1]?.replaceAll("_", "");
    expect(FIRST_HEARTBEAT_DEADLINE_MS).toBe(Number(startupMs));
    expect(FIRST_HEARTBEAT_RETRY_MS).toBe(2_000);
  });
});
