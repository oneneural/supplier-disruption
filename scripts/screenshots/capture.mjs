#!/usr/bin/env node
// README screenshots of the packaged application in demonstration mode.
//
//   corepack pnpm screenshots          fresh demo, capture, frame, manifest, demo:down
//   corepack pnpm screenshots --keep   leave the demonstration running afterwards
//
// Starts `corepack pnpm demo` (fresh synthetic data, fixed simulated clock, no
// model call), drives part 1 of docs/demo/README.md in Playwright's Chromium and
// writes raw captures, framed exports and manifest.json to docs/demo/screenshots/.
// The frame is docs/demo/screenshots/frame.html rendered by the same browser;
// it adds window chrome and padding around the unscaled raw pixels and never
// changes application content. Development tooling only: nothing here is part
// of the application image or the browser bundle.
/* global window, document -- page.evaluate callbacks run in the browser. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "docs", "demo", "screenshots");
const RAW = join(OUT, "raw");
const FRAME = join(OUT, "frame.html");
const ORIGIN = "http://127.0.0.1:3102";
const DPR = 2;
const DESKTOP = { width: 1280, height: 900 };
const NARROW = { width: 390, height: 844 };
// Margin kept around an element clip, in CSS pixels.
const MARGIN = 16;

const keep = process.argv.includes("--keep");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function demo(action) {
  const result = spawnSync("node", [join(ROOT, "scripts", "demo", "demo.mjs"), action], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`demo ${action} failed`);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const password = (name) =>
  readFileSync(join(ROOT, ".secrets", `fixture_${name}_password`), "utf8").trim();

/**
 * Union of the elements' boxes, widened by MARGIN and limited to maxHeight.
 * bottomMargin 0 ends the clip on the last element's edge, so the next row is
 * not cut through.
 */
async function clipOf(page, locators, { maxHeight, bottomMargin = MARGIN } = {}) {
  const boxes = [];
  for (const locator of locators) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (box === null) throw new Error("element to capture is not visible");
    const scroll = await page.evaluate(() => window.scrollY);
    boxes.push({ ...box, y: box.y + scroll });
  }
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - MARGIN);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - MARGIN);
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + MARGIN;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + bottomMargin;
  const height = Math.min(bottom - y, maxHeight ?? Number.POSITIVE_INFINITY);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(right - x),
    height: Math.round(height),
  };
}

const panel = (page, id) => page.locator(`section[aria-labelledby="${id}-heading"]`);

async function main() {
  const revision = run("git", ["rev-parse", "HEAD"]);
  // Application sources that differ from HEAD would make the revision untrue.
  const dirty = run("git", ["status", "--porcelain", "--", "apps", "packages", "infra"]);
  if (dirty !== "") throw new Error(`commit application changes first:\n${dirty}`);

  demo("up");
  mkdirSync(RAW, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const shots = [];
  try {
    const context = await browser.newContext({
      baseURL: ORIGIN,
      viewport: DESKTOP,
      deviceScaleFactor: DPR,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const status = page.locator("[data-review-status]");
    const actAs = page.getByLabel("Act as (simulated role)");

    async function signIn(email, name) {
      await page.goto("/");
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      await page.getByLabel("Fixture identity").selectOption(email);
      await page.getByLabel("Password").fill(password(name));
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: "Exception queue" }).waitFor();
    }

    /** Settles the page, removes focus rings and writes one raw capture. */
    async function capture(spec, clip) {
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(0, 0);
      // The case page re-reads itself while live; let the latest render settle.
      await page.waitForLoadState("load");
      await page.waitForTimeout(750);
      const path = join(RAW, `${spec.name}.png`);
      await page.screenshot({ path, clip, fullPage: clip !== undefined });
      shots.push({ ...spec, route: new URL(page.url()).pathname, clip: clip ?? null, path });
    }

    // Buyer loads the structured C-01 message; the case awaits approval.
    await signIn("buyer@fixture.local", "buyer");
    await page.getByRole("button", { name: "Load fixture message" }).click();
    await page.getByRole("heading", { name: "CASE-1" }).waitFor();
    await page.locator('[data-case-state="awaiting_approval"]').first().waitFor();
    const caseUrl = page.url();

    await page.goto("/");
    await page.getByRole("link", { name: "CASE-1" }).waitFor();
    const queue = page
      .locator("section", { has: page.getByRole("link", { name: "CASE-1" }) })
      .last();
    await capture(
      {
        name: "01-exception-queue",
        scenario: "C-01 structured message loaded by the buyer; CASE-1 awaiting approval",
        viewport: DESKTOP,
        crop: "Page top through the queue panel; the supplier email form below is omitted",
      },
      await page
        .evaluate(() => window.scrollTo(0, 0))
        .then(async () => {
          // From the top of the page, so the demonstration notices stay in view.
          const box = await clipOf(page, [queue]);
          return { x: 0, y: 0, width: DESKTOP.width, height: box.y + box.height };
        }),
    );

    await page.goto(caseUrl);
    await panel(page, "impact").waitFor();
    await capture(
      {
        name: "02-case-assessment",
        scenario: "CASE-1 before any decision: deterministic coverage, shortage and transfer",
        viewport: DESKTOP,
        crop: "Case summary and demand impact panels with a 16 px margin",
      },
      await clipOf(page, [
        page.getByRole("navigation", { name: "Breadcrumb" }),
        panel(page, "impact"),
      ]),
    );

    // The buyer's approval of the EUR 160 plan is refused above the EUR 100 limit.
    await page.getByRole("button", { name: "Approve plan" }).click();
    await page.locator("[data-review-refusal]").waitFor();
    await capture(
      {
        name: "03-approval-refused",
        scenario: "Buyer approval of the EUR 160 plan refused with over_approval_limit",
        viewport: DESKTOP,
        crop: "Cited fields beside the review panel, cut 1000 CSS px below their top",
      },
      await clipOf(page, [panel(page, "fields"), panel(page, "review")], { maxHeight: 1000 }),
    );

    // Narrow width: the same case stacks the review panel above the evidence.
    await page.setViewportSize(NARROW);
    await page.goto(caseUrl);
    await panel(page, "impact").waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture(
      {
        name: "06-case-narrow",
        scenario: "CASE-1 awaiting approval at phone width: stacked totals, scrolling tables",
        viewport: NARROW,
        crop: "Top 844 CSS px of the demand impact panel with a 16 px margin",
      },
      await clipOf(page, [panel(page, "impact")], { maxHeight: NARROW.height }),
    );
    await page.setViewportSize(DESKTOP);

    // Part 1 to plan_verified through a lost reservation response.
    await page.goto(caseUrl);
    await page.getByRole("button", { name: /Lose the response of this case/ }).click();
    await page.locator("[data-demonstration-status]").getByText("recorded").waitFor();
    await actAs.selectOption("supplier-1");
    await page.getByRole("button", { name: "Record supplier acknowledgement" }).click();
    await status.getByText("Supplier acknowledgement recorded by the API").waitFor();
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn("manager@fixture.local", "manager");
    await page.goto(caseUrl);
    await page.getByRole("button", { name: "Approve plan" }).click();
    await status.getByText("Approval recorded by the API").waitFor();
    await actAs.selectOption("planner-1");
    await page.getByRole("button", { name: "Record warehouse planner confirmation" }).click();
    await status.getByText("Warehouse planner confirmation recorded by the API").waitFor();
    await page.locator('[data-case-state="plan_verified"]').first().waitFor({ timeout: 120_000 });
    await page.goto(caseUrl);
    await page.locator('[data-event-kind="action_reconciled"]').waitFor();
    await capture(
      {
        name: "04-recovery-verified",
        scenario:
          "CASE-1 plan_verified after ACT-2's response was lost and reconciled by operation ID",
        viewport: DESKTOP,
        crop: "Action timeline and verification panels with a 16 px margin",
      },
      await clipOf(page, [panel(page, "actions"), panel(page, "verification")]),
    );
    const history = panel(page, "history");
    await capture(
      {
        name: "05-uncertain-write-history",
        scenario: "CASE-1 history from ACT-2's unknown outcome to its reconciliation",
        viewport: DESKTOP,
        crop: "Case history heading through the event after the reconciliation, ending on that row",
      },
      await clipOf(
        page,
        [
          page.locator("#history-heading"),
          history.locator('[data-event-kind="action_outcome_unknown"]').first(),
          history
            .locator('[data-event-kind="action_reconciled"]')
            .last()
            .locator("xpath=following-sibling::li[1]"),
        ],
        { bottomMargin: 0 },
      ),
    );
    await context.close();

    // Frame each raw capture with the editable recipe at the same pixel ratio.
    const framing = await browser.newContext({ deviceScaleFactor: DPR });
    const framePage = await framing.newPage();
    for (const shot of shots) {
      await framePage.goto(pathToFileURL(FRAME).href);
      const width = shot.clip?.width ?? shot.viewport.width;
      await framePage.evaluate(
        ({ src, address, width }) => {
          document.getElementById("address").textContent = address;
          const image = document.getElementById("shot");
          image.style.width = `${String(width)}px`;
          // The window is exactly as wide as the capture, whatever the address length.
          document.querySelector(".window").style.width = `${String(width)}px`;
          image.src = src;
          return image.decode();
        },
        {
          src: `data:image/png;base64,${readFileSync(shot.path).toString("base64")}`,
          address: `127.0.0.1:3102${shot.route}`,
          width,
        },
      );
      shot.framed = join(OUT, `${shot.name}.png`);
      await framePage.locator("#frame").screenshot({ path: shot.framed });
    }
    await framing.close();

    const manifest = {
      implementationRevision: revision,
      capturedAt: new Date().toISOString(),
      command: "corepack pnpm screenshots",
      mode: "Demonstration mode (corepack pnpm demo): synthetic fixtures, simulated actors and fixture source adapters, fixed simulated business clock 2026-10-21 07:00 UTC; the structured C-01 message, so no extraction or model call",
      origin: ORIGIN,
      deviceScaleFactor: DPR,
      colorScheme: "light",
      tools: {
        node: process.version,
        playwright: JSON.parse(
          readFileSync(join(ROOT, "node_modules", "playwright", "package.json"), "utf8"),
        ).version,
        chromium: browser.version(),
        frameRecipe: { path: relative(ROOT, FRAME), sha256: sha256(FRAME) },
      },
      image: {
        tag: "supplier-disruption-app:demo",
        id: run("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          "supplier-disruption-app:demo",
        ]),
        buildRevision: run("docker", [
          "image",
          "inspect",
          "--format",
          '{{index .Config.Labels "org.opencontainers.image.revision"}}',
          "supplier-disruption-app:demo",
        ]),
      },
      framing:
        "Raw pixels are placed unscaled; the window's 10 px rounded bottom corners mask a few corner pixels",
      redactions: "None",
      shots: shots.map((shot) => ({
        name: shot.name,
        route: shot.route,
        scenario: shot.scenario,
        viewport: shot.viewport,
        clip: shot.clip,
        crop: shot.crop,
        raw: { path: relative(ROOT, shot.path), sha256: sha256(shot.path) },
        framed: { path: relative(ROOT, shot.framed), sha256: sha256(shot.framed) },
      })),
    };
    writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`\nWrote ${String(shots.length)} screenshots to ${relative(ROOT, OUT)}\n`);
  } finally {
    await browser.close();
    if (!keep) demo("down");
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`screenshots: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
