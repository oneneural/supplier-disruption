import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORG_A,
  ORG_B,
  Observer,
  command,
  credentials,
  provisionOrganizationB,
  signIn,
  startTestApi,
  submit,
  type TestApi,
} from "./support.js";

let api: TestApi;
let observer: Observer;
let managerA: string;
let managerAUserId: string;
let buyerA: string;
let managerB: string;

async function expectNothingCreated(operationId: string): Promise<void> {
  expect(await observer.operationRows(operationId)).toEqual([]);
  expect(await observer.jobRows(operationId)).toEqual([]);
}

beforeAll(async () => {
  await provisionOrganizationB();
  api = await startTestApi();
  observer = new Observer();
  managerA = (await signIn(api.baseUrl, credentials.manager())).cookie;
  buyerA = (await signIn(api.baseUrl, credentials.buyer())).cookie;
  managerB = (await signIn(api.baseUrl, credentials.managerB())).cookie;
  const [row] = await observer.query<{ id: string }>(
    `SELECT id FROM auth."user" WHERE email = 'manager@fixture.local'`,
  );
  managerAUserId = row?.id ?? "";
});

afterAll(async () => {
  await api?.close();
  await observer?.close();
});

describe("G5 authorization", () => {
  it("a buyer gets 403 for the manager-only command and nothing is created", async () => {
    const body = command(ORG_A.id);
    const result = await submit(api.baseUrl, body, { cookie: buyerA });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "forbidden" });
    await expectNothingCreated(body.operationId);
  });

  it("a manager of another organization gets 403", async () => {
    const body = command(ORG_A.id);
    const result = await submit(api.baseUrl, body, { cookie: managerB });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "forbidden" });
    await expectNothingCreated(body.operationId);
  });

  it("forged identity headers do not change the outcome", async () => {
    const forged = {
      "x-user-id": managerAUserId,
      "x-user-email": "manager@fixture.local",
      "x-user-role": "manager",
      "x-forwarded-user": "manager@fixture.local",
      "x-organization-id": ORG_A.id,
    };
    const asBuyer = command(ORG_A.id);
    expect((await submit(api.baseUrl, asBuyer, { cookie: buyerA, ...forged })).status).toBe(403);
    await expectNothingCreated(asBuyer.operationId);

    const anonymous = command(ORG_A.id);
    expect((await submit(api.baseUrl, anonymous, forged)).status).toBe(401);
    await expectNothingCreated(anonymous.operationId);

    const session = await fetch(`${api.baseUrl}/api/session`, { headers: forged });
    expect(session.status).toBe(401);
  });

  it.each([
    ["a different origin", { origin: "http://127.0.0.1:3101" }],
    ["a different port on the same host", { origin: "http://127.0.0.1:3000" }],
    ["the null origin", { origin: "null" }],
  ])("a mutation from %s is rejected", async (_label, headers) => {
    const body = command(ORG_A.id);
    const result = await submit(api.baseUrl, body, { cookie: managerA, ...headers });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "origin_rejected" });
    await expectNothingCreated(body.operationId);
  });

  it("a mutation without an Origin header is rejected", async () => {
    const body = command(ORG_A.id);
    const response = await fetch(`${api.baseUrl}/api/pilot/operations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: managerA },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(403);
    await expectNothingCreated(body.operationId);
  });

  describe("replaying an operation ID owned by organization A as a manager of organization B", () => {
    const operationId = randomUUID();
    const secretNote = `org-a-confidential-${randomUUID()}`;
    let ownedRow: Awaited<ReturnType<Observer["operationRows"]>>;
    let ownedJobs: Awaited<ReturnType<Observer["jobRows"]>>;

    beforeAll(async () => {
      const created = await submit(
        api.baseUrl,
        command(ORG_A.id, { operationId, note: secretNote }),
        {
          cookie: managerA,
        },
      );
      expect(created.status).toBe(202);
      ownedRow = await observer.operationRows(operationId);
      ownedJobs = await observer.jobRows(operationId);
      expect(ownedRow).toHaveLength(1);
      expect(ownedJobs).toHaveLength(1);
    });

    function expectNoDisclosure(text: string): void {
      for (const leaked of [
        secretNote,
        ORG_A.id,
        ownedRow[0]?.payload_sha256 ?? "",
        "queued",
        "completed",
        "receipt",
      ]) {
        expect(text).not.toContain(leaked);
      }
    }

    async function expectUnchanged(): Promise<void> {
      expect(await observer.operationRows(operationId)).toEqual(ownedRow);
      expect(await observer.jobRows(operationId)).toEqual(ownedJobs);
    }

    it("submitting organization A's ID gets the ordinary 403", async () => {
      const result = await submit(
        api.baseUrl,
        command(ORG_A.id, { operationId, note: secretNote }),
        {
          cookie: managerB,
        },
      );
      expect(result.status).toBe(403);
      expect(result.text).toBe('{"error":"forbidden"}');
      expectNoDisclosure(result.text);
      await expectUnchanged();
    });

    it("submitting organization B's ID gets the fixed generic operation_id_unavailable denial", async () => {
      for (const note of [secretNote, "a different payload"]) {
        const result = await submit(api.baseUrl, command(ORG_B.id, { operationId, note }), {
          cookie: managerB,
        });
        expect(result.status).toBe(409);
        expect(result.text).toBe('{"error":"operation_id_unavailable"}');
        expectNoDisclosure(result.text);
      }
      await expectUnchanged();
    });

    it("a non-member reading the operation cannot tell it exists", async () => {
      const read = await fetch(`${api.baseUrl}/api/pilot/operations/${operationId}`, {
        headers: { cookie: managerB },
      });
      const missing = await fetch(`${api.baseUrl}/api/pilot/operations/${randomUUID()}`, {
        headers: { cookie: managerB },
      });
      expect(read.status).toBe(404);
      expect(await read.text()).toBe(await missing.text());
    });
  });
});
