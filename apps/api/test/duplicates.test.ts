import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORG_A,
  Observer,
  command,
  credentials,
  signIn,
  startTestApi,
  submit,
  type TestApi,
} from "./support.js";

// The receipt half of G7 (one receipt under redelivery) runs against a real
// worker in apps/worker/test/replay.test.ts.

let api: TestApi;
let observer: Observer;
let manager: string;

beforeAll(async () => {
  api = await startTestApi();
  observer = new Observer();
  manager = (await signIn(api.baseUrl, credentials.manager())).cookie;
});

afterAll(async () => {
  await api?.close();
  await observer?.close();
});

describe("G7 duplicate commands", () => {
  it("the same command sent sequentially yields one operation and one job", async () => {
    const body = command(ORG_A.id);
    const first = await submit(api.baseUrl, body, { cookie: manager });
    const second = await submit(api.baseUrl, body, { cookie: manager });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await observer.operationRows(body.operationId)).toHaveLength(1);
    expect(await observer.jobRows(body.operationId)).toHaveLength(1);
  });

  it("key order in the payload does not change the operation's identity", async () => {
    const body = command(ORG_A.id);
    expect((await submit(api.baseUrl, body, { cookie: manager })).status).toBe(202);
    const reordered = {
      payload: body.payload,
      organizationId: body.organizationId,
      operationId: body.operationId,
      contractVersion: body.contractVersion,
    };
    expect((await submit(api.baseUrl, reordered, { cookie: manager })).status).toBe(200);
  });

  it("12 concurrent identical requests yield one operation and one job", async () => {
    const body = command(ORG_A.id);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => submit(api.baseUrl, body, { cookie: manager })),
    );
    const statuses = results.map((result) => result.status).sort();
    expect(statuses.filter((status) => status === 202)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(11);
    const operations = new Set(results.map((result) => JSON.stringify(result.body)));
    expect(operations.size).toBe(1);
    expect(await observer.operationRows(body.operationId)).toHaveLength(1);
    expect(await observer.jobRows(body.operationId)).toHaveLength(1);
  });

  it("reusing an operation ID with a changed payload returns 409 and changes nothing", async () => {
    const body = command(ORG_A.id, { note: "original" });
    expect((await submit(api.baseUrl, body, { cookie: manager })).status).toBe(202);
    const before = await observer.operationRows(body.operationId);
    const jobsBefore = await observer.jobRows(body.operationId);

    const changed = await submit(
      api.baseUrl,
      { ...body, payload: { note: "changed" } },
      { cookie: manager },
    );
    expect(changed.status).toBe(409);
    expect(changed.body).toEqual({ error: "operation_payload_conflict" });

    // Concurrent changed-payload reuse is rejected the same way.
    const racing = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        submit(
          api.baseUrl,
          { ...body, payload: { note: `changed-${index}` } },
          { cookie: manager },
        ),
      ),
    );
    expect(racing.every((result) => result.status === 409)).toBe(true);

    expect(await observer.operationRows(body.operationId)).toEqual(before);
    expect(await observer.jobRows(body.operationId)).toEqual(jobsBefore);
    expect(before[0]?.payload).toEqual({ note: "original" });
  });

  it("concurrent first submissions with different payloads leave exactly one winner", async () => {
    const operationId = command(ORG_A.id).operationId;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        submit(api.baseUrl, command(ORG_A.id, { operationId, note: `racer-${index}` }), {
          cookie: manager,
        }),
      ),
    );
    const accepted = results.filter((result) => result.status === 202);
    expect(accepted).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(9);
    const rows = await observer.operationRows(operationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual((accepted[0]?.body as { payload: unknown }).payload);
    expect(await observer.jobRows(operationId)).toHaveLength(1);
  });
});
