#!/usr/bin/env node
// Single readiness probe: probe api|web|worker [--log-changes]. s6-notifyoncheck
// runs "probe api --log-changes" every 250 ms until the API is ready, then
// notifies s6, which starts the worker and the web server. Its output goes to
// the container log, so with --log-changes a result is printed only when it
// differs from the previous attempt's.
import { readFile, writeFile } from "node:fs/promises";
import { probeApi, probeWeb, probeWorker } from "../lib/probes.mjs";

const probes = { api: probeApi, web: probeWeb, worker: probeWorker };
const [name = "", flag] = process.argv.slice(2);
const probe = probes[name];
if (probe === undefined || (flag !== undefined && flag !== "--log-changes")) {
  process.stderr.write("usage: probe api|web|worker [--log-changes]\n");
  process.exit(2);
}
const result = await probe();
const line = `${name}=${result.detail}`;
if (flag === undefined) {
  process.stdout.write(`${line}\n`);
} else {
  const last = `${process.env.SD_RUN_DIR ?? "/run/sd"}/probe-${name}.last`;
  const previous = await readFile(last, "utf8").catch(() => "");
  if (previous !== line) {
    process.stdout.write(`${line}\n`);
    await writeFile(last, line).catch(() => undefined);
  }
}
process.exitCode = result.ok ? 0 : 1;
