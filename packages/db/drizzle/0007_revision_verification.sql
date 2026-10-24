CREATE TABLE "fixture_inventory"."transfer_observation" (
	"observation_id" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" numeric(18, 0) NOT NULL,
	"observed_on" date NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "transfer_observation_kind_unique" UNIQUE("request_id","kind"),
	CONSTRAINT "transfer_observation_kind_check" CHECK ("fixture_inventory"."transfer_observation"."kind" in ('dispatched', 'received')),
	CONSTRAINT "transfer_observation_quantity_check" CHECK ("fixture_inventory"."transfer_observation"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."supplier_case" ADD COLUMN "predecessor_case_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."supplier_case" ADD COLUMN "successor_case_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."supplier_case" ADD COLUMN "verified_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."transfer_observation" ADD CONSTRAINT "transfer_observation_request_id_transfer_request_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "fixture_inventory"."transfer_request"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_case" ADD CONSTRAINT "supplier_case_predecessor_fk" FOREIGN KEY ("predecessor_case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_case" ADD CONSTRAINT "supplier_case_successor_fk" FOREIGN KEY ("successor_case_id") REFERENCES "app"."supplier_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_case" ADD CONSTRAINT "supplier_case_predecessor_unique" UNIQUE("predecessor_case_id");--> statement-breakpoint
ALTER TABLE "app"."supplier_case" ADD CONSTRAINT "supplier_case_successor_unique" UNIQUE("successor_case_id");