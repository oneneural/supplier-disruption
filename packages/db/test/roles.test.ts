import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type pg from "pg";
import { PgBoss, type Db } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGBOSS_SCHEMA, PILOT_JOB_OPTIONS, PILOT_QUEUE } from "../src/queue.js";
import { SCHEMA_TAG } from "../src/schema-tag.js";
import {
  EXPECTED_QUEUE_OPTIONS,
  FIXTURE_ORG,
  NOTHING_CHANGED,
  REPO_ROOT,
  commandEnv,
  connect,
  queueOptions,
  snapshot,
  urls,
} from "./support.js";

const run = promisify(execFile);

// Each table with a column to name in a no-op UPDATE.
const BUSINESS_AND_AUTH_TABLES = [
  ['auth."user"', "id"],
  ["auth.session", "id"],
  ["auth.account", "id"],
  ["auth.verification", "id"],
  ["app.organization", "id"],
  ["app.membership", "role"],
  ["app.pilot_operation", "state"],
  ["app.pilot_receipt_attempt", "outcome"],
  ["app.pilot_handler_attempt", "job_id"],
  ["app.schema_tag", "tag"],
];
const APPLICATION_SCHEMAS = ["public", "auth", "app", "worker", "pgboss", "drizzle"];

let migrator: pg.Client;
let api: pg.Client;
let worker: pg.Client;

/** Runs SQL and returns the SQLSTATE it failed with, or "ok". */
async function sqlState(client: pg.Client, text: string, values: unknown[] = []): Promise<string> {
  await client.query("BEGIN");
  try {
    await client.query(text, values);
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  } finally {
    await client.query("ROLLBACK");
  }
}

/** A pg-boss Db over one client, so a test can run pg-boss calls inside its own transaction. */
function clientDb(client: pg.Client): Db {
  return { executeSql: (text, values) => client.query(text, values) };
}

beforeAll(async () => {
  migrator = await connect(urls.migrator(), "g3-observer");
  api = await connect(urls.api(), "g3-api");
  worker = await connect(urls.worker(), "g3-worker");
});

afterAll(async () => {
  await Promise.all([migrator?.end(), api?.end(), worker?.end()]);
});

describe("G3 roles", () => {
  it("runtime roles are login roles without superuser, createdb, createrole or replication", async () => {
    const { rows } = await migrator.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles WHERE rolname IN ('sd_migrator', 'sd_api', 'sd_worker') ORDER BY rolname`,
    );
    expect(rows.map((row) => row.rolname)).toEqual(["sd_api", "sd_migrator", "sd_worker"]);
    for (const row of rows) {
      expect(row).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });
    }
  });

  it.each(BUSINESS_AND_AUTH_TABLES)("sd_worker cannot read or write %s", async (table, column) => {
    expect(await sqlState(worker, `SELECT 1 FROM ${table} LIMIT 1`)).toBe("42501");
    expect(await sqlState(worker, `DELETE FROM ${table}`)).toBe("42501");
    expect(await sqlState(worker, `UPDATE ${table} SET ${column} = ${column}`)).toBe("42501");
    expect(await sqlState(worker, `INSERT INTO ${table} DEFAULT VALUES`)).toBe("42501");
  });

  it.each([
    ["sd_api", () => api],
    ["sd_worker", () => worker],
  ])(
    "%s cannot CREATE in any schema, create schemas, temp tables or roles",
    async (_role, client) => {
      const c = client();
      for (const schema of APPLICATION_SCHEMAS) {
        expect(await sqlState(c, `CREATE TABLE ${schema}.zz_probe (x int)`), schema).toBe("42501");
        expect(
          await sqlState(
            c,
            `CREATE FUNCTION ${schema}.zz_probe() RETURNS int LANGUAGE sql AS 'select 1'`,
          ),
        ).toBe("42501");
      }
      expect(await sqlState(c, "CREATE SCHEMA zz_probe")).toBe("42501");
      expect(await sqlState(c, "CREATE TEMP TABLE zz_probe (x int)")).toBe("42501");
      expect(await sqlState(c, "CREATE ROLE zz_probe")).toBe("42501");

      const { rows } = await c.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace WHERE has_schema_privilege(current_user, oid, 'CREATE')`,
      );
      expect(rows).toEqual([]);
      const db = await c.query<{ can_create: boolean; can_temp: boolean }>(
        `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
              has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_temp`,
      );
      expect(db.rows[0]).toEqual({ can_create: false, can_temp: false });
    },
  );

  it("sd_api can read but never write the worker heartbeat and schema tag", async () => {
    expect(await sqlState(api, "SELECT boot_id, observed_at FROM worker.heartbeat LIMIT 1")).toBe(
      "ok",
    );
    expect(await sqlState(api, "SELECT tag FROM app.schema_tag")).toBe("ok");
    expect(
      await sqlState(
        api,
        "INSERT INTO worker.heartbeat (boot_id, build_revision) VALUES ($1, 'x')",
        [randomUUID()],
      ),
    ).toBe("42501");
    expect(await sqlState(api, "UPDATE worker.heartbeat SET observed_at = now()")).toBe("42501");
    expect(await sqlState(api, "DELETE FROM worker.heartbeat")).toBe("42501");
    expect(await sqlState(api, "UPDATE app.schema_tag SET tag = tag")).toBe("42501");
    expect(await sqlState(api, "INSERT INTO app.schema_tag (id, tag) VALUES (1, 'x')")).toBe(
      "42501",
    );
    expect(await sqlState(api, "DELETE FROM app.schema_tag")).toBe("42501");
    // Only the heartbeat in the worker schema; pg-boss queue state is separate.
    const { rows } = await api.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'worker' AND c.relkind = 'r' AND has_table_privilege(current_user, c.oid, 'SELECT')`,
    );
    expect(rows.map((row) => row.relname)).toEqual(["heartbeat"]);
  });

  it("nobody but the migrator reads migration history", async () => {
    expect(await sqlState(api, "SELECT 1 FROM drizzle.__drizzle_migrations")).toBe("42501");
    expect(await sqlState(worker, "SELECT 1 FROM drizzle.__drizzle_migrations")).toBe("42501");
  });

  it("sd_api can do its own auth, business and queue-producer work", async () => {
    const [manager] = (
      await migrator.query<{ id: string }>(
        `SELECT id FROM auth."user" WHERE email = 'manager@fixture.local'`,
      )
    ).rows;
    expect(manager, "seeded manager is required; run corepack pnpm db:seed").toBeDefined();

    await api.query("BEGIN");
    try {
      await api.query(`SELECT count(*) FROM auth.session`);
      await api.query(`SELECT role FROM app.membership WHERE organization_id = $1`, [FIXTURE_ORG]);
      const operationId = randomUUID();
      await api.query(
        `INSERT INTO app.pilot_operation (operation_id, organization_id, submitted_by, contract_version, payload, payload_sha256)
         VALUES ($1, $2, $3, 'pilot-operation.v1', '{"note":"g3"}', repeat('a', 64))`,
        [operationId, FIXTURE_ORG, manager?.id],
      );
      await api.query(`UPDATE app.pilot_operation SET updated_at = now() WHERE operation_id = $1`, [
        operationId,
      ]);

      const boss = new PgBoss({
        connectionString: urls.api(),
        schema: PGBOSS_SCHEMA,
        migrate: false,
        supervise: false,
        schedule: false,
        registerInstance: false,
        max: 1,
      });
      const errors: unknown[] = [];
      boss.on("error", (error: unknown) => errors.push(error));
      await boss.start();
      try {
        const jobId = await boss.send(
          PILOT_QUEUE,
          { operationId },
          {
            ...PILOT_JOB_OPTIONS,
            singletonKey: operationId,
            db: clientDb(api),
          },
        );
        expect(jobId).toEqual(expect.any(String));
        const job = await boss.getJobById(PILOT_QUEUE, jobId ?? "", { db: clientDb(api) });
        expect(job?.data).toEqual({ operationId });
      } finally {
        await boss.stop({ graceful: false });
      }
      expect(errors).toEqual([]);
    } finally {
      await api.query("ROLLBACK");
    }
  });

  it("sd_worker can write its heartbeat, claim jobs and run pg-boss supervision", async () => {
    const bootId = randomUUID();
    await worker.query("BEGIN");
    try {
      await worker.query(
        `INSERT INTO worker.heartbeat (boot_id, build_revision) VALUES ($1, 'g3')`,
        [bootId],
      );
      await worker.query(`UPDATE worker.heartbeat SET observed_at = now() WHERE boot_id = $1`, [
        bootId,
      ]);
    } finally {
      await worker.query("ROLLBACK");
    }

    const boss = new PgBoss({
      connectionString: urls.worker(),
      schema: PGBOSS_SCHEMA,
      migrate: false,
      supervise: false,
      schedule: false,
      registerInstance: false,
      persistWarnings: false,
      persistQueueStats: false,
      reindex: false,
      monitorVacuum: false,
      max: 2,
    });
    const errors: unknown[] = [];
    boss.on("error", (error: unknown) => errors.push(error));
    await boss.start();
    try {
      // Claims inside a rolled-back transaction leave other tests' jobs untouched.
      await worker.query("BEGIN");
      try {
        await boss.fetch(PILOT_QUEUE, { batchSize: 5, db: clientDb(worker) });
      } finally {
        await worker.query("ROLLBACK");
      }
      // One full supervision pass (expiry, retention, monitor counts, registry pruning).
      await boss.supervise();
    } finally {
      await boss.stop({ graceful: false });
    }
    expect(errors).toEqual([]);
  });
});

describe("G3 migrations and seed", () => {
  it("rerunning migrate and seed on a current database changes nothing", async () => {
    const before = await snapshot(migrator);
    expect(before).toContain("manager@fixture.local");

    const migrate = await run("node", ["packages/db/dist/cli/migrate.js"], {
      cwd: REPO_ROOT,
      env: commandEnv(),
    });
    expect(migrate.stdout).toContain("migrate: done");
    expect(migrate.stdout).not.toContain("created");
    expect(migrate.stdout).not.toContain("corrected");

    const seed = await run("node", ["apps/api/dist/seed.js"], {
      cwd: REPO_ROOT,
      env: commandEnv(),
    });
    expect(seed.stdout).toBe(NOTHING_CHANGED);

    expect(await snapshot(migrator)).toBe(before);
  });

  // The drift tests change the shared development database, so each one
  // restores the declared state itself even if the migrate command fails.
  it("rerunning migrate removes grant drift", async () => {
    try {
      await migrator.query("GRANT USAGE ON SCHEMA app TO sd_worker");
      await migrator.query("GRANT SELECT ON app.organization TO sd_worker");
      expect(await sqlState(worker, "SELECT 1 FROM app.organization LIMIT 1")).toBe("ok");

      await run("node", ["packages/db/dist/cli/migrate.js"], { cwd: REPO_ROOT, env: commandEnv() });
      expect(await sqlState(worker, "SELECT 1 FROM app.organization LIMIT 1")).toBe("42501");
    } finally {
      await migrator.query("REVOKE SELECT ON app.organization FROM sd_worker");
      await migrator.query("REVOKE USAGE ON SCHEMA app FROM sd_worker");
    }
  });

  it("migrate records the build's schema tag and corrects a drifted one", async () => {
    const { rows: tags } = await migrator.query<{ tag: string }>("SELECT tag FROM app.schema_tag");
    expect(tags).toEqual([{ tag: SCHEMA_TAG }]);
    try {
      await migrator.query("UPDATE app.schema_tag SET tag = 'drifted'");
      const migrate = await run("node", ["packages/db/dist/cli/migrate.js"], {
        cwd: REPO_ROOT,
        env: commandEnv(),
      });
      expect(migrate.stdout).toContain(`schema tag ${SCHEMA_TAG} recorded`);
      const { rows } = await migrator.query("SELECT id, tag FROM app.schema_tag");
      expect(rows).toEqual([{ id: 1, tag: SCHEMA_TAG }]);
    } finally {
      await migrator.query("UPDATE app.schema_tag SET tag = $1 WHERE tag <> $1", [SCHEMA_TAG]);
    }
  });

  it("rerunning migrate corrects queue option drift", async () => {
    try {
      await migrator.query(
        `UPDATE pgboss.queue
            SET retry_limit = 9, retry_delay = 7, retry_backoff = true, expire_seconds = 99, retention_seconds = 60
          WHERE name = $1`,
        [PILOT_QUEUE],
      );
      expect(await queueOptions(migrator)).not.toEqual(EXPECTED_QUEUE_OPTIONS);

      const migrate = await run("node", ["packages/db/dist/cli/migrate.js"], {
        cwd: REPO_ROOT,
        env: commandEnv(),
      });
      expect(migrate.stdout).toContain(`queue ${PILOT_QUEUE} options corrected`);
      expect(await queueOptions(migrator)).toEqual(EXPECTED_QUEUE_OPTIONS);
    } finally {
      await migrator.query(
        `UPDATE pgboss.queue
            SET retry_limit = $2, retry_delay = $3, retry_backoff = $4, expire_seconds = $5,
                retention_seconds = $6, deletion_seconds = $7, dead_letter = NULL
          WHERE name = $1`,
        [
          PILOT_QUEUE,
          EXPECTED_QUEUE_OPTIONS.retry_limit,
          EXPECTED_QUEUE_OPTIONS.retry_delay,
          EXPECTED_QUEUE_OPTIONS.retry_backoff,
          EXPECTED_QUEUE_OPTIONS.expire_seconds,
          EXPECTED_QUEUE_OPTIONS.retention_seconds,
          EXPECTED_QUEUE_OPTIONS.deletion_seconds,
        ],
      );
    }
  });

  it("the pilot queue has the explicit exclusive policy and job options", async () => {
    expect(await queueOptions(migrator)).toEqual(EXPECTED_QUEUE_OPTIONS);
  });
});
