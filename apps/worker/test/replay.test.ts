import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

// Expiry is 30 s and supervision runs every 5 s, so a redelivery takes up to ~40 s.
const REDELIVERY_TIMEOUT_MS = 75_000;

let apiPort: number;
let api: Service;
let observer: Observer;
let cookie: string;
const workers: Service[] = [];

async function worker(hooks: Parameters<typeof startWorker>[1] = {}) {
  const started = await startWorker(apiPort, hooks);
  workers.push(started.worker);
  return started;
}

async function waitForCompletion(operationId: string, timeoutMs: number) {
  await observer.waitFor(
    () => observer.jobs(operationId),
    (jobs) => jobs.length === 1 && jobs[0]?.state === "completed",
    timeoutMs,
    `job for ${operationId} to complete`,
  );
}

beforeAll(async () => {
  observer = new Observer();
  apiPort = await freePort();
  api = await startApi(apiPort);
  cookie = await signInManager(apiPort);
  await drainBacklog(apiPort, observer);
}, 180_000);

afterEach(async () => {
  await Promise.all(workers.splice(0).map((service) => service.stop()));
});

afterAll(async () => {
  await api?.stop();
  await observer?.close();
});

describe("G7 duplicates end to end", () => {
  it("12 concurrent identical commands give one operation, one job and one receipt", async () => {
    const { bootId } = await worker();
    const operationId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => submit(apiPort, cookie, operationId)),
    );
    expect(results.map((result) => result.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 202,
    ]);

    await waitForCompletion(operationId, 30_000);
    // Repeating the command after completion still creates nothing.
    expect((await submit(apiPort, cookie, operationId)).status).toBe(200);

    const [operation] = await observer.operation(operationId);
    expect(operation?.state).toBe("completed");
    expect(await observer.jobs(operationId)).toHaveLength(1);
    const attempts = await observer.attempts(operationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: "recorded",
      receipt_id: operation?.receipt_id,
      worker_boot_id: bootId,
    });
  });
});

describe("G8 replay", () => {
  it("(a) a job committed while no worker runs completes after the worker starts", async () => {
    const { status, operationId } = await submit(apiPort, cookie);
    expect(status).toBe(202);

    // Nothing consumes the queue yet.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const [queued] = await observer.operation(operationId);
    expect(queued).toMatchObject({ state: "queued", receipt_id: null });
    expect(await observer.jobs(operationId)).toMatchObject([{ state: "created", retry_count: 0 }]);

    const { bootId } = await worker();
    await waitForCompletion(operationId, 30_000);

    const [operation] = await observer.operation(operationId);
    expect(operation?.state).toBe("completed");
    expect(operation?.receipt_job_id).toBe(queued?.job_id);
    const attempts = await observer.attempts(operationId);
    expect(attempts).toEqual([
      {
        outcome: "recorded",
        receipt_id: operation?.receipt_id,
        job_id: queued?.job_id,
        job_retry_count: 0,
        worker_boot_id: bootId,
      },
    ]);
  });

  it(
    "(b) a worker killed after claim and before the receipt call is redelivered after expiry",
    async () => {
      const first = await worker({ holdAt: "before-receipt" });
      const { status, operationId } = await submit(apiPort, cookie);
      expect(status).toBe(202);
      await first.worker.waitForLine(
        new RegExp(`^TEST_MARKER hold-before-receipt \\S+ ${operationId} 0$`),
        30_000,
      );

      const [held] = await observer.operation(operationId);
      expect(held).toMatchObject({ state: "queued", receipt_id: null });
      expect(await observer.jobs(operationId)).toMatchObject([{ state: "active", retry_count: 0 }]);

      first.worker.signal("SIGKILL");
      expect(await first.worker.exited).toEqual({ code: null, signal: "SIGKILL" });

      const second = await worker();
      await waitForCompletion(operationId, REDELIVERY_TIMEOUT_MS);

      const [operation] = await observer.operation(operationId);
      const jobs = await observer.jobs(operationId);
      expect(operation?.state).toBe("completed");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.retry_count).toBe(1);
      // Attempt history: the killed delivery never reached the API; the redelivery recorded the receipt.
      expect(await observer.attempts(operationId)).toEqual([
        {
          outcome: "recorded",
          receipt_id: operation?.receipt_id,
          job_id: held?.job_id,
          job_retry_count: 1,
          worker_boot_id: second.bootId,
        },
      ]);
      expect(
        second.worker.lines.some((line) =>
          line.includes(`TEST_MARKER claimed ${held?.job_id} ${operationId} 1`),
        ),
      ).toBe(true);
    },
    REDELIVERY_TIMEOUT_MS + 30_000,
  );

  it(
    "(c) a worker killed after the receipt commits but before the job completes gets the existing receipt",
    async () => {
      const first = await worker({ holdAt: "after-receipt" });
      const { status, operationId } = await submit(apiPort, cookie);
      expect(status).toBe(202);
      await first.worker.waitForLine(
        new RegExp(`^TEST_MARKER hold-after-receipt \\S+ ${operationId} 0$`),
        30_000,
      );

      const [recorded] = await observer.operation(operationId);
      expect(recorded?.state).toBe("completed");
      expect(recorded?.receipt_id).toEqual(expect.any(String));
      expect(await observer.jobs(operationId)).toMatchObject([{ state: "active", retry_count: 0 }]);

      first.worker.signal("SIGKILL");
      expect(await first.worker.exited).toEqual({ code: null, signal: "SIGKILL" });

      const second = await worker();
      await waitForCompletion(operationId, REDELIVERY_TIMEOUT_MS);

      const [operation] = await observer.operation(operationId);
      const jobs = await observer.jobs(operationId);
      expect(operation).toEqual(recorded);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.retry_count).toBe(1);
      expect(await observer.attempts(operationId)).toEqual([
        {
          outcome: "recorded",
          receipt_id: recorded?.receipt_id,
          job_id: recorded?.job_id,
          job_retry_count: 0,
          worker_boot_id: first.bootId,
        },
        {
          outcome: "existing",
          receipt_id: recorded?.receipt_id,
          job_id: recorded?.job_id,
          job_retry_count: 1,
          worker_boot_id: second.bootId,
        },
      ]);
    },
    REDELIVERY_TIMEOUT_MS + 30_000,
  );
});
