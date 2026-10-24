// D2 grants and module ownership. Fresh and upgrade migrations keep canonical input
// data while initializing explicit current heads; the runtime roles get
// exactly the source grants the modules need. Observed through raw SQL on
// separate migrator, API and worker connections. Lint ownership rules are
// tested in scripts/test/import-boundaries.test.mjs. This gate does not claim
// that the API role cannot bypass its own source modules with its DML grants.
// R6 adds the read-only reference entry to the structural checks
// and confirms its reads need no new grant.
import { readFileSync } from "node:fs";
import { is, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgSchema, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeDemand, initializeDemandHeads } from "../src/authorities/demand/initialize.js";
import * as demandEntry from "../src/authorities/demand/index.js";
import {
  initializeInventory,
  initializeInventoryHeads,
} from "../src/authorities/inventory/initialize.js";
import * as inventoryEntry from "../src/authorities/inventory/index.js";
import { initializePurchasing } from "../src/authorities/purchasing/initialize.js";
import * as purchasingEntry from "../src/authorities/purchasing/index.js";
import * as referenceEntry from "../src/authorities/reference/index.js";
import { initializeReference } from "../src/authorities/reference/initialize.js";
import { seedMarker } from "../src/authorities/reference/schema.js";
import { AmbiguousCurrentVersionError } from "../src/authorities/values.js";
import * as root from "../src/index.js";
import * as workerEntry from "../src/worker.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  NODE_TIMEOUT_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import { ALL_RECORDS } from "./reference-support.js";
import { fingerprint, rows } from "./source-support.js";
import { REPO_ROOT } from "./support.js";

const db = new DisposableDatabase("d2");
let observer: pg.Client;

/** The 21 canonical input tables of migration 0002. */
const MIGRATION_0002_TABLES = [
  "fixture_demand.demand_line",
  "fixture_demand.demand_snapshot",
  "fixture_demand.supply_link",
  "fixture_inventory.in_transit",
  "fixture_inventory.reservation",
  "fixture_inventory.stock_snapshot",
  "fixture_inventory.transfer_option",
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
] as const;

const NONE = { select: false, insert: false, update: false, delete: false, other: false };
const READ = { ...NONE, select: true };
const APPEND = { ...READ, insert: true };
const MOVE = { ...READ, update: true };

/** The API's intended privileges on every fixture table after migration 0003. */
const API_MATRIX: Record<string, typeof NONE> = {
  "fixture_demand.demand_head": READ,
  "fixture_demand.demand_line": READ,
  "fixture_demand.demand_snapshot": READ,
  "fixture_demand.supply_link": READ,
  "fixture_inventory.in_transit": READ,
  "fixture_inventory.operation": APPEND,
  "fixture_inventory.operation_receipt": APPEND,
  "fixture_inventory.reservation": APPEND,
  "fixture_inventory.stock_head": MOVE,
  "fixture_inventory.stock_snapshot": APPEND,
  "fixture_inventory.transfer_observation": READ,
  "fixture_inventory.transfer_option": READ,
  "fixture_inventory.transfer_request": APPEND,
  "fixture_purchasing.operation": APPEND,
  "fixture_purchasing.operation_receipt": APPEND,
  "fixture_purchasing.po_head": MOVE,
  "fixture_purchasing.po_line": APPEND,
  "fixture_purchasing.po_line_segment": APPEND,
  "fixture_purchasing.po_revision": APPEND,
  "fixture_reference.actor": READ,
  "fixture_reference.business_clock": READ,
  "fixture_reference.item": READ,
  "fixture_reference.item_mapping": READ,
  "fixture_reference.organization_alias": READ,
  "fixture_reference.policy": READ,
  "fixture_reference.scenario_timing": READ,
  "fixture_reference.seed_marker": NONE,
  // The API appends an email-derived input; it never changes one (ADR 0011).
  "fixture_reference.supplier_input": APPEND,
  "fixture_reference.vendor": READ,
  "fixture_reference.vendor_contact": READ,
};

const HEADS = {
  po: [{ po_number: "PO-120", organization: "ORG-NDL", revision: 3 }],
  stock: [
    { organization: "ORG-NDL", sku: "PART-A", warehouse: "WH-A", version: "INV-A@1" },
    { organization: "ORG-NDL", sku: "PART-A", warehouse: "WH-B", version: "INV-B@1" },
  ],
  demand: [{ organization: "ORG-NDL", version: "DEM@1" }],
};

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "d2-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

async function heads() {
  return {
    po: await rows(
      observer,
      "SELECT po_number, organization, revision FROM fixture_purchasing.po_head ORDER BY 1",
    ),
    stock: await rows(
      observer,
      "SELECT organization, sku, warehouse, version FROM fixture_inventory.stock_head ORDER BY 3",
    ),
    demand: await rows(
      observer,
      "SELECT organization, version FROM fixture_demand.demand_head ORDER BY 1",
    ),
  };
}

/**
 * Effective privileges per fixture table. SELECT, INSERT, UPDATE and
 * REFERENCES can also be granted on single columns, so those use
 * has_any_column_privilege, which is true for a table grant or any column
 * grant; PUBLIC is checked in both table and column ACLs.
 */
async function privileges() {
  return rows(
    observer,
    `SELECT n.nspname || '.' || c.relname AS name,
            has_any_column_privilege('sd_api', c.oid, 'SELECT') AS select,
            has_any_column_privilege('sd_api', c.oid, 'INSERT') AS insert,
            has_any_column_privilege('sd_api', c.oid, 'UPDATE') AS update,
            has_table_privilege('sd_api', c.oid, 'DELETE') AS delete,
            has_any_column_privilege('sd_api', c.oid, 'REFERENCES')
              OR has_table_privilege('sd_api', c.oid, 'TRUNCATE, TRIGGER, MAINTAIN') AS other,
            has_any_column_privilege('sd_worker', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
              OR has_table_privilege('sd_worker', c.oid, 'DELETE, TRUNCATE, TRIGGER, MAINTAIN')
              AS worker_any,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                     WHERE a.grantee = 0)
              OR EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                          WHERE att.attrelid = c.oid AND a.grantee = 0) AS public_any
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname LIKE 'fixture\\_%' AND c.relkind IN ('r', 'v', 'm', 'S', 'p')
      ORDER BY 1`,
  );
}

const EXPECTED_PRIVILEGES = Object.entries(API_MATRIX).map(([name, api]) => ({
  name,
  ...api,
  worker_any: false,
  public_any: false,
}));

/** Runs a statement as a role and reports "ok" or the SQLSTATE; allowed DML is rolled back. */
async function attempt(client: pg.Client, text: string): Promise<string> {
  await client.query("BEGIN");
  try {
    await client.query(text);
    return "ok";
  } catch (error) {
    return String((error as { code?: string }).code);
  } finally {
    await client.query("ROLLBACK");
  }
}

describe("D2 grants and module ownership", () => {
  it("a fresh migrate and seed add exactly the source support with explicit current heads", async () => {
    const tables = await rows<{ name: string }>(
      observer,
      `SELECT schemaname || '.' || tablename AS name FROM pg_tables
        WHERE schemaname LIKE 'fixture\\_%' ORDER BY 1`,
    );
    expect(tables.map((row) => row.name)).toEqual(Object.keys(API_MATRIX));
    expect(await heads()).toEqual(HEADS);
    expect(await rows(observer, "SELECT tag FROM app.schema_tag")).toEqual([
      { tag: "0010_model_spend_guards" },
    ]);
  });

  it("grants the API exactly the source rights its modules need, and the worker and PUBLIC nothing", async () => {
    expect(await privileges()).toEqual(EXPECTED_PRIVILEGES);
    const schemas = await rows(
      observer,
      `SELECT nspname,
              has_schema_privilege('sd_api', oid, 'USAGE') AS api_usage,
              has_schema_privilege('sd_api', oid, 'CREATE') AS api_create,
              has_schema_privilege('sd_worker', oid, 'USAGE, CREATE') AS worker_any,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(nspacl, acldefault('n', nspowner))) a
                       WHERE a.grantee = 0) AS public_any
         FROM pg_namespace WHERE nspname LIKE 'fixture\\_%' ORDER BY 1`,
    );
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
    // No function, privileged or otherwise, implements source logic.
    expect(
      await rows(
        observer,
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname LIKE 'fixture\\_%'`,
      ),
    ).toEqual([]);
  });

  it("an independent API connection may append and move heads but not delete, rewrite, write demand or reference, or change DDL", async () => {
    const api = await db.client("api", "d2-api");
    const allowed = [
      "INSERT INTO fixture_purchasing.operation (organization, operation_id, kind, request_digest) VALUES ('ORG-NDL', 'OP-D2', 'amend_schedule', repeat('a', 64))",
      "UPDATE fixture_purchasing.po_head SET revision = revision",
      "SELECT 1 FROM fixture_purchasing.po_head FOR UPDATE",
      "INSERT INTO fixture_inventory.stock_snapshot (version, organization, sku, warehouse, uom, physical, quality_hold, safety_stock) VALUES ('INV-D2', 'ORG-NDL', 'PART-A', 'WH-C', 'EA', 1, 0, 0)",
      "UPDATE fixture_inventory.stock_head SET version = version",
      "INSERT INTO fixture_inventory.operation (organization, operation_id, kind, request_digest) VALUES ('ORG-NDL', 'OP-D2', 'reserve', repeat('b', 64))",
      "SELECT count(*) FROM fixture_demand.demand_head",
      "SELECT instant FROM fixture_reference.business_clock",
      // Reference and transfer-option reads use existing SELECT grants (ADR 0006).
      "SELECT label, organization_id FROM fixture_reference.organization_alias",
      "SELECT sku, stock_uom, integral FROM fixture_reference.item",
      "SELECT ratio_numerator, ratio_denominator FROM fixture_reference.item_mapping",
      "SELECT parameters FROM fixture_reference.policy",
      "SELECT name FROM fixture_reference.vendor",
      "SELECT address FROM fixture_reference.vendor_contact",
      "SELECT content_sha256, content FROM fixture_reference.supplier_input",
      "SELECT o.option_id FROM fixture_inventory.transfer_option o JOIN fixture_inventory.stock_snapshot s ON s.version = o.based_on",
    ];
    for (const text of allowed) expect(await attempt(api, text), text).toBe("ok");
    const denied = [
      "DELETE FROM fixture_purchasing.po_revision",
      "DELETE FROM fixture_purchasing.operation_receipt",
      "UPDATE fixture_purchasing.po_line_segment SET quantity = quantity",
      "UPDATE fixture_inventory.reservation SET quantity = quantity",
      "UPDATE fixture_inventory.stock_snapshot SET physical = physical",
      "UPDATE fixture_inventory.operation_receipt SET quantity = quantity",
      "DELETE FROM fixture_inventory.transfer_request",
      "TRUNCATE fixture_purchasing.po_line",
      "INSERT INTO fixture_inventory.transfer_option (option_id, sku, uom, from_warehouse, to_warehouse, quantity, dispatch_date, arrival_date, cost_minor_units, currency, valid_until, based_on, owner_role) VALUES ('TRO-D2', 'PART-A', 'EA', 'WH-B', 'WH-A', 1, '2026-10-22', '2026-10-23', 1, 'EUR', now(), 'INV-B@1', 'warehouse_planner')",
      "INSERT INTO fixture_inventory.in_transit (transit_id, sku, uom, from_warehouse, to_warehouse, quantity) VALUES ('TRR-D2', 'PART-A', 'EA', 'WH-B', 'WH-A', 1)",
      "UPDATE fixture_demand.demand_line SET open_quantity = 60",
      "UPDATE fixture_demand.demand_head SET version = version",
      "INSERT INTO fixture_demand.supply_link (version, sales_order, line, po_number, po_line) VALUES ('DEM@1', 'SO-201', '10', 'PO-121', '10')",
      "UPDATE fixture_reference.business_clock SET instant = now()",
      "INSERT INTO fixture_reference.vendor (vendor_id, name) VALUES ('V-D2', 'x')",
      "UPDATE fixture_reference.vendor SET name = name",
      "DELETE FROM fixture_reference.vendor_contact",
      "INSERT INTO fixture_reference.vendor_contact (vendor_id, address, purpose) VALUES ('V-100', 'd2@example.test', 'registered_sender')",
      "UPDATE fixture_reference.organization_alias SET organization_id = organization_id",
      "INSERT INTO fixture_reference.organization_alias (label, organization_id, name) VALUES ('ORG-D2', gen_random_uuid(), 'x')",
      "UPDATE fixture_reference.item SET stock_uom = stock_uom",
      "UPDATE fixture_reference.item_mapping SET ratio_numerator = ratio_numerator",
      "DELETE FROM fixture_reference.item_mapping",
      "INSERT INTO fixture_reference.policy (policy_id, version, parameters) VALUES ('AUTH-1', 9, '{}')",
      "UPDATE fixture_reference.policy SET parameters = parameters",
      "UPDATE fixture_reference.supplier_input SET content_sha256 = content_sha256",
      "UPDATE fixture_inventory.transfer_option SET valid_until = valid_until",
      "DELETE FROM fixture_inventory.transfer_option",
      "SELECT fixture_version FROM fixture_reference.seed_marker",
      "DELETE FROM fixture_reference.seed_marker",
      "CREATE TABLE fixture_purchasing.d2_probe (id int)",
      "ALTER TABLE fixture_inventory.stock_head ADD COLUMN d2 int",
    ];
    for (const text of denied) expect(await attempt(api, text), text).toBe("42501");

    const worker = await db.client("worker", "d2-worker");
    for (const table of Object.keys(API_MATRIX)) {
      expect(await attempt(worker, `SELECT 1 FROM ${table} LIMIT 1`), table).toBe("42501");
    }
    expect(await attempt(worker, "UPDATE fixture_inventory.stock_head SET version = version")).toBe(
      "42501",
    );
    // Existing pilot grants are preserved.
    expect(
      await rows(
        observer,
        `SELECT has_table_privilege('sd_api', 'app.pilot_operation', 'INSERT') AS api_operations,
                has_table_privilege('sd_worker', 'worker.heartbeat', 'UPDATE') AS worker_heartbeat,
                has_table_privilege('sd_worker', 'app.organization', 'SELECT') AS worker_organizations`,
      ),
    ).toEqual([{ api_operations: true, worker_heartbeat: true, worker_organizations: false }]);
  });

  it(
    "migration reapplies the source grants after drift",
    async () => {
      await observer.query(`
        GRANT DELETE, UPDATE ON fixture_purchasing.po_revision TO sd_api;
        GRANT INSERT ON fixture_demand.demand_line TO sd_api;
        GRANT SELECT ON fixture_reference.seed_marker TO sd_api;
        GRANT SELECT, UPDATE ON fixture_inventory.stock_head TO sd_worker;
        GRANT SELECT ON fixture_purchasing.operation_receipt TO PUBLIC;
        GRANT UPDATE (plan_id) ON fixture_inventory.reservation TO sd_api;
        GRANT SELECT (version) ON fixture_inventory.stock_head TO PUBLIC;`);
      expect(await privileges()).not.toEqual(EXPECTED_PRIVILEGES);
      expect((await db.migrate()).code).toBe(0);
      expect(await privileges()).toEqual(EXPECTED_PRIVILEGES);
    },
    NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it(
    "migration removes an injected column-level UPDATE grant on reference fields",
    async () => {
      const columnGrants = () =>
        rows(
          observer,
          `SELECT has_column_privilege('sd_api', 'fixture_reference.item_mapping', 'ratio_numerator', 'UPDATE') AS ratio,
                  has_column_privilege('sd_api', 'fixture_reference.supplier_input', 'content_sha256', 'UPDATE') AS digest,
                  has_column_privilege('sd_api', 'fixture_reference.organization_alias', 'organization_id', 'UPDATE') AS alias`,
        );
      expect(await columnGrants()).toEqual([{ ratio: false, digest: false, alias: false }]);
      await observer.query(`
        GRANT UPDATE (ratio_numerator) ON fixture_reference.item_mapping TO sd_api;
        GRANT UPDATE (content_sha256) ON fixture_reference.supplier_input TO sd_api;
        GRANT UPDATE (organization_id) ON fixture_reference.organization_alias TO sd_api;`);
      expect(await columnGrants()).toEqual([{ ratio: true, digest: true, alias: true }]);
      expect(await privileges()).not.toEqual(EXPECTED_PRIVILEGES);
      const api = await db.client("api", "d2-api-column");
      expect(
        await attempt(
          api,
          "UPDATE fixture_reference.item_mapping SET ratio_numerator = ratio_numerator",
        ),
      ).toBe("ok");
      expect((await db.migrate()).code).toBe(0);
      expect(await columnGrants()).toEqual([{ ratio: false, digest: false, alias: false }]);
      expect(await privileges()).toEqual(EXPECTED_PRIVILEGES);
      expect(
        await attempt(
          api,
          "UPDATE fixture_reference.item_mapping SET ratio_numerator = ratio_numerator",
        ),
      ).toBe("42501");
    },
    NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it(
    "a repeated migrate and seed keep the schema tag, seed marker, canonical rows and grants",
    async () => {
      const before = await fingerprint(observer, ALL_RECORDS);
      await db.prepare();
      expect(await fingerprint(observer, ALL_RECORDS)).toBe(before);
      expect(await rows(observer, "SELECT tag FROM app.schema_tag")).toEqual([
        { tag: "0010_model_spend_guards" },
      ]);
      expect(
        await rows(
          observer,
          "SELECT fixture_version, manifest_sha256, oracle_sha256 FROM fixture_reference.seed_marker",
        ),
      ).toEqual([
        {
          fixture_version: "first-slice-c01.v1",
          manifest_sha256: "57547d808324fcb2c8572295048a945aed542c9bde39f8e28ed8c60bdc78c48e",
          oracle_sha256: "b90368cb66fec1b3122092153bd98337292b168b68ca5a568a46878fe189e8ea",
        },
      ]);
      expect(await privileges()).toEqual(EXPECTED_PRIVILEGES);
    },
    2 * NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it("root and worker entries expose no source tables or modules; each public subpath exposes only its runtime module", () => {
    const manifest = JSON.parse(readFileSync(`${REPO_ROOT}packages/db/package.json`, "utf8")) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./worker": { types: "./dist/worker.d.ts", default: "./dist/worker.js" },
      "./purchasing": {
        types: "./dist/authorities/purchasing/index.d.ts",
        default: "./dist/authorities/purchasing/index.js",
      },
      "./inventory": {
        types: "./dist/authorities/inventory/index.d.ts",
        default: "./dist/authorities/inventory/index.js",
      },
      "./demand": {
        types: "./dist/authorities/demand/index.d.ts",
        default: "./dist/authorities/demand/index.js",
      },
      "./reference": {
        types: "./dist/authorities/reference/index.d.ts",
        default: "./dist/authorities/reference/index.js",
      },
    });
    const sourceNames = [
      "poRevision",
      "poLine",
      "poLineSegment",
      "poHead",
      "operation",
      "operationReceipt",
      "stockSnapshot",
      "stockHead",
      "reservation",
      "transferOption",
      "transferRequest",
      "inTransit",
      "demandSnapshot",
      "demandLine",
      "supplyLink",
      "demandHead",
      "seedMarker",
      "organizationAlias",
      "vendor",
      "vendorContact",
      "item",
      "itemMapping",
      "actor",
      "policy",
      "supplierInput",
      "scenarioTiming",
      "businessClock",
      "createPurchasingSource",
      "createInventorySource",
      "createDemandSource",
      "createReferenceSource",
      "initializePurchasing",
      "initializeInventory",
      "initializeDemand",
      "initializeReference",
    ];
    expect(Object.keys(root).filter((name) => sourceNames.includes(name))).toEqual([]);
    // Structurally, whatever the export is called or however it is re-exported:
    // no root, worker or public source entry export is a fixture table or schema.
    const fixtureExports = [
      ...Object.entries(root),
      ...Object.entries(workerEntry),
      ...Object.entries(purchasingEntry),
      ...Object.entries(inventoryEntry),
      ...Object.entries(demandEntry),
      ...Object.entries(referenceEntry),
    ].filter(
      ([, value]) =>
        (is(value, PgTable) && getTableConfig(value).schema?.startsWith("fixture_")) ||
        (is(value, PgSchema) && value.schemaName.startsWith("fixture_")),
    );
    expect(fixtureExports.map(([name]) => name)).toEqual([]);
    // The probe recognizes a fixture table.
    expect(is(seedMarker, PgTable) && getTableConfig(seedMarker).schema).toBe("fixture_reference");
    const shared = ["DEFAULT_SOURCE_TIMEOUTS", "SourceRejectedError"];
    expect(Object.keys(purchasingEntry).sort()).toEqual(
      [...shared, "createPurchasingSource"].sort(),
    );
    expect(Object.keys(inventoryEntry).sort()).toEqual([...shared, "createInventorySource"].sort());
    expect(Object.keys(demandEntry).sort()).toEqual([...shared, "createDemandSource"].sort());
    // The reference reads return outcomes and never throw a source refusal.
    expect(Object.keys(referenceEntry).sort()).toEqual(
      ["DEFAULT_SOURCE_TIMEOUTS", "createReferenceSource"].sort(),
    );
  });

  it.each([
    [
      "stock",
      `INSERT INTO fixture_inventory.stock_snapshot
           (version, organization, sku, warehouse, uom, physical, quality_hold, safety_stock)
         VALUES ('INV-B@2', 'ORG-NDL', 'PART-A', 'WH-B', 'EA', 70, 0, 0)`,
      initializeInventoryHeads,
    ],
    [
      "demand",
      `INSERT INTO fixture_demand.demand_snapshot (version, organization, observed_at)
         VALUES ('DEM@2', 'ORG-NDL', NULL)`,
      initializeDemandHeads,
    ],
  ] as const)(
    "the %s head initializer refuses several snapshots without a stated current version",
    async (_kind, setup, initializeHeads) => {
      const before = await heads();
      const pool = db.pool("migrator", "d2-initializer");
      const refused = await drizzle(pool)
        .transaction(async (tx) => {
          await tx.execute(sql.raw(setup));
          await initializeHeads(tx);
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(AmbiguousCurrentVersionError);
      // The refused initialization rolled back with its transaction.
      expect(await heads()).toEqual(before);
      expect(
        await rows(
          observer,
          `SELECT (SELECT count(*) FROM fixture_inventory.stock_snapshot)::int AS stock,
                  (SELECT count(*) FROM fixture_demand.demand_snapshot)::int AS demand`,
        ),
      ).toEqual([{ stock: 2, demand: 1 }]);
    },
  );

  it(
    "upgrades a database seeded at 0002 with a matching marker: heads backfilled, rows, clock and marker kept",
    async () => {
      await db.recreate();
      observer = await db.client("migrator", "d2-observer-upgrade");
      await db.migrateThrough(["0000_initial", "0001_readiness", "0002_domain_fixture_inputs"]);
      // Pilot data the upgrade must keep.
      await observer.query(`
        INSERT INTO app.organization (id, slug, name)
          VALUES ('3f0e8a52-6c43-4c8e-9a51-5f1f6a3b2d10', 'd2-pilot', 'D2 pilot (synthetic)');
        INSERT INTO auth."user" (id, name, email) VALUES ('d2-user', 'D2 user', 'd2@fixture.local');
        INSERT INTO app.membership (organization_id, user_id, role)
          VALUES ('3f0e8a52-6c43-4c8e-9a51-5f1f6a3b2d10', 'd2-user', 'buyer');`);
      // The canonical seed at 0002: the four owner input writers and the marker, in
      // one transaction. Setup only; expectations below are literals and xmins.
      const pool = db.pool("migrator", "d2-canonical-seed");
      await drizzle(pool).transaction(async (tx) => {
        await initializeReference(tx, root.CANONICAL_MANIFEST.reference);
        await initializePurchasing(tx, root.CANONICAL_MANIFEST.purchasing.orders);
        await initializeInventory(tx, root.CANONICAL_MANIFEST.inventory);
        await initializeDemand(tx, root.CANONICAL_MANIFEST.demand.snapshots);
        await tx.insert(seedMarker).values({
          id: 1,
          fixtureVersion: root.CANONICAL_FIXTURE_VERSION,
          manifestSha256: root.manifestSha256(),
          oracleSha256: root.FROZEN_ORACLE_SHA256,
        });
      });
      // Simulated fixture maintenance after the seed.
      await observer.query(
        "UPDATE fixture_reference.business_clock SET instant = '2026-10-21T14:00:00+02:00'",
      );
      const preserved = [
        ...MIGRATION_0002_TABLES,
        "app.organization",
        "auth.user",
        "app.membership",
      ] as const;
      const before = await fingerprint(observer, preserved);
      expect(
        await rows(
          observer,
          "SELECT fixture_version, manifest_sha256 FROM fixture_reference.seed_marker",
        ),
      ).toEqual([
        {
          fixture_version: "first-slice-c01.v1",
          manifest_sha256: "57547d808324fcb2c8572295048a945aed542c9bde39f8e28ed8c60bdc78c48e",
        },
      ]);

      const migrated = await db.migrate();
      expect(migrated.code).toBe(0);
      expect(migrated.stdout).toContain("migrate: schema tag 0010_model_spend_guards recorded");
      expect(await fingerprint(observer, preserved)).toBe(before);
      expect(await heads()).toEqual(HEADS);
      expect(
        await rows(
          observer,
          `SELECT to_char(instant AT TIME ZONE 'Europe/Copenhagen', 'YYYY-MM-DD HH24:MI') AS wall
             FROM fixture_reference.business_clock`,
        ),
      ).toEqual([{ wall: "2026-10-21 14:00" }]);
      expect(await privileges()).toEqual(EXPECTED_PRIVILEGES);

      // The seed's canonical step stays a no-op on the matching marker.
      const headsBefore = await fingerprint(observer, [
        "fixture_purchasing.po_head",
        "fixture_inventory.stock_head",
        "fixture_demand.demand_head",
      ]);
      expect(await root.initializeCanonicalInputs(drizzle(pool))).toBe("present");
      expect(await fingerprint(observer, preserved)).toBe(before);
      expect(
        await fingerprint(observer, [
          "fixture_purchasing.po_head",
          "fixture_inventory.stock_head",
          "fixture_demand.demand_head",
        ]),
      ).toBe(headsBefore);
    },
    RESET_TIMEOUT_MS + 2 * NODE_TIMEOUT_MS,
  );

  it.each([
    [
      "stock",
      `INSERT INTO fixture_inventory.stock_snapshot
           (version, organization, sku, warehouse, uom, physical, quality_hold, safety_stock)
         VALUES ('INV-B@1', 'ORG-NDL', 'PART-A', 'WH-B', 'EA', 70, 0, 0),
                ('INV-B@2', 'ORG-NDL', 'PART-A', 'WH-B', 'EA', 70, 0, 0)`,
      "several stock snapshots for one SKU and warehouse",
      "fixture_inventory.stock_head",
    ],
    [
      "demand",
      `INSERT INTO fixture_demand.demand_snapshot (version, organization, observed_at)
         VALUES ('DEM@1', 'ORG-NDL', NULL), ('DEM@2', 'ORG-NDL', NULL)`,
      "several demand snapshots for one organization",
      "fixture_demand.demand_head",
    ],
  ])(
    "refuses to guess a current %s version when several snapshots exist before the upgrade",
    async (_kind, setup, message, head) => {
      await db.recreate();
      observer = await db.client("migrator", "d2-observer-ambiguous");
      await db.migrateThrough(["0000_initial", "0001_readiness", "0002_domain_fixture_inputs"]);
      await observer.query(setup);
      const migrated = await db.migrate();
      expect(migrated.code).toBe(1);
      expect(migrated.stderr).toContain(message);
      expect(await rows(observer, "SELECT tag FROM app.schema_tag")).toEqual([
        { tag: "0002_domain_fixture_inputs" },
      ]);
      expect(await rows(observer, "SELECT to_regclass($1) IS NULL AS absent", [head])).toEqual([
        { absent: true },
      ]);
    },
    RESET_TIMEOUT_MS,
  );
});
