// Helpers for the container gate tests. Every Docker resource they create
// belongs to a disposable Compose project named supplier-disruption-ct-<suffix>;
// nothing here touches the supplier-disruption project or any other project.
import { execFile, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inject } from "vitest";

/** Fixture organization and manager seeded by `seed.js` (apps/api/src/fixtures.ts). */
export const FIXTURE_ORGANIZATION_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const FIXTURE_MANAGER_EMAIL = "manager@fixture.local";

/**
 * Declared bounds the gates assert against. The image's own bounds live in
 * infra/app/rootfs/opt/sd/lib/watchdog-core.mjs and the s6 timeout files; these
 * add the observation slack each gate needs and are recorded in ADR 0002.
 */
export const GATE_BOUNDS = {
  /** First aggregate readiness after `up` (watchdog startup bound is 90 s). */
  healthyMs: 120_000,
  /** SIGKILL or unexpected exit of an essential service to container exit. */
  deathExitMs: 15_000,
  /** SIGSTOP to container exit: 30 s hang bound, plus 10 s heartbeat freshness for the worker, probe period and timeout. */
  hangExitMs: 60_000,
  /** `docker compose stop app` with a job in flight; the image drains in under 30 s. */
  stopMs: 30_000,
  /** Restarted container back to healthy. */
  recoveryMs: 120_000,
  /**
   * Container exit to Compose's restart of it. Docker restarts at once after
   * a run longer than 10 s; recovery then gets the full healthyMs from the
   * restarted container's own start (ADR 0021).
   */
  restartMs: 15_000,
  /**
   * SIGSTOP to the watchdog to container exit: 20 s beat staleness, up to one
   * 2 s healthcheck interval and its run, then the halt (about 5.2 s).
   */
  watchdogHangExitMs: 45_000,
};

/**
 * Runs a command without a shell and never throws on a nonzero exit.
 * @returns {Promise<{ code: number, stdout: string, stderr: string, ms: number }>}
 */
export function run(command, args, { env, cwd, input, timeout = 600_000 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { env: env ?? process.env, cwd, timeout, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(new Error(`${command} ${args.join(" ")}: ${error.message}\n${stderr}`));
          return;
        }
        resolve({ code: error?.code ?? 0, stdout, stderr, ms: Date.now() - started });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

const SWEEP_ROOT = "supplier-disruption-ct-";

/**
 * Force-removes the containers, volumes and networks whose Compose project
 * label starts with prefix, which must lie inside supplier-disruption-ct-, and
 * unless `images` is false, the test images tagged under it. Covers projects
 * `docker compose ls` no longer lists, such as a volume left after its
 * containers were removed.
 * @returns {Promise<string[]>} what was removed
 */
export async function sweep(prefix = SWEEP_ROOT, { images = true } = {}) {
  if (!prefix.startsWith(SWEEP_ROOT)) throw new Error(`refusing to sweep outside ${SWEEP_ROOT}`);
  const removed = [];
  const labelled = async (kind, field) => {
    const { stdout } = await must("docker", [
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      "--filter",
      "label=com.docker.compose.project",
      "--format",
      `{{.${field}}} {{.Label "com.docker.compose.project"}}`,
    ]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "))
      .filter(([, project]) => project.startsWith(prefix))
      .map(([id]) => id);
  };
  for (const [kind, field, rm] of [
    ["container", "ID", ["rm", "--force", "--volumes"]],
    ["volume", "Name", ["rm", "--force"]],
    ["network", "ID", ["rm"]],
  ]) {
    const ids = await labelled(kind, field);
    if (ids.length === 0) continue;
    await must("docker", [kind, ...rm, ...ids]);
    removed.push(...ids.map((id) => `${kind} ${id}`));
  }
  if (!images) return removed;
  const { stdout: tags } = await must("docker", [
    "image",
    "ls",
    "--filter",
    `reference=${prefix}*`,
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);
  for (const image of tags.split("\n").filter(Boolean)) {
    await must("docker", ["image", "rm", "--force", image]);
    removed.push(`image ${image}`);
  }
  return removed;
}

/** Like run, but throws with the command's output when it exits nonzero. */
export async function must(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.code}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

/** A free TCP port on 127.0.0.1, released before it is returned. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Polls `check` until it returns a value other than undefined/false, or throws on timeout. */
export async function waitFor(what, check, { timeoutMs, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last !== undefined && last !== false) return last;
    if (Date.now() >= deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(intervalMs);
  }
}

/** The values the global setup provided: source clone, image tag, canaries. */
export function context() {
  return inject("ct");
}

/**
 * Appends a line of gate evidence (timings, secret modes) to timings.log in the
 * run's work directory; the global teardown prints the file at the end.
 */
export function record(line) {
  appendFileSync(join(context().work, "timings.log"), `${line}\n`);
}

/**
 * Container log lines from both streams, merged in timestamp order, each as
 * { time: Date, text: string }.
 */
export function parseTimestampedLogs(stdout, stderr) {
  const lines = [];
  for (const chunk of [stdout, stderr]) {
    for (const raw of chunk.split("\n")) {
      if (raw === "") continue;
      const space = raw.indexOf(" ");
      lines.push({ stamp: raw.slice(0, space), text: raw.slice(space + 1) });
    }
  }
  // RFC 3339 nano timestamps with a fixed width sort correctly as strings.
  lines.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  return lines.map(({ stamp, text }) => ({ time: new Date(stamp), text }));
}

/**
 * Splits log lines into container boots at each "sd-boot boot=<id>" line. A
 * boot's stop and failure lines precede the next boot line, so they stay with
 * the boot they belong to. Lines before the first boot line are dropped.
 * @returns {{ bootId: string, lines: { time: Date, text: string }[] }[]}
 */
export function bootSegments(lines) {
  const boots = [];
  for (const line of lines) {
    const match = /^sd-boot boot=([0-9a-f-]{36})$/.exec(line.text);
    if (match !== null) boots.push({ bootId: match[1], lines: [line] });
    else boots.at(-1)?.lines.push(line);
  }
  return boots;
}

/** Parses "key=value key=value" fields from an sd-lifecycle or sd-first-failure line. */
export function fields(text) {
  return Object.fromEntries(
    text
      .split(" ")
      .slice(1)
      .map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
  );
}

/**
 * Streams `docker events` for one container from now on and records every
 * "die" event, so a test can learn the exit code of a container that Compose
 * restarts before `docker inspect` could show it.
 */
export class DieWatcher {
  constructor(container) {
    this.events = [];
    this.waiters = [];
    this.child = spawn(
      "docker",
      [
        "events",
        "--filter",
        `container=${container}`,
        "--filter",
        "event=die",
        "--format",
        "{{json .}}",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        this.events.push({
          exitCode: Number(event.Actor.Attributes.exitCode),
          at: Math.floor(event.timeNano / 1e6),
        });
        for (const wake of this.waiters.splice(0)) wake();
      }
    });
  }

  /** Waits for the die event with this index (0 for the first). */
  async next(index, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.events.length <= index) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no container exit within ${timeoutMs} ms`);
      await Promise.race([new Promise((wake) => this.waiters.push(wake)), delay(remaining)]);
    }
    return this.events[index];
  }

  stop() {
    this.child.kill();
  }
}

/**
 * One disposable Compose project built from the clone's compose.yaml. A gate
 * may add app environment variables for its own project only; they go into an
 * override file beside the run, never into compose.yaml.
 */
export class Project {
  constructor(gate, { appEnvironment } = {}) {
    const ct = context();
    this.ct = ct;
    this.name = `supplier-disruption-ct-${ct.runId}-${gate}`;
    this.app = `${this.name}-app-1`;
    this.db = `${this.name}-db-1`;
    this.port = null;
    this.overrideFile = null;
    if (appEnvironment !== undefined) {
      this.overrideFile = join(tmpdir(), `${this.name}.override.json`);
      // JSON is valid YAML, so Compose merges this file over compose.yaml.
      writeFileSync(
        this.overrideFile,
        JSON.stringify({ services: { app: { environment: appEnvironment } } }),
      );
    }
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  env() {
    const env = {
      ...process.env,
      SD_APP_IMAGE: this.ct.image,
      SD_APP_HOST_PORT: String(this.port),
    };
    delete env.COMPOSE_PROJECT_NAME;
    delete env.COMPOSE_FILE;
    return env;
  }

  compose(args, options = {}) {
    return run(
      "docker",
      [
        "compose",
        "--project-name",
        this.name,
        "--project-directory",
        this.ct.sourceDir,
        "--file",
        join(this.ct.sourceDir, "compose.yaml"),
        ...(this.overrideFile === null ? [] : ["--file", this.overrideFile]),
        ...args,
      ],
      { env: this.env(), ...options },
    );
  }

  async mustCompose(args, options) {
    const result = await this.compose(args, options);
    if (result.code !== 0) {
      throw new Error(
        `compose ${args.join(" ")} exited ${result.code}\n${result.stdout}\n${result.stderr}`,
      );
    }
    return result;
  }

  /** Allocates a port, starts the database, runs the init service and starts the app. */
  async start() {
    this.port = await freePort();
    const init = await this.mustCompose(["run", "--rm", "init"]);
    const up = await this.mustCompose(["up", "--detach", "--no-build", "app"]);
    await this.waitReady(GATE_BOUNDS.healthyMs);
    return { init, up };
  }

  /** Removes the project's containers, networks and volumes; safe to call twice. */
  async remove() {
    if (this.port === null) return;
    await this.compose([
      "--profile",
      "init",
      "down",
      "--volumes",
      "--remove-orphans",
      "--timeout",
      "60",
    ]);
  }

  async inspect(container = this.app) {
    const { stdout } = await must("docker", ["inspect", container]);
    return JSON.parse(stdout)[0];
  }

  async health() {
    const { code, stdout } = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
      this.app,
    ]);
    if (code !== 0) return { status: "missing", health: "" };
    const [status, health = ""] = stdout.trim().split(" ");
    return { status, health };
  }

  /**
   * Docker healthy and the watchdog's own first readiness for the current
   * boot. Docker can report healthy before the watchdog's next probe round;
   * until then the watchdog applies only its startup bound, not the hang bound.
   */
  async waitReady(timeoutMs) {
    await this.waitHealthy(timeoutMs);
    const boot = await this.bootId();
    await waitFor(
      "the watchdog's first readiness",
      async () =>
        (await this.boots())
          .find((segment) => segment.bootId === boot)
          ?.lines.some((line) => line.text.startsWith("sd-watchdog ready ")),
      { timeoutMs: 15_000, intervalMs: 250 },
    );
  }

  waitHealthy(timeoutMs) {
    return waitFor(`${this.app} healthy`, async () => (await this.health()).health === "healthy", {
      timeoutMs,
      intervalMs: 250,
    });
  }

  /** Runs a shell command as the container user inside the running app container. */
  exec(script, options = {}) {
    return run(
      "docker",
      ["exec", ...(options.input === undefined ? [] : ["-i"]), this.app, "sh", "-c", script],
      options,
    );
  }

  async bootId() {
    const { stdout } = await must("docker", ["exec", this.app, "cat", "/run/sd/boot-id"]);
    return stdout.trim();
  }

  /** PID of an s6 longrun's process, from s6-svstat. */
  async pid(service) {
    const { stdout } = await must("docker", [
      "exec",
      this.app,
      "s6-svstat",
      "-o",
      "pid",
      `/run/service/${service}`,
    ]);
    return Number(stdout.trim());
  }

  async logLines() {
    const { stdout, stderr } = await must("docker", ["logs", "--timestamps", this.app]);
    return parseTimestampedLogs(stdout, stderr);
  }

  async boots() {
    return bootSegments(await this.logLines());
  }

  /** Runs SQL as the PostgreSQL superuser inside the db container and returns JSON rows. */
  async sql(query) {
    const wrapped = `SELECT coalesce(json_agg(row_to_json(q)), '[]'::json) FROM (${query}) q`;
    const { stdout } = await must("docker", [
      "exec",
      this.db,
      "psql",
      "--username",
      "postgres",
      "--dbname",
      "supplier_disruption",
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--quiet",
      "--command",
      wrapped,
    ]);
    return JSON.parse(stdout);
  }

  async execSql(statement) {
    await must("docker", [
      "exec",
      this.db,
      "psql",
      "--username",
      "postgres",
      "--dbname",
      "supplier_disruption",
      "--no-psqlrc",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      statement,
    ]);
  }

  /**
   * Signs in as the fixture manager on the API's loopback listener inside the
   * container and submits one pilot operation. The password travels on stdin,
   * never in arguments. Returns the API's status and body.
   */
  async submitOperation(payload) {
    const operationId = crypto.randomUUID();
    const script = `
      const input = JSON.parse(await new Response(process.stdin).text());
      const api = "http://127.0.0.1:3001";
      const headers = { "content-type": "application/json", origin: input.origin };
      const signIn = await fetch(api + "/api/auth/sign-in/email", {
        method: "POST", headers, body: JSON.stringify({ email: input.email, password: input.password }),
      });
      if (signIn.status !== 200) { console.log(JSON.stringify({ signIn: signIn.status })); process.exit(0); }
      const cookie = signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      const response = await fetch(api + "/api/pilot/operations", {
        method: "POST", headers: { ...headers, cookie }, body: JSON.stringify(input.command),
      });
      console.log(JSON.stringify({ status: response.status, body: await response.json().catch(() => null) }));
    `;
    const input = JSON.stringify({
      origin: this.origin,
      email: FIXTURE_MANAGER_EMAIL,
      password: this.ct.managerPassword,
      command: {
        contractVersion: "pilot-operation.v1",
        operationId,
        organizationId: FIXTURE_ORGANIZATION_ID,
        payload,
      },
    });
    const { stdout } = await must(
      "docker",
      ["exec", "-i", this.app, "node", "--input-type=module", "--eval", script],
      { input },
    );
    return { operationId, ...JSON.parse(stdout.trim()) };
  }

  /** The operation row, its handler attempts and its receipt, read independently. */
  async operation(operationId) {
    const [row] = await this.sql(
      `SELECT o.operation_id, o.receipt_id, o.receipt_recorded_at,
              (SELECT count(*) FROM app.pilot_handler_attempt a WHERE a.operation_id = o.operation_id)::int AS attempts
         FROM app.pilot_operation o WHERE o.operation_id = '${operationId}'`,
    );
    return row ?? null;
  }
}
