CREATE SCHEMA "fixture_purchasing";
--> statement-breakpoint
CREATE SCHEMA "fixture_inventory";
--> statement-breakpoint
CREATE SCHEMA "fixture_demand";
--> statement-breakpoint
CREATE SCHEMA "fixture_reference";
--> statement-breakpoint
CREATE TABLE "fixture_purchasing"."po_line" (
	"po_number" text NOT NULL,
	"revision" integer NOT NULL,
	"line_number" text NOT NULL,
	"sku" text NOT NULL,
	"uom" text NOT NULL,
	"destination" text NOT NULL,
	"ordered" numeric(18, 0) NOT NULL,
	"received" numeric(18, 0) NOT NULL,
	"canceled" numeric(18, 0) NOT NULL,
	CONSTRAINT "po_line_po_number_revision_line_number_pk" PRIMARY KEY("po_number","revision","line_number"),
	CONSTRAINT "po_line_quantities_check" CHECK ("fixture_purchasing"."po_line"."ordered" >= 0 and "fixture_purchasing"."po_line"."received" >= 0 and "fixture_purchasing"."po_line"."canceled" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fixture_purchasing"."po_line_segment" (
	"po_number" text NOT NULL,
	"revision" integer NOT NULL,
	"line_number" text NOT NULL,
	"sequence" integer NOT NULL,
	"quantity" numeric(18, 0) NOT NULL,
	"arrival_date" date,
	CONSTRAINT "po_line_segment_po_number_revision_line_number_sequence_pk" PRIMARY KEY("po_number","revision","line_number","sequence"),
	CONSTRAINT "po_line_segment_quantity_check" CHECK ("fixture_purchasing"."po_line_segment"."quantity" > 0),
	CONSTRAINT "po_line_segment_sequence_check" CHECK ("fixture_purchasing"."po_line_segment"."sequence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "fixture_purchasing"."po_revision" (
	"po_number" text NOT NULL,
	"revision" integer NOT NULL,
	"organization" text NOT NULL,
	"vendor_id" text NOT NULL,
	"observed_at" timestamp with time zone,
	"effective_date" date,
	CONSTRAINT "po_revision_po_number_revision_pk" PRIMARY KEY("po_number","revision"),
	CONSTRAINT "po_revision_revision_check" CHECK ("fixture_purchasing"."po_revision"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "fixture_inventory"."in_transit" (
	"transit_id" text PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"uom" text NOT NULL,
	"from_warehouse" text NOT NULL,
	"to_warehouse" text NOT NULL,
	"quantity" numeric(18, 0) NOT NULL,
	"dispatched_on" date,
	"arrival_date" date,
	CONSTRAINT "in_transit_quantity_check" CHECK ("fixture_inventory"."in_transit"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "fixture_inventory"."reservation" (
	"snapshot_version" text NOT NULL,
	"reservation_id" text NOT NULL,
	"quantity" numeric(18, 0) NOT NULL,
	"plan_id" text,
	CONSTRAINT "reservation_snapshot_version_reservation_id_pk" PRIMARY KEY("snapshot_version","reservation_id"),
	CONSTRAINT "reservation_quantity_check" CHECK ("fixture_inventory"."reservation"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "fixture_inventory"."stock_snapshot" (
	"version" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"sku" text NOT NULL,
	"warehouse" text NOT NULL,
	"uom" text NOT NULL,
	"observed_at" timestamp with time zone,
	"physical" numeric(18, 0) NOT NULL,
	"quality_hold" numeric(18, 0) NOT NULL,
	"safety_stock" numeric(18, 0) NOT NULL,
	CONSTRAINT "stock_snapshot_quantities_check" CHECK ("fixture_inventory"."stock_snapshot"."physical" >= 0 and "fixture_inventory"."stock_snapshot"."quality_hold" >= 0 and "fixture_inventory"."stock_snapshot"."safety_stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fixture_inventory"."transfer_option" (
	"option_id" text PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"uom" text NOT NULL,
	"from_warehouse" text NOT NULL,
	"to_warehouse" text NOT NULL,
	"quantity" numeric(18, 0) NOT NULL,
	"dispatch_date" date NOT NULL,
	"arrival_date" date NOT NULL,
	"cost_minor_units" bigint NOT NULL,
	"currency" text NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"based_on" text NOT NULL,
	"owner_role" text NOT NULL,
	CONSTRAINT "transfer_option_quantity_check" CHECK ("fixture_inventory"."transfer_option"."quantity" > 0),
	CONSTRAINT "transfer_option_cost_check" CHECK ("fixture_inventory"."transfer_option"."cost_minor_units" >= 0 AND "fixture_inventory"."transfer_option"."cost_minor_units" <= 9007199254740991),
	CONSTRAINT "transfer_option_dates_check" CHECK ("fixture_inventory"."transfer_option"."dispatch_date" <= "fixture_inventory"."transfer_option"."arrival_date"),
	CONSTRAINT "transfer_option_currency_check" CHECK ("fixture_inventory"."transfer_option"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "transfer_option_warehouses_check" CHECK ("fixture_inventory"."transfer_option"."from_warehouse" <> "fixture_inventory"."transfer_option"."to_warehouse")
);
--> statement-breakpoint
CREATE TABLE "fixture_demand"."demand_line" (
	"version" text NOT NULL,
	"sales_order" text NOT NULL,
	"line" text NOT NULL,
	"sku" text NOT NULL,
	"uom" text NOT NULL,
	"open_quantity" numeric(18, 0) NOT NULL,
	"delivered_quantity" numeric(18, 0),
	"destination" text NOT NULL,
	"receipt_cutoff" date NOT NULL,
	"calendar_policy_id" text NOT NULL,
	"calendar_policy_version" integer NOT NULL,
	"priority" integer NOT NULL,
	CONSTRAINT "demand_line_version_sales_order_line_pk" PRIMARY KEY("version","sales_order","line"),
	CONSTRAINT "demand_line_quantities_check" CHECK ("fixture_demand"."demand_line"."open_quantity" >= 0 and ("fixture_demand"."demand_line"."delivered_quantity" is null or "fixture_demand"."demand_line"."delivered_quantity" >= 0)),
	CONSTRAINT "demand_line_priority_check" CHECK ("fixture_demand"."demand_line"."priority" >= 1)
);
--> statement-breakpoint
CREATE TABLE "fixture_demand"."demand_snapshot" (
	"version" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"observed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fixture_demand"."supply_link" (
	"version" text NOT NULL,
	"sales_order" text NOT NULL,
	"line" text NOT NULL,
	"po_number" text NOT NULL,
	"po_line" text NOT NULL,
	CONSTRAINT "supply_link_version_sales_order_line_po_number_po_line_pk" PRIMARY KEY("version","sales_order","line","po_number","po_line")
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."actor" (
	"actor_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"vendor_id" text,
	"simulated" boolean NOT NULL,
	CONSTRAINT "actor_role_check" CHECK ("fixture_reference"."actor"."role" in ('buyer', 'procurement_manager', 'warehouse_planner', 'customer_service_owner', 'supplier_contact')),
	CONSTRAINT "actor_vendor_check" CHECK (("fixture_reference"."actor"."role" = 'supplier_contact') = ("fixture_reference"."actor"."vendor_id" is not null)),
	CONSTRAINT "actor_simulated_check" CHECK ("fixture_reference"."actor"."simulated")
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."business_clock" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"instant" timestamp with time zone NOT NULL,
	CONSTRAINT "business_clock_single_row_check" CHECK ("fixture_reference"."business_clock"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."item" (
	"sku" text PRIMARY KEY NOT NULL,
	"stock_uom" text NOT NULL,
	"integral" boolean NOT NULL,
	CONSTRAINT "item_integral_check" CHECK ("fixture_reference"."item"."integral")
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."item_mapping" (
	"mapping_id" text NOT NULL,
	"version" integer NOT NULL,
	"vendor_id" text NOT NULL,
	"vendor_item" text NOT NULL,
	"source_uom" text NOT NULL,
	"sku" text NOT NULL,
	"stock_uom" text NOT NULL,
	"ratio_numerator" numeric(18, 0) NOT NULL,
	"ratio_denominator" numeric(18, 0) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_through" date,
	"provenance" text NOT NULL,
	CONSTRAINT "item_mapping_mapping_id_version_pk" PRIMARY KEY("mapping_id","version"),
	CONSTRAINT "item_mapping_ratio_check" CHECK ("fixture_reference"."item_mapping"."ratio_numerator" > 0 and "fixture_reference"."item_mapping"."ratio_denominator" > 0),
	CONSTRAINT "item_mapping_dates_check" CHECK ("fixture_reference"."item_mapping"."effective_through" is null or "fixture_reference"."item_mapping"."effective_through" >= "fixture_reference"."item_mapping"."effective_from"),
	CONSTRAINT "item_mapping_provenance_check" CHECK ("fixture_reference"."item_mapping"."provenance" in ('item_master'))
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."organization_alias" (
	"label" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "organization_alias_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."policy" (
	"policy_id" text NOT NULL,
	"version" integer NOT NULL,
	"parameters" jsonb NOT NULL,
	CONSTRAINT "policy_policy_id_version_pk" PRIMARY KEY("policy_id","version"),
	CONSTRAINT "policy_version_check" CHECK ("fixture_reference"."policy"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."scenario_timing" (
	"scenario" text NOT NULL,
	"name" text NOT NULL,
	"instant" timestamp with time zone NOT NULL,
	CONSTRAINT "scenario_timing_scenario_name_pk" PRIMARY KEY("scenario","name")
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."seed_marker" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"fixture_version" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"oracle_sha256" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seed_marker_single_row_check" CHECK ("fixture_reference"."seed_marker"."id" = 1),
	CONSTRAINT "seed_marker_digest_check" CHECK ("fixture_reference"."seed_marker"."manifest_sha256" ~ '^[0-9a-f]{64}$' and "fixture_reference"."seed_marker"."oracle_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."supplier_input" (
	"source_system" text NOT NULL,
	"message_id" text NOT NULL,
	"input_version" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"sender" text NOT NULL,
	"proposal_id" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"authored_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"content" jsonb NOT NULL,
	CONSTRAINT "supplier_input_source_system_message_id_input_version_pk" PRIMARY KEY("source_system","message_id","input_version"),
	CONSTRAINT "supplier_input_proposal_id_unique" UNIQUE("proposal_id"),
	CONSTRAINT "supplier_input_digest_check" CHECK ("fixture_reference"."supplier_input"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."vendor" (
	"vendor_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixture_reference"."vendor_contact" (
	"vendor_id" text NOT NULL,
	"address" text NOT NULL,
	"purpose" text NOT NULL,
	CONSTRAINT "vendor_contact_vendor_id_address_pk" PRIMARY KEY("vendor_id","address"),
	CONSTRAINT "vendor_contact_purpose_check" CHECK ("fixture_reference"."vendor_contact"."purpose" in ('registered_sender'))
);
--> statement-breakpoint
ALTER TABLE "fixture_purchasing"."po_line" ADD CONSTRAINT "po_line_po_revision_fk" FOREIGN KEY ("po_number","revision") REFERENCES "fixture_purchasing"."po_revision"("po_number","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_purchasing"."po_line_segment" ADD CONSTRAINT "po_line_segment_po_line_fk" FOREIGN KEY ("po_number","revision","line_number") REFERENCES "fixture_purchasing"."po_line"("po_number","revision","line_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."reservation" ADD CONSTRAINT "reservation_snapshot_version_stock_snapshot_version_fk" FOREIGN KEY ("snapshot_version") REFERENCES "fixture_inventory"."stock_snapshot"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."transfer_option" ADD CONSTRAINT "transfer_option_based_on_stock_snapshot_version_fk" FOREIGN KEY ("based_on") REFERENCES "fixture_inventory"."stock_snapshot"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_demand"."demand_line" ADD CONSTRAINT "demand_line_version_demand_snapshot_version_fk" FOREIGN KEY ("version") REFERENCES "fixture_demand"."demand_snapshot"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_demand"."supply_link" ADD CONSTRAINT "supply_link_demand_line_fk" FOREIGN KEY ("version","sales_order","line") REFERENCES "fixture_demand"."demand_line"("version","sales_order","line") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_reference"."actor" ADD CONSTRAINT "actor_vendor_id_vendor_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "fixture_reference"."vendor"("vendor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_reference"."item_mapping" ADD CONSTRAINT "item_mapping_vendor_id_vendor_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "fixture_reference"."vendor"("vendor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_reference"."item_mapping" ADD CONSTRAINT "item_mapping_sku_item_sku_fk" FOREIGN KEY ("sku") REFERENCES "fixture_reference"."item"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_reference"."vendor_contact" ADD CONSTRAINT "vendor_contact_vendor_id_vendor_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "fixture_reference"."vendor"("vendor_id") ON DELETE no action ON UPDATE no action;