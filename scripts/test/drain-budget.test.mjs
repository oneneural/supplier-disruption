import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PILOT_MAX_HOLD_MS } from "../../packages/contracts/dist/index.js";
import { DRAIN_TIMEOUT_MS, SHUTDOWN_DEADLINE_MS } from "../../apps/worker/dist/shutdown.js";

// The container's stop budget (ADR 0002): Compose allows 60 s, the image must
// drain in under 30 s, and every value below is read from the files the image
// actually uses.
const ROOT = new URL("../../", import.meta.url);
const S6 = new URL("infra/app/rootfs/etc/s6-overlay/s6-rc.d/", ROOT);
const BUDGET_MS = 30_000;
// Process exits, s6 bookkeeping and Docker's own stop handling.
const OVERHEAD_MS = 1_000;

const ms = async (service, file) =>
  Number((await readFile(new URL(`${service}/${file}`, S6), "utf8")).trim());

async function killGrace() {
  const dockerfile = await readFile(new URL("Dockerfile", ROOT), "utf8");
  const match = /S6_KILL_GRACETIME=(\d+)/.exec(dockerfile);
  if (match === null) throw new Error("S6_KILL_GRACETIME is not set in the Dockerfile");
  return Number(match[1]);
}

describe("container drain budget", () => {
  it("escalates in order inside each service", async () => {
    for (const service of ["api", "worker", "web", "watchdog"]) {
      expect(await ms(service, "timeout-kill")).toBeLessThan(await ms(service, "timeout-down"));
    }
    expect(DRAIN_TIMEOUT_MS).toBeLessThan(SHUTDOWN_DEADLINE_MS);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(await ms("worker", "timeout-kill"));
  });

  it("lets a job holding the longest pilot hold finish inside the drain", () => {
    // The hold starts just before the stop; its receipt call needs the rest.
    expect(PILOT_MAX_HOLD_MS + 2_000).toBeLessThanOrEqual(DRAIN_TIMEOUT_MS);
  });

  it("stops in under 30 s in the worst case, including escalation and the final-stage wait", async () => {
    // web, worker and watchdog stop in parallel, then api, then s6-overlay's
    // final stage waits S6_KILL_GRACETIME before its last SIGKILL.
    const first = Math.max(
      await ms("worker", "timeout-down"),
      await ms("web", "timeout-down"),
      await ms("watchdog", "timeout-down"),
    );
    const worst = first + (await ms("api", "timeout-down")) + (await killGrace()) + OVERHEAD_MS;
    expect(worst).toBeLessThan(BUDGET_MS);
  });
});
