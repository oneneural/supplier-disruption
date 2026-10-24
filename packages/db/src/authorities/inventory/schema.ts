import { sql } from "drizzle-orm";
import {
  bigint,
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
 * Fixture inventory and transfer authority: versioned stock snapshots with
 * separate physical, hold and safety-stock buckets, individually identified
 * reservations, transfer options and in-transit records, the current stock
 * version of each SKU at each warehouse, transfer requests, and native
 * operations with their receipts. Snapshots, reservations, requests and
 * receipts are append-only. Eligible stock is derived by policy and has no
 * column. Expected inbound stays with purchasing.
 */
export const inventorySchema = pgSchema("fixture_inventory");

export const stockSnapshot = inventorySchema.table(
  "stock_snapshot",
  {
    version: text("version").primaryKey(),
    organization: text("organization").notNull(),
    sku: text("sku").notNull(),
    warehouse: text("warehouse").notNull(),
    uom: text("uom").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }),
    physical: quantity("physical").notNull(),
    qualityHold: quantity("quality_hold").notNull(),
    safetyStock: quantity("safety_stock").notNull(),
  },
  (table) => [
    check(
      "stock_snapshot_quantities_check",
      sql`${table.physical} >= 0 and ${table.qualityHold} >= 0 and ${table.safetyStock} >= 0`,
    ),
  ],
);

export const reservation = inventorySchema.table(
  "reservation",
  {
    snapshotVersion: text("snapshot_version")
      .notNull()
      .references(() => stockSnapshot.version),
    reservationId: text("reservation_id").notNull(),
    quantity: quantity("quantity").notNull(),
    /** Null for a reservation unrelated to any plan. */
    planId: text("plan_id"),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotVersion, table.reservationId] }),
    check("reservation_quantity_check", sql`${table.quantity} > 0`),
  ],
);

export const transferOption = inventorySchema.table(
  "transfer_option",
  {
    optionId: text("option_id").primaryKey(),
    sku: text("sku").notNull(),
    uom: text("uom").notNull(),
    fromWarehouse: text("from_warehouse").notNull(),
    toWarehouse: text("to_warehouse").notNull(),
    quantity: quantity("quantity").notNull(),
    dispatchDate: date("dispatch_date").notNull(),
    arrivalDate: date("arrival_date").notNull(),
    costMinorUnits: bigint("cost_minor_units", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "string" }).notNull(),
    basedOn: text("based_on").notNull(),
    ownerRole: text("owner_role").notNull(),
  },
  (table) => [
    foreignKey({ columns: [table.basedOn], foreignColumns: [stockSnapshot.version] }),
    check("transfer_option_quantity_check", sql`${table.quantity} > 0`),
    // Read as a JavaScript number, so the column holds safe integers only.
    check(
      "transfer_option_cost_check",
      sql`${table.costMinorUnits} >= 0 AND ${table.costMinorUnits} <= 9007199254740991`,
    ),
    check("transfer_option_dates_check", sql`${table.dispatchDate} <= ${table.arrivalDate}`),
    check("transfer_option_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("transfer_option_warehouses_check", sql`${table.fromWarehouse} <> ${table.toWarehouse}`),
  ],
);

export const inTransit = inventorySchema.table(
  "in_transit",
  {
    transitId: text("transit_id").primaryKey(),
    sku: text("sku").notNull(),
    uom: text("uom").notNull(),
    fromWarehouse: text("from_warehouse").notNull(),
    toWarehouse: text("to_warehouse").notNull(),
    quantity: quantity("quantity").notNull(),
    /** Null is unknown. */
    dispatchedOn: date("dispatched_on"),
    /** Null is undated. */
    arrivalDate: date("arrival_date"),
  },
  (table) => [check("in_transit_quantity_check", sql`${table.quantity} > 0`)],
);

/**
 * The current stock version of one SKU at one warehouse, chosen explicitly
 * rather than by observation time or label order. A reservation locks this
 * row, checks the version and moves it to the appended successor snapshot.
 */
export const stockHead = inventorySchema.table(
  "stock_head",
  {
    organization: text("organization").notNull(),
    sku: text("sku").notNull(),
    warehouse: text("warehouse").notNull(),
    version: text("version")
      .notNull()
      .unique()
      .references(() => stockSnapshot.version),
  },
  (table) => [primaryKey({ columns: [table.organization, table.sku, table.warehouse] })],
);

/**
 * One native operation identity per organization across operation kinds. It
 * is inserted first in the operation's transaction, so a concurrent call with
 * the same key waits for it; a refused operation rolls it back.
 */
export const operation = inventorySchema.table(
  "operation",
  {
    organization: text("organization").notNull(),
    operationId: text("operation_id").notNull(),
    kind: text("kind").notNull(),
    requestDigest: text("request_digest").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organization, table.operationId] }),
    check("operation_kind_check", sql`${table.kind} in ('reserve', 'create_transfer_request')`),
    check("operation_digest_check", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A requested transfer drawing on one identified reservation at the source
 * warehouse. Requested is not dispatched: it moves no stock. Each reservation
 * backs at most one request.
 */
export const transferRequest = inventorySchema.table(
  "transfer_request",
  {
    requestId: text("request_id").primaryKey(),
    organization: text("organization").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    optionId: text("option_id")
      .notNull()
      .references(() => transferOption.optionId),
    sku: text("sku").notNull(),
    uom: text("uom").notNull(),
    fromWarehouse: text("from_warehouse").notNull(),
    toWarehouse: text("to_warehouse").notNull(),
    quantity: quantity("quantity").notNull(),
    dispatchDate: date("dispatch_date").notNull(),
    arrivalDate: date("arrival_date").notNull(),
    stockVersion: text("stock_version").notNull(),
    reservationId: text("reservation_id").notNull(),
    planId: text("plan_id").notNull(),
  },
  (table) => [
    foreignKey({
      name: "transfer_request_reservation_fk",
      columns: [table.stockVersion, table.reservationId],
      foreignColumns: [reservation.snapshotVersion, reservation.reservationId],
    }),
    unique("transfer_request_reservation_unique").on(
      table.organization,
      table.sku,
      table.fromWarehouse,
      table.reservationId,
    ),
    check("transfer_request_version_check", sql`${table.version} >= 1`),
    check("transfer_request_status_check", sql`${table.status} in ('requested')`),
    check("transfer_request_quantity_check", sql`${table.quantity} > 0`),
    check("transfer_request_dates_check", sql`${table.dispatchDate} <= ${table.arrivalDate}`),
    check("transfer_request_warehouses_check", sql`${table.fromWarehouse} <> ${table.toWarehouse}`),
  ],
);

/**
 * The native receipt of a committed reservation or transfer request, written
 * with its effect. A reservation receipt names the stock version it produced
 * and its parent; a transfer request receipt names the stock version checked,
 * which linking leaves unchanged. Append-only.
 */
export const operationReceipt = inventorySchema.table(
  "operation_receipt",
  {
    receiptId: uuid("receipt_id").primaryKey(),
    organization: text("organization").notNull(),
    operationId: text("operation_id").notNull(),
    kind: text("kind").notNull(),
    planId: text("plan_id").notNull(),
    actionId: text("action_id").notNull(),
    sku: text("sku").notNull(),
    warehouse: text("warehouse").notNull(),
    priorVersion: text("prior_version")
      .notNull()
      .references(() => stockSnapshot.version),
    /** Null for a transfer request, which produces no stock version. */
    successorVersion: text("successor_version")
      .unique()
      .references(() => stockSnapshot.version),
    reservationId: text("reservation_id").notNull(),
    /** The reserved or requested quantity at commit. */
    quantity: quantity("quantity").notNull(),
    transferRequestId: text("transfer_request_id")
      .unique()
      .references(() => transferRequest.requestId),
    /** The request version created; null for a reservation. */
    requestVersion: integer("request_version"),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    unique("operation_receipt_operation_unique").on(table.organization, table.operationId),
    foreignKey({
      name: "operation_receipt_operation_fk",
      columns: [table.organization, table.operationId],
      foreignColumns: [operation.organization, operation.operationId],
    }),
    check(
      "operation_receipt_kind_check",
      sql`(${table.kind} = 'reserve' and ${table.successorVersion} is not null
            and ${table.transferRequestId} is null and ${table.requestVersion} is null)
       or (${table.kind} = 'create_transfer_request' and ${table.successorVersion} is null
            and ${table.transferRequestId} is not null and ${table.requestVersion} is not null)`,
    ),
    check("operation_receipt_quantity_check", sql`${table.quantity} > 0`),
  ],
);

/**
 * A warehouse's observation of a requested transfer: `dispatched` when the
 * goods left the source, `received` when the destination booked them in
 * (ADR 0015). Observations are evidence beside the request: they
 * never change the request, a reservation or any stock snapshot, so neither
 * creates physical stock. The fixture records them only as simulated
 * warehouse events; the API reads them and cannot write them.
 */
export const transferObservation = inventorySchema.table(
  "transfer_observation",
  {
    observationId: text("observation_id").primaryKey(),
    organization: text("organization").notNull(),
    requestId: text("request_id")
      .notNull()
      .references(() => transferRequest.requestId),
    kind: text("kind").notNull(),
    quantity: quantity("quantity").notNull(),
    observedOn: date("observed_on").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    unique("transfer_observation_kind_unique").on(table.requestId, table.kind),
    check("transfer_observation_kind_check", sql`${table.kind} in ('dispatched', 'received')`),
    check("transfer_observation_quantity_check", sql`${table.quantity} > 0`),
  ],
);
