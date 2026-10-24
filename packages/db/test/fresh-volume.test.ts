import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_ORG,
  NOTHING_CHANGED,
  REPO_ROOT,
  SECRETS,
  connect,
  secret,
  snapshot,
} from "./support.js";

const run = promisify(execFile);

// A disposable Compose project with its own volume, so the shared development
// database is never touched. The test removes the project and volume at the end.
const PROJECT = "supplier-disruption-fresh";
const VOLUME = `${PROJECT}_db-data`;

// Every hook and test timeout below covers the worst case of the commands it
// runs, so a slow Docker call fails its command instead of cutting off teardown.
const COMPOSE_TIMEOUT_MS = 120_000;
const DOCKER_TIMEOUT_MS = 30_000;
const NODE_TIMEOUT_MS = 60_000;
const MARGIN_MS = 30_000;

let port: number;
let observer: pg.Client | undefined;

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

function compose(...args: string[]) {
  return run(
    "docker",
    ["compose", "-p", PROJECT, "-f", "compose.yaml", "-f", "compose.dev.yaml", ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, SD_DB_HOST_PORT: String(port) },
      timeout: COMPOSE_TIMEOUT_MS,
    },
  );
}

async function volumeExists(): Promise<boolean> {
  try {
    await run("docker", ["volume", "inspect", VOLUME], { timeout: DOCKER_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * The development URL with this project's port. Fails rather than fall back to
 * the shared development database if the URL does not have the expected shape.
 */
function migratorUrl(): string {
  const url = secret("host/database_url_migrator").replace(
    /@127\.0\.0\.1:\d+\//,
    `@127.0.0.1:${port}/`,
  );
  if (!url.includes(`@127.0.0.1:${port}/`)) {
    throw new Error(
      `.secrets/host/database_url_migrator does not point at 127.0.0.1:<port>; refusing to run against it`,
    );
  }
  return url;
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    APP_ID: "supplier-disruption",
    APP_ORIGIN: "http://127.0.0.1:3102",
    NODE_ENV: "test",
    DATABASE_URL_MIGRATOR: migratorUrl(),
    BETTER_AUTH_SECRET_FILE: `${SECRETS}/better_auth_secret`,
    FIXTURE_BUYER_PASSWORD_FILE: `${SECRETS}/fixture_buyer_password`,
    FIXTURE_MANAGER_PASSWORD_FILE: `${SECRETS}/fixture_manager_password`,
  };
}

function migrate() {
  return run("node", ["packages/db/dist/cli/migrate.js"], {
    cwd: REPO_ROOT,
    env: commandEnv(),
    timeout: NODE_TIMEOUT_MS,
  });
}

function seed() {
  return run("node", ["apps/api/dist/seed.js"], {
    cwd: REPO_ROOT,
    env: commandEnv(),
    timeout: NODE_TIMEOUT_MS,
  });
}

beforeAll(
  async () => {
    port = await freePort();
    // Checked before any container starts, and again by every migrate and seed call.
    migratorUrl();
    // A previous interrupted run may have left the disposable project behind.
    await compose("down", "--volumes", "--remove-orphans");
    expect(await volumeExists()).toBe(false);
    await compose("up", "--detach", "--wait", "db");
  },
  2 * COMPOSE_TIMEOUT_MS + DOCKER_TIMEOUT_MS + MARGIN_MS,
);

afterAll(async () => {
  await observer?.end();
  await compose("down", "--volumes", "--remove-orphans");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

describe("G3 fresh volume", () => {
  it(
    "initializes roles from secret files on an empty volume",
    async () => {
      expect(await volumeExists()).toBe(true);
      const logs = await compose("logs", "db");
      expect(logs.stdout).toContain("running /docker-entrypoint-initdb.d/10-roles.sh");

      observer = await connect(migratorUrl(), "g3-fresh-observer");
      const { rows } = await observer.query<{
        rolname: string;
        rolsuper: boolean;
        rolcreaterole: boolean;
      }>(
        `SELECT rolname, rolsuper, rolcreaterole FROM pg_roles
        WHERE rolname IN ('sd_migrator', 'sd_api', 'sd_worker') ORDER BY rolname`,
      );
      expect(rows).toEqual([
        { rolname: "sd_api", rolsuper: false, rolcreaterole: false },
        { rolname: "sd_migrator", rolsuper: false, rolcreaterole: false },
        { rolname: "sd_worker", rolsuper: false, rolcreaterole: false },
      ]);
      // Nothing exists before the migration command runs.
      const schemas = await observer.query(
        `SELECT nspname FROM pg_namespace WHERE nspname IN ('auth', 'app', 'worker', 'pgboss', 'drizzle')`,
      );
      expect(schemas.rows).toEqual([]);
    },
    COMPOSE_TIMEOUT_MS + DOCKER_TIMEOUT_MS + MARGIN_MS,
  );

  it(
    "migrates and seeds from empty",
    async () => {
      const migrated = await migrate();
      expect(migrated.stdout).toContain("migrate: queue pilot-operation created");
      expect(migrated.stdout).toContain("migrate: queue case-application created");
      expect(migrated.stdout).toContain("migrate: done");

      const seeded = await seed();
      expect(seeded.stdout).toBe(
        "seed: organization created=true, users created=[buyer@fixture.local, manager@fixture.local], " +
          "memberships created=[buyer@fixture.local, manager@fixture.local]\n" +
          "seed: canonical inputs first-slice-c01.v1 initialized\n" +
          "seed: simulated case actors created=[buyer-1, cs-1, supplier-1, manager-1, planner-1]\n",
      );

      const db = observer!;
      const schemas = await db.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace
        WHERE nspname IN ('auth', 'app', 'worker', 'pgboss', 'drizzle') ORDER BY 1`,
      );
      expect(schemas.rows.map((row) => row.nspname)).toEqual([
        "app",
        "auth",
        "drizzle",
        "pgboss",
        "worker",
      ]);

      const members = await db.query(
        `SELECT u.email, m.role FROM app.membership m JOIN auth."user" u ON u.id = m.user_id
        WHERE m.organization_id = $1 ORDER BY u.email`,
        [FIXTURE_ORG],
      );
      expect(members.rows).toEqual([
        { email: "buyer@fixture.local", role: "buyer" },
        { email: "manager@fixture.local", role: "manager" },
      ]);
      // Provisioning signs nobody in.
      const sessions = await db.query<{ count: string }>(`SELECT count(*) FROM auth.session`);
      expect(sessions.rows[0]?.count).toBe("0");
    },
    2 * NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it(
    "reruns migrate and seed as no-ops",
    async () => {
      const db = observer!;
      const before = await snapshot(db);

      const migrated = await migrate();
      expect(migrated.stdout).toContain("migrate: done");
      expect(migrated.stdout).not.toContain("created");
      expect(migrated.stdout).not.toContain("corrected");
      const seeded = await seed();
      expect(seeded.stdout).toBe(NOTHING_CHANGED);

      expect(await snapshot(db)).toBe(before);
    },
    2 * NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it(
    "tears the disposable project and its volume down",
    async () => {
      await observer?.end();
      observer = undefined;
      await compose("down", "--volumes", "--remove-orphans");
      expect(await volumeExists()).toBe(false);
      const { stdout } = await run(
        "docker",
        ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${PROJECT}`],
        { timeout: DOCKER_TIMEOUT_MS },
      );
      expect(stdout.trim()).toBe("");
    },
    COMPOSE_TIMEOUT_MS + 2 * DOCKER_TIMEOUT_MS + MARGIN_MS,
  );
});
