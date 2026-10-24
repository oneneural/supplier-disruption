import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";
import pg from "pg";
import { REPO_ROOT, SECRETS, secret } from "./support.js";

const run = promisify(execFile);

// Every hook and test timeout covers the worst case of the commands it runs.
export const COMPOSE_TIMEOUT_MS = 120_000;
export const NODE_TIMEOUT_MS = 60_000;
export const MARGIN_MS = 30_000;
/** Covers start(): a defensive down, then up with the database healthy. */
export const START_TIMEOUT_MS = 2 * COMPOSE_TIMEOUT_MS + MARGIN_MS;

const PROJECT_PATTERN = /^supplier-disruption-itapi-[a-z0-9]+-[a-z0-9]+$/;
const SHARED_DEVELOPMENT_PORT = 55102;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address !== null ? address.port : 0),
      );
    });
  });
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A disposable Compose project, supplier-disruption-itapi-<run>-<gate>, with
 * only the database service and its own volume on a free loopback port. "Test
 * reset" is recreating this project; the shared development database and
 * every other project are never touched. remove() deletes its containers,
 * network and volume and is safe to call after any failure.
 */
export class DisposableDatabase {
  readonly project: string;
  private port: number | null = null;
  private readonly clients: Array<pg.Client | pg.Pool> = [];

  constructor(gate: string) {
    const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    this.project = `supplier-disruption-itapi-${runId}-${gate}`;
    if (!PROJECT_PATTERN.test(this.project)) {
      throw new Error(`refusing to use project name ${this.project}`);
    }
  }

  private compose(...args: string[]) {
    if (this.port === null) throw new Error("the disposable project has no port yet");
    return run(
      "docker",
      ["compose", "-p", this.project, "-f", "compose.yaml", "-f", "compose.dev.yaml", ...args],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, SD_DB_HOST_PORT: String(this.port) },
        timeout: COMPOSE_TIMEOUT_MS,
      },
    );
  }

  /** Starts the project's database on a new free port, removing any earlier leftover first. */
  async start(): Promise<void> {
    this.port = await freePort();
    if (this.port === SHARED_DEVELOPMENT_PORT) throw new Error("free port is the shared port");
    // Checked before any container starts.
    this.url("migrator");
    try {
      await this.compose("down", "--volumes", "--remove-orphans");
      await this.compose("up", "--detach", "--wait", "db");
    } catch (error) {
      await this.remove();
      throw error;
    }
  }

  /** Removes the project and its volume, keeping the same port, then starts it again. */
  async recreate(): Promise<void> {
    await this.closeClients();
    await this.compose("down", "--volumes", "--remove-orphans");
    await this.compose("up", "--detach", "--wait", "db");
  }

  async remove(): Promise<void> {
    await this.closeClients();
    if (this.port === null) return;
    await this.compose("down", "--volumes", "--remove-orphans");
  }

  /**
   * Ends the sessions of an application name inside the project's own
   * database container, as the superuser over its local socket. A killed
   * process's statement that already waits on a lock would otherwise still
   * run, and an autocommit one would commit, once the lock is released.
   */
  async terminateSessions(applicationName: string): Promise<number> {
    const { stdout } = await this.compose(
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "postgres",
      "-d",
      "supplier_disruption",
      "-Atc",
      `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = '${applicationName.replace(/'/g, "")}'`,
    );
    return Number(stdout.trim());
  }

  /** Whether the project still has any container or volume. */
  async leftovers(): Promise<string> {
    const label = `label=com.docker.compose.project=${this.project}`;
    const containers = await run("docker", ["ps", "--all", "--quiet", "--filter", label]);
    const volumes = await run("docker", ["volume", "ls", "--quiet", "--filter", label]);
    return `${containers.stdout}${volumes.stdout}`.trim();
  }

  /**
   * The development connection URL for a role, pointed at this project's
   * port. Fails rather than fall back to the shared development database.
   */
  url(role: "migrator" | "api" | "worker"): string {
    const port = this.port;
    if (port === null) throw new Error("the disposable project has no port yet");
    const url = secret(`host/database_url_${role}`).replace(
      /@127\.0\.0\.1:\d+\//,
      `@127.0.0.1:${port}/`,
    );
    if (!url.includes(`@127.0.0.1:${port}/`) || port === SHARED_DEVELOPMENT_PORT) {
      throw new Error(
        `.secrets/host/database_url_${role} does not point at 127.0.0.1:<port>; refusing to run against it`,
      );
    }
    return url;
  }

  async client(role: "migrator" | "api" | "worker", name: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: this.url(role), application_name: name });
    this.clients.push(client);
    await client.connect();
    return client;
  }

  pool(role: "migrator" | "api" | "worker", name: string): pg.Pool {
    const pool = new pg.Pool({ connectionString: this.url(role), application_name: name, max: 2 });
    pool.on("error", () => undefined);
    this.clients.push(pool);
    return pool;
  }

  private async closeClients(): Promise<void> {
    await Promise.allSettled(this.clients.splice(0).map((client) => client.end()));
  }

  private env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      APP_ID: "supplier-disruption",
      APP_ORIGIN: "http://127.0.0.1:3102",
      NODE_ENV: "test",
      DATABASE_URL_MIGRATOR: this.url("migrator"),
      BETTER_AUTH_SECRET_FILE: `${SECRETS}/better_auth_secret`,
      FIXTURE_BUYER_PASSWORD_FILE: `${SECRETS}/fixture_buyer_password`,
      FIXTURE_MANAGER_PASSWORD_FILE: `${SECRETS}/fixture_manager_password`,
    };
  }

  /** Runs a built command and never throws on a nonzero exit. */
  private async command(script: string): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await run("node", [script], {
        cwd: REPO_ROOT,
        env: this.env(),
        timeout: NODE_TIMEOUT_MS,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof failed.code !== "number") throw error;
      return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  }

  migrate(): Promise<CommandResult> {
    return this.command("packages/db/dist/cli/migrate.js");
  }

  seed(): Promise<CommandResult> {
    return this.command("apps/api/dist/seed.js");
  }
}
