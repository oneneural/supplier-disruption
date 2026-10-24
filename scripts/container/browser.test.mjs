// P1 browser flow: Playwright drives Chromium (headless shell) at the
// app origin of one disposable project. Every request to another origin is
// blocked and fails the test; so does any non-2xx response the page receives.
// ADR 0020 adds the page's own session refresh and stream resume.
/* global window, document, MutationObserver -- page.evaluate callbacks run in the browser */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COOKIE_PREFIX, SESSION_COOKIE, passwords } from "./gates.mjs";
import { FIXTURE_MANAGER_EMAIL, Project, context, record } from "./support.mjs";

const require = createRequire(import.meta.url);
const project = new Project("browser");
const UNRELATED = { name: "better-auth.session_token", value: "unrelated-application-value" };

let browser;

beforeAll(async () => {
  await project.start();
  browser = await chromium.launch({ headless: true });
  const { version } = JSON.parse(
    await readFile(join(dirname(require.resolve("playwright")), "package.json"), "utf8"),
  );
  // headless: true runs Playwright's chromium-headless-shell build of this version.
  record(`P1 Playwright ${version}, Chromium headless shell ${browser.version()}`);
});

/** A context that reaches only the app origin, signed in as the fixture manager on the queue. */
async function signedInPage({ clock = false } = {}) {
  const browserContext = await browser.newContext({ baseURL: project.origin });
  const blocked = [];
  await browserContext.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === project.origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const page = await browserContext.newPage();
  // Installed before the first page script runs, so the page's timers use it.
  if (clock) await page.clock.install();
  await page.goto("/");
  await page.getByLabel("Fixture identity").selectOption(FIXTURE_MANAGER_EMAIL);
  await page.getByLabel("Password").fill(passwords.manager());
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Exception queue" }).waitFor();
  return { browserContext, page, blocked };
}

const tokenOf = (cookie) => decodeURIComponent(cookie.value).split(".")[0];

afterAll(async () => {
  await browser?.close();
  await project.remove();
});

describe("P1 browser flow", () => {
  it("signs in, renders the stream progressively with its receipt, and signs out", async () => {
    const browserContext = await browser.newContext({ baseURL: project.origin });
    let phase = "load";
    const blocked = [];
    const failed = [];
    const responses = [];
    // No external sites: only the app origin is reachable from the page.
    await browserContext.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === project.origin) return route.continue();
      blocked.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    // Another application's default-named cookie on the same host.
    await browserContext.addCookies([{ ...UNRELATED, url: project.origin }]);
    const page = await browserContext.newPage();
    page.on("response", (response) => {
      responses.push({
        status: response.status(),
        url: response.url(),
        type: response.request().resourceType(),
        phase,
      });
      if (response.status() < 200 || response.status() > 299) {
        failed.push(`${response.status()} ${response.url()}`);
      }
    });
    const cancelled = [];
    page.on("requestfailed", (request) => {
      const failure = `${phase}: ${request.resourceType()} ${request.url()} ${request.failure()?.errorText}`;
      // Next's router cancels its refresh (RSC) fetch after the 2xx response
      // has arrived (observed for router.refresh() in Next 16.4.2). Anything
      // that failed without a response, or any other kind of request, fails.
      const rsc =
        request.resourceType() === "fetch" && new URL(request.url()).searchParams.has("_rsc");
      const delivered = responses.some(
        (r) => r.url === request.url() && r.phase === phase && r.status >= 200 && r.status <= 299,
      );
      if (rsc && delivered && request.failure()?.errorText === "net::ERR_ABORTED")
        cancelled.push(failure);
      else failed.push(`failed during ${failure}`);
    });

    // Sign-in page and its static assets from the standalone server.
    await page.goto("/");
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    const statics = responses.filter((r) => new URL(r.url).pathname.startsWith("/_next/static/"));
    expect(statics.some((r) => r.type === "script")).toBe(true);
    expect(statics.some((r) => r.type === "stylesheet")).toBe(true);
    for (const asset of statics) expect(asset.status, asset.url).toBe(200);

    await page.getByLabel("Fixture identity").selectOption(FIXTURE_MANAGER_EMAIL);
    await page.getByLabel("Password").fill(passwords.manager());
    phase = "sign-in";
    await page.getByRole("button", { name: "Sign in" }).click();
    // Sign-in lands on the workbench queue (ADR 0010); the pilot has its own page.
    await page.getByRole("heading", { name: "Exception queue" }).waitFor();
    phase = "pilot page";
    await page.getByRole("link", { name: "Pilot operation" }).click();
    await page.getByRole("heading", { name: "Pilot operation" }).waitFor();

    // Observe the DOM from inside the page: when each event row appears,
    // how many rows exist then and the stream state shown at that moment.
    await page.evaluate(() => {
      const log = { clickAt: null, seen: [] };
      window.__sdStream = log;
      document
        .querySelector("form button[type=submit]")
        .addEventListener("click", () => (log.clickAt = performance.now()), { capture: true });
      new MutationObserver(() => {
        const rows = [...document.querySelectorAll("[data-event-seq]")];
        const state = document
          .querySelector("[data-stream-state]")
          ?.getAttribute("data-stream-state");
        for (const row of rows) {
          const seq = Number(row.getAttribute("data-event-seq"));
          if (!log.seen.some((entry) => entry.seq === seq)) {
            log.seen.push({ seq, at: performance.now(), rows: rows.length, state });
          }
        }
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });

    phase = "submit";
    await page.getByRole("button", { name: "Submit pilot operation" }).click();
    await page.locator('[data-stream-state="ended"]').waitFor({ timeout: 15_000 });
    await page.locator("[data-receipt-id]").waitFor({ timeout: 15_000 });
    const { clickAt, seen } = await page.evaluate(() => window.__sdStream);
    record(
      `P1 DOM event rows (ms after the submit click): ${JSON.stringify(seen.map((e) => ({ seq: e.seq, ms: Math.round(e.at - clickAt), rows: e.rows, state: e.state })))}`,
    );

    expect(seen.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(seen[0].at - clickAt).toBeLessThanOrEqual(1_500);
    // Progressive: rows appeared one by one while the stream was still open.
    for (const entry of seen.slice(0, 4)) {
      expect(entry.rows, `rows when event ${entry.seq} appeared`).toBe(entry.seq);
      expect(entry.state).toBe("open");
    }
    expect(seen[4].at - seen[0].at).toBeGreaterThanOrEqual(3_200);
    await expect(page.locator("[data-event-seq]").count()).resolves.toBe(5);
    expect(await page.locator("[data-receipt-id]").textContent()).toMatch(
      /^Receipt [0-9a-f-]{36} recorded at /,
    );

    const signedIn = await browserContext.cookies();
    expect(signedIn.find((cookie) => cookie.name === SESSION_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
      path: "/",
    });

    phase = "sign-out";
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    const signedOut = await browserContext.cookies();
    expect(signedOut.filter((cookie) => cookie.name.startsWith(COOKIE_PREFIX))).toEqual([]);
    expect(signedOut.find((cookie) => cookie.name === UNRELATED.name)?.value).toBe(UNRELATED.value);
    phase = "after sign-out";
    const protectedRead = await page.request.get("/api/session");
    expect(protectedRead.status()).toBe(401);

    // P7 in the browser: nothing the page received carries a secret value.
    const { canaries, secretFiles } = context();
    const values = [...canaries.map((c) => c.value), ...secretFiles.map((f) => f.value)];
    const html = await page.content();
    for (const value of values) expect(html).not.toContain(value);

    record(
      `P1 responses: ${JSON.stringify(responses.map((r) => `${r.phase} ${r.type} ${r.status} ${new URL(r.url).pathname}${new URL(r.url).search.slice(0, 6)}`))}`,
    );
    record(
      `P1 page responses: ${responses.length}, blocked external requests: ${blocked.length}, non-2xx or failed: ${failed.length}, ` +
        `RSC fetches cancelled after a 2xx response: ${JSON.stringify(cancelled)}`,
    );
    expect(blocked).toEqual([]);
    expect(failed).toEqual([]);
    await browserContext.close();
  });
});

describe("P1 session refresh and stream resume in the browser", () => {
  it("refreshes a due session through the rewrite while the page is used, never while idle", async () => {
    const { browserContext, page, blocked } = await signedInPage({ clock: true });
    const before = (await browserContext.cookies()).find((c) => c.name === SESSION_COOKIE);
    const token = tokenOf(before);
    // Due for refresh: Better Auth refreshes once updateAge (1 day) of the 7-day lifetime passed.
    await project.execSql(
      `UPDATE auth.session SET expires_at = now() + interval '5 days' WHERE token = '${token}'`,
    );
    const calls = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/auth/get-session") calls.push(request.url());
    });

    // The page load counts as use; the first due check calls the refresh route.
    const refreshing = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/get-session",
    );
    await page.clock.fastForward("01:01");
    const response = await refreshing;
    expect(response.status()).toBe(200);
    expect((await response.json())?.user?.email).toBe(FIXTURE_MANAGER_EMAIL);
    const setCookie = (await response.headerValue("set-cookie")) ?? "";
    record(`P1 refresh Set-Cookie attributes: ${setCookie.replace(/=[^;\n]+/, "=<redacted>")}`);
    expect(setCookie).toMatch(/^supplier-disruption\.session_token=[^;]+;.*Max-Age=604800/m);
    const after = (await browserContext.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(tokenOf(after)).toBe(token);
    expect(after).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect(after.expires).toBeGreaterThanOrEqual(before.expires);
    const [row] = await project.sql(
      `SELECT expires_at > now() + interval '6 days 23 hours' AS extended FROM auth.session WHERE token = '${token}'`,
    );
    expect(row.extended).toBe(true);

    // Six idle minutes: no call. Then use the page and the next check calls again.
    await page.clock.fastForward("06:00");
    await page.waitForTimeout(500);
    expect(calls).toHaveLength(1);
    await page.mouse.move(20, 20);
    await page.mouse.move(60, 60);
    const again = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/auth/get-session",
    );
    await page.clock.fastForward("01:01");
    expect((await again).status()).toBe(200);
    expect(calls).toHaveLength(2);
    record(`P1 refresh calls: ${calls.length}, idle minutes without a call: 6`);
    expect((await page.request.get("/api/session")).status()).toBe(200);
    expect(blocked).toEqual([]);
    await browserContext.close();
  });

  it("resumes the pilot stream after an interruption from the last event ID received", async () => {
    const { browserContext, page, blocked } = await signedInPage();
    await page.getByRole("link", { name: "Pilot operation" }).click();
    await page.getByRole("heading", { name: "Pilot operation" }).waitFor();
    const requests = [];
    // The network drops the first stream after its second event: the page
    // receives the server's own first two events and then the end of the body.
    await page.route("**/api/pilot/operations/*/events", async (route) => {
      requests.push(route.request().headers()["last-event-id"] ?? null);
      if (requests.length > 1) return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).split("\n\n").slice(0, 2).join("\n\n");
      return route.fulfill({ response, body: `${body}\n\n` });
    });
    await page.evaluate(() => {
      const states = [];
      window.__sdStates = states;
      new MutationObserver(() => {
        const state = document
          .querySelector("[data-stream-state]")
          ?.getAttribute("data-stream-state");
        if (state !== undefined && states.at(-1) !== state) states.push(state);
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });

    await page.getByRole("button", { name: "Submit pilot operation" }).click();
    await page.locator('[data-stream-state="ended"]').waitFor({ timeout: 20_000 });
    await page.locator("[data-receipt-id]").waitFor({ timeout: 15_000 });
    const states = await page.evaluate(() => window.__sdStates);
    const seqs = await page
      .locator("[data-event-seq]")
      .evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("data-event-seq"))));
    record(
      `P1 resume: Last-Event-ID per request ${JSON.stringify(requests.map((id) => id?.replace(/^[0-9a-f-]{36}/, "<op>") ?? null))}, states ${JSON.stringify(states)}, rows ${JSON.stringify(seqs)}`,
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBeNull();
    expect(requests[1]).toMatch(/^[0-9a-f-]{36}:2$/);
    expect(states).toContain("reconnecting");
    expect(states.at(-1)).toBe("ended");
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(blocked).toEqual([]);
    await browserContext.close();
  });
});
