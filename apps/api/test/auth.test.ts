import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  ORG_A,
  Observer,
  command,
  credentials,
  signIn,
  startTestApi,
  submit,
  type TestApi,
} from "./support.js";

const PREFIX = "supplier-disruption.";
// Another local project's Better Auth cookie on the same host, with its default name.
const UNRELATED_COOKIE = "better-auth.session_token=another-project-session-value";

let api: TestApi;
let observer: Observer;

function cookieNames(setCookies: string[]): string[] {
  return setCookies.map((value) => value.split("=")[0] ?? "");
}

async function session(cookie: string | undefined) {
  const response = await fetch(`${api.baseUrl}/api/session`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  api = await startTestApi();
  observer = new Observer();
});

afterAll(async () => {
  await api?.close();
  await observer?.close();
});

describe("G4 authentication", () => {
  it.each([
    ["manager", credentials.manager, "manager"],
    ["buyer", credentials.buyer, "buyer"],
  ] as const)(
    "the seeded %s signs in through /api/auth and sees their role",
    async (_label, user, role) => {
      const { cookie, setCookies } = await signIn(api.baseUrl, user());
      expect(setCookies.length).toBeGreaterThan(0);
      for (const name of cookieNames(setCookies)) {
        expect(name.startsWith(PREFIX), name).toBe(true);
      }
      for (const value of setCookies) {
        expect(value).toMatch(/HttpOnly/i);
      }
      const result = await session(cookie);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        user: { email: user().email },
        memberships: [{ organizationId: ORG_A.id, role }],
      });
    },
  );

  it("a missing session gets 401 for the session read and the command", async () => {
    expect((await session(undefined)).status).toBe(401);
    const result = await submit(api.baseUrl, command(ORG_A.id));
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "unauthenticated" });
  });

  it("a tampered session cookie gets 401", async () => {
    const { cookie } = await signIn(api.baseUrl, credentials.manager());
    const [name, value = ""] = cookie.split("=");
    // Flip the token half and, separately, the signature half.
    const [token = "", signature = ""] = decodeURIComponent(value).split(".");
    const flip = (text: string) => text.slice(0, -1) + (text.endsWith("A") ? "B" : "A");
    for (const tampered of [`${flip(token)}.${signature}`, `${token}.${flip(signature)}`]) {
      const forged = `${name}=${encodeURIComponent(tampered)}`;
      expect((await session(forged)).status).toBe(401);
      expect((await submit(api.baseUrl, command(ORG_A.id), { cookie: forged })).status).toBe(401);
    }
  });

  it("a signed-out session gets 401 and its session row is gone", async () => {
    const { cookie } = await signIn(api.baseUrl, credentials.manager());
    const token = decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0];
    expect(
      await observer.query(`SELECT 1 FROM auth.session WHERE token = $1`, [token]),
    ).toHaveLength(1);

    const signOut = await fetch(`${api.baseUrl}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        cookie: `${cookie}; ${UNRELATED_COOKIE}`,
        origin: APP_ORIGIN,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(signOut.status).toBe(200);
    // Clearing touches only this project's prefixed cookies.
    const cleared = cookieNames(signOut.headers.getSetCookie());
    expect(cleared.length).toBeGreaterThan(0);
    for (const name of cleared) {
      expect(name.startsWith(PREFIX), name).toBe(true);
    }

    expect((await session(cookie)).status).toBe(401);
    expect(
      await observer.query(`SELECT 1 FROM auth.session WHERE token = $1`, [token]),
    ).toHaveLength(0);
  });

  it("runtime sign-up is disabled", async () => {
    const email = `signup-${Date.now()}@fixture.local`;
    const response = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ email, password: "a-long-enough-password", name: "Should Not Exist" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(
      await observer.query(`SELECT 1 FROM auth."user" WHERE email = $1`, [email]),
    ).toHaveLength(0);
  });

  it("sign-in leaves another project's default-named cookie untouched", async () => {
    const response = await fetch(`${api.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie: UNRELATED_COOKIE },
      body: JSON.stringify(credentials.manager()),
    });
    expect(response.status).toBe(200);
    const names = cookieNames(response.headers.getSetCookie());
    expect(names).not.toContain("better-auth.session_token");
    for (const name of names) {
      expect(name.startsWith(PREFIX), name).toBe(true);
    }
  });

  it("a valid session token under the default cookie name is not accepted", async () => {
    const { cookie } = await signIn(api.baseUrl, credentials.manager());
    const value = cookie.split("=")[1];
    expect((await session(`better-auth.session_token=${value}`)).status).toBe(401);
  });
});
