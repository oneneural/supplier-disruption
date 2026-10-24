CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "worker";
--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."membership" (
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "membership_role_check" CHECK ("app"."membership"."role" in ('buyer', 'manager'))
);
--> statement-breakpoint
CREATE TABLE "app"."organization" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app"."pilot_operation" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"submitted_by" text NOT NULL,
	"contract_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"job_id" uuid,
	"receipt_id" uuid,
	"receipt_recorded_at" timestamp with time zone,
	"receipt_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilot_operation_receipt_id_unique" UNIQUE("receipt_id"),
	CONSTRAINT "pilot_operation_state_check" CHECK ("app"."pilot_operation"."state" in ('queued', 'completed')),
	CONSTRAINT "pilot_operation_digest_check" CHECK ("app"."pilot_operation"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pilot_operation_receipt_check" CHECK (("app"."pilot_operation"."state" = 'completed') = ("app"."pilot_operation"."receipt_id" is not null and "app"."pilot_operation"."receipt_recorded_at" is not null and "app"."pilot_operation"."receipt_job_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."pilot_receipt_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"job_retry_count" integer NOT NULL,
	"worker_boot_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilot_receipt_attempt_outcome_check" CHECK ("app"."pilot_receipt_attempt"."outcome" in ('recorded', 'existing'))
);
--> statement-breakpoint
CREATE TABLE "worker"."heartbeat" (
	"boot_id" uuid PRIMARY KEY NOT NULL,
	"build_revision" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pilot_operation" ADD CONSTRAINT "pilot_operation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pilot_operation" ADD CONSTRAINT "pilot_operation_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pilot_receipt_attempt" ADD CONSTRAINT "pilot_receipt_attempt_operation_id_pilot_operation_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "app"."pilot_operation"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "membership_user_id_idx" ON "app"."membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pilot_operation_organization_id_idx" ON "app"."pilot_operation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "pilot_receipt_attempt_operation_id_idx" ON "app"."pilot_receipt_attempt" USING btree ("operation_id");