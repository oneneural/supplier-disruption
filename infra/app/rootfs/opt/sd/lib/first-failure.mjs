// The container's first-failure record, shared by the watchdog and the
// healthcheck. finish-essential claims the same directory from shell.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export const RUN_DIR = "/run/sd";
const RESULTS_FILE = "/run/s6-linux-init-container-results/exitcode";
const HALT = "/run/s6/basedir/bin/halt";

/**
 * Atomically claims the first-failure record; false if another failure won.
 * `log` receives the sd-first-failure line (default: this process's stdout).
 */
export function claimFirstFailure(
  record,
  containerExit,
  log = (line) => process.stdout.write(line),
) {
  try {
    mkdirSync(`${RUN_DIR}/first-failure`);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  writeFileSync(`${RUN_DIR}/first-failure/record`, `${record}\n`);
  writeFileSync(`${RUN_DIR}/first-failure/exit`, `${containerExit}\n`);
  writeFileSync(RESULTS_FILE, `${containerExit}\n`);
  log(`sd-first-failure ${record} container-exit=${containerExit}\n`);
  return true;
}

/** The claimed first-failure record, or null when none is readable yet. */
export function readFirstFailure() {
  try {
    return readFileSync(`${RUN_DIR}/first-failure/record`, "utf8").trim();
  } catch {
    return null;
  }
}

/** Asks s6-overlay to stop the container; the claimed exit code survives it. */
export function halt() {
  return run(HALT);
}
