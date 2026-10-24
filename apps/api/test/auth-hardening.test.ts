import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authOptions } from "../src/auth.js";
import {
  APP_ORIGIN,
  Observer,
  credentials,
  signIn,
  startTestApi,
  type TestApi,
} from "./support.js";

const UNTRUSTED_ORIGIN = "http://127.0.0.1:3000";

let api: TestApi;
let observer: Observer;

function sessionToken(cookie: string): string {
  const pair = cookie
    .split("; ")
    .find((part) => part.startsWith("supplier-disruption.session_token="));
  return decodeURIComponent(pair?.split("=")[1] ?? "").split(".")[0] ?? "";
}

async function sessionRows(token: string) {
  return observer.query(`SELECT 1 FROM auth.session WHERE token = $1`, [token]);
}

async function managerSessionCount(): Promise<number> {
  const [row] = await observer.query<{ count: string }>(
    `SELECT count(*) FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`,
    [credentials.manager().email],
  );
  return Number(row?.count ?? 0);
}

async function sessionStatus(cookie: string): Promise<number> {
  return (await fetch(`${api.baseUrl}/api/session`, { headers: { cookie } })).status;
}

beforeAll(async () => {
  api = await startTestApi();
  observer = new Observer();
});

afterAll(async () => {
  await api?.close();
  await observer?.close();
});

describe("G4 Better Auth origin and CSRF checks", () => {
  it("run under NODE_ENV=test, where Better Auth would otherwise skip them", () => {
    // This file's other tests only prove the checks if this precondition holds.
    expect(process.env.NODE_ENV).toBe("test");
  });

  it.each([
    ["an untrusted Origin", { origin: UNTRUSTED_ORIGIN }],
    ["no Origin", {}],
  ])(
    "sign-out with a valid cookie and %s gets 403 and the session survives",
    async (_label, headers) => {
      const { cookie } = await signIn(api.baseUrl, credentials.manager());
      const token = sessionToken(cookie);
      expect(await sessionRows(token)).toHaveLength(1);

      const response = await fetch(`${api.baseUrl}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...headers },
        body: "{}",
      });
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await sessionRows(token)).toHaveLength(1);
      expect(await sessionStatus(cookie)).toBe(200);
    },
  );

  it("sign-in from an untrusted Origin gets 403 and creates no session", async () => {
    const before = await managerSessionCount();
    const response = await fetch(`${api.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: UNTRUSTED_ORIGIN },
      body: JSON.stringify(credentials.manager()),
    });
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await managerSessionCount()).toBe(before);
  });

  it("sign-in carrying a cookie from an untrusted Origin gets 403", async () => {
    const { cookie } = await signIn(api.baseUrl, credentials.manager());
    const before = await managerSessionCount();
    const response = await fetch(`${api.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: UNTRUSTED_ORIGIN, cookie },
      body: JSON.stringify(credentials.manager()),
    });
    expect(response.status).toBe(403);
    expect(await managerSessionCount()).toBe(before);
  });
});

describe("G4 sessions are read from PostgreSQL", () => {
  it("cookie caching is off in the auth options", async () => {
    // The adapter connects lazily; this pool is never used.
    const pool = new pg.Pool();
    const options = authOptions(
      { appOrigin: APP_ORIGIN, secret: "x".repeat(32), production: false, allowSignUp: false },
      drizzle(pool),
    );
    await pool.end();
    expect(options.session.cookieCache.enabled).toBe(false);
  });

  it("sign-in sets no session data cookie, and deleting the session row revokes it at once", async () => {
    const { cookie, setCookies } = await signIn(api.baseUrl, credentials.manager());
    expect(setCookies.map((value) => value.split("=")[0])).toEqual([
      "supplier-disruption.session_token",
    ]);
    expect(await sessionStatus(cookie)).toBe(200);

    await observer.query(`DELETE FROM auth.session WHERE token = $1`, [sessionToken(cookie)]);
    expect(await sessionStatus(cookie)).toBe(401);
  });
});

describe("G4 secure cookies follow the application origin", () => {
  it("an http origin sets cookies without Secure", async () => {
    const { setCookies } = await signIn(api.baseUrl, credentials.manager());
    for (const value of setCookies) {
      expect(value).not.toMatch(/;\s*Secure/i);
      expect(value.startsWith("__Secure-")).toBe(false);
    }
  });

  it("an https origin sets Secure, __Secure- prefixed cookies", async () => {
    const httpsOrigin = "https://supplier-disruption.example.test";
    const secureApi = await startTestApi(undefined, { appOrigin: httpsOrigin });
    try {
      const response = await fetch(`${secureApi.baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: httpsOrigin },
        body: JSON.stringify(credentials.manager()),
      });
      expect(response.status).toBe(200);
      const setCookies = response.headers.getSetCookie();
      expect(setCookies.length).toBeGreaterThan(0);
      for (const value of setCookies) {
        expect(value.startsWith("__Secure-supplier-disruption.")).toBe(true);
        expect(value).toMatch(/;\s*Secure/i);
      }
    } finally {
      await secureApi.close();
    }
  });
});

describe("client address used by Better Auth", () => {
  it("is the connecting address, never a client-supplied X-Forwarded-For", async () => {
    const forged = "203.0.113.7";
    const response = await fetch(`${api.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP_ORIGIN,
        "x-forwarded-for": forged,
      },
      body: JSON.stringify(credentials.manager()),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const [row] = await observer.query<{ ip_address: string }>(
      `SELECT ip_address FROM auth.session WHERE token = $1`,
      [sessionToken(cookie)],
    );
    expect(row?.ip_address).toBe("127.0.0.1");
  });
});
