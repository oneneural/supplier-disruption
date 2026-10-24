import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Observer,
  drainBacklog,
  freePort,
  signInManager,
  startApi,
  startWorker,
  submit,
  type Service,
} from "./support.js";

const HANDLER_DELAY_MS = 4000;
const DRAIN_BOUND_MS = 20_000;

let apiPort: number;
let api: Service;
let observer: Observer;
let cookie: string;

beforeAll(async () => {
  observer = new Observer();
  apiPort = await freePort();
  api = await startApi(apiPort);
  cookie = await signInManager(apiPort);
  await drainBacklog(apiPort, observer);
}, 180_000);

afterAll(async () => {
  await api?.stop();
  await observer?.close();
});

describe("G10 graceful worker stop", () => {
  it("SIGTERM during a handler lets it record its receipt, claims nothing new, and exits 0", async () => {
    const { worker, bootId } = await startWorker(apiPort, { handlerDelayMs: HANDLER_DELAY_MS });
    try {
      const inFlight = await submit(apiPort, cookie);
      await worker.waitForLine(
        new RegExp(`^TEST_MARKER claimed \\S+ ${inFlight.operationId} 0$`),
        30_000,
      );

      const signalledAt = Date.now();
      worker.signal("SIGTERM");
      // Submitted after the signal: must not be claimed by the stopping worker.
      const later = await submit(apiPort, cookie);
      expect(later.status).toBe(202);

      const exit = await worker.exited;
      const elapsed = Date.now() - signalledAt;
      expect(exit).toEqual({ code: 0, signal: null });
      expect(elapsed).toBeLessThan(DRAIN_BOUND_MS);
      expect(elapsed).toBeGreaterThanOrEqual(HANDLER_DELAY_MS - 1000);

      const finishedIndex = worker.lines.findIndex((line) =>
        new RegExp(`^TEST_MARKER handler-finished \\S+ ${inFlight.operationId} 0$`).test(line),
      );
      expect(finishedIndex, worker.output()).toBeGreaterThanOrEqual(0);

      const [operation] = await observer.operation(inFlight.operationId);
      expect(operation?.state).toBe("completed");
      expect(await observer.jobs(inFlight.operationId)).toMatchObject([{ state: "completed" }]);
      expect(await observer.attempts(inFlight.operationId)).toMatchObject([
        { outcome: "recorded", worker_boot_id: bootId },
      ]);

      expect(worker.lines.some((line) => line.includes(later.operationId))).toBe(false);
      expect(await observer.jobs(later.operationId)).toMatchObject([
        { state: "created", retry_count: 0 },
      ]);
    } finally {
      await worker.stop();
    }
    // Leave no backlog for later runs.
    await drainBacklog(apiPort, observer);
  }, 90_000);
});
