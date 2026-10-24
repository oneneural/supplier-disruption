CREATE TABLE "app"."pilot_handler_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"job_retry_count" integer NOT NULL,
	"worker_boot_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."schema_tag" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"tag" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_tag_single_row_check" CHECK ("app"."schema_tag"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "app"."pilot_handler_attempt" ADD CONSTRAINT "pilot_handler_attempt_operation_id_pilot_operation_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "app"."pilot_operation"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pilot_handler_attempt_operation_id_idx" ON "app"."pilot_handler_attempt" USING btree ("operation_id");