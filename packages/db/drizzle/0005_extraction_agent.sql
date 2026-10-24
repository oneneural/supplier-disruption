CREATE SCHEMA "agent_checkpoint";
--> statement-breakpoint
CREATE TABLE "app"."agent_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"tool_budget" integer NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"cost_cap_micro_usd" integer NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"pause_reason" text,
	"pause_detail" text,
	"evidence_text" text NOT NULL,
	"evidence_sha256" text NOT NULL,
	"terms" jsonb,
	"locators" jsonb,
	"rationale" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_run_case_unique" UNIQUE("case_id"),
	CONSTRAINT "agent_run_status_check" CHECK ("app"."agent_run"."status" in ('queued', 'running', 'proposed', 'paused')),
	CONSTRAINT "agent_run_budget_check" CHECK ("app"."agent_run"."tool_budget" between 1 and 12),
	CONSTRAINT "agent_run_calls_check" CHECK ("app"."agent_run"."tool_calls" <= "app"."agent_run"."tool_budget"),
	CONSTRAINT "agent_run_digest_check" CHECK ("app"."agent_run"."evidence_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app"."agent_step" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"tool" text,
	"input" jsonb,
	"result" jsonb,
	"accepted" boolean NOT NULL,
	"reason" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"cost_micro_usd" integer,
	CONSTRAINT "agent_step_run_id_sequence_pk" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "agent_step_kind_check" CHECK ("app"."agent_step"."kind" in ('model', 'tool'))
);
--> statement-breakpoint
CREATE TABLE "agent_checkpoint"."checkpoint_blobs" (
	"thread_id" text NOT NULL,
	"checkpoint_ns" text DEFAULT '' NOT NULL,
	"channel" text NOT NULL,
	"version" text NOT NULL,
	"type" text NOT NULL,
	"blob" "bytea",
	CONSTRAINT "checkpoint_blobs_thread_id_checkpoint_ns_channel_version_pk" PRIMARY KEY("thread_id","checkpoint_ns","channel","version")
);
--> statement-breakpoint
CREATE TABLE "agent_checkpoint"."checkpoint_migrations" (
	"v" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_checkpoint"."checkpoint_writes" (
	"thread_id" text NOT NULL,
	"checkpoint_ns" text DEFAULT '' NOT NULL,
	"checkpoint_id" text NOT NULL,
	"task_id" text NOT NULL,
	"idx" integer NOT NULL,
	"channel" text NOT NULL,
	"type" text,
	"blob" "bytea" NOT NULL,
	CONSTRAINT "checkpoint_writes_thread_id_checkpoint_ns_checkpoint_id_task_id_idx_pk" PRIMARY KEY("thread_id","checkpoint_ns","checkpoint_id","task_id","idx")
);
--> statement-breakpoint
CREATE TABLE "agent_checkpoint"."checkpoints" (
	"thread_id" text NOT NULL,
	"checkpoint_ns" text DEFAULT '' NOT NULL,
	"checkpoint_id" text NOT NULL,
	"parent_checkpoint_id" text,
	"type" text,
	"checkpoint" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "checkpoints_thread_id_checkpoint_ns_checkpoint_id_pk" PRIMARY KEY("thread_id","checkpoint_ns","checkpoint_id")
);
--> statement-breakpoint
ALTER TABLE "app"."supplier_message" DROP CONSTRAINT "supplier_message_disposition_check";--> statement-breakpoint
ALTER TABLE "app"."agent_run" ADD CONSTRAINT "agent_run_case_id_supplier_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_step" ADD CONSTRAINT "agent_step_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "app"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_message" ADD CONSTRAINT "supplier_message_disposition_check" CHECK ("app"."supplier_message"."disposition" in ('accept', 'duplicate', 'blocked', 'evidence'));--> statement-breakpoint
-- The checkpoint saver's own migrations 0 to 4 are the DDL above; recording them keeps setup() a no-op.
INSERT INTO "agent_checkpoint"."checkpoint_migrations" ("v") VALUES (0), (1), (2), (3), (4);
