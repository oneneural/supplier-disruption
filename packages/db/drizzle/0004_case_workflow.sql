CREATE TABLE "app"."case_action" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"plan_row_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"operation_id" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"command" jsonb,
	"receipt" jsonb,
	"readback" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "case_action_plan_action_unique" UNIQUE("plan_row_id","action_id"),
	CONSTRAINT "case_action_operation_unique" UNIQUE("operation_id"),
	CONSTRAINT "case_action_state_check" CHECK ("app"."case_action"."state" in ('planned', 'authorized', 'pending', 'confirmed', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "app"."case_actor" (
	"organization_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"role" text NOT NULL,
	"vendor_id" text,
	"user_id" text NOT NULL,
	"simulated" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "case_actor_organization_id_actor_id_pk" PRIMARY KEY("organization_id","actor_id"),
	CONSTRAINT "case_actor_role_check" CHECK ("app"."case_actor"."role" in ('buyer', 'procurement_manager', 'warehouse_planner', 'customer_service_owner', 'supplier_contact')),
	CONSTRAINT "case_actor_vendor_check" CHECK (("app"."case_actor"."role" = 'supplier_contact') = ("app"."case_actor"."vendor_id" is not null)),
	CONSTRAINT "case_actor_simulated_check" CHECK ("app"."case_actor"."simulated")
);
--> statement-breakpoint
CREATE TABLE "app"."case_assessment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"intake" jsonb NOT NULL,
	"assessment" jsonb,
	"assessed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "case_assessment_sequence_unique" UNIQUE("case_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "app"."case_decision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"plan_row_id" uuid,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"role" text NOT NULL,
	"user_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"binding" jsonb NOT NULL,
	"submitted" jsonb NOT NULL,
	"simulated" boolean NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text,
	CONSTRAINT "case_decision_kind_check" CHECK ("app"."case_decision"."kind" in ('approval', 'rejection', 'supplier_acknowledgement', 'warehouse_planner_confirmation', 'escalation')),
	CONSTRAINT "case_decision_outcome_check" CHECK ("app"."case_decision"."outcome" in ('accepted', 'rejected', 'non_matching')),
	CONSTRAINT "case_decision_status_check" CHECK ("app"."case_decision"."status" in ('current', 'stale', 'expired', 'superseded', 'void'))
);
--> statement-breakpoint
CREATE TABLE "app"."case_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"reason" text,
	"owner" text,
	"actor_id" text,
	"detail" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "case_event_sequence_unique" UNIQUE("case_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "app"."case_plan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"plan_id" text NOT NULL,
	"plan_version" integer NOT NULL,
	"sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "case_plan_version_unique" UNIQUE("case_id","plan_version"),
	CONSTRAINT "case_plan_sha256_check" CHECK ("app"."case_plan"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app"."supplier_case" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_number" integer NOT NULL,
	"source_system" text NOT NULL,
	"message_id" text NOT NULL,
	"input_version" integer NOT NULL,
	"proposal_id" text,
	"vendor_id" text,
	"content_sha256" text,
	"intake_receipt" jsonb,
	"state" text NOT NULL,
	"reason" text,
	"owner" text,
	"next_action" text NOT NULL,
	"current_plan_id" uuid,
	"plan_version" integer DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "supplier_case_message_unique" UNIQUE("organization_id","source_system","message_id"),
	CONSTRAINT "supplier_case_number_unique" UNIQUE("organization_id","case_number"),
	CONSTRAINT "supplier_case_state_check" CHECK ("app"."supplier_case"."state" in ('received', 'needs_clarification', 'assessing', 'awaiting_approval', 'awaiting_acknowledgement', 'applying', 'partially_applied', 'verifying', 'plan_verified', 'escalated', 'superseded')),
	CONSTRAINT "supplier_case_owner_check" CHECK ("app"."supplier_case"."owner" is null or "app"."supplier_case"."owner" in ('buyer', 'procurement_manager', 'warehouse_planner', 'customer_service_owner', 'supplier_contact'))
);
--> statement-breakpoint
CREATE TABLE "app"."supplier_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"message_id" text NOT NULL,
	"input_version" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"content_sha256" text NOT NULL,
	"disposition" text NOT NULL,
	"reason" text,
	"case_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "supplier_message_delivery_unique" UNIQUE("organization_id","delivery_id"),
	CONSTRAINT "supplier_message_digest_check" CHECK ("app"."supplier_message"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "supplier_message_disposition_check" CHECK ("app"."supplier_message"."disposition" in ('accept', 'duplicate', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "app"."case_action" ADD CONSTRAINT "case_action_case_id_supplier_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_action" ADD CONSTRAINT "case_action_plan_row_id_case_plan_id_fk" FOREIGN KEY ("plan_row_id") REFERENCES "app"."case_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_actor" ADD CONSTRAINT "case_actor_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_actor" ADD CONSTRAINT "case_actor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_assessment" ADD CONSTRAINT "case_assessment_case_id_supplier_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_decision" ADD CONSTRAINT "case_decision_case_id_supplier_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_decision" ADD CONSTRAINT "case_decision_plan_row_id_case_plan_id_fk" FOREIGN KEY ("plan_row_id") REFERENCES "app"."case_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_event" ADD CONSTRAINT "case_event_case_id_supplier_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_plan" ADD CONSTRAINT "case_plan_case_id_supplier_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."case_plan" ADD CONSTRAINT "case_plan_assessment_id_case_assessment_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "app"."case_assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_case" ADD CONSTRAINT "supplier_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_message" ADD CONSTRAINT "supplier_message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_message" ADD CONSTRAINT "supplier_message_case_id_supplier_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_actor_user_id_idx" ON "app"."case_actor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "case_decision_case_id_idx" ON "app"."case_decision" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "supplier_message_case_id_idx" ON "app"."supplier_message" USING btree ("case_id");