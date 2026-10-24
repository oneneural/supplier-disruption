import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SECRETS = `${REPO_ROOT}.secrets`;

export function secret(relative: string): string {
  try {
    return readFileSync(`${SECRETS}/${relative}`, "utf8").trim();
  } catch {
    throw new Error(
      `Missing .secrets/${relative}. Run: sh scripts/init-secrets.sh, then start the database with corepack pnpm db:up`,
    );
  }
}

export const urls = {
  migrator: () => secret("host/database_url_migrator"),
  api: () => secret("host/database_url_api"),
  worker: () => secret("host/database_url_worker"),
};

/** Environment for the migrate and seed commands, using _FILE indirection only. */
export function commandEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    APP_ID: "supplier-disruption",
    APP_ORIGIN: "http://127.0.0.1:3102",
    NODE_ENV: "test",
    DATABASE_URL_MIGRATOR_FILE: `${SECRETS}/host/database_url_migrator`,
    BETTER_AUTH_SECRET_FILE: `${SECRETS}/better_auth_secret`,
    FIXTURE_BUYER_PASSWORD_FILE: `${SECRETS}/fixture_buyer_password`,
    FIXTURE_MANAGER_PASSWORD_FILE: `${SECRETS}/fixture_manager_password`,
  };
}

export async function connect(url: string, name: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: name });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the Compose database (${String(error)}). Start it with corepack pnpm db:up, then corepack pnpm db:migrate and db:seed.`,
      { cause: error },
    );
  }
  return client;
}

export const FIXTURE_ORG = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** Seed output when the pilot fixtures, the canonical inputs and the case actors are present. */
export const NOTHING_CHANGED =
  "seed: fixtures already present; nothing changed\n" +
  "seed: canonical inputs first-slice-c01.v1 already present; nothing changed\n" +
  "seed: simulated case actors already present; nothing changed\n";

const SCHEMAS = `'auth', 'app', 'worker', 'pgboss', 'drizzle', 'fixture_purchasing', 'fixture_inventory', 'fixture_demand', 'fixture_reference'`;

/** A stable fingerprint of schema, grants, migration history, queue policy and fixtures. */
export async function snapshot(client: pg.Client): Promise<string> {
  const queries = [
    `SELECT n.nspname, c.relname, c.relkind, c.relacl::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (${SCHEMAS})
      ORDER BY 1, 2`,
    `SELECT nspname, nspacl::text FROM pg_namespace
      WHERE nspname IN ('public', ${SCHEMAS}) ORDER BY 1`,
    `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema IN (${SCHEMAS}) ORDER BY 1, 2, 3`,
    `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
    `SELECT version FROM pgboss.version`,
    `SELECT id, tag, applied_at FROM app.schema_tag`,
    `SELECT name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds, retention_seconds,
            deletion_seconds, dead_letter, partition, created_on, updated_on FROM pgboss.queue ORDER BY name`,
    `SELECT id, slug, name, created_at FROM app.organization ORDER BY id`,
    `SELECT u.id, u.email, u.updated_at, a.password, a.updated_at AS account_updated
       FROM auth."user" u JOIN auth.account a ON a.user_id = u.id
      WHERE u.email IN ('buyer@fixture.local', 'manager@fixture.local') ORDER BY u.email`,
    `SELECT organization_id, user_id, role, created_at FROM app.membership
      WHERE organization_id = '${FIXTURE_ORG}' ORDER BY user_id`,
    // Canonical inputs: the marker, the clock and one record per authority.
    `SELECT fixture_version, manifest_sha256, oracle_sha256, completed_at FROM fixture_reference.seed_marker`,
    `SELECT instant FROM fixture_reference.business_clock`,
    `SELECT xmin::text, to_jsonb(t) FROM fixture_purchasing.po_line t ORDER BY 2::text`,
    `SELECT xmin::text, to_jsonb(t) FROM fixture_inventory.stock_snapshot t ORDER BY 2::text`,
    `SELECT xmin::text, to_jsonb(t) FROM fixture_demand.demand_line t ORDER BY 2::text`,
    // Provisioning must not sign anyone in.
    `SELECT count(*) AS sessions FROM auth.session`,
  ];
  const parts: unknown[] = [];
  for (const text of queries) {
    parts.push((await client.query(text)).rows);
  }
  return JSON.stringify(parts);
}

export const EXPECTED_QUEUE_OPTIONS = {
  policy: "exclusive",
  retry_limit: 3,
  retry_delay: 1,
  retry_backoff: false,
  expire_seconds: 30,
  retention_seconds: 86_400,
  deletion_seconds: 86_400,
  dead_letter: null,
  partition: false,
};

export async function queueOptions(client: pg.Client): Promise<unknown> {
  const { rows } = await client.query(
    `SELECT policy, retry_limit, retry_delay, retry_backoff, expire_seconds, retention_seconds,
            deletion_seconds, dead_letter, partition
       FROM pgboss.queue WHERE name = 'pilot-operation'`,
  );
  return rows[0];
}
