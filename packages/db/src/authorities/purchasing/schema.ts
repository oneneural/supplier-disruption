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
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { quantity } from "../columns.js";

/**
 * Fixture purchasing authority: accepted PO revisions, lines and schedule
 * segments, the current revision of each PO, and native operations with their
 * receipts. Private to purchasing: only its runtime module and initialization
 * use these tables. Revisions are append-only history. A null observation
 * time or effective date is unknown, never defaulted.
 */
export const purchasingSchema = pgSchema("fixture_purchasing");

export const poRevision = purchasingSchema.table(
  "po_revision",
  {
    poNumber: text("po_number").notNull(),
    revision: integer("revision").notNull(),
    organization: text("organization").notNull(),
    vendorId: text("vendor_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }),
    effectiveDate: date("effective_date"),
  },
  (table) => [
    primaryKey({ columns: [table.poNumber, table.revision] }),
    check("po_revision_revision_check", sql`${table.revision} >= 1`),
  ],
);

export const poLine = purchasingSchema.table(
  "po_line",
  {
    poNumber: text("po_number").notNull(),
    revision: integer("revision").notNull(),
    lineNumber: text("line_number").notNull(),
    sku: text("sku").notNull(),
    uom: text("uom").notNull(),
    destination: text("destination").notNull(),
    ordered: quantity("ordered").notNull(),
    received: quantity("received").notNull(),
    canceled: quantity("canceled").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.poNumber, table.revision, table.lineNumber] }),
    foreignKey({
      name: "po_line_po_revision_fk",
      columns: [table.poNumber, table.revision],
      foreignColumns: [poRevision.poNumber, poRevision.revision],
    }),
    check(
      "po_line_quantities_check",
      sql`${table.ordered} >= 0 and ${table.received} >= 0 and ${table.canceled} >= 0`,
    ),
  ],
);

export const poLineSegment = purchasingSchema.table(
  "po_line_segment",
  {
    poNumber: text("po_number").notNull(),
    revision: integer("revision").notNull(),
    lineNumber: text("line_number").notNull(),
    sequence: integer("sequence").notNull(),
    quantity: quantity("quantity").notNull(),
    /** Null is an undated segment. */
    arrivalDate: date("arrival_date"),
  },
  (table) => [
    primaryKey({
      columns: [table.poNumber, table.revision, table.lineNumber, table.sequence],
    }),
    foreignKey({
      name: "po_line_segment_po_line_fk",
      columns: [table.poNumber, table.revision, table.lineNumber],
      foreignColumns: [poLine.poNumber, poLine.revision, poLine.lineNumber],
    }),
    check("po_line_segment_quantity_check", sql`${table.quantity} > 0`),
    check("po_line_segment_sequence_check", sql`${table.sequence} >= 1`),
  ],
);

/**
 * The current revision of each PO, chosen explicitly rather than by
 * observation time. A conditional amendment locks this row, checks the base
 * revision and moves it to the appended successor.
 */
export const poHead = purchasingSchema.table(
  "po_head",
  {
    poNumber: text("po_number").primaryKey(),
    organization: text("organization").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    foreignKey({
      name: "po_head_po_revision_fk",
      columns: [table.poNumber, table.revision],
      foreignColumns: [poRevision.poNumber, poRevision.revision],
    }),
  ],
);

/**
 * One native operation identity per organization across operation kinds. It
 * is inserted first in the operation's transaction, so a concurrent call with
 * the same key waits for it; a refused operation rolls it back.
 */
export const operation = purchasingSchema.table(
  "operation",
  {
    organization: text("organization").notNull(),
    operationId: text("operation_id").notNull(),
    kind: text("kind").notNull(),
    requestDigest: text("request_digest").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organization, table.operationId] }),
    check("operation_kind_check", sql`${table.kind} in ('amend_schedule')`),
    check("operation_digest_check", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** The native receipt of a committed amendment, written with its effect. Append-only. */
export const operationReceipt = purchasingSchema.table(
  "operation_receipt",
  {
    receiptId: uuid("receipt_id").primaryKey(),
    organization: text("organization").notNull(),
    operationId: text("operation_id").notNull(),
    planId: text("plan_id").notNull(),
    actionId: text("action_id").notNull(),
    poNumber: text("po_number").notNull(),
    lineNumber: text("line_number").notNull(),
    priorRevision: integer("prior_revision").notNull(),
    successorRevision: integer("successor_revision").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    unique("operation_receipt_operation_unique").on(table.organization, table.operationId),
    foreignKey({
      name: "operation_receipt_operation_fk",
      columns: [table.organization, table.operationId],
      foreignColumns: [operation.organization, operation.operationId],
    }),
    foreignKey({
      name: "operation_receipt_successor_fk",
      columns: [table.poNumber, table.successorRevision, table.lineNumber],
      foreignColumns: [poLine.poNumber, poLine.revision, poLine.lineNumber],
    }),
    check(
      "operation_receipt_successor_check",
      sql`${table.successorRevision} = ${table.priorRevision} + 1`,
    ),
  ],
);
