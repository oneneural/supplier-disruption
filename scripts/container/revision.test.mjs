// W5 verification currency and later revision (ADR 0015): Playwright
// drives the packaged image of one disposable project, with every other
// origin blocked, from C-01's verified plan to an expired verification, a
// matching recheck and a later supplier revision that opens a linked
// successor. Like W1 it runs the API on the controlled business clock (ADR
// 0010); the gate moves that clock past the four-hour validity itself.
// MSG-0002 is a synthetic later revision stored as the fixture mailbox would.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/index.ts";
import { FIXTURE_BUYER_EMAIL, passwords } from "./gates.mjs";
import {
  FIXTURE_MANAGER_EMAIL,
  FIXTURE_ORGANIZATION_ID,
  Project,
  context,
  record,
} from "./support.mjs";

const project = new Project("revision", {
  appEnvironment: { NODE_ENV: "test", DOMAIN_CLOCK_MODE: "controlled" },
});

// PO-120 is at revision 4 after PLAN-1; the supplier moves the 80 EA to 28 October.
const MSG_0002 = {
  poNumber: "PO-120",
  poLine: "10",
  baseRevision: "4",
  vendorItem: "KF-A-01",
  uom: "EA",
  segments: [
    { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
    { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-28" } },
  ],
  unresolvedFields: [],
};

async function storeLaterRevision() {
  const content = canonicalJson(MSG_0002);
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  await project.execSql(
    `INSERT INTO fixture_reference.supplier_input
       (source_system, message_id, input_version, content_sha256, sender, proposal_id,
        evidence_ref, authored_at, received_at, content)
     VALUES ('fixture-supplier-mail', 'MSG-0002', 1, '${sha256}',
             'orders@kestrel-fasteners.test', 'PROP-MSG-0002', 'MSG-0002@1', NULL, NULL,
             '${content}'::jsonb)`,
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

describe("W5 verification currency and later revision", () => {
  it("shows current versus historical verification and the linked successor", async () => {
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
    const history = () =>
      page
        .locator("[data-verification-entry]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-verification-entry")));

    // C-01 to a verified plan: the supplier acknowledges, the manager approves
    // and the planner confirms, as in W1.
    await signIn(FIXTURE_BUYER_EMAIL, passwords.buyer());
    await page.getByRole("button", { name: "Load fixture message" }).click();
    await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
    await page.getByRole("heading", { name: "CASE-1" }).waitFor();
    const predecessorUrl = page.url();
    await actAs.selectOption("supplier-1");
    await page.getByRole("button", { name: "Record supplier acknowledgement" }).click();
    await status.getByText("Supplier acknowledgement recorded by the API").waitFor();
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn(FIXTURE_MANAGER_EMAIL, passwords.manager());
    await page.goto(predecessorUrl);
    await page.getByRole("button", { name: "Approve plan" }).click();
    await status.getByText("Approval recorded by the API").waitFor();
    await actAs.selectOption("planner-1");
    await page.getByRole("button", { name: "Record warehouse planner confirmation" }).click();
    await status.getByText("Warehouse planner confirmation recorded by the API").waitFor();
    await page.locator('[data-case-state="plan_verified"]').first().waitFor({ timeout: 90_000 });
    await page.locator('[data-verification-current="current"]').waitFor();
    expect(await history()).toEqual(["verified"]);
    expect(await page.locator("[data-verification-current]").textContent()).toContain(
      "valid until 2026-10-21 11:00 UTC",
    );

    // Four hours later the plan is no longer currently verified; the evidence stays.
    await project.execSql(
      "UPDATE fixture_reference.business_clock SET instant = '2026-10-21T11:30:00Z'",
    );
    await page.reload();
    await page.locator('[data-verification-current="expired"]').waitFor();
    expect(await history()).toEqual(["verified"]);
    await expect(page.locator('[data-verification="plan_verified"]').count()).resolves.toBe(0);
    expect(await page.locator("[data-case-state-text]").textContent()).toBe("Plan verified");
    await page.getByText("Verification expired at 2026-10-21T11:00:00.000Z").waitFor();
    const expiredShot = join(tmpdir(), `supplier-disruption-${context().runId}-w5-expired.png`);
    await page.screenshot({ path: expiredShot, fullPage: true });

    // A recheck by the planner reads the records back and renews the validity.
    await page.getByLabel("Recheck as simulated actor").selectOption("planner-1");
    await page.getByRole("button", { name: "Recheck the source records" }).click();
    await page
      .locator("[data-verification-recheck-status]")
      .getByText("The records still match. Verified until 2026-10-21 15:30 UTC.")
      .waitFor();
    await page.locator('[data-verification-current="current"]').waitFor();
    expect(await history()).toEqual(["verified", "verified"]);

    // A later valid supplier revision opens a linked successor case.
    await storeLaterRevision();
    const ingested = await page.evaluate(async (organizationId) => {
      const response = await fetch("/api/cases/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          organizationId,
          deliveryId: crypto.randomUUID(),
          sourceSystem: "fixture-supplier-mail",
          messageId: "MSG-0002",
          inputVersion: 1,
        }),
      });
      return { status: response.status, body: await response.json() };
    }, FIXTURE_ORGANIZATION_ID);
    expect(ingested).toMatchObject({
      status: 201,
      body: { disposition: "accept", caseRef: "CASE-2", state: "awaiting_approval" },
    });

    await page.goto(predecessorUrl);
    await page.locator('[data-lineage-successor="CASE-2"]').waitFor();
    await page.locator('[data-verification-current="superseded"]').waitFor();
    expect(await page.locator("[data-case-state-text]").textContent()).toBe("Superseded");
    expect(await history()).toEqual(["verified", "verified"]);
    await page.locator("[data-lineage-successor]").getByRole("link", { name: "CASE-2" }).click();
    await page.getByRole("heading", { name: "CASE-2" }).waitFor();
    await page.locator('[data-lineage-predecessor="CASE-1"]').waitFor();
    const total = (id) => page.locator(`[data-total="${id}"]`).textContent();
    expect(await total("prior-commitment")).toBe("50 EA");
    expect(await total("conditional-transfer")).toBe("0 EA");
    expect(await total("conditional-shortage")).toBe("0 EA");
    await expect(page.locator("[data-commitment-reservations]").textContent()).resolves.toContain(
      "(PLAN-1)",
    );
    await expect(page.locator("[data-verification-current]").count()).resolves.toBe(0);
    const successorShot = join(tmpdir(), `supplier-disruption-${context().runId}-w5-successor.png`);
    await page.screenshot({ path: successorShot, fullPage: true });

    // One linked history: the predecessor keeps its plan and actions, and no
    // second reservation or transfer request exists.
    expect(
      await project.sql(
        `SELECT case_number, state, predecessor_case_id IS NOT NULL AS has_predecessor,
                successor_case_id IS NOT NULL AS has_successor
           FROM app.supplier_case ORDER BY case_number`,
      ),
    ).toEqual([
      { case_number: 1, state: "superseded", has_predecessor: false, has_successor: true },
      { case_number: 2, state: "awaiting_approval", has_predecessor: true, has_successor: false },
    ]);
    expect(
      await project.sql(
        `SELECT (SELECT count(*) FROM fixture_inventory.transfer_request)::int AS requests,
                (SELECT count(*) FROM fixture_inventory.reservation WHERE plan_id IS NOT NULL)::int AS plan_reservations`,
      ),
    ).toEqual([{ requests: 1, plan_reservations: 1 }]);

    const { canaries, secretFiles } = context();
    const html = await page.content();
    for (const value of [...canaries.map((c) => c.value), ...secretFiles.map((f) => f.value)]) {
      expect(html).not.toContain(value);
    }
    record(`W5 screenshots: ${expiredShot}, ${successorShot}`);
    record(`W5 non-2xx responses: ${JSON.stringify(nonOk)}, blocked: ${blocked.length}`);
    expect(blocked).toEqual([]);
    expect(nonOk).toEqual([]);
    await browserContext.close();
  });
});
