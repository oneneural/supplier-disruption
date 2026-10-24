CREATE TABLE "app"."case_clarification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"fields" jsonb NOT NULL,
	"question" text NOT NULL,
	"draft" jsonb NOT NULL,
	"sent" boolean DEFAULT false NOT NULL,
	"basis_assessment" integer NOT NULL,
	"plan_version" integer NOT NULL,
	"actor_id" text NOT NULL,
	"user_id" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"reply_message_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	CONSTRAINT "case_clarification_sequence_unique" UNIQUE("case_id","sequence"),
	CONSTRAINT "case_clarification_status_check" CHECK ("app"."case_clarification"."status" in ('awaiting_reply', 'answered', 'superseded')),
	CONSTRAINT "case_clarification_not_sent_check" CHECK (not "app"."case_clarification"."sent")
);
--> statement-breakpoint
CREATE TABLE "app"."case_correction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"diagnostics" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"user_id" text NOT NULL,
	"basis_assessment" integer NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changes" jsonb NOT NULL,
	"locators" jsonb NOT NULL,
	"input" jsonb,
	"assessment_id" uuid,
	"plan_version" integer,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "case_correction_sequence_unique" UNIQUE("case_id","sequence"),
	CONSTRAINT "case_correction_status_check" CHECK ("app"."case_correction"."status" in ('rejected', 'blocked', 'accepted'))
);
--> statement-breakpoint
ALTER TABLE "app"."supplier_message" DROP CONSTRAINT "supplier_message_disposition_check";--> statement-breakpoint
ALTER TABLE "app"."case_clarification" ADD CONSTRAINT "case_clarification_case_id_supplier_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_clarification" ADD CONSTRAINT "case_clarification_reply_message_id_supplier_message_id_fk" FOREIGN KEY ("reply_message_id") REFERENCES "app"."supplier_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_correction" ADD CONSTRAINT "case_correction_case_id_supplier_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_correction" ADD CONSTRAINT "case_correction_assessment_id_case_assessment_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "app"."case_assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_message" ADD CONSTRAINT "supplier_message_disposition_check" CHECK ("app"."supplier_message"."disposition" in ('accept', 'duplicate', 'blocked', 'evidence', 'reply'));