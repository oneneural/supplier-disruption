import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigError, loadMigratorConfig } from "@supplier-disruption/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { PgBoss } from "pg-boss";
import {
  CASE_JOB_OPTIONS,
  CASE_QUEUE,
  CASE_QUEUE_OPTIONS,
  PGBOSS_SCHEMA,
  PILOT_JOB_OPTIONS,
  PILOT_QUEUE,
  PILOT_QUEUE_OPTIONS,
} from "../queue.js";
import { SCHEMA_TAG } from "../schema-tag.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const GRANTS_FILE = fileURLToPath(new URL("../../sql/grants.sql", import.meta.url));
// Serializes concurrent migration runs for this database.
const MIGRATION_LOCK_KEY = "supplier-disruption:migrate";

function log(message: string): void {
  process.stdout.write(`migrate: ${message}\n`);
}

interface QueueSpec {
  name: string;
  options: typeof PILOT_QUEUE_OPTIONS | typeof CASE_QUEUE_OPTIONS;
  jobOptions: typeof PILOT_JOB_OPTIONS | typeof CASE_JOB_OPTIONS;
}

const QUEUES: readonly QueueSpec[] = [
  { name: PILOT_QUEUE, options: PILOT_QUEUE_OPTIONS, jobOptions: PILOT_JOB_OPTIONS },
  { name: CASE_QUEUE, options: CASE_QUEUE_OPTIONS, jobOptions: CASE_JOB_OPTIONS },
];

/** Creates a queue, or corrects its job options; a policy change is refused. */
async function ensureQueue(boss: PgBoss, queue: QueueSpec): Promise<void> {
  const existing = await boss.getQueue(queue.name);
  if (existing === null) {
    await boss.createQueue(queue.name, { ...queue.options, partition: false });
    log(`queue ${queue.name} created`);
    return;
  }
  if (existing.policy !== queue.options.policy) {
    // pg-boss cannot change a queue's policy in place.
    throw new Error(
      `queue ${queue.name} has policy ${String(existing.policy)}, expected ${queue.options.policy}`,
    );
  }
  const keys = Object.keys(queue.jobOptions) as Array<keyof typeof queue.jobOptions>;
  const drifted = keys.some((key) => existing[key] !== queue.jobOptions[key]);
  if (drifted || existing.deadLetter != null) {
    await boss.updateQueue(queue.name, { ...queue.jobOptions, deadLetter: null });
    log(`queue ${queue.name} options corrected`);
  }
}

/**
 * Applies Drizzle migrations, completes the pg-boss schema, ensures the pilot
 * and case queues, applies runtime grants and finally records the schema tag. Runs as
 * the migrator role. Rerunning it on a current database changes nothing.
 */
export async function runMigrations(databaseUrl: string, roles: { api: string; worker: string }) {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "sd-migrate" });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);

    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    log("drizzle migrations applied");

    const boss = new PgBoss({
      connectionString: databaseUrl,
      schema: PGBOSS_SCHEMA,
      application_name: "sd-migrate-pgboss",
      max: 2,
      migrate: true,
      supervise: false,
      schedule: false,
      registerInstance: false,
      persistWarnings: false,
      persistQueueStats: false,
    });
    boss.on("error", (error: unknown) => {
      process.stderr.write(`migrate: pg-boss error: ${String(error)}\n`);
    });
    await boss.start();
    try {
      for (const queue of QUEUES) await ensureQueue(boss, queue);
    } finally {
      await boss.stop({ graceful: false });
    }
    log("pg-boss schema current");

    const grants = readFileSync(GRANTS_FILE, "utf8")
      .replaceAll("{{api}}", `"${roles.api}"`)
      .replaceAll("{{worker}}", `"${roles.worker}"`);
    await client.query(grants);
    log("grants applied");

    // Last, so the API never sees a compatible tag before every step above succeeded.
    const tagged = await client.query(
      `INSERT INTO app.schema_tag (id, tag) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET tag = excluded.tag, applied_at = now()
       WHERE app.schema_tag.tag IS DISTINCT FROM excluded.tag`,
      [SCHEMA_TAG],
    );
    if ((tagged.rowCount ?? 0) > 0) {
      log(`schema tag ${SCHEMA_TAG} recorded`);
    }
  } finally {
    await client.end();
  }
}

// Compare real paths: in a pnpm deployment this file is reached through a
// node_modules symlink, while import.meta.url is always the resolved path.
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  try {
    const config = loadMigratorConfig(process.env);
    await runMigrations(config.databaseUrl, { api: config.apiRole, worker: config.workerRole });
    log("done");
  } catch (error) {
    process.stderr.write(
      error instanceof ConfigError ? `${error.message}\n` : `migrate: failed: ${String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
