#!/usr/bin/env node
// Docker healthcheck: aggregate readiness on loopback inside the container.
// Healthy only when the API is ready, the web server answers and the worker
// heartbeat for this boot is fresh. Prints status words, never secrets.
//
// Docker runs this check every interval in its own process, independent of
// the watchdog, so it also detects a hung watchdog (ADR 0021): a wanted-up
// watchdog whose beat is older than the bound is recorded as the container's
// first failure, hang:watchdog, and the container halts.
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { claimFirstFailure, halt, readFirstFailure } from "../lib/first-failure.mjs";
import { probeAll, summarize } from "../lib/probes.mjs";
import {
  BOUNDS,
  EXIT_CODES,
  WATCHDOG_BEAT_FILE,
  haltForHungWatchdog,
  watchdogHung,
} from "../lib/watchdog-core.mjs";

const run = promisify(execFile);

function readBeat() {
  try {
    return Number(readFileSync(WATCHDOG_BEAT_FILE, "utf8").trim());
  } catch {
    return null;
  }
}

/** s6's state of the watchdog (up, wanted up, time in that state); null where unreadable. */
async function watchdogState() {
  try {
    const { stdout } = await run(
      "s6-svstat",
      ["-o", "up,wantedup,updownfor", "/run/service/watchdog"],
      { timeout: 1_000 },
    );
    const [up, wantedUp, seconds] = stdout.trim().split(" ");
    const parse = (value) => (value === "true" ? true : value === "false" ? false : null);
    const upFor = Number(seconds);
    return {
      up: parse(up),
      wantedUp: parse(wantedUp),
      upForMs: seconds !== undefined && Number.isFinite(upFor) ? upFor * 1_000 : null,
    };
  } catch {
    return { up: null, wantedUp: null, upForMs: null };
  }
}

/** The record goes to the container log too; this process's output only reaches Docker's health log. */
function log(line) {
  process.stdout.write(line);
  try {
    appendFileSync("/proc/1/fd/1", line);
  } catch {
    // Best effort: the record directory and exit code are the durable evidence.
  }
}

const beatAt = readBeat();
if (beatAt !== null && Date.now() - beatAt >= BOUNDS.watchdogStaleMs) {
  const hung = watchdogHung({ now: Date.now(), beatAt, ...(await watchdogState()) });
  if (hung !== null) {
    const record = `reason=${hung.reason} detail=${hung.detail} source=healthcheck`;
    const claimed = claimFirstFailure(record, EXIT_CODES.hang, log);
    // A later round retries the halt for its own record, should one have failed.
    if (haltForHungWatchdog({ claimed, record: claimed ? record : readFirstFailure() })) {
      await halt().catch((error) => log(`sd-healthcheck halt failed: ${String(error)}\n`));
    }
    process.stdout.write(`watchdog=hung ${hung.detail}\n`);
    process.exit(1);
  }
}

const probes = await probeAll();
process.stdout.write(`${summarize(probes)}\n`);
process.exitCode = Object.values(probes).every((probe) => probe.ok) ? 0 : 1;
