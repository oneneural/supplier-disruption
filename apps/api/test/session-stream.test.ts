// Session and open-stream authorization (ADR 0020) on the Compose
// database: per-account sign-in limits under the shared ceiling, session
// refresh cookies, revocation of an already open stream, Last-Event-ID resume
// scope and order, and the browser session versus worker token separation.
import { randomUUID } from "node:crypto";
import { PILOT_STREAM_INTERVAL_MS, pilotStreamEventSchema } from "@supplier-disruption/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGN_IN_ACCOUNT_LIMIT, SIGN_IN_SHARED_LIMIT } from "../src/auth.js";
import {
  APP_ORIGIN,
  LogCapture,
  ORG_A,
  ORG_B,
  Observer,
  command,
  credentials,
  provisionOrganizationB,
  readEvents,
  secret,
  signIn,
  startTestApi,
  submit,
  type TestApi,
} from "./support.js";

let api: TestApi;
let logs: LogCapture;
let observer: Observer;
let manager: string;
let managerB: string;

const eventsUrl = (id: string) => `${api.baseUrl}/api/pilot/operations/${id}/events`;

function sessionToken(cookie: string): string {
  const pair = cookie
    .split("; ")
    .find((part) => part.startsWith("supplier-disruption.session_token="));
  return decodeURIComponent(pair?.split("=")[1] ?? "").split(".")[0] ?? "";
}

async function operation(organizationId: string, cookie: string): Promise<string> {
  const body = command(organizationId, { note: "session-stream" });
  expect((await submit(api.baseUrl, body, { cookie })).status).toBe(202);
  return body.operationId;
}

function attempt(base: string, email: string, password: string, headers = {}) {
  return fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
    body: JSON.stringify({ email, password }),
  });
}

beforeAll(async () => {
  await provisionOrganizationB();
  logs = new LogCapture();
  api = await startTestApi(undefined, { logs });
  observer = new Observer();
  manager = (await signIn(api.baseUrl, credentials.manager())).cookie;
  managerB = (await signIn(api.baseUrl, credentials.managerB())).cookie;
});

afterAll(async () => {
  await api?.close();
  await observer?.close();
});

describe("sign-in limits per account under a shared ceiling", () => {
  it("limits one account without locking out another, whatever it forges", async () => {
    const limited = await startTestApi(undefined, { production: true });
    try {
      const { email, password } = credentials.manager();
      const statuses: number[] = [];
      for (let index = 0; index < SIGN_IN_ACCOUNT_LIMIT.max; index += 1) {
        statuses.push((await attempt(limited.baseUrl, email, password)).status);
      }
      // A forged client address and another spelling of the same account.
      const evading = await attempt(limited.baseUrl, ` ${email.toUpperCase()} `, password, {
        "x-forwarded-for": "198.51.100.7",
      });
      statuses.push(evading.status);
      expect(statuses).toEqual([200, 200, 200, 429]);
      expect(evading.headers.getSetCookie()).toEqual([]);
      expect(Number(evading.headers.get("x-retry-after"))).toBeGreaterThan(0);
      // Better Auth answers 404 to a trailing slash; the adapter counts it as the same account.
      const slashed = await fetch(`${limited.baseUrl}/api/auth/sign-in/email/`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: JSON.stringify({ email, password }),
      });
      expect(slashed.status).toBe(429);

      // Other users still sign in at once.
      expect(
        (await attempt(limited.baseUrl, credentials.buyer().email, credentials.buyer().password))
          .status,
      ).toBe(200);
      expect(
        (
          await attempt(
            limited.baseUrl,
            credentials.managerB().email,
            credentials.managerB().password,
          )
        ).status,
      ).toBe(200);

      // Spraying many accounts reaches the shared ceiling instead: 5 attempts
      // above were allowed through it, so it admits 25 more in this window.
      const sprayed: number[] = [];
      for (let index = 0; index < SIGN_IN_SHARED_LIMIT.max - 5 + 1; index += 1) {
        sprayed.push(
          (await attempt(limited.baseUrl, `${randomUUID()}@fixture.local`, "wrong")).status,
        );
      }
      expect(sprayed.slice(0, -1).every((status) => status === 401)).toBe(true);
      expect(sprayed.at(-1)).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe("session refresh", () => {
  it("re-sends the session cookie with a new lifetime once the session is due for refresh", async () => {
    const { cookie } = await signIn(api.baseUrl, credentials.manager());
    const token = sessionToken(cookie);
    // Better Auth refreshes a session updateAge (1 day) into its 7-day lifetime.
    await observer.query(
      `UPDATE auth.session SET expires_at = now() + interval '5 days' WHERE token = $1`,
      [token],
    );
    const response = await fetch(`${api.baseUrl}/api/auth/get-session`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const refreshed = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("supplier-disruption.session_token="));
    expect(refreshed).toMatch(/Max-Age=604800/);
    expect(sessionToken(refreshed!.split(";")[0]!)).toBe(token);
    const [row] = await observer.query<{ days: number }>(
      `SELECT extract(epoch FROM expires_at - now()) / 86400 AS days FROM auth.session WHERE token = $1`,
      [token],
    );
    expect(Number(row?.days)).toBeGreaterThan(6.9);
    const session = await fetch(`${api.baseUrl}/api/session`, {
      headers: { cookie: refreshed!.split(";")[0]! },
    });
    expect(session.status).toBe(200);
  });

  it("leaves a due session to the refresh route: API reads authorize without sliding it", async () => {
    const { cookie } = await signIn(api.baseUrl, credentials.manager());
    const token = sessionToken(cookie);
    await observer.query(
      `UPDATE auth.session SET expires_at = now() + interval '5 days' WHERE token = $1`,
      [token],
    );
    const id = await operation(ORG_A.id, cookie);
    for (const path of [
      "/api/session",
      `/api/cases?organizationId=${ORG_A.id}`,
      `/api/pilot/operations/${id}`,
    ]) {
      const response = await fetch(`${api.baseUrl}${path}`, { headers: { cookie } });
      expect(response.status, path).toBe(200);
      expect(response.headers.getSetCookie(), path).toEqual([]);
    }
    const days = async () =>
      Number(
        (
          await observer.query<{ days: number }>(
            `SELECT extract(epoch FROM expires_at - now()) / 86400 AS days FROM auth.session WHERE token = $1`,
            [token],
          )
        )[0]?.days,
      );
    // Had a read slid the row, the refresh route would find nothing due and send no cookie.
    expect(await days()).toBeLessThan(5.01);
    const refreshed = await fetch(`${api.baseUrl}/api/auth/get-session`, { headers: { cookie } });
    expect(refreshed.headers.getSetCookie().join("\n")).toMatch(
      /^supplier-disruption\.session_token=[^;]+;.*Max-Age=604800/m,
    );
    expect(await days()).toBeGreaterThan(6.9);
  });

  it.each([
    ["an expired session", "UPDATE auth.session SET expires_at = now() - interval '1 second'"],
    ["a revoked session", "DELETE FROM auth.session"],
  ])("never extends %s through the refresh route", async (_label, revoke) => {
    const { cookie } = await signIn(api.baseUrl, credentials.manager());
    const token = sessionToken(cookie);
    await observer.query(`${revoke} WHERE token = $1`, [token]);
    const response = await fetch(`${api.baseUrl}/api/auth/get-session`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    // The one session cookie sent back clears it.
    const sessionCookies = response.headers
      .getSetCookie()
      .filter((header) => header.startsWith("supplier-disruption.session_token="));
    expect(sessionCookies).toHaveLength(1);
    expect(sessionCookies[0]).toMatch(/Max-Age=0/);
    const rows = await observer.query(
      `SELECT 1 FROM auth.session WHERE token = $1 AND expires_at > now()`,
      [token],
    );
    expect(rows).toEqual([]);
    expect((await fetch(`${api.baseUrl}/api/session`, { headers: { cookie } })).status).toBe(401);
  });
});

describe("an already open stream", () => {
  const revocations: [string, (cookie: string) => Promise<unknown>][] = [
    [
      "a deleted session",
      (cookie) =>
        observer.query(`DELETE FROM auth.session WHERE token = $1`, [sessionToken(cookie)]),
    ],
    [
      "an expired session",
      (cookie) =>
        observer.query(
          `UPDATE auth.session SET expires_at = now() - interval '1 second' WHERE token = $1`,
          [sessionToken(cookie)],
        ),
    ],
  ];

  it.each(revocations)("closes before its next event after %s", async (_label, revoke) => {
    const { cookie } = await signIn(api.baseUrl, credentials.manager());
    const id = await operation(ORG_A.id, manager);
    let revokedAt = 0;
    let revoking: Promise<unknown> = Promise.resolve();
    const response = await fetch(eventsUrl(id), { headers: { cookie } });
    const { events, endedAt } = await readEvents(response, (_event, all) => {
      if (all.length === 2) {
        revoking = revoke(cookie).then(() => (revokedAt = Date.now()));
      }
    });
    await revoking;
    expect(events.map((event) => pilotStreamEventSchema.parse(event.data).seq)).toEqual([1, 2]);
    // The next check is at most one interval away.
    expect(endedAt - revokedAt).toBeLessThan(PILOT_STREAM_INTERVAL_MS + 500);
    expect(logs.matching("pilot stream closed", { operationId: id })).toMatchObject([
      { reason: "revoked", events: 2 },
    ]);
    // A reconnect is authorized from scratch.
    const again = await fetch(eventsUrl(id), {
      headers: { cookie, "last-event-id": events[1]!.id! },
    });
    expect(again.status).toBe(401);
  });

  it("closes before its next event once the user's membership is removed", async () => {
    const id = await operation(ORG_B.id, managerB);
    let revoking: Promise<unknown> = Promise.resolve();
    try {
      const response = await fetch(eventsUrl(id), { headers: { cookie: managerB } });
      const { events } = await readEvents(response, (_event, all) => {
        if (all.length === 1) {
          revoking = observer.query(
            `DELETE FROM app.membership m USING auth."user" u
              WHERE m.user_id = u.id AND u.email = $1 AND m.organization_id = $2`,
            [credentials.managerB().email, ORG_B.id],
          );
        }
      });
      await revoking;
      expect(events).toHaveLength(1);
      expect(logs.matching("pilot stream closed", { operationId: id })).toMatchObject([
        { reason: "revoked", events: 1 },
      ]);
      // The same session is still signed in, but no longer reaches the operation.
      expect(
        (await fetch(`${api.baseUrl}/api/session`, { headers: { cookie: managerB } })).status,
      ).toBe(200);
      expect((await fetch(eventsUrl(id), { headers: { cookie: managerB } })).status).toBe(404);
    } finally {
      await revoking;
      await provisionOrganizationB();
    }
  });
});

describe("Last-Event-ID resume", () => {
  it("resumes after the last event received, in order, and refuses one past the end", async () => {
    const id = await operation(ORG_A.id, manager);
    const controller = new AbortController();
    const first = await fetch(eventsUrl(id), {
      headers: { cookie: manager },
      signal: controller.signal,
    });
    const before = await readEvents(first, (_event, all) => all.length === 2);
    controller.abort();
    expect(before.events.map((event) => event.id)).toEqual([`${id}:1`, `${id}:2`]);

    const resumed = await fetch(eventsUrl(id), {
      headers: { cookie: manager, "last-event-id": before.events[1]!.id! },
    });
    expect(resumed.status).toBe(200);
    const after = await readEvents(resumed);
    const parsed = after.events.map((event) => pilotStreamEventSchema.parse(event.data));
    expect(parsed.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(parsed.map((event) => event.final)).toEqual([false, false, true]);
    expect(after.events.map((event) => event.id)).toEqual([`${id}:3`, `${id}:4`, `${id}:5`]);
    // Read fresh, at the stream's own pace: the first resumed event comes at once.
    expect(after.events[0]!.arrivedAt - Date.parse(parsed[0]!.emittedAt)).toBeLessThan(500);
    expect(logs.matching("pilot stream closed", { operationId: id }).at(-1)).toMatchObject({
      reason: "completed",
      events: 3,
      lastSeq: 5,
    });

    // After the final event there is nothing to resume: 204 stops an EventSource.
    const done = await fetch(eventsUrl(id), {
      headers: { cookie: manager, "last-event-id": `${id}:5` },
    });
    expect(done.status).toBe(204);
    expect(await done.text()).toBe("");
  });

  it("refuses a forged, foreign or out-of-range event ID without opening a stream", async () => {
    const id = await operation(ORG_A.id, manager);
    const other = await operation(ORG_A.id, manager);
    const forged = [
      `${other}:2`,
      `${id}:0`,
      `${id}:6`,
      `${id}:02`,
      `${id}:-1`,
      `${id}:2.5`,
      `${id.toUpperCase()}:2`,
      "2",
      "",
    ];
    for (const lastEventId of forged) {
      const response = await fetch(eventsUrl(id), {
        headers: { cookie: manager, "last-event-id": lastEventId },
      });
      expect(response.status, JSON.stringify(lastEventId)).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(logs.matching("pilot stream closed", { operationId: id })).toEqual([]);
    // Authorization comes first: a non-member gets the missing-operation answer.
    const cross = await fetch(eventsUrl(id), {
      headers: { cookie: managerB, "last-event-id": `${id}:2` },
    });
    expect(cross.status).toBe(404);
  });
});

describe("browser session and worker token separation", () => {
  it("never accepts the worker token as a browser session", async () => {
    const id = await operation(ORG_A.id, manager);
    const authorization = `Bearer ${secret("worker_service_token")}`;
    for (const url of [`${api.baseUrl}/api/session`, eventsUrl(id)]) {
      expect((await fetch(url, { headers: { authorization } })).status, url).toBe(401);
    }
  });
});
