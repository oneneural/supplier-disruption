// W1 workbench flow: Playwright drives the C-01 case end to end in
// the browser against the packaged image of one disposable project, through
// the Next proxy and the case API. Every other origin is blocked. The only
// non-2xx response the page may receive is the buyer's refused approval.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_BUYER_EMAIL, passwords } from "./gates.mjs";
import { FIXTURE_MANAGER_EMAIL, Project, context, record } from "./support.mjs";

// The C-01 fixture is time-bound: an approval expires at 18:00 Copenhagen
// time on the day it is given (ADR 0009) and the TRO-1 quote is valid until
// 2026-10-22T10:00Z. This project alone runs the API on the controlled
// business clock, which the init seeds at the fixture's start instant and
// nothing advances, so the flow never depends on wall time (ADR 0010). The
// config accepts controlled mode only with NODE_ENV=test, so this project's
// container runs with it; Next still serves its production runtime.
const project = new Project("workbench", {
  appEnvironment: { NODE_ENV: "test", DOMAIN_CLOCK_MODE: "controlled" },
});
const CLOCK_START_EPOCH = Date.parse("2026-10-21T09:00:00+02:00") / 1000;

async function clockEpochs() {
  return project.sql(
    "SELECT extract(epoch FROM instant)::bigint AS epoch FROM fixture_reference.business_clock",
  );
}

let browser;

beforeAll(async () => {
  await project.start();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await project.remove();
});

describe("W1 workbench flow", () => {
  it("runs C-01 from the fixture message to a verified plan with read-back evidence", async () => {
    // The API of this boot runs on the controlled clock at the seeded instant.
    const boot = await project.bootId();
    const clockLines = (await project.boots())
      .find((segment) => segment.bootId === boot)
      .lines.map((line) => line.text)
      .filter((text) => text.includes('"msg":"business clock"'));
    expect(clockLines).toHaveLength(1);
    expect(JSON.parse(clockLines[0]).domainClockMode).toBe("controlled");
    expect(await clockEpochs()).toEqual([{ epoch: CLOCK_START_EPOCH }]);

    const browserContext = await browser.newContext({
      baseURL: project.origin,
      viewport: { width: 1440, height: 1000 },
    });
    const blocked = [];
    const nonOk = [];
    await browserContext.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === project.origin) return route.continue();
      blocked.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    const page = await browserContext.newPage();
    page.on("response", (response) => {
      if (response.status() < 200 || response.status() > 299) {
        nonOk.push(
          `${response.request().method()} ${response.status()} ${new URL(response.url()).pathname}`,
        );
      }
    });

    async function signIn(email, password) {
      await page.goto("/");
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      await page.getByLabel("Fixture identity").selectOption(email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: "Exception queue" }).waitFor();
    }
    const status = page.locator("[data-review-status]");
    const actAs = page.getByLabel("Act as (simulated role)");

    // The buyer loads the fixture message and reviews the assessed case.
    await signIn(FIXTURE_BUYER_EMAIL, passwords.buyer());
    await page.getByText("No open cases").waitFor();
    await page.getByRole("button", { name: "Load fixture message" }).click();
    await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
    await page.getByRole("heading", { name: "CASE-1" }).waitFor();
    await expect(
      page.locator("[data-case-state]").first().getAttribute("data-case-state"),
    ).resolves.toBe("awaiting_approval");
    const total = (id) => page.locator(`[data-total="${id}"]`).textContent();
    expect(await total("pre-transfer-coverage")).toBe("70 EA");
    expect(await total("pre-transfer-shortage")).toBe("50 EA");
    expect(await total("conditional-transfer")).toBe("50 EA");
    expect(await total("conditional-shortage")).toBe("0 EA");
    expect(await page.locator("[data-plan-cost]").textContent()).toBe("EUR 160.00");
    // The original stored message is on the page with its digest, and a
    // field's locator points at its stored value.
    await expect(page.locator("[data-evidence-sha256]").count()).resolves.toBe(1);
    await page.getByRole("link", { name: /proposal\.terms\.segments\[1\]\.quantity/ }).click();
    expect(await page.locator(":target").textContent()).toContain("80");
    await expect(page.locator("[data-physical-delivery]").textContent()).resolves.toContain(
      "A verified plan is not evidence of physical delivery",
    );

    // The buyer's approval of EUR 160 is refused by the API over the EUR 100 limit.
    await page.getByRole("button", { name: "Approve plan" }).click();
    const refusal = page.locator("[data-review-refusal]");
    await refusal.waitFor();
    expect(await refusal.textContent()).toContain("HTTP 422: over_approval_limit");
    expect(await refusal.textContent()).toContain("Nothing was authorized");

    // The buyer account relays the simulated supplier's acknowledgement.
    await actAs.selectOption("supplier-1");
    await page.getByRole("button", { name: "Record supplier acknowledgement" }).click();
    await status.getByText("Supplier acknowledgement recorded by the API").waitFor();
    await page.getByRole("button", { name: "Sign out" }).click();

    // The manager approves within the EUR 500 limit and records the planner's confirmation.
    await signIn(FIXTURE_MANAGER_EMAIL, passwords.manager());
    await page.getByRole("link", { name: "CASE-1" }).click();
    await page.getByRole("heading", { name: "CASE-1" }).waitFor();
    await page.getByRole("button", { name: "Approve plan" }).click();
    await status.getByText("Approval recorded by the API").waitFor();
    await actAs.selectOption("planner-1");
    await page.getByRole("button", { name: "Record warehouse planner confirmation" }).click();
    await status.getByText("Warehouse planner confirmation recorded by the API").waitFor();

    // The worker applies the plan; the page re-reads the case until it is verified.
    await page.locator('[data-case-state="plan_verified"]').first().waitFor({ timeout: 90_000 });
    await page.locator('[data-verification="plan_verified"]').waitFor();
    for (const action of ["ACT-1", "ACT-2", "ACT-3"]) {
      const row = page.locator(`[data-action-id="${action}"]`);
      await expect(
        row.locator("[data-action-state]").getAttribute("data-action-state"),
      ).resolves.toBe("confirmed");
      await expect(row.locator(`[data-readback="${action}"]`).count()).resolves.toBe(1);
    }
    await page.locator('[data-event-kind="verification"]').waitFor();

    // Every case event carries the business instant, not wall time, and the
    // clock was never advanced.
    expect(
      await project.sql(
        "SELECT DISTINCT extract(epoch FROM occurred_at)::bigint AS epoch FROM app.case_event",
      ),
    ).toEqual([{ epoch: CLOCK_START_EPOCH }]);
    expect(await clockEpochs()).toEqual([{ epoch: CLOCK_START_EPOCH }]);

    // Nothing the page received carries a secret value.
    const { canaries, secretFiles } = context();
    const html = await page.content();
    for (const value of [...canaries.map((c) => c.value), ...secretFiles.map((f) => f.value)]) {
      expect(html).not.toContain(value);
    }

    const screenshot = join(tmpdir(), `supplier-disruption-${context().runId}-w1-verified.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    record(`W1 screenshot of the verified case: ${screenshot}`);
    record(
      `W1 non-2xx responses: ${JSON.stringify(nonOk)}, blocked external requests: ${blocked.length}`,
    );
    expect(blocked).toEqual([]);
    expect(
      nonOk.filter((entry) => !/^POST 422 \/api\/cases\/[0-9a-f-]{36}\/decisions$/.test(entry)),
    ).toEqual([]);
    expect(nonOk).toHaveLength(1);
    await browserContext.close();
  });
});
