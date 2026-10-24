import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { appSchema } from "./app.js";

/**
 * The project-wide model spend ledger (ADR 0017). The API and the
 * evaluation runner admit every metered provider run here: a reservation of
 * the run's worst-case cost is inserted before the provider is called and is
 * settled with reported usage afterwards. Times are operational, not business
 * time.
 */

const operationalTime = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/**
 * The single account row. Its opening balance carries forward spend recorded
 * before this database existed; an operator writes it with reconciliation
 * evidence. Without it every metered admission is refused, so a recreated
 * database cannot silently restart the project total at zero.
 */
export const modelSpendAccount = appSchema.table(
  "model_spend_account",
  {
    id: smallint("id").primaryKey(),
    openingMicroUsd: bigint("opening_micro_usd", { mode: "number" }).notNull(),
    openingEvidence: text("opening_evidence").notNull(),
    openedAt: operationalTime("opened_at").notNull().defaultNow(),
  },
  (table) => [
    check("model_spend_account_singleton_check", sql`${table.id} = 1`),
    check("model_spend_account_opening_check", sql`${table.openingMicroUsd} >= 0`),
    check("model_spend_account_evidence_check", sql`length(${table.openingEvidence}) > 0`),
  ],
);

/**
 * One admitted provider run. `reserved` is in flight or abandoned by a dead
 * process; `uncertain` has unknown usage; both count at the reserved amount
 * until `settled` with reported usage or reconciliation evidence.
 */
export const modelSpendReservation = appSchema.table(
  "model_spend_reservation",
  {
    key: text("key").primaryKey(),
    source: text("source").notNull(),
    reference: text("reference").notNull(),
    model: text("model").notNull(),
    reservedMicroUsd: bigint("reserved_micro_usd", { mode: "number" }).notNull(),
    status: text("status").notNull(),
    settledMicroUsd: bigint("settled_micro_usd", { mode: "number" }),
    usage: jsonb("usage"),
    detail: text("detail"),
    reservedAt: operationalTime("reserved_at").notNull().defaultNow(),
    resolvedAt: operationalTime("resolved_at"),
  },
  (table) => [
    index("model_spend_reservation_reference_idx").on(table.reference),
    check("model_spend_reservation_source_check", sql`${table.source} in ('api', 'evaluation')`),
    check(
      "model_spend_reservation_status_check",
      sql`${table.status} in ('reserved', 'uncertain', 'settled')`,
    ),
    check("model_spend_reservation_amount_check", sql`${table.reservedMicroUsd} > 0`),
    check(
      "model_spend_reservation_settled_check",
      sql`(${table.status} = 'settled') = (${table.settledMicroUsd} is not null) and coalesce(${table.settledMicroUsd}, 0) >= 0`,
    ),
  ],
);
