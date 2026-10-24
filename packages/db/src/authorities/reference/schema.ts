import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { quantity } from "../columns.js";

/**
 * Fixture reference data: organization alias, vendor contacts, items and
 * item-master mappings, simulated actors, named policy versions, structured
 * supplier input awaiting intake, scenario timing, the controlled business
 * clock and the seed marker.
 */
export const referenceSchema = pgSchema("fixture_reference");

/** Explicit mapping from an organization's business label to its application UUID. */
export const organizationAlias = referenceSchema.table("organization_alias", {
  label: text("label").primaryKey(),
  organizationId: uuid("organization_id").notNull().unique(),
  name: text("name").notNull(),
});

export const vendor = referenceSchema.table("vendor", {
  vendorId: text("vendor_id").primaryKey(),
  name: text("name").notNull(),
});

export const vendorContact = referenceSchema.table(
  "vendor_contact",
  {
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendor.vendorId),
    address: text("address").notNull(),
    purpose: text("purpose").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vendorId, table.address] }),
    check("vendor_contact_purpose_check", sql`${table.purpose} in ('registered_sender')`),
  ],
);

export const item = referenceSchema.table(
  "item",
  {
    sku: text("sku").primaryKey(),
    stockUom: text("stock_uom").notNull(),
    integral: boolean("integral").notNull(),
  },
  (table) => [check("item_integral_check", sql`${table.integral}`)],
);

export const itemMapping = referenceSchema.table(
  "item_mapping",
  {
    mappingId: text("mapping_id").notNull(),
    version: integer("version").notNull(),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendor.vendorId),
    vendorItem: text("vendor_item").notNull(),
    sourceUom: text("source_uom").notNull(),
    sku: text("sku")
      .notNull()
      .references(() => item.sku),
    stockUom: text("stock_uom").notNull(),
    ratioNumerator: quantity("ratio_numerator").notNull(),
    ratioDenominator: quantity("ratio_denominator").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** Inclusive; null has no end date. */
    effectiveThrough: date("effective_through"),
    provenance: text("provenance").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.mappingId, table.version] }),
    check(
      "item_mapping_ratio_check",
      sql`${table.ratioNumerator} > 0 and ${table.ratioDenominator} > 0`,
    ),
    check(
      "item_mapping_dates_check",
      sql`${table.effectiveThrough} is null or ${table.effectiveThrough} >= ${table.effectiveFrom}`,
    ),
    check("item_mapping_provenance_check", sql`${table.provenance} in ('item_master')`),
  ],
);

/** Simulated actors: registry inputs, not sign-in accounts or authority grants. */
export const actor = referenceSchema.table(
  "actor",
  {
    actorId: text("actor_id").primaryKey(),
    role: text("role").notNull(),
    vendorId: text("vendor_id").references(() => vendor.vendorId),
    simulated: boolean("simulated").notNull(),
  },
  (table) => [
    check(
      "actor_role_check",
      sql`${table.role} in ('buyer', 'procurement_manager', 'warehouse_planner', 'customer_service_owner', 'supplier_contact')`,
    ),
    check(
      "actor_vendor_check",
      sql`(${table.role} = 'supplier_contact') = (${table.vendorId} is not null)`,
    ),
    check("actor_simulated_check", sql`${table.simulated}`),
  ],
);

/** A named policy version and its parameters, as validated by the policy contract. */
export const policy = referenceSchema.table(
  "policy",
  {
    policyId: text("policy_id").notNull(),
    version: integer("version").notNull(),
    parameters: jsonb("parameters").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.policyId, table.version] }),
    check("policy_version_check", sql`${table.version} >= 1`),
  ],
);

/**
 * One structured supplier input awaiting intake. `content` holds the
 * supplier-stated proposal terms; `content_sha256` is the SHA-256 of their
 * canonical JSON and excludes the message ID. Null times are unknown.
 */
export const supplierInput = referenceSchema.table(
  "supplier_input",
  {
    sourceSystem: text("source_system").notNull(),
    messageId: text("message_id").notNull(),
    inputVersion: integer("input_version").notNull(),
    contentSha256: text("content_sha256").notNull(),
    sender: text("sender").notNull(),
    proposalId: text("proposal_id").notNull(),
    evidenceRef: text("evidence_ref").notNull(),
    authoredAt: timestamp("authored_at", { withTimezone: true, mode: "string" }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }),
    content: jsonb("content").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceSystem, table.messageId, table.inputVersion] }),
    unique("supplier_input_proposal_id_unique").on(table.proposalId),
    check("supplier_input_digest_check", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const scenarioTiming = referenceSchema.table(
  "scenario_timing",
  {
    scenario: text("scenario").notNull(),
    name: text("name").notNull(),
    instant: timestamp("instant", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scenario, table.name] })],
);

/**
 * The controlled business clock, in a single row. Only a test-mode controlled
 * Clock reads it; tests advance it directly with a migrator connection.
 */
export const businessClock = referenceSchema.table(
  "business_clock",
  {
    id: smallint("id").primaryKey().default(1),
    instant: timestamp("instant", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [check("business_clock_single_row_check", sql`${table.id} = 1`)],
);

/**
 * Written in the same transaction as the canonical inputs. A matching marker
 * makes the seed a no-op; a different one stops it without repair.
 */
export const seedMarker = referenceSchema.table(
  "seed_marker",
  {
    id: smallint("id").primaryKey().default(1),
    fixtureVersion: text("fixture_version").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    oracleSha256: text("oracle_sha256").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("seed_marker_single_row_check", sql`${table.id} = 1`),
    check(
      "seed_marker_digest_check",
      sql`${table.manifestSha256} ~ '^[0-9a-f]{64}$' and ${table.oracleSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
