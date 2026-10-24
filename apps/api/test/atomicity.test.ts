import { randomUUID } from "node:crypto";
import { PGBOSS_SCHEMA, PILOT_JOB_OPTIONS, PILOT_QUEUE } from "@supplier-disruption/db";
import pg from "pg";
import { PgBoss, type Db } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PilotFaultHooks } from "../src/routes/pilot.js";
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

let observer: Observer;

/** Runs `fn` with a pg-boss handle bound to a transaction that is always rolled back. */
async function inRolledBackTransaction<T>(
  url: string,
  fn: (db: Db, boss: PgBoss) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const boss = new PgBoss({
    connectionString: url,
    schema: PGBOSS_SCHEMA,
    max: 1,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  await boss.start();
  try {
    await client.query("BEGIN");
    return await fn({ executeSql: (text, values) => client.query(text, values) }, boss);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await boss.stop({ graceful: false });
    await client.end();
  }
}

/** Whether a worker-role claim can see this operation's job. Claims are rolled back. */
async function claimable(operationId: string): Promise<boolean> {
  return inRolledBackTransaction(secret("host/database_url_worker"), async (db, boss) => {
    const jobs = await boss.fetch<{ operationId: string }>(PILOT_QUEUE, { batchSize: 1000, db });
    return jobs.some((job) => job.data.operationId === operationId);
  });
}

async function withApi<T>(
  faults: PilotFaultHooks,
  fn: (api: TestApi, cookie: string) => Promise<T>,
): Promise<T> {
  const api = await startTestApi(faults);
  try {
    const { cookie } = await signIn(api.baseUrl, credentials.manager());
    return await fn(api, cookie);
  } finally {
    await api.close();
  }
}

beforeAll(() => {
  observer = new Observer();
});

afterAll(async () => {
  await observer?.close();
});

describe("G6 atomic enqueue", () => {
  it("a failure after send but before commit leaves neither the operation nor a job", async () => {
    let sendReturned = false;
    await withApi(
      {
        afterSend: () => {
          sendReturned = true;
          return Promise.reject(new Error("injected failure after send"));
        },
      },
      async (api, cookie) => {
        const body = command(ORG_A.id);
        const result = await submit(api.baseUrl, body, { cookie });
        expect(result.status).toBe(503);
        expect(result.body).toEqual({ error: "enqueue_failed" });
        expect(sendReturned).toBe(true);
        expect(await observer.operationRows(body.operationId)).toEqual([]);
        expect(await observer.jobRows(body.operationId)).toEqual([]);
      },
    );
  });

  it("a send failure after the domain insert leaves neither", async () => {
    const executed: string[] = [];
    await withApi(
      {
        // The job INSERT really runs inside the transaction, then send reports failure.
        wrapSendDatabase: (db) => ({
          async executeSql(text, values) {
            await db.executeSql(text, values);
            executed.push(text);
            throw new Error("injected send failure");
          },
        }),
      },
      async (api, cookie) => {
        const body = command(ORG_A.id);
        const result = await submit(api.baseUrl, body, { cookie });
        expect(result.status).toBe(503);
        expect(executed.some((text) => /insert into/i.test(text))).toBe(true);
        expect(await observer.operationRows(body.operationId)).toEqual([]);
        expect(await observer.jobRows(body.operationId)).toEqual([]);
      },
    );
  });

  it("a job from an uncommitted transaction is never claimable, and becomes claimable on commit", async () => {
    const body = command(ORG_A.id);
    let reachedSend!: () => void;
    const atSend = new Promise<void>((resolve) => (reachedSend = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));

    await withApi(
      {
        afterSend: async (operationId) => {
          if (operationId !== body.operationId) return;
          reachedSend();
          await released;
        },
      },
      async (api, cookie) => {
        const pending = submit(api.baseUrl, body, { cookie });
        await atSend;

        // The transaction holds the operation row and job but has not committed.
        expect(await observer.operationRows(body.operationId)).toEqual([]);
        expect(await observer.jobRows(body.operationId)).toEqual([]);
        expect(await claimable(body.operationId)).toBe(false);

        release();
        const result = await pending;
        expect(result.status).toBe(202);
        const [row] = await observer.operationRows(body.operationId);
        const jobs = await observer.jobRows(body.operationId);
        expect(jobs).toHaveLength(1);
        expect(row?.job_id).toBe(jobs[0]?.id);
        expect(await claimable(body.operationId)).toBe(true);
      },
    );
  });

  it("a null send result is not ignored: nothing is committed and the caller is told", async () => {
    const body = command(ORG_A.id);
    // Occupy the exclusive singleton key so pg-boss returns null for this operation.
    const producer = new PgBoss({
      connectionString: secret("host/database_url_api"),
      schema: PGBOSS_SCHEMA,
      max: 1,
      migrate: false,
      supervise: false,
      schedule: false,
      registerInstance: false,
    });
    await producer.start();
    const blockerId = await producer.send(
      PILOT_QUEUE,
      { operationId: body.operationId },
      {
        ...PILOT_JOB_OPTIONS,
        singletonKey: body.operationId,
        startAfter: 3600,
      },
    );
    await producer.stop({ graceful: false });
    expect(blockerId).toEqual(expect.any(String));

    try {
      await withApi({}, async (api, cookie) => {
        const result = await submit(api.baseUrl, body, { cookie });
        expect(result.status).toBe(503);
        expect(result.body).toEqual({ error: "enqueue_failed" });
        expect(await observer.operationRows(body.operationId)).toEqual([]);
        expect((await observer.jobRows(body.operationId)).map((job) => job.id)).toEqual([
          blockerId,
        ]);
      });
    } finally {
      await observer.query(`DELETE FROM pgboss.job WHERE id = $1`, [blockerId]);
    }
  });

  it("an unrelated operation ID is unaffected by the failures above", async () => {
    await withApi({}, async (api, cookie) => {
      const body = command(ORG_A.id, { operationId: randomUUID() });
      expect((await submit(api.baseUrl, body, { cookie })).status).toBe(202);
      expect(await observer.operationRows(body.operationId)).toHaveLength(1);
      expect(await observer.jobRows(body.operationId)).toHaveLength(1);
    });
  });
});
