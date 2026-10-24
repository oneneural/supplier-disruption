import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appSchema } from "./app.js";
import { supplierCase } from "./cases.js";

/**
 * Extraction agent records (ADR 0011). A run and its steps are
 * application records owned by the API: the run row holds the current status
 * and totals, each step is appended once by its sequence number. Business
 * times come from the injected clock.
 */

const businessTime = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const agentRun = appSchema.table(
  "agent_run",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supplierCase.id),
    status: text("status").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    toolBudget: integer("tool_budget").notNull(),
    toolCalls: integer("tool_calls").notNull().default(0),
    modelCalls: integer("model_calls").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    costCapMicroUsd: integer("cost_cap_micro_usd").notNull(),
    latencyMs: integer("latency_ms").notNull().default(0),
    pauseReason: text("pause_reason"),
    pauseDetail: text("pause_detail"),
    /** The text every email locator indexes, and its SHA-256. */
    evidenceText: text("evidence_text").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    terms: jsonb("terms"),
    locators: jsonb("locators"),
    rationale: text("rationale"),
    startedAt: businessTime("started_at").notNull(),
    finishedAt: businessTime("finished_at"),
  },
  (table) => [
    unique("agent_run_case_unique").on(table.caseId),
    check(
      "agent_run_status_check",
      sql`${table.status} in ('queued', 'running', 'proposed', 'paused')`,
    ),
    check("agent_run_budget_check", sql`${table.toolBudget} between 1 and 12`),
    check("agent_run_calls_check", sql`${table.toolCalls} <= ${table.toolBudget}`),
    check("agent_run_digest_check", sql`${table.evidenceSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const agentStep = appSchema.table(
  "agent_step",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRun.id),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    tool: text("tool"),
    input: jsonb("input"),
    result: jsonb("result"),
    accepted: boolean("accepted").notNull(),
    reason: text("reason").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costMicroUsd: integer("cost_micro_usd"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    check("agent_step_kind_check", sql`${table.kind} in ('model', 'tool')`),
  ],
);

/**
 * LangGraph checkpoint tables, matching the DDL of
 * @langchain/langgraph-checkpoint-postgres 1.0.6 so its saver runs without
 * `setup()`: the API role never creates schema objects.
 */
export const agentCheckpointSchema = pgSchema("agent_checkpoint");

export const checkpointMigrations = agentCheckpointSchema.table("checkpoint_migrations", {
  v: integer("v").primaryKey(),
});

export const checkpoints = agentCheckpointSchema.table(
  "checkpoints",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    parentCheckpointId: text("parent_checkpoint_id"),
    type: text("type"),
    checkpoint: jsonb("checkpoint").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.checkpointNs, table.checkpointId] })],
);

export const checkpointBlobs = agentCheckpointSchema.table(
  "checkpoint_blobs",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    channel: text("channel").notNull(),
    version: text("version").notNull(),
    type: text("type").notNull(),
    blob: bytea("blob"),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.checkpointNs, table.channel, table.version] }),
  ],
);

export const checkpointWrites = agentCheckpointSchema.table(
  "checkpoint_writes",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    taskId: text("task_id").notNull(),
    idx: integer("idx").notNull(),
    channel: text("channel").notNull(),
    type: text("type"),
    blob: bytea("blob").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.checkpointNs, table.checkpointId, table.taskId, table.idx],
    }),
  ],
);

/** The checkpoint schema name the API passes to the saver. */
export const AGENT_CHECKPOINT_SCHEMA = "agent_checkpoint";
