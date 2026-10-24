import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORG_A,
  Observer,
  command,
  credentials,
  secret,
  signIn,
  startTestApi,
  submit,
  type TestApi,
} from "./support.js";

let api: TestApi;
let observer: Observer;
let managerCookie: string;
let token: string;

async function receipt(
  operationId: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${api.baseUrl}/internal/pilot/operations/${operationId}/receipt`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function queuedOperation(): Promise<{ operationId: string; jobId: string }> {
  const body = command(ORG_A.id);
  expect((await submit(api.baseUrl, body, { cookie: managerCookie })).status).toBe(202);
  const [row] = await observer.operationRows(body.operationId);
  return { operationId: body.operationId, jobId: row?.job_id ?? "" };
}

async function expectNoReceipt(operationId: string): Promise<void> {
  const [row] = await observer.operationRows(operationId);
  expect(row?.receipt_id ?? null).toBeNull();
  expect(row?.state ?? "queued").toBe("queued");
  expect(await observer.attemptRows(operationId)).toEqual([]);
}

beforeAll(async () => {
  api = await startTestApi();
  observer = new Observer();
  managerCookie = (await signIn(api.baseUrl, credentials.manager())).cookie;
  token = secret("worker_service_token");
});

afterAll(async () => {
  await api?.close();
  await observer?.close();
});

describe("G9 internal receipt boundary", () => {
  it("rejects a browser session cookie, with or without a valid token", async () => {
    const { operationId, jobId } = await queuedOperation();
    const body = { jobId, workerBootId: randomUUID() };
    const cookieOnly = await receipt(operationId, body, { cookie: managerCookie });
    expect(cookieOnly).toEqual({ status: 403, body: { error: "browser_session_rejected" } });
    const both = await receipt(operationId, body, {
      cookie: managerCookie,
      authorization: `Bearer ${token}`,
    });
    expect(both).toEqual({ status: 403, body: { error: "browser_session_rejected" } });
    await expectNoReceipt(operationId);
  });

  it.each([
    ["a missing token", {}],
    ["a wrong token", { authorization: "Bearer not-the-worker-service-token-0000000000000" }],
    [
      "a token with the wrong scheme",
      { authorization: `Basic ${Buffer.from(`worker:x`).toString("base64")}` },
    ],
    ["a forged identity header", { "x-user-role": "worker", "x-service": "worker" }],
  ])("rejects %s", async (_label, headers: Record<string, string>) => {
    const { operationId, jobId } = await queuedOperation();
    const result = await receipt(operationId, { jobId, workerBootId: randomUUID() }, headers);
    expect(result).toEqual({ status: 401, body: { error: "service_token_required" } });
    await expectNoReceipt(operationId);
  });

  it("rejects a valid token for an operation that has no matching job", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const first = await queuedOperation();
    const second = await queuedOperation();

    // A job ID that exists nowhere.
    expect(
      await receipt(first.operationId, { jobId: randomUUID(), workerBootId: randomUUID() }, auth),
    ).toEqual({
      status: 409,
      body: { error: "job_not_matched" },
    });
    // Another operation's real job.
    expect(
      await receipt(first.operationId, { jobId: second.jobId, workerBootId: randomUUID() }, auth),
    ).toEqual({
      status: 409,
      body: { error: "job_not_matched" },
    });
    // The operation's own job, but nobody has claimed it.
    expect(
      await receipt(first.operationId, { jobId: first.jobId, workerBootId: randomUUID() }, auth),
    ).toEqual({
      status: 409,
      body: { error: "job_not_matched" },
    });
    // An operation that does not exist.
    expect(
      await receipt(randomUUID(), { jobId: first.jobId, workerBootId: randomUUID() }, auth),
    ).toEqual({ status: 404, body: { error: "operation_not_found" } });

    await expectNoReceipt(first.operationId);
    await expectNoReceipt(second.operationId);
  });

  it("records one receipt for a claimed job and returns the same receipt on replay", async () => {
    const { operationId, jobId } = await queuedOperation();
    // Stand in for a worker claim. The real claim path is covered in apps/worker/test.
    await observer.query(
      `UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = $1`,
      [jobId],
    );
    try {
      const auth = { authorization: `Bearer ${token}` };
      const body = { jobId, workerBootId: randomUUID() };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => receipt(operationId, body, auth)),
      );
      const created = results.filter((result) => result.status === 201);
      const replayed = results.filter((result) => result.status === 200);
      expect(created).toHaveLength(1);
      expect(replayed).toHaveLength(4);
      const receiptIds = new Set(
        results.map((result) => (result.body as { receiptId: string }).receiptId),
      );
      expect(receiptIds.size).toBe(1);

      const [row] = await observer.operationRows(operationId);
      expect(row?.state).toBe("completed");
      expect(row?.receipt_id).toBe([...receiptIds][0]);
      const attempts = await observer.attemptRows(operationId);
      expect(attempts.map((attempt) => attempt.outcome).sort()).toEqual([
        "existing",
        "existing",
        "existing",
        "existing",
        "recorded",
      ]);
    } finally {
      await observer.query(
        `UPDATE pgboss.job SET state = 'completed', completed_on = now() WHERE id = $1`,
        [jobId],
      );
    }
  });

  it("is not part of the browser API surface under /api", async () => {
    const { operationId, jobId } = await queuedOperation();
    const response = await fetch(
      `${api.baseUrl}/api/internal/pilot/operations/${operationId}/receipt`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          cookie: managerCookie,
        },
        body: JSON.stringify({ jobId, workerBootId: randomUUID() }),
      },
    );
    expect(response.status).toBe(404);
    await expectNoReceipt(operationId);
  });
});

describe("internal handler start record", () => {
  async function start(
    operationId: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${api.baseUrl}/internal/pilot/operations/${operationId}/start`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  const startRows = (operationId: string) =>
    observer.query<{ job_id: string; job_retry_count: number; worker_boot_id: string }>(
      `SELECT job_id, job_retry_count, worker_boot_id FROM app.pilot_handler_attempt WHERE operation_id = $1`,
      [operationId],
    );

  it("requires the worker service token and never a browser session", async () => {
    const { operationId, jobId } = await queuedOperation();
    const body = { jobId, workerBootId: randomUUID() };
    expect(await start(operationId, body, {})).toEqual({
      status: 401,
      body: { error: "service_token_required" },
    });
    expect(
      await start(operationId, body, { cookie: managerCookie, authorization: `Bearer ${token}` }),
    ).toEqual({ status: 403, body: { error: "browser_session_rejected" } });
    expect(await startRows(operationId)).toEqual([]);
  });

  it("rejects a job that is not the operation's active job", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const { operationId, jobId } = await queuedOperation();
    expect(await start(operationId, { jobId, workerBootId: randomUUID() }, auth)).toEqual({
      status: 409,
      body: { error: "job_not_matched" },
    });
    expect(await start(randomUUID(), { jobId, workerBootId: randomUUID() }, auth)).toEqual({
      status: 404,
      body: { error: "operation_not_found" },
    });
    expect(await startRows(operationId)).toEqual([]);
  });

  it("records the start for a claimed job and returns the stored pilot hold", async () => {
    const body = { ...command(ORG_A.id), payload: { note: "hold", holdMs: 1_234 } };
    expect((await submit(api.baseUrl, body, { cookie: managerCookie })).status).toBe(202);
    const [row] = await observer.operationRows(body.operationId);
    const jobId = row?.job_id ?? "";
    await observer.query(
      `UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = $1`,
      [jobId],
    );
    try {
      const workerBootId = randomUUID();
      const result = await start(
        body.operationId,
        { jobId, workerBootId },
        { authorization: `Bearer ${token}` },
      );
      expect(result.status).toBe(201);
      const started = result.body as { holdMs: number; attemptId: unknown };
      expect(started.holdMs).toBe(1_234);
      expect(typeof started.attemptId).toBe("string");
      expect(await startRows(body.operationId)).toEqual([
        { job_id: jobId, job_retry_count: 0, worker_boot_id: workerBootId },
      ]);
      // A start is not a receipt.
      await expectNoReceipt(body.operationId);
    } finally {
      await observer.query(
        `UPDATE pgboss.job SET state = 'completed', completed_on = now() WHERE id = $1`,
        [jobId],
      );
    }
  });
});
