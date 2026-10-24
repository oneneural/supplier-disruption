import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Worker-owned operational state. The worker role has no business or auth access. */
export const workerSchema = pgSchema("worker");

export const workerHeartbeat = workerSchema.table("heartbeat", {
  bootId: uuid("boot_id").primaryKey(),
  buildRevision: text("build_revision").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});
