// P2 cookie multiplicity, P3 authorization, P4 internal boundary and
// P7 leakage, through the Next proxy on the published port of one disposable
// project, compared with the API's loopback listener inside the container.
// ADR 0020 adds session refresh through the rewrite and per-account sign-in
// limits (ADR 0020).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COOKIE_PREFIX,
  RECEIPT_ROUTE,
  SESSION_COOKIE,
  SignInPacer,
  apiLogs,
  buyerSignIn,
  canary,
  cookieHeader,
  httpCall,
  inContainer,
  managerSignIn,
  openStream,
  parseSetCookie,
  passwords,
  pilotCommand,
  rawExchange,
  signInThroughProxy,
  submitThroughProxy,
} from "./gates.mjs";
import {
  FIXTURE_MANAGER_EMAIL,
  FIXTURE_ORGANIZATION_ID,
  Project,
  context,
  record,
  waitFor,
} from "./support.mjs";

const project = new Project("proxy");
const pacer = new SignInPacer();
const UNTRUSTED_ORIGIN = "http://127.0.0.1.evil.example";
// Another application's Better Auth cookie on the same host, under the default name.
const UNRELATED_COOKIE = "better-auth.session_token=unrelated-application-value";

let manager;

beforeAll(async () => {
  await project.start();
  manager = await managerSignIn(project, pacer);
  expect(manager.status).toBe(200);
});

afterAll(async () => {
  await project.remove();
});

const counts = async () =>
  (
    await project.sql(
      `SELECT (SELECT count(*) FROM app.pilot_operation)::int AS operations,
              (SELECT count(*) FROM pgboss.job)::int AS jobs,
              (SELECT count(*) FROM auth.session)::int AS sessions`,
    )
  )[0];

/** The session token is the part of the signed cookie value before the signature. */
const sessionToken = (cookie) =>
  decodeURIComponent(/supplier-disruption\.session_token=([^;]+)/.exec(cookie)[1]).split(".")[0];

const sessionRows = async (cookie) =>
  (await project.sql(`SELECT id FROM auth.session WHERE token = '${sessionToken(cookie)}'`)).length;

/** Name, flags and attribute names of a Set-Cookie header; values that vary per response are dropped. */
function shape(header) {
  const { name, attributes } = parseSetCookie(header);
  const kept = Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, key === "expires" ? "<date>" : value]),
  );
  return { name, attributes: kept };
}

describe("P2 cookie multiplicity and attributes", () => {
  it("forwards every Set-Cookie of a rememberMe=false sign-in separately and unchanged", async () => {
    await pacer.slot();
    const direct = await inContainer(
      project,
      `const input = JSON.parse(await new Response(process.stdin).text());
       const r = await fetch("http://127.0.0.1:3001/api/auth/sign-in/email", {
         method: "POST",
         headers: { "content-type": "application/json", origin: input.origin },
         body: JSON.stringify({ email: input.email, password: input.password, rememberMe: false }),
       });
       console.log(JSON.stringify({ status: r.status, setCookies: r.headers.getSetCookie() }));`,
      { origin: project.origin, email: FIXTURE_MANAGER_EMAIL, password: passwords.manager() },
    );
    const proxied = await managerSignIn(project, pacer, { rememberMe: false });
    record(`P2 direct Set-Cookie shapes: ${JSON.stringify(direct.setCookies.map(shape))}`);
    record(`P2 proxied Set-Cookie shapes: ${JSON.stringify(proxied.setCookies.map(shape))}`);

    expect(direct.status).toBe(200);
    expect(proxied.status).toBe(200);
    // The premise: this real auth response sets at least two distinct cookies.
    const names = direct.setCookies.map((header) => parseSetCookie(header).name);
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(SESSION_COOKIE);
    // Separate raw headers through the proxy, never folded into one.
    expect(proxied.setCookies).toHaveLength(direct.setCookies.length);
    expect(proxied.setCookies.map(shape)).toEqual(direct.setCookies.map(shape));
    for (const header of proxied.setCookies) {
      const { name, attributes } = parseSetCookie(header);
      expect(name.startsWith(COOKIE_PREFIX)).toBe(true);
      expect(attributes.httponly).toBe(true);
      expect(attributes.samesite).toBe("Lax");
      expect(attributes.path).toBe("/");
      expect(attributes.secure).toBeUndefined();
    }

    const session = await httpCall(project.origin, {
      path: "/api/session",
      headers: { cookie: proxied.cookie },
    });
    expect(session.status).toBe(200);
  });

  it("leaves another application's default-named cookie untouched on sign-in and sign-out", async () => {
    const signedIn = await signInThroughProxy(project, pacer, {
      email: FIXTURE_MANAGER_EMAIL,
      password: passwords.manager(),
      rememberMe: false,
    });
    expect(signedIn.status).toBe(200);
    const signOut = await httpCall(project.origin, {
      method: "POST",
      path: "/api/auth/sign-out",
      headers: {
        "content-type": "application/json",
        "content-length": 2,
        origin: project.origin,
        cookie: `${UNRELATED_COOKIE}; ${signedIn.cookie}`,
      },
      body: "{}",
    });
    expect(signOut.status).toBe(200);
    record(`P2 sign-out Set-Cookie shapes: ${JSON.stringify(signOut.setCookies.map(shape))}`);
    // Sign-out clears this application's cookies, each in its own header.
    expect(signOut.setCookies.length).toBeGreaterThanOrEqual(2);
    for (const response of [signedIn, signOut]) {
      for (const header of response.setCookies) {
        expect(parseSetCookie(header).name.startsWith(COOKIE_PREFIX), header).toBe(true);
      }
    }
    expect(await sessionRows(signedIn.cookie)).toBe(0);
  });

  it("re-sends a refreshed session cookie through the rewrite, with the same token", async () => {
    const signedIn = await managerSignIn(project, pacer);
    expect(signedIn.status).toBe(200);
    const token = sessionToken(signedIn.cookie);
    // Due for refresh: Better Auth refreshes once updateAge (1 day) of the 7-day lifetime passed.
    await project.execSql(
      `UPDATE auth.session SET expires_at = now() + interval '5 days' WHERE token = '${token}'`,
    );
    const refreshed = await httpCall(project.origin, {
      path: "/api/auth/get-session",
      headers: { cookie: signedIn.cookie },
    });
    record(`P2 refresh Set-Cookie shapes: ${JSON.stringify(refreshed.setCookies.map(shape))}`);
    expect(refreshed.status).toBe(200);
    const session = refreshed.setCookies.find((h) => parseSetCookie(h).name === SESSION_COOKIE);
    expect(session).toBeDefined();
    const { attributes } = parseSetCookie(session);
    expect(attributes["max-age"]).toBe("604800");
    expect(attributes.httponly).toBe(true);
    expect(attributes.samesite).toBe("Lax");
    const cookie = cookieHeader([session]);
    expect(sessionToken(cookie)).toBe(token);
    const [row] = await project.sql(
      `SELECT expires_at > now() + interval '6 days 23 hours' AS extended FROM auth.session WHERE token = '${token}'`,
    );
    expect(row.extended).toBe(true);
    const after = await httpCall(project.origin, { path: "/api/session", headers: { cookie } });
    expect(after.status).toBe(200);
  });
});

describe("P3 authorization through the proxy", () => {
  it("rejects a missing or tampered session with 401", async () => {
    const operation = await submitThroughProxy(project, manager.cookie, pilotCommand());
    expect(operation.status).toBe(202);
    const id = operation.json.operationId;
    const tampered = manager.cookie.replace(
      /(supplier-disruption\.session_token=[^;]*?)(.)(;|$)/,
      (_all, head, last, tail) => `${head}${last === "A" ? "B" : "A"}${tail}`,
    );
    expect(tampered).not.toBe(manager.cookie);
    for (const cookie of [undefined, tampered]) {
      for (const path of ["/api/session", `/api/pilot/operations/${id}`]) {
        const response = await httpCall(project.origin, {
          path,
          headers: cookie === undefined ? {} : { cookie },
        });
        expect(response.status, `${path} ${cookie === undefined ? "anonymous" : "tampered"}`).toBe(
          401,
        );
      }
      const before = await counts();
      const command = pilotCommand();
      expect((await submitThroughProxy(project, cookie, command)).status).toBe(401);
      expect((await counts()).operations).toBe(before.operations);
      expect((await counts()).jobs).toBe(before.jobs);
    }
  });

  it("refuses the manager-only command to a buyer and ignores forged identity headers", async () => {
    const buyer = await buyerSignIn(project, pacer);
    expect(buyer.status).toBe(200);
    const [{ id: managerId }] = await project.sql(
      `SELECT id FROM auth."user" WHERE email = '${FIXTURE_MANAGER_EMAIL}'`,
    );
    const forged = {
      "x-user-id": managerId,
      "x-user-email": FIXTURE_MANAGER_EMAIL,
      "x-user-role": "manager",
      "x-forwarded-user": FIXTURE_MANAGER_EMAIL,
      "x-organization-id": FIXTURE_ORGANIZATION_ID,
    };
    const before = await counts();
    const asBuyer = pilotCommand();
    const buyerResult = await submitThroughProxy(project, buyer.cookie, asBuyer);
    expect(buyerResult.status).toBe(403);
    expect(buyerResult.json).toEqual({ error: "forbidden" });
    expect((await submitThroughProxy(project, buyer.cookie, pilotCommand(), forged)).status).toBe(
      403,
    );
    expect((await submitThroughProxy(project, undefined, pilotCommand(), forged)).status).toBe(401);
    const session = await httpCall(project.origin, { path: "/api/session", headers: forged });
    expect(session.status).toBe(401);
    const after = await counts();
    expect(after.operations).toBe(before.operations);
    expect(after.jobs).toBe(before.jobs);
    expect(
      await project.sql(
        `SELECT 1 FROM app.pilot_operation WHERE operation_id = '${asBuyer.operationId}'`,
      ),
    ).toEqual([]);
  });

  it("rejects an untrusted Origin on the mutation with no new operation or job", async () => {
    const before = await counts();
    const command = pilotCommand();
    const result = await submitThroughProxy(project, manager.cookie, command, {
      origin: UNTRUSTED_ORIGIN,
    });
    expect(result.status).toBe(403);
    expect(result.json).toEqual({ error: "origin_rejected" });
    const after = await counts();
    expect(after.operations).toBe(before.operations);
    expect(after.jobs).toBe(before.jobs);
  });

  it("rejects an untrusted Origin on sign-in with no session and no auth cookie", async () => {
    const before = await counts();
    const result = await managerSignIn(project, pacer, { origin: UNTRUSTED_ORIGIN });
    expect(result.status).toBe(403);
    expect(result.setCookies.filter((header) => header.startsWith(COOKIE_PREFIX))).toEqual([]);
    expect((await counts()).sessions).toBe(before.sessions);
  });

  it("limits sign-in per account, never per forged X-Forwarded-For, and leaves other users signing in", async () => {
    // Each attempt claims another client address. Were that header trusted,
    // each would get a fresh bucket and every attempt would be allowed.
    const forged = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"];
    await pacer.fresh();
    const results = [];
    for (const [index, address] of forged.entries()) {
      // The first three spend the window's slots; the fourth goes straight out.
      results.push(
        await managerSignIn(project, index < 3 ? pacer : null, {
          headers: { "x-forwarded-for": address },
        }),
      );
    }
    record(
      `P3 sign-ins with forged X-Forwarded-For: ${JSON.stringify(results.map((r) => r.status))}`,
    );
    expect(results.map((result) => result.status)).toEqual([200, 200, 200, 429]);
    expect(results[3].setCookies.filter((header) => header.startsWith(COOKIE_PREFIX))).toEqual([]);
    const [row] = await project.sql(
      `SELECT ip_address FROM auth.session WHERE token = '${sessionToken(results[0].cookie)}'`,
    );
    expect(row.ip_address).toBe("127.0.0.1");
    expect(forged).not.toContain(row.ip_address);
    // Another user, through the same proxy address, is not locked out (ADR 0020).
    const buyer = await buyerSignIn(project, null);
    record(`P3 another account straight after the 429: ${buyer.status}`);
    expect(buyer.status).toBe(200);
  });

  it("rejects an untrusted Origin on sign-out and keeps the session usable", async () => {
    const signedIn = await managerSignIn(project, pacer);
    expect(signedIn.status).toBe(200);
    expect(await sessionRows(signedIn.cookie)).toBe(1);
    const result = await httpCall(project.origin, {
      method: "POST",
      path: "/api/auth/sign-out",
      headers: {
        "content-type": "application/json",
        "content-length": 2,
        origin: UNTRUSTED_ORIGIN,
        cookie: signedIn.cookie,
      },
      body: "{}",
    });
    expect(result.status).toBe(403);
    expect(result.setCookies).toEqual([]);
    expect(await sessionRows(signedIn.cookie)).toBe(1);
    const session = await httpCall(project.origin, {
      path: "/api/session",
      headers: { cookie: signedIn.cookie },
    });
    expect(session.status).toBe(200);
  });
});

describe("P4 internal boundary through the proxy", () => {
  it("reaches the receipt handler only canonically on loopback, never through the proxy", async () => {
    // A seeded operation with no active job: submitted, then completed by the worker.
    const submitted = await submitThroughProxy(project, manager.cookie, pilotCommand());
    expect(submitted.status).toBe(202);
    const id = submitted.json.operationId;
    const row = await waitFor(
      "the receipt",
      async () =>
        (
          await project.sql(
            `SELECT job_id, receipt_id FROM app.pilot_operation WHERE operation_id = '${id}' AND receipt_id IS NOT NULL`,
          )
        )[0],
      { timeoutMs: 30_000 },
    );
    const body = JSON.stringify({ jobId: row.job_id, workerBootId: crypto.randomUUID() });
    const canonical = `/internal/pilot/operations/${id}/receipt`;
    const startedAt = new Date();
    const token = canary("worker_service_token");

    // Positive control on the API's loopback listener, token read from the mounted secret.
    const control = await inContainer(
      project,
      `import { readFileSync } from "node:fs";
       const input = JSON.parse(await new Response(process.stdin).text());
       const token = readFileSync("/run/secrets/worker_service_token", "utf8").trim();
       const r = await fetch("http://127.0.0.1:3001" + input.path, {
         method: "POST",
         headers: { authorization: "Bearer " + token, "content-type": "application/json" },
         body: input.body,
       });
       // Only whether the proxied requests below carry this same token.
       const sameToken = token === input.proxiedToken;
       console.log(JSON.stringify({ status: r.status, body: await r.json(), sameToken }));`,
      { path: canonical, body, proxiedToken: token },
    );
    expect(control).toEqual({ status: 409, body: { error: "job_not_matched" }, sameToken: true });
    const controlLine = await waitFor(
      "the control's route log line",
      async () =>
        (await apiLogs(project)).find(
          (line) => line.msg === "request" && line.time >= startedAt && line.target === canonical,
        ),
      { timeoutMs: 5_000, intervalMs: 200 },
    );
    expect(controlLine.route).toBe(RECEIPT_ROUTE);

    const tail = `internal/pilot/operations/${id}/receipt`;
    const targets = [
      `/${tail}`,
      `/api/%2e%2e/${tail}`,
      `/api/%2E%2E/${tail}`,
      `/api/..%2f${tail}`,
      `/api/%2e%2e%2f${tail}`,
      `/api/%252e%252e%252f${tail}`,
      `/api/../${tail}`,
    ];
    const outcomes = [];
    for (const target of targets) {
      const text =
        `POST ${target} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${project.port}\r\n` +
        `Authorization: Bearer ${token}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`;
      const result = await rawExchange(project.port, text);
      // The exact bytes went out: no client normalized the target.
      expect(result.sent.equals(result.intended)).toBe(true);
      expect(result.bytesWritten).toBe(result.intended.length);
      const responseBody = result.response.slice(result.response.indexOf("\r\n\r\n") + 4);
      const source = responseBody.includes('"Not Found"') ? "api-unmatched" : "next";
      outcomes.push({ target, status: result.status, source });
      expect(result.status, target).toBe(404);
      expect(responseBody).not.toContain("job_not_matched");
      expect(responseBody).not.toContain("service_token_required");
      expect(responseBody).not.toContain("browser_session_rejected");
    }
    record(`P4 proxied targets: ${JSON.stringify(outcomes)}`);

    await new Promise((resolve) => setTimeout(resolve, 500));
    const lines = (await apiLogs(project)).filter(
      (line) => line.msg === "request" && line.time >= startedAt,
    );
    const receiptMatches = lines.filter((line) => line.route === RECEIPT_ROUTE);
    // Only the positive control reached the receipt route.
    expect(receiptMatches.map((line) => line.target)).toEqual([canonical]);
    const reached = lines.filter((line) => line.target !== canonical);
    record(
      `P4 proxied requests seen by the API: ${JSON.stringify(reached.map((l) => ({ route: l.route, target: l.target })))}`,
    );
    for (const line of reached) expect(line.route, line.target).toBe("none");
    // No receipt attempt was recorded by any of them.
    const attempts = await project.sql(
      `SELECT count(*)::int AS n FROM app.pilot_receipt_attempt WHERE operation_id = '${id}' AND observed_at >= '${startedAt.toISOString()}'`,
    );
    expect(attempts[0].n).toBe(0);
  });
});

describe("P7 stream and bundle leakage", () => {
  it("keeps every secret value out of stream payloads, page HTML and the served bundle", async () => {
    const { canaries, secretFiles } = context();
    const values = [...canaries.map((c) => c.value), ...secretFiles.map((f) => f.value)];
    expect(values.length).toBeGreaterThan(10);

    const submitted = await submitThroughProxy(project, manager.cookie, pilotCommand());
    expect(submitted.status).toBe(202);
    const id = submitted.json.operationId;
    const stream = openStream(project.origin, `/api/pilot/operations/${id}/events`, manager.cookie);
    expect((await stream.ended).how).toBe("end");
    expect(stream.events).toHaveLength(5);
    const payload = stream.events.map((event) => JSON.stringify(event.data)).join("\n");
    for (const event of stream.events) {
      expect(Object.keys(event.data).sort()).toEqual([
        "emittedAt",
        "final",
        "operationId",
        "seq",
        "state",
      ]);
    }
    // No internal identifier beyond the operation ID.
    const [ids] = await project.sql(
      `SELECT o.job_id, o.receipt_id, o.submitted_by, s.token
         FROM app.pilot_operation o, auth.session s
        WHERE o.operation_id = '${id}' AND s.token = '${sessionToken(manager.cookie)}'`,
    );
    for (const value of Object.values(ids).filter(Boolean)) expect(payload).not.toContain(value);

    const signedOut = await httpCall(project.origin, { path: "/" });
    const signedIn = await httpCall(project.origin, {
      path: "/",
      headers: { cookie: manager.cookie },
    });
    expect(signedOut.status).toBe(200);
    expect(signedIn.status).toBe(200);
    expect(signedIn.text).toContain("Pilot operation");
    const html = signedOut.text + signedIn.text;
    const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) ?? [])];
    expect(assets.some((asset) => asset.endsWith(".js"))).toBe(true);
    let bundle = "";
    for (const asset of assets) {
      const response = await httpCall(project.origin, { path: asset });
      expect(response.status, asset).toBe(200);
      bundle += response.text;
    }
    record(
      `P7 checked ${values.length} secret values against ${assets.length} assets, 2 pages and ${stream.events.length} events`,
    );
    for (const value of values) {
      expect(payload).not.toContain(value);
      expect(html).not.toContain(value);
      expect(bundle).not.toContain(value);
    }
  });
});

describe("P7 server logs", () => {
  // Runs last in this file: by now the gates above have sent passwords,
  // session cookies and the worker token through the proxy and the API.
  it("keeps every secret value out of the container log", async () => {
    const { canaries, secretFiles } = context();
    const values = [
      ...canaries.map((c) => c.value),
      ...secretFiles.map((f) => f.value),
      sessionToken(manager.cookie),
      ...manager.cookie.split("; ").map((pair) => pair.slice(pair.indexOf("=") + 1)),
    ];
    const lines = await project.logLines();
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("/api/auth/sign-in/email");
    expect(text).toContain("/internal/pilot/operations/");
    record(`P7 scanned ${lines.length} container log lines for ${values.length} secret values`);
    // A boolean, so a failure never prints the value or the log.
    for (const [index, value] of values.entries()) {
      expect(text.includes(value), `secret value ${index} in the log`).toBe(false);
    }
  });
});
