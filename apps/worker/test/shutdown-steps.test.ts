import { describe, expect, it } from "vitest";
import { drainAndClose } from "../src/shutdown.js";

function recorder(
  stopQueue: () => Promise<void>,
  closePool: () => Promise<void> = () => Promise.resolve(),
) {
  const calls: string[] = [];
  const steps = {
    stopQueue: async () => {
      calls.push("stopQueue");
      await stopQueue();
    },
    stopHeartbeat: () => {
      calls.push("stopHeartbeat");
    },
    closePool: async () => {
      calls.push("closePool");
      await closePool();
    },
  };
  return { calls, steps };
}

describe("worker shutdown steps", () => {
  it("drains, then stops the heartbeat and closes the pool", async () => {
    const { calls, steps } = recorder(() => Promise.resolve());
    await drainAndClose(steps);
    expect(calls).toEqual(["stopQueue", "stopHeartbeat", "closePool"]);
  });

  it("still stops the heartbeat and closes the pool when draining fails, then reports the failure", async () => {
    const { calls, steps } = recorder(() => Promise.reject(new Error("pg-boss stop failed")));
    await expect(drainAndClose(steps)).rejects.toThrow("pg-boss stop failed");
    expect(calls).toEqual(["stopQueue", "stopHeartbeat", "closePool"]);
  });

  it("reports a pool failure after a successful drain", async () => {
    const { calls, steps } = recorder(
      () => Promise.resolve(),
      () => Promise.reject(new Error("pool end failed")),
    );
    await expect(drainAndClose(steps)).rejects.toThrow("pool end failed");
    expect(calls).toEqual(["stopQueue", "stopHeartbeat", "closePool"]);
  });

  it("keeps the drain error when closing the pool also fails", async () => {
    const drainError = new Error("pg-boss stop failed");
    const closeError = new Error("pool end failed");
    const { calls, steps } = recorder(
      () => Promise.reject(drainError),
      () => Promise.reject(closeError),
    );
    const failure: unknown = await drainAndClose(steps).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([drainError, closeError]);
    expect((failure as AggregateError).cause).toBe(closeError);
    expect(calls).toEqual(["stopQueue", "stopHeartbeat", "closePool"]);
  });
});
