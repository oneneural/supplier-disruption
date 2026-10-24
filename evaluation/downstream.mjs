// PostgreSQL downstream stage of the evaluation runner (ADR 0011). Each arm's
// proposal for a case enters the real API workflow, CaseWorkflow.ingest, the
// way the email hand-off does: the terms are stored as a supplier input under
// the email's message key, then intake and assessment run on the seeded
// canonical fixture world. Nothing here computes or injects an outcome.
//
// The stage owns one disposable Compose project,
// supplier-disruption-eval-<run>, with only the database service on a free
// loopback port. It migrates and seeds that database once, then clones it per
// (case, arm) so no case sees another's message, duplicate content or case
// history, and removes the project and its volume on close, also after a
// failure. The shared development database is never touched.
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { emailMessageKey } from "../packages/agent/dist/index.js";
import { DOMAIN_CONTRACT_VERSION } from "../packages/contracts/dist/index.js";
import {
  CANONICAL_MANIFEST,
  createControlledClock,
  supplierContentSha256,
} from "../packages/db/dist/index.js";
import { CASE_FIXTURE } from "../apps/api/dist/cases/fixture.js";
import { CaseWorkflow } from "../apps/api/dist/cases/workflow.js";

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = join(REPO, ".secrets");
const SHARED_DEVELOPMENT_PORT = 55102;
const COMPOSE_TIMEOUT_MS = 120_000;
const PROJECT_PATTERN = /^supplier-disruption-eval-[a-z0-9]+$/;

// pg and drizzle-orm are the API's own dependencies; resolve the same copies it loads.
const apiRequire = createRequire(join(REPO, "apps/api/package.json"));
const pg = apiRequire("pg");
// The require condition names the CommonJS file; its ESM sibling is the one the API imports.
const nodePostgresDir = dirname(apiRequire.resolve("drizzle-orm/node-postgres"));
const { drizzle } = await import(pathToFileURL(join(nodePostgresDir, "index.js")).href);

/**
 * The seeded world as the canonical manifest declares it: registered senders
 * by vendor and purchase orders. A case belongs to it when its order is
 * seeded and its sender has the same standing as in the evaluation world;
 * every other row is in-memory only.
 */
export function seededWorld() {
  const senders = new Map();
  for (const vendor of CANONICAL_MANIFEST.reference.vendors) {
    for (const sender of vendor.registeredSenders) senders.set(sender, vendor.vendorId);
  }
  const orders = new Map(
    CANONICAL_MANIFEST.purchasing.orders.map((po) => [po.poNumber, po.vendorId]),
  );
  return { senders, orders };
}

/**
 * Classifies a row: `postgres` when its order is seeded and the sender's
 * registered vendor (or its absence) is the same in the seeded and the
 * evaluation worlds, so the database result is comparable; otherwise
 * `in-memory-only` with the reason.
 */
export function classify(scenario, poNumber, evaluationSenders) {
  const world = seededWorld();
  if (poNumber === undefined) return { world: "in-memory-only", why: "no order to look up" };
  if (!world.orders.has(poNumber)) {
    return { world: "in-memory-only", why: `${poNumber} is not in the seeded world` };
  }
  const seeded = world.senders.get(scenario.email.sender) ?? null;
  const evaluated = evaluationSenders[scenario.email.sender] ?? null;
  if (seeded !== evaluated) {
    return {
      world: "in-memory-only",
      why: `sender ${scenario.email.sender} is ${evaluated ?? "unregistered"} in the evaluation world and ${seeded ?? "unregistered"} in the seed`,
    };
  }
  return { world: "postgres", why: null };
}

function secret(relative) {
  return readFileSync(join(SECRETS, relative), "utf8").trim();
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export class PostgresDownstream {
  #port = null;
  #clones = 0;
  #pools = [];

  constructor() {
    const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    this.project = `supplier-disruption-eval-${runId}`;
    if (!PROJECT_PATTERN.test(this.project)) throw new Error(`refusing project ${this.project}`);
  }

  #compose(...args) {
    return run(
      "docker",
      ["compose", "-p", this.project, "-f", "compose.yaml", "-f", "compose.dev.yaml", ...args],
      {
        cwd: REPO,
        env: { ...process.env, SD_DB_HOST_PORT: String(this.#port) },
        timeout: COMPOSE_TIMEOUT_MS,
      },
    );
  }

  /** A role's development URL pointed at this project's port and a database. */
  url(role, database = "supplier_disruption") {
    const port = this.#port;
    const url = secret(`host/database_url_${role}`).replace(
      /@127\.0\.0\.1:\d+\/[^?]*/,
      `@127.0.0.1:${String(port)}/${database}`,
    );
    if (!url.includes(`@127.0.0.1:${String(port)}/`) || port === SHARED_DEVELOPMENT_PORT) {
      throw new Error(`.secrets/host/database_url_${role} does not point at 127.0.0.1; refusing`);
    }
    return url;
  }

  async #node(script) {
    await run("node", [script], {
      cwd: REPO,
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        APP_ID: "supplier-disruption",
        APP_ORIGIN: "http://127.0.0.1:3102",
        NODE_ENV: "test",
        DATABASE_URL_MIGRATOR: this.url("migrator"),
        BETTER_AUTH_SECRET_FILE: join(SECRETS, "better_auth_secret"),
        FIXTURE_BUYER_PASSWORD_FILE: join(SECRETS, "fixture_buyer_password"),
        FIXTURE_MANAGER_PASSWORD_FILE: join(SECRETS, "fixture_manager_password"),
      },
    });
  }

  async #psql(statement) {
    await this.#compose(
      "exec",
      "-T",
      "db",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-Atc",
      statement,
    );
  }

  /** Starts, migrates and seeds the template database. */
  async start() {
    this.#port = await freePort();
    if (this.#port === SHARED_DEVELOPMENT_PORT) throw new Error("free port is the shared port");
    this.url("migrator");
    try {
      await this.#compose("down", "--volumes", "--remove-orphans");
      await this.#compose("up", "--detach", "--wait", "db");
      await this.#node("packages/db/dist/cli/migrate.js");
      await this.#node("apps/api/dist/seed.js");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * Runs one arm's terms for one case through intake and assessment on a
   * fresh clone of the seeded database, and reads back what the case became.
   */
  async ingest(scenario, terms, evidence) {
    this.#clones += 1;
    const database = `eval_${String(this.#clones)}`;
    await this.#psql(`CREATE DATABASE ${database} TEMPLATE supplier_disruption`);
    const pool = new pg.Pool({ connectionString: this.url("api", database), max: 4 });
    const clockPool = new pg.Pool({ connectionString: this.url("api", database), max: 1 });
    for (const each of [pool, clockPool]) each.on("error", () => undefined);
    this.#pools.push(pool, clockPool);
    try {
      const workflow = new CaseWorkflow({
        db: drizzle(pool),
        sourcePool: pool,
        clock: createControlledClock(clockPool),
        // Intake and assessment enqueue nothing; any use here is a defect.
        boss: {
          send() {
            throw new Error("the downstream stage queues no job");
          },
        },
      });
      const key = emailMessageKey(scenario.email);
      const identity = {
        contractVersion: DOMAIN_CONTRACT_VERSION,
        sourceSystem: key.sourceSystem,
        messageId: key.messageId,
        inputVersion: key.inputVersion,
        contentSha256: supplierContentSha256(terms),
        sender: scenario.email.sender,
        proposalId: `PROP-${key.messageId}`,
        evidenceRef: `${key.messageId}@${String(key.inputVersion)}`,
        authoredAt: { state: "unknown" },
        receivedAt: { state: "unknown" },
      };
      await workflow.sources.reference.recordSupplierInput({ identity, terms });
      const result = await workflow.ingest({
        organizationId: CASE_FIXTURE.organization.id,
        deliveryId: randomUUID(),
        sourceSystem: key.sourceSystem,
        messageId: key.messageId,
        inputVersion: key.inputVersion,
        supplierText: evidence.slice(0, 20_000),
      });
      if (result.status >= 300) {
        return {
          intake: "error",
          intakeReason: String(result.body.error ?? result.status),
          caseState: "none",
          caseReason: null,
        };
      }
      const { rows } = await pool.query(
        "SELECT state, reason FROM app.supplier_case WHERE id = $1",
        [result.body.caseId],
      );
      return {
        intake: result.body.disposition,
        intakeReason: result.body.reason ?? null,
        caseState: rows[0]?.state ?? "none",
        caseReason: rows[0]?.reason ?? null,
      };
    } finally {
      this.#pools = this.#pools.filter((each) => each !== pool && each !== clockPool);
      await Promise.allSettled([pool.end(), clockPool.end()]);
      await this.#psql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
  }

  /** Removes the project, its containers and its volume. Safe after any failure. */
  async close() {
    await Promise.allSettled(this.#pools.splice(0).map((each) => each.end()));
    if (this.#port === null) return;
    await this.#compose("down", "--volumes", "--remove-orphans");
  }
}
