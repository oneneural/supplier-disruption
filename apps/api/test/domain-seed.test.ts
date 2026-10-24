// D10 seed and initialization idempotency, on disposable databases. Results
// are read through raw SQL on a separate migrator connection and compared
// with the independently written rows in canonical-inputs.ts.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.js";
import {
  FIXTURE_BUYER_EMAIL,
  FIXTURE_MANAGER_EMAIL,
  FIXTURE_ORGANIZATION,
} from "../src/fixtures.js";
import { provisionFixtures } from "../src/provision.js";
import {
  CANONICAL_MANIFEST_SHA256,
  CANONICAL_QUERIES,
  FIXTURE_VERSION,
  FROZEN_ORACLE_SHA256,
  MARKER_QUERY,
  sortRows,
  type Row,
} from "./canonical-inputs.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  NODE_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import { APP_ORIGIN, REPO_ROOT, secret } from "./support.js";

const db = new DisposableDatabase("seed");
let observer: pg.Client;

const CASE_ACTORS_SEEDED =
  "seed: simulated case actors created=[buyer-1, cs-1, supplier-1, manager-1, planner-1]\n";
const FRESH_SEED =
  "seed: organization created=true, users created=[buyer@fixture.local, manager@fixture.local], " +
  "memberships created=[buyer@fixture.local, manager@fixture.local]\n" +
  "seed: canonical inputs first-slice-c01.v1 initialized\n" +
  CASE_ACTORS_SEEDED;
const PILOT_PRESENT_CANONICAL_NEW =
  "seed: fixtures already present; nothing changed\n" +
  "seed: canonical inputs first-slice-c01.v1 initialized\n" +
  CASE_ACTORS_SEEDED;
const NOTHING_CHANGED =
  "seed: fixtures already present; nothing changed\n" +
  "seed: canonical inputs first-slice-c01.v1 already present; nothing changed\n" +
  "seed: simulated case actors already present; nothing changed\n";

/**
 * Exactly the canonical input tables, the seed marker and the fixture authority source
 * support (current heads, operations, receipts and transfer requests).
 */
const FIXTURE_TABLES = [
  "fixture_demand.demand_head",
  "fixture_demand.demand_line",
  "fixture_demand.demand_snapshot",
  "fixture_demand.supply_link",
  "fixture_inventory.in_transit",
  "fixture_inventory.operation",
  "fixture_inventory.operation_receipt",
  "fixture_inventory.reservation",
  "fixture_inventory.stock_head",
  "fixture_inventory.stock_snapshot",
  "fixture_inventory.transfer_observation",
  "fixture_inventory.transfer_option",
  "fixture_inventory.transfer_request",
  "fixture_purchasing.operation",
  "fixture_purchasing.operation_receipt",
  "fixture_purchasing.po_head",
  "fixture_purchasing.po_line",
  "fixture_purchasing.po_line_segment",
  "fixture_purchasing.po_revision",
  "fixture_reference.actor",
  "fixture_reference.business_clock",
  "fixture_reference.item",
  "fixture_reference.item_mapping",
  "fixture_reference.organization_alias",
  "fixture_reference.policy",
  "fixture_reference.scenario_timing",
  "fixture_reference.seed_marker",
  "fixture_reference.supplier_input",
  "fixture_reference.vendor",
  "fixture_reference.vendor_contact",
];

/**
 * The API's write grants (ADR 0005): append-only INSERT on purchasing
 * and inventory history, operations, receipts and requests, UPDATE only on the
 * two current-version heads. Every other fixture table is SELECT only, the
 * seed marker has no API access, and nothing is ever deletable.
 */
const API_APPEND = [
  "fixture_inventory.operation",
  "fixture_inventory.operation_receipt",
  "fixture_inventory.reservation",
  "fixture_inventory.stock_snapshot",
  "fixture_inventory.transfer_request",
  "fixture_purchasing.operation",
  "fixture_purchasing.operation_receipt",
  "fixture_purchasing.po_line",
  "fixture_purchasing.po_line_segment",
  "fixture_purchasing.po_revision",
  // Email extraction (ADR 0011): the API appends an email-derived supplier input; it never changes one.
  "fixture_reference.supplier_input",
];
const API_MOVE = ["fixture_inventory.stock_head", "fixture_purchasing.po_head"];

/** Current heads for the canonical inputs, as an independent literal. */
const CANONICAL_HEADS = [
  { head: "demand", key: "ORG-NDL", version: "DEM@1" },
  { head: "po", key: "PO-120", version: "3" },
  { head: "stock", key: "ORG-NDL/PART-A/WH-A", version: "INV-A@1" },
  { head: "stock", key: "ORG-NDL/PART-A/WH-B", version: "INV-B@1" },
];
const HEADS_QUERY = `
  SELECT 'demand' AS head, organization AS key, version FROM fixture_demand.demand_head
  UNION ALL SELECT 'po', po_number, revision::text FROM fixture_purchasing.po_head
  UNION ALL SELECT 'stock', organization || '/' || sku || '/' || warehouse, version
              FROM fixture_inventory.stock_head
  ORDER BY 1, 2`;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

beforeAll(async () => {
  await db.start();
  observer = await db.client("migrator", "d10-observer");
}, START_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

async function rows(sql: string): Promise<pg.QueryResultRow[]> {
  return (await observer.query<pg.QueryResultRow>(sql)).rows;
}

/** Every canonical table compared with its independently written rows. */
async function expectCanonicalInputs(): Promise<void> {
  for (const [name, query] of Object.entries(CANONICAL_QUERIES)) {
    expect(sortRows<Row>(await rows(query.sql)), name).toEqual(sortRows<Row>(query.rows));
  }
  expect(await rows(HEADS_QUERY)).toEqual(CANONICAL_HEADS);
  const marker = await rows(MARKER_QUERY);
  expect(marker).toEqual([
    {
      fixture_version: FIXTURE_VERSION,
      oracle_sha256: FROZEN_ORACLE_SHA256,
      manifest_sha256: CANONICAL_MANIFEST_SHA256,
    },
  ]);
}

/**
 * A digest of the pilot rows: organizations, users with their password
 * hashes and update times, and memberships. Only the digest is compared, so
 * a failure never prints a password hash.
 */
async function pilotDigest(): Promise<string> {
  const [row] = await rows(`
    SELECT json_build_object(
      'organizations', (SELECT json_agg(o ORDER BY o.id) FROM app.organization o),
      'users', (SELECT json_agg(json_build_object('id', u.id, 'email', u.email,
                  'updated', u.updated_at, 'password', a.password, 'account_updated', a.updated_at)
                  ORDER BY u.email)
                  FROM auth."user" u JOIN auth.account a ON a.user_id = u.id),
      'memberships', (SELECT json_agg(m ORDER BY m.organization_id, m.user_id) FROM app.membership m),
      'sessions', (SELECT count(*) FROM auth.session)
    )::text AS snapshot`);
  return sha256(String(row?.snapshot));
}

/**
 * Every fixture row with its xmin, so a rewrite with equal values (a blind
 * upsert) is visible, plus the pilot digest.
 */
async function fingerprint(): Promise<string> {
  const parts: unknown[] = [await pilotDigest()];
  for (const table of FIXTURE_TABLES) {
    parts.push(
      table,
      await rows(`SELECT xmin::text AS xmin, to_jsonb(t)::text AS row FROM ${table} t ORDER BY 2`),
    );
  }
  return JSON.stringify(parts);
}

async function count(table: string): Promise<number> {
  const [row] = await rows(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(row?.n);
}

/** The pilot baseline: the unchanged 0000 and 0001 migrations, its schema tag and the pilot seed. */
async function pilotBaseline(): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "sd-d10-pilot-"));
  cpSync(join(REPO_ROOT, "packages/db/drizzle"), folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.filter((entry) =>
    ["0000_initial", "0001_readiness"].includes(entry.tag),
  );
  expect(journal.entries).toHaveLength(2);
  writeFileSync(journalPath, JSON.stringify(journal));

  const migrator = await db.client("migrator", "d10-pilot-baseline");
  await migrate(drizzle(migrator), { migrationsFolder: folder });
  await migrator.query("INSERT INTO app.schema_tag (id, tag) VALUES (1, '0001_readiness')");

  const pool = db.pool("migrator", "d10-pilot-seed");
  const database = drizzle(pool);
  const auth = createAuth(database, {
    appOrigin: APP_ORIGIN,
    secret: secret("better_auth_secret"),
    production: false,
    allowSignUp: true,
  });
  await provisionFixtures(database, auth, FIXTURE_ORGANIZATION, [
    {
      email: FIXTURE_BUYER_EMAIL,
      name: "Synthetic Buyer",
      password: secret("fixture_buyer_password"),
      role: "buyer",
    },
    {
      email: FIXTURE_MANAGER_EMAIL,
      name: "Synthetic Manager",
      password: secret("fixture_manager_password"),
      role: "manager",
    },
  ]);
}

describe("D10 seed and initialization idempotency", () => {
  it(
    "upgrades a pilot database: pilot rows kept, exactly the inputs and marker created",
    async () => {
      await pilotBaseline();
      const pilot = await pilotDigest();
      expect(
        await rows(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'fixture\\_%'`),
      ).toEqual([]);

      const migrated = await db.migrate();
      expect(migrated.code).toBe(0);
      expect(migrated.stdout).toContain("migrate: schema tag 0010_model_spend_guards recorded");
      const seeded = await db.seed();
      expect(seeded.code).toBe(0);
      expect(seeded.stdout).toBe(PILOT_PRESENT_CANONICAL_NEW);

      expect(await pilotDigest()).toBe(pilot);
      const tables = await rows(
        `SELECT schemaname || '.' || tablename AS name FROM pg_tables
          WHERE schemaname LIKE 'fixture\\_%' ORDER BY 1`,
      );
      expect(tables.map((row) => row.name as string)).toEqual(FIXTURE_TABLES);
      await expectCanonicalInputs();
      expect(await rows("SELECT tag FROM app.schema_tag")).toEqual([
        { tag: "0010_model_spend_guards" },
      ]);
    },
    3 * NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it("gives the API reads plus the source modules' append and head grants, and the worker and PUBLIC nothing", async () => {
    const privileges = await rows(`
      SELECT n.nspname || '.' || c.relname AS name,
             -- Column grants count: has_any_column_privilege covers table and column grants.
             has_any_column_privilege('sd_api', c.oid, 'SELECT') AS api_select,
             has_any_column_privilege('sd_api', c.oid, 'INSERT') AS api_insert,
             has_any_column_privilege('sd_api', c.oid, 'UPDATE') AS api_update,
             has_any_column_privilege('sd_api', c.oid, 'REFERENCES')
               OR has_table_privilege('sd_api', c.oid, 'DELETE, TRUNCATE, TRIGGER, MAINTAIN')
               AS api_other,
             has_any_column_privilege('sd_worker', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
               OR has_table_privilege('sd_worker', c.oid, 'DELETE, TRUNCATE, TRIGGER, MAINTAIN')
               AS worker_any,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                      WHERE a.grantee = 0)
               OR EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                           WHERE att.attrelid = c.oid AND a.grantee = 0) AS public_any
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname LIKE 'fixture\\_%' AND c.relkind IN ('r', 'v', 'm', 'S', 'p')
       ORDER BY 1`);
    expect(privileges).toEqual(
      FIXTURE_TABLES.map((name) => ({
        name,
        // The seed marker is seed bookkeeping; no API code reads it.
        api_select: name !== "fixture_reference.seed_marker",
        api_insert: API_APPEND.includes(name),
        api_update: API_MOVE.includes(name),
        api_other: false,
        worker_any: false,
        public_any: false,
      })),
    );
    const schemas = await rows(`
      SELECT nspname,
             has_schema_privilege('sd_api', oid, 'USAGE') AS api_usage,
             has_schema_privilege('sd_api', oid, 'CREATE') AS api_create,
             has_schema_privilege('sd_worker', oid, 'USAGE, CREATE') AS worker_any,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(nspacl, acldefault('n', nspowner))) a
                      WHERE a.grantee = 0) AS public_any
        FROM pg_namespace WHERE nspname LIKE 'fixture\\_%' ORDER BY 1`);
    expect(schemas).toEqual(
      ["fixture_demand", "fixture_inventory", "fixture_purchasing", "fixture_reference"].map(
        (nspname) => ({
          nspname,
          api_usage: true,
          api_create: false,
          worker_any: false,
          public_any: false,
        }),
      ),
    );
    // No function exists in the new schemas, privileged or otherwise.
    expect(
      await rows(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname LIKE 'fixture\\_%'`),
    ).toEqual([]);

    // Observed through the runtime roles themselves.
    const api = await db.client("api", "d10-api");
    const worker = await db.client("worker", "d10-worker");
    const state = async (client: pg.Client, text: string) =>
      client.query(text).then(
        () => "ok",
        (error: { code?: string }) => error.code,
      );
    expect(await state(api, "SELECT count(*) FROM fixture_purchasing.po_line")).toBe("ok");
    expect(await state(api, "SELECT instant FROM fixture_reference.business_clock")).toBe("ok");
    expect(
      await state(api, "UPDATE fixture_inventory.stock_snapshot SET physical = physical"),
    ).toBe("42501");
    expect(await state(api, "UPDATE fixture_reference.business_clock SET instant = now()")).toBe(
      "42501",
    );
    expect(await state(api, "SELECT fixture_version FROM fixture_reference.seed_marker")).toBe(
      "42501",
    );
    expect(await state(api, "DELETE FROM fixture_reference.seed_marker")).toBe("42501");
    expect(await state(worker, "SELECT count(*) FROM fixture_demand.demand_line")).toBe("42501");
    expect(await state(worker, "SELECT instant FROM fixture_reference.business_clock")).toBe(
      "42501",
    );
    // Existing pilot grants are preserved.
    const pilotGrants = await rows(`
      SELECT has_table_privilege('sd_api', 'app.pilot_operation', 'INSERT') AS api_operations,
             has_table_privilege('sd_api', 'app.organization', 'SELECT') AS api_organizations,
             has_table_privilege('sd_worker', 'worker.heartbeat', 'UPDATE') AS worker_heartbeat,
             has_table_privilege('sd_worker', 'app.organization', 'SELECT') AS worker_organizations`);
    expect(pilotGrants).toEqual([
      {
        api_operations: true,
        api_organizations: true,
        worker_heartbeat: true,
        worker_organizations: false,
      },
    ]);
  });

  it(
    "repeated and concurrent seeds leave identical rows, versions, hashes and timestamps",
    async () => {
      const before = await fingerprint();
      const again = await db.seed();
      expect(again).toMatchObject({ code: 0, stdout: NOTHING_CHANGED });
      const concurrent = await Promise.all([db.seed(), db.seed(), db.seed()]);
      for (const result of concurrent) {
        expect(result).toMatchObject({ code: 0, stdout: NOTHING_CHANGED });
      }
      expect(await fingerprint()).toBe(before);
      const migrated = await db.migrate();
      expect(migrated.code).toBe(0);
      expect(await fingerprint()).toBe(before);
    },
    5 * NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it(
    "keeps an advanced clock and a maintained source row when the seed runs again",
    async () => {
      // Simulated external fixture maintenance, as a test or operator would do it.
      await observer.query(
        "UPDATE fixture_reference.business_clock SET instant = '2026-10-21T14:00:00+02:00'",
      );
      await observer.query(
        "UPDATE fixture_inventory.stock_snapshot SET physical = 41 WHERE version = 'INV-A@1'",
      );
      const before = await fingerprint();
      expect(await db.seed()).toMatchObject({ code: 0, stdout: NOTHING_CHANGED });
      expect(await fingerprint()).toBe(before);
      expect(
        await rows(`SELECT to_char(instant AT TIME ZONE 'Europe/Copenhagen', 'HH24:MI') AS wall
                      FROM fixture_reference.business_clock`),
      ).toEqual([{ wall: "14:00" }]);
      expect(
        await rows(
          "SELECT physical::text FROM fixture_inventory.stock_snapshot WHERE version = 'INV-A@1'",
        ),
      ).toEqual([{ physical: "41" }]);
    },
    NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it("rejects direct maintenance that would leave a transfer option unsafe to read", async () => {
    const before = await fingerprint();
    await observer.query("BEGIN");
    try {
      // The largest safe integer is accepted; anything above it would read back rounded.
      await observer.query(
        "UPDATE fixture_inventory.transfer_option SET cost_minor_units = 9007199254740991",
      );
      for (const [assignment, constraint] of [
        ["cost_minor_units = 9007199254740992", "transfer_option_cost_check"],
        ["cost_minor_units = -1", "transfer_option_cost_check"],
        ["arrival_date = dispatch_date - 1", "transfer_option_dates_check"],
      ] as const) {
        await observer.query("SAVEPOINT attempt");
        const error = await observer
          .query(`UPDATE fixture_inventory.transfer_option SET ${assignment}`)
          .then(
            () => undefined,
            (rejected: unknown) => rejected,
          );
        expect(error, assignment).toMatchObject({ code: "23514", constraint });
        await observer.query("ROLLBACK TO SAVEPOINT attempt");
      }
    } finally {
      await observer.query("ROLLBACK");
    }
    expect(await fingerprint()).toBe(before);
  });

  it(
    "fails without repair on a marker that does not match",
    async () => {
      const [marker] = await rows(
        "SELECT manifest_sha256, fixture_version FROM fixture_reference.seed_marker",
      );
      for (const [column, value] of [
        ["manifest_sha256", "0".repeat(64)],
        ["oracle_sha256", "1".repeat(64)],
        ["fixture_version", "first-slice-c01.v0"],
      ] as const) {
        try {
          await observer.query(`UPDATE fixture_reference.seed_marker SET ${column} = $1`, [value]);
          const before = await fingerprint();
          const failed = await db.seed();
          expect(failed.code).toBe(1);
          expect(failed.stderr).toContain("seed: failed: CanonicalSeedConflictError: seed marker");
          expect(failed.stderr).toContain("does not match");
          expect(await fingerprint()).toBe(before);
        } finally {
          await observer.query(
            `UPDATE fixture_reference.seed_marker
                SET manifest_sha256 = $1, oracle_sha256 = $2, fixture_version = $3`,
            [marker?.manifest_sha256, FROZEN_ORACLE_SHA256, marker?.fixture_version],
          );
        }
      }
      expect(await db.seed()).toMatchObject({ code: 0, stdout: NOTHING_CHANGED });
    },
    4 * NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it(
    "fails without repair on canonical rows that have no marker",
    async () => {
      await observer.query("DELETE FROM fixture_reference.seed_marker");
      const before = await fingerprint();
      const failed = await db.seed();
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain(
        "seed: failed: CanonicalSeedConflictError: canonical input tables hold rows without a seed marker",
      );
      expect(await fingerprint()).toBe(before);
      expect(await count("fixture_reference.seed_marker")).toBe(0);
    },
    NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it(
    "leaves no partial canonical rows when initialization fails before completion",
    async () => {
      await db.recreate();
      observer = await db.client("migrator", "d10-observer-fresh");
      expect((await db.migrate()).code).toBe(0);
      // Test setup only: the marker is the last insert, so every input row
      // has been written in the transaction when this check rejects it.
      await observer.query(
        "ALTER TABLE fixture_reference.seed_marker ADD CONSTRAINT d10_reject_marker CHECK (false) NOT VALID",
      );
      try {
        const failed = await db.seed();
        expect(failed.code).toBe(1);
        expect(failed.stderr).toContain("d10_reject_marker");
      } finally {
        await observer.query(
          "ALTER TABLE fixture_reference.seed_marker DROP CONSTRAINT d10_reject_marker",
        );
      }
      for (const table of FIXTURE_TABLES) {
        expect(await count(table), table).toBe(0);
      }
    },
    COMPOSE_TIMEOUT_MS * 2 + 2 * NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it(
    "a fresh disposable recreation restores C-01, also with concurrent first seeds",
    async () => {
      await db.recreate();
      observer = await db.client("migrator", "d10-observer-restored");
      expect((await db.migrate()).code).toBe(0);
      const results = await Promise.all([db.seed(), db.seed()]);
      for (const result of results) expect(result.code).toBe(0);
      expect(results.map((result) => result.stdout).sort()).toEqual(
        [FRESH_SEED, NOTHING_CHANGED].sort(),
      );
      await expectCanonicalInputs();
    },
    COMPOSE_TIMEOUT_MS * 2 + 3 * NODE_TIMEOUT_MS + MARGIN_MS,
  );
});
