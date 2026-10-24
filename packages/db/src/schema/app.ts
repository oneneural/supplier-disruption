import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";

/** Business records. Only the API role reads or writes this schema at runtime. */
export const appSchema = pgSchema("app");

export const organization = appSchema.table("organization", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const membership = appSchema.table(
  "membership",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["buyer", "manager"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("membership_user_id_idx").on(table.userId),
    check("membership_role_check", sql`${table.role} in ('buyer', 'manager')`),
  ],
);

/**
 * One pilot operation. The operation ID is globally unique; ownership,
 * payload digest and receipt are application records, not queue state.
 */
export const pilotOperation = appSchema.table(
  "pilot_operation",
  {
    operationId: uuid("operation_id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => user.id),
    contractVersion: text("contract_version").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    state: text("state", { enum: ["queued", "completed"] })
      .notNull()
      .default("queued"),
    jobId: uuid("job_id"),
    receiptId: uuid("receipt_id").unique(),
    receiptRecordedAt: timestamp("receipt_recorded_at", { withTimezone: true }),
    receiptJobId: uuid("receipt_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pilot_operation_organization_id_idx").on(table.organizationId),
    check("pilot_operation_state_check", sql`${table.state} in ('queued', 'completed')`),
    check("pilot_operation_digest_check", sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "pilot_operation_receipt_check",
      sql`(${table.state} = 'completed') = (${table.receiptId} is not null and ${table.receiptRecordedAt} is not null and ${table.receiptJobId} is not null)`,
    ),
  ],
);

/**
 * One worker handler start for a job attempt, recorded through the API before
 * the handler does any work, so a start without a receipt is observable.
 */
export const pilotHandlerAttempt = appSchema.table(
  "pilot_handler_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => pilotOperation.operationId),
    jobId: uuid("job_id").notNull(),
    jobRetryCount: integer("job_retry_count").notNull(),
    workerBootId: uuid("worker_boot_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("pilot_handler_attempt_operation_id_idx").on(table.operationId)],
);

/** Every receipt call the API accepted, including idempotent replays. */
export const pilotReceiptAttempt = appSchema.table(
  "pilot_receipt_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => pilotOperation.operationId),
    jobId: uuid("job_id").notNull(),
    jobRetryCount: integer("job_retry_count").notNull(),
    workerBootId: uuid("worker_boot_id").notNull(),
    outcome: text("outcome", { enum: ["recorded", "existing"] }).notNull(),
    receiptId: uuid("receipt_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pilot_receipt_attempt_operation_id_idx").on(table.operationId),
    check("pilot_receipt_attempt_outcome_check", sql`${table.outcome} in ('recorded', 'existing')`),
  ],
);

/**
 * The schema tag the migrator applied last, in a single row. The API compares
 * it with SCHEMA_TAG compiled into its own build and reports not ready when
 * they differ. Only the migrator writes it; the API role may only read it.
 */
export const schemaTag = appSchema.table(
  "schema_tag",
  {
    id: smallint("id").primaryKey().default(1),
    tag: text("tag").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("schema_tag_single_row_check", sql`${table.id} = 1`)],
);
