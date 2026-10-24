import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { quantity } from "../columns.js";

/**
 * Fixture demand authority: versioned open sales-order lines with their
 * explicit supply links, and the current version for each organization.
 * Read-only for every runtime role; only the order system (in tests, migrator
 * setup) adds versions and moves the current one.
 */
export const demandSchema = pgSchema("fixture_demand");

export const demandSnapshot = demandSchema.table("demand_snapshot", {
  version: text("version").primaryKey(),
  organization: text("organization").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }),
});

export const demandLine = demandSchema.table(
  "demand_line",
  {
    version: text("version")
      .notNull()
      .references(() => demandSnapshot.version),
    salesOrder: text("sales_order").notNull(),
    line: text("line").notNull(),
    sku: text("sku").notNull(),
    uom: text("uom").notNull(),
    open: quantity("open_quantity").notNull(),
    /** Null is unknown. */
    delivered: quantity("delivered_quantity"),
    destination: text("destination").notNull(),
    receiptCutoff: date("receipt_cutoff").notNull(),
    calendarPolicyId: text("calendar_policy_id").notNull(),
    calendarPolicyVersion: integer("calendar_policy_version").notNull(),
    priority: integer("priority").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.version, table.salesOrder, table.line] }),
    check(
      "demand_line_quantities_check",
      sql`${table.open} >= 0 and (${table.delivered} is null or ${table.delivered} >= 0)`,
    ),
    check("demand_line_priority_check", sql`${table.priority} >= 1`),
  ],
);

export const supplyLink = demandSchema.table(
  "supply_link",
  {
    version: text("version").notNull(),
    salesOrder: text("sales_order").notNull(),
    line: text("line").notNull(),
    poNumber: text("po_number").notNull(),
    poLine: text("po_line").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.version, table.salesOrder, table.line, table.poNumber, table.poLine],
    }),
    foreignKey({
      name: "supply_link_demand_line_fk",
      columns: [table.version, table.salesOrder, table.line],
      foreignColumns: [demandLine.version, demandLine.salesOrder, demandLine.line],
    }),
  ],
);

/** The order system's current demand version for an organization, never chosen by label order. */
export const demandHead = demandSchema.table("demand_head", {
  organization: text("organization").primaryKey(),
  version: text("version")
    .notNull()
    .unique()
    .references(() => demandSnapshot.version),
});
