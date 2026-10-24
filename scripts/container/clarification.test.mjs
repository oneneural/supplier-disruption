// W4 clarification flow (ADR 0014): Playwright drives the packaged
// image of one disposable project, with every other origin blocked, from an
// ambiguous supplier email to a draft question, a recorded supplier reply, a
// source-supported correction and the resumed assessment. The project has no
// model provider, so the email pauses before any model call; the buyer then
// cites the supplier's own words for every field. Like W1 it runs the API on
// the controlled business clock at the seeded instant (ADR 0010), so the C-01
// quote and approval times never depend on wall time.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_BUYER_EMAIL, passwords } from "./gates.mjs";
import { Project, context, record } from "./support.mjs";

const project = new Project("clarify", {
  appEnvironment: { NODE_ENV: "test", DOMAIN_CLOCK_MODE: "controlled" },
});

const SENDER = "orders@kestrel-fasteners.test";
const EMAIL_TEXT =
  "Hello,\n\nRegarding PO-120 (revision 3), line 10, item KF-A-01: we can deliver 40 EA " +
  "to your warehouse on 23 October 2026. The remaining 80 EA will follow later.\n\n" +
  "Best regards,\nKestrel Fasteners order desk";
const REPLY_TEXT = "The remaining 80 EA will arrive at your warehouse on 26 October 2026.";

/** Each field, its value and the quote that states it, from the email or the reply. */
const CORRECTION = [
  ["poNumber", "PO-120", "email", "PO-120 (revision 3)"],
  ["poLine", "10", "email", "line 10"],
  ["baseRevision", "3", "email", "(revision 3)"],
  ["vendorItem", "KF-A-01", "email", "item KF-A-01"],
  ["uom", "EA", "email", "deliver 40 EA"],
  ["segments[0].quantity", "40", "email", "deliver 40 EA"],
  [
    "segments[0].arrival",
    "2026-10-23",
    "email",
    "deliver 40 EA to your warehouse on 23 October 2026",
  ],
  ["segments[1].quantity", "80", "reply", "The remaining 80 EA will arrive"],
  ["segments[1].arrival", "2026-10-26", "reply", "arrive at your warehouse on 26 October 2026"],
];

let browser;

beforeAll(async () => {
  await project.start();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await project.remove();
});

describe("W4 clarification flow", () => {
  it("resumes an ambiguous email through a question, a reply and a cited correction", async () => {
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
    const status = page.locator("[data-review-status]");
    const actAs = page.getByLabel("Act as (simulated role)");
    const caseState = () =>
      page.locator("[data-case-state]").first().getAttribute("data-case-state");

    await page.goto("/");
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    await page.getByLabel("Fixture identity").selectOption(FIXTURE_BUYER_EMAIL);
    await page.getByLabel("Password").fill(passwords.buyer());
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Exception queue" }).waitFor();

    // The ambiguous email: the remaining 80 EA have no date.
    await page.getByLabel("Sender", { exact: true }).fill(SENDER);
    await page.getByLabel("Subject", { exact: true }).fill("PO-120 line 10: partial delivery");
    await page.getByLabel("Email text").fill(EMAIL_TEXT);
    await page.getByRole("button", { name: "Submit for extraction" }).click();
    await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
    await page
      .locator('[data-case-state="needs_clarification"]')
      .first()
      .waitFor({ timeout: 60_000 });
    expect(await project.sql("SELECT provider, status FROM app.agent_run")).toEqual([
      { provider: "none", status: "paused" },
    ]);

    // The buyer saves a question; it is a local draft and the case waits on it.
    await page
      .getByLabel("Question", { exact: true })
      .fill("When will the remaining 80 EA arrive at warehouse A?");
    await page.getByRole("button", { name: "Save draft question" }).click();
    await status.getByText("Question recorded by the API").waitFor();
    await page.locator('[data-question="Q-1"][data-question-status="awaiting_reply"]').waitFor();
    await expect(page.locator("[data-draft-not-sent]").textContent()).resolves.toContain(
      "Local draft, not sent",
    );
    await page.getByText("Record the supplier's reply to the open question").waitFor();

    // The buyer account relays the simulated supplier contact's reply as received.
    await actAs.selectOption("supplier-1");
    await expect(page.getByLabel("Reply sender (as received)").inputValue()).resolves.toBe(SENDER);
    await page.getByLabel("Reply text").fill(REPLY_TEXT);
    await page.getByRole("button", { name: "Record supplier reply" }).click();
    await status.getByText("Supplier reply recorded by the API").waitFor();
    await page.locator('[data-question="Q-1"][data-question-status="answered"]').waitFor();
    expect(await caseState()).toBe("needs_clarification");
    await page.getByText("Propose a correction that cites the supplier's own words").waitFor();

    // The buyer cites the email and the reply for every field.
    await actAs.selectOption("buyer-1");
    for (const [field, value, source, quote] of CORRECTION) {
      const evidence = page.getByLabel(`Evidence for ${field}`);
      const option = evidence.locator("option", {
        hasText: source === "reply" ? "Supplier reply" : "Supplier email",
      });
      await evidence.selectOption(await option.getAttribute("value"));
      await page.getByLabel(`Value of ${field}`).fill(value);
      await page.getByLabel(`Quote for ${field}`).fill(quote);
    }
    await page.getByRole("button", { name: "Submit correction" }).click();
    await status.getByText("Correction recorded by the API").waitFor();

    // The resumed assessment: the C-01 arithmetic under a new plan, awaiting approval.
    await page
      .locator('[data-case-state="awaiting_approval"]')
      .first()
      .waitFor({ timeout: 30_000 });
    const total = (id) => page.locator(`[data-total="${id}"]`).textContent();
    expect(await total("pre-transfer-coverage")).toBe("70 EA");
    expect(await total("pre-transfer-shortage")).toBe("50 EA");
    expect(await total("conditional-transfer")).toBe("50 EA");
    expect(await total("conditional-shortage")).toBe("0 EA");
    expect(await page.locator("[data-plan-cost]").textContent()).toBe("EUR 160.00");
    const correction = page.locator('[data-correction="COR-1"][data-correction-status="accepted"]');
    await correction.waitFor();
    await expect(correction.locator("[data-correction-before]").textContent()).resolves.toBe(
      "none",
    );
    await expect(correction.locator("[data-correction-after]").textContent()).resolves.toContain(
      "80 EA arriving 2026-10-26",
    );
    await expect(correction.locator("[data-locator-field]").count()).resolves.toBe(9);
    for (const kind of [
      "clarification_requested",
      "reply_recorded",
      "clarification_resumed",
      "correction_recorded",
      "assessed",
    ]) {
      await expect(page.locator(`[data-event-kind="${kind}"]`).count()).resolves.toBe(1);
    }

    // Stored records: the email and reply bytes kept, the draft unsent, no source effect.
    expect(
      await project.sql(
        "SELECT disposition, source_system FROM app.supplier_message ORDER BY source_system",
      ),
    ).toEqual([
      { disposition: "accept", source_system: "operator-correction" },
      { disposition: "evidence", source_system: "operator-email" },
      { disposition: "reply", source_system: "supplier-reply" },
    ]);
    expect(await project.sql("SELECT status, sent FROM app.case_clarification")).toEqual([
      { status: "answered", sent: false },
    ]);
    expect(
      await project.sql(
        `SELECT (SELECT count(*) FROM fixture_purchasing.operation)::int AS purchasing,
                (SELECT count(*) FROM fixture_inventory.operation)::int AS inventory`,
      ),
    ).toEqual([{ purchasing: 0, inventory: 0 }]);

    const { canaries, secretFiles } = context();
    const html = await page.content();
    for (const value of [...canaries.map((c) => c.value), ...secretFiles.map((f) => f.value)]) {
      expect(html).not.toContain(value);
    }
    const screenshot = join(tmpdir(), `supplier-disruption-${context().runId}-w4-resumed.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    record(`W4 screenshot of the resumed case: ${screenshot}`);
    record(`W4 non-2xx responses: ${JSON.stringify(nonOk)}, blocked: ${blocked.length}`);
    expect(blocked).toEqual([]);
    expect(nonOk).toEqual([]);
    await browserContext.close();
  });
});
