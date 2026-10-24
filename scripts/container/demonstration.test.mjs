// W2 and W3: the demonstration mode of ADR 0012 through the packaged
// image in Chromium, each in its own disposable project with every other
// origin blocked. The container keeps NODE_ENV=production; only
// DOMAIN_CLOCK_MODE=demonstration is added. W2 runs the C-01 email through the
// recorded agent run and makes the approval stale with the simulated foreign
// reservation; W3 loses the response of the C-01 reservation write and
// reconciles it to a verified plan with one effect.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_BUYER_EMAIL, passwords } from "./gates.mjs";
import { FIXTURE_MANAGER_EMAIL, Project, context, record } from "./support.mjs";

const SEEDED_EPOCH = Date.parse("2026-10-21T09:00:00+02:00") / 1000;
const DEMONSTRATION = { DOMAIN_CLOCK_MODE: "demonstration" };

let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

/** A page on the project's origin that blocks other origins and records non-2xx responses. */
async function openPage(project) {
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
  return { browserContext, page, blocked, nonOk, signIn };
}

/** The API of this boot logged the demonstration clock mode once, and the clock sits at the seed. */
async function expectDemonstrationMode(project) {
  const boot = await project.bootId();
  const lines = (await project.boots())
    .find((segment) => segment.bootId === boot)
    .lines.map((line) => line.text)
    .filter((text) => text.includes('"msg":"business clock"'));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]).domainClockMode).toBe("demonstration");
  expect(await clockEpochs(project)).toEqual([{ epoch: SEEDED_EPOCH }]);
}

function clockEpochs(project) {
  return project.sql(
    "SELECT extract(epoch FROM instant)::bigint AS epoch FROM fixture_reference.business_clock",
  );
}

async function expectClockUnmoved(project) {
  expect(await clockEpochs(project)).toEqual([{ epoch: SEEDED_EPOCH }]);
  expect(
    await project.sql(
      "SELECT DISTINCT extract(epoch FROM occurred_at)::bigint AS epoch FROM app.case_event",
    ),
  ).toEqual([{ epoch: SEEDED_EPOCH }]);
}

async function finish(gate, { browserContext, page, blocked, nonOk }) {
  const { canaries, secretFiles } = context();
  const html = await page.content();
  for (const value of [...canaries.map((c) => c.value), ...secretFiles.map((f) => f.value)]) {
    expect(html).not.toContain(value);
  }
  const screenshot = join(tmpdir(), `supplier-disruption-${context().runId}-${gate}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  record(`${gate.toUpperCase()} screenshot: ${screenshot}`);
  record(`${gate.toUpperCase()} non-2xx: ${JSON.stringify(nonOk)}, blocked: ${blocked.length}`);
  expect(blocked).toEqual([]);
  expect(nonOk).toEqual([]);
  await browserContext.close();
}

describe("W2 replayed email and a stale approval", () => {
  const project = new Project("demo-stale", { appEnvironment: DEMONSTRATION });
  beforeAll(() => project.start());
  afterAll(() => project.remove());

  it("labels the replay, refuses the stale approval without a write and escalates", async () => {
    await expectDemonstrationMode(project);
    const session = await openPage(project);
    const { page, signIn } = session;
    const status = page.locator("[data-review-status]");
    const actAs = page.getByLabel("Act as (simulated role)");

    // The sign-in page already says the business clock is simulated.
    await page.goto("/");
    await expect(page.getByText("Simulated business clock").textContent()).resolves.toContain(
      "2026-10-21 07:00 UTC",
    );

    // The buyer submits the C-01 sample email; the recorded run proposes its terms.
    await signIn(FIXTURE_BUYER_EMAIL, passwords.buyer());
    await page.getByRole("button", { name: "Load C-01 sample email" }).click();
    await page.getByRole("button", { name: "Submit for extraction" }).click();
    await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
    await page
      .locator('[data-case-state="awaiting_approval"]')
      .first()
      .waitFor({ timeout: 60_000 });
    await page.locator("[data-agent-replay]").waitFor();
    await page.getByText("Recorded cost (replay, no new spend)").waitFor();
    const total = (id) => page.locator(`[data-total="${id}"]`).textContent();
    expect(await total("pre-transfer-coverage")).toBe("70 EA");
    expect(await total("conditional-transfer")).toBe("50 EA");
    expect(await project.sql("SELECT provider, status FROM app.agent_run")).toEqual([
      { provider: "replay", status: "proposed" },
    ]);
    await actAs.selectOption("supplier-1");
    await page.getByRole("button", { name: "Record supplier acknowledgement" }).click();
    await status.getByText("Supplier acknowledgement recorded by the API").waitFor();
    await page.getByRole("button", { name: "Sign out" }).click();

    // The manager approves; then another order reserves 20 EA at WH-B.
    await signIn(FIXTURE_MANAGER_EMAIL, passwords.manager());
    await page.getByRole("link", { name: "CASE-1" }).click();
    await page.getByRole("button", { name: "Approve plan" }).click();
    await status.getByText("Approval recorded by the API").waitFor();
    await page
      .getByRole("button", { name: "Simulate another order reserving 20 EA at WH-B" })
      .click();
    await page.locator("[data-demonstration-status]").getByText("recorded").waitFor();
    await actAs.selectOption("planner-1");
    await page.getByRole("button", { name: "Record warehouse planner confirmation" }).click();
    await status.getByText("Warehouse planner confirmation recorded by the API").waitFor();

    // Application refuses the approval bound to the old stock version and reassesses.
    await page.locator('[data-case-state="escalated"]').first().waitFor({ timeout: 90_000 });
    await page.reload();
    await expect(page.locator("[data-case-state-text]").textContent()).resolves.toBe("Escalated");
    await page.getByText("unresolved_shortage").first().waitFor();
    expect(
      await project.sql("SELECT state, reason, owner FROM app.supplier_case WHERE case_number = 1"),
    ).toEqual([{ state: "escalated", reason: "unresolved_shortage", owner: "buyer" }]);
    expect(
      await project.sql(
        "SELECT DISTINCT status, invalidated_reason FROM app.case_decision WHERE outcome = 'accepted'",
      ),
    ).toEqual([{ status: "stale", invalidated_reason: "stale_source_stock" }]);
    // No plan write reached a source; only the simulated foreign reservation moved WH-B.
    expect(
      await project.sql(`
        SELECT (SELECT count(*)::int FROM fixture_purchasing.operation_receipt) AS purchasing,
               (SELECT count(*)::int FROM fixture_inventory.operation_receipt
                 WHERE plan_id <> 'DEMO-FOREIGN-ORDER') AS inventory,
               (SELECT count(*)::int FROM fixture_inventory.operation_receipt
                 WHERE plan_id = 'DEMO-FOREIGN-ORDER') AS foreign_order`),
    ).toEqual([{ purchasing: 0, inventory: 0, foreign_order: 1 }]);
    await expectClockUnmoved(project);
    await finish("w2", session);
  });
});

describe("W3 uncertain reservation write reconciled", () => {
  const project = new Project("demo-uncertain", { appEnvironment: DEMONSTRATION });
  beforeAll(() => project.start());
  afterAll(() => project.remove());

  it("records the lost response as unknown and confirms it by read-back, with one effect", async () => {
    await expectDemonstrationMode(project);
    const session = await openPage(project);
    const { page, signIn } = session;
    const status = page.locator("[data-review-status]");
    const actAs = page.getByLabel("Act as (simulated role)");

    await signIn(FIXTURE_BUYER_EMAIL, passwords.buyer());
    await page.getByRole("button", { name: "Load fixture message" }).click();
    await page.getByRole("heading", { name: "CASE-1" }).waitFor();
    await page.getByRole("button", { name: /Lose the response of this case/ }).click();
    await page.locator("[data-demonstration-status]").getByText("recorded").waitFor();
    await actAs.selectOption("supplier-1");
    await page.getByRole("button", { name: "Record supplier acknowledgement" }).click();
    await status.getByText("Supplier acknowledgement recorded by the API").waitFor();
    await page.getByRole("button", { name: "Sign out" }).click();

    await signIn(FIXTURE_MANAGER_EMAIL, passwords.manager());
    await page.getByRole("link", { name: "CASE-1" }).click();
    await page.getByRole("button", { name: "Approve plan" }).click();
    await status.getByText("Approval recorded by the API").waitFor();
    await actAs.selectOption("planner-1");
    await page.getByRole("button", { name: "Record warehouse planner confirmation" }).click();
    await status.getByText("Warehouse planner confirmation recorded by the API").waitFor();

    await page.locator('[data-case-state="plan_verified"]').first().waitFor({ timeout: 120_000 });
    await page.locator('[data-event-kind="action_outcome_unknown"]').waitFor();
    await page.locator('[data-event-kind="action_reconciled"]').waitFor();
    expect(
      await project.sql("SELECT action_id, state, attempts FROM app.case_action ORDER BY sequence"),
    ).toEqual([
      { action_id: "ACT-1", state: "confirmed", attempts: 1 },
      { action_id: "ACT-2", state: "confirmed", attempts: 1 },
      { action_id: "ACT-3", state: "confirmed", attempts: 1 },
    ]);
    expect(
      await project.sql(
        "SELECT kind, count(*)::int AS n FROM fixture_inventory.operation_receipt GROUP BY kind ORDER BY kind",
      ),
    ).toEqual([
      { kind: "create_transfer_request", n: 1 },
      { kind: "reserve", n: 1 },
    ]);
    await expectClockUnmoved(project);
    await finish("w3", session);
  });
});
