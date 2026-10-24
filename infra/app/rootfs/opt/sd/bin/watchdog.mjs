#!/usr/bin/env node
// Container watchdog, an essential s6 longrun. Until first aggregate readiness
// it enforces the startup bound; afterwards it probes every service s6 reports
// as wanted up and halts the container when one stays failed past the hang
// bound. Docker's unhealthy status alone never restarts a container, so this
// halt (followed by Compose's restart policy) is the recovery path.
import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { claimFirstFailure, halt } from "../lib/first-failure.mjs";
import { probeAll, summarize } from "../lib/probes.mjs";
import {
  BOUNDS,
  EXIT_CODES,
  SERVICES,
  WATCHDOG_BEAT_FILE,
  initialState,
  step,
} from "../lib/watchdog-core.mjs";

const run = promisify(execFile);

function say(line) {
  process.stdout.write(`sd-watchdog ${line}\n`);
}

/** s6's view of whether a service should be running; unreadable counts as wanted. */
async function wantedUp(service) {
  try {
    const { stdout } = await run("s6-svstat", ["-o", "wantedup", `/run/service/${service}`], {
      timeout: 1_000,
    });
    return stdout.trim() !== "false";
  } catch {
    return true;
  }
}

/**
 * Records that this round ran, for the healthcheck's hung-watchdog check. The
 * rename makes a reader see either the previous beat or this one, never a
 * partial write.
 */
function beat(now) {
  writeFileSync(`${WATCHDOG_BEAT_FILE}.tmp`, `${now}\n`);
  renameSync(`${WATCHDOG_BEAT_FILE}.tmp`, WATCHDOG_BEAT_FILE);
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

say(
  `started startup-bound=${BOUNDS.startupMs}ms hang-bound=${BOUNDS.hangMs}ms interval=${BOUNDS.intervalMs}ms`,
);
let state = initialState(Date.now());
for (;;) {
  const now = Date.now();
  beat(now);
  const [probes, wanted] = await Promise.all([probeAll(), Promise.all(SERVICES.map(wantedUp))]);
  const wantedUpByService = Object.fromEntries(SERVICES.map((service, i) => [service, wanted[i]]));
  const result = step(state, { now, probes, wantedUp: wantedUpByService });
  state = result.state;

  if (result.action?.kind === "ready") {
    say(`ready after=${result.action.afterMs}ms`);
  } else if (result.action?.kind === "halt") {
    const { reason, detail } = result.action;
    const containerExit =
      reason === "startup-timeout" ? EXIT_CODES.startupTimeout : EXIT_CODES.hang;
    const record = `reason=${reason} detail=${detail} probes=${summarize(probes).replaceAll(" ", ",")}`;
    if (claimFirstFailure(record, containerExit)) {
      await halt().catch((error) => say(`halt failed: ${String(error)}`));
    }
    // The container is stopping; stay up until s6 brings this service down.
    // The interval keeps Node from exiting on an empty event loop.
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
  }
  await delay(Math.max(0, BOUNDS.intervalMs - (Date.now() - now)));
}
