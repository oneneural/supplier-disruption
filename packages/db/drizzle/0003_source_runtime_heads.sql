CREATE TABLE "fixture_purchasing"."operation" (
	"organization" text NOT NULL,
	"operation_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_digest" text NOT NULL,
	CONSTRAINT "operation_organization_operation_id_pk" PRIMARY KEY("organization","operation_id"),
	CONSTRAINT "operation_kind_check" CHECK ("fixture_purchasing"."operation"."kind" in ('amend_schedule')),
	CONSTRAINT "operation_digest_check" CHECK ("fixture_purchasing"."operation"."request_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "fixture_purchasing"."operation_receipt" (
	"receipt_id" uuid PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"operation_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"action_id" text NOT NULL,
	"po_number" text NOT NULL,
	"line_number" text NOT NULL,
	"prior_revision" integer NOT NULL,
	"successor_revision" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operation_receipt_operation_unique" UNIQUE("organization","operation_id"),
	CONSTRAINT "operation_receipt_successor_check" CHECK ("fixture_purchasing"."operation_receipt"."successor_revision" = "fixture_purchasing"."operation_receipt"."prior_revision" + 1)
);
--> statement-breakpoint
CREATE TABLE "fixture_purchasing"."po_head" (
	"po_number" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"revision" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixture_inventory"."operation" (
	"organization" text NOT NULL,
	"operation_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_digest" text NOT NULL,
	CONSTRAINT "operation_organization_operation_id_pk" PRIMARY KEY("organization","operation_id"),
	CONSTRAINT "operation_kind_check" CHECK ("fixture_inventory"."operation"."kind" in ('reserve', 'create_transfer_request')),
	CONSTRAINT "operation_digest_check" CHECK ("fixture_inventory"."operation"."request_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "fixture_inventory"."operation_receipt" (
	"receipt_id" uuid PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"operation_id" text NOT NULL,
	"kind" text NOT NULL,
	"plan_id" text NOT NULL,
	"action_id" text NOT NULL,
	"sku" text NOT NULL,
	"warehouse" text NOT NULL,
	"prior_version" text NOT NULL,
	"successor_version" text,
	"reservation_id" text NOT NULL,
	"quantity" numeric(18, 0) NOT NULL,
	"transfer_request_id" text,
	"request_version" integer,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operation_receipt_successor_version_unique" UNIQUE("successor_version"),
	CONSTRAINT "operation_receipt_transfer_request_id_unique" UNIQUE("transfer_request_id"),
	CONSTRAINT "operation_receipt_operation_unique" UNIQUE("organization","operation_id"),
	CONSTRAINT "operation_receipt_kind_check" CHECK (("fixture_inventory"."operation_receipt"."kind" = 'reserve' and "fixture_inventory"."operation_receipt"."successor_version" is not null
            and "fixture_inventory"."operation_receipt"."transfer_request_id" is null and "fixture_inventory"."operation_receipt"."request_version" is null)
       or ("fixture_inventory"."operation_receipt"."kind" = 'create_transfer_request' and "fixture_inventory"."operation_receipt"."successor_version" is null
            and "fixture_inventory"."operation_receipt"."transfer_request_id" is not null and "fixture_inventory"."operation_receipt"."request_version" is not null)),
	CONSTRAINT "operation_receipt_quantity_check" CHECK ("fixture_inventory"."operation_receipt"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "fixture_inventory"."stock_head" (
	"organization" text NOT NULL,
	"sku" text NOT NULL,
	"warehouse" text NOT NULL,
	"version" text NOT NULL,
	CONSTRAINT "stock_head_organization_sku_warehouse_pk" PRIMARY KEY("organization","sku","warehouse"),
	CONSTRAINT "stock_head_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "fixture_inventory"."transfer_request" (
	"request_id" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"option_id" text NOT NULL,
	"sku" text NOT NULL,
	"uom" text NOT NULL,
	"from_warehouse" text NOT NULL,
	"to_warehouse" text NOT NULL,
	"quantity" numeric(18, 0) NOT NULL,
	"dispatch_date" date NOT NULL,
	"arrival_date" date NOT NULL,
	"stock_version" text NOT NULL,
	"reservation_id" text NOT NULL,
	"plan_id" text NOT NULL,
	CONSTRAINT "transfer_request_reservation_unique" UNIQUE("organization","sku","from_warehouse","reservation_id"),
	CONSTRAINT "transfer_request_version_check" CHECK ("fixture_inventory"."transfer_request"."version" >= 1),
	CONSTRAINT "transfer_request_status_check" CHECK ("fixture_inventory"."transfer_request"."status" in ('requested')),
	CONSTRAINT "transfer_request_quantity_check" CHECK ("fixture_inventory"."transfer_request"."quantity" > 0),
	CONSTRAINT "transfer_request_dates_check" CHECK ("fixture_inventory"."transfer_request"."dispatch_date" <= "fixture_inventory"."transfer_request"."arrival_date"),
	CONSTRAINT "transfer_request_warehouses_check" CHECK ("fixture_inventory"."transfer_request"."from_warehouse" <> "fixture_inventory"."transfer_request"."to_warehouse")
);
--> statement-breakpoint
CREATE TABLE "fixture_demand"."demand_head" (
	"organization" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	CONSTRAINT "demand_head_version_unique" UNIQUE("version")
);
--> statement-breakpoint
ALTER TABLE "fixture_purchasing"."operation_receipt" ADD CONSTRAINT "operation_receipt_operation_fk" FOREIGN KEY ("organization","operation_id") REFERENCES "fixture_purchasing"."operation"("organization","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_purchasing"."operation_receipt" ADD CONSTRAINT "operation_receipt_successor_fk" FOREIGN KEY ("po_number","successor_revision","line_number") REFERENCES "fixture_purchasing"."po_line"("po_number","revision","line_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_purchasing"."po_head" ADD CONSTRAINT "po_head_po_revision_fk" FOREIGN KEY ("po_number","revision") REFERENCES "fixture_purchasing"."po_revision"("po_number","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."operation_receipt" ADD CONSTRAINT "operation_receipt_prior_version_stock_snapshot_version_fk" FOREIGN KEY ("prior_version") REFERENCES "fixture_inventory"."stock_snapshot"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."operation_receipt" ADD CONSTRAINT "operation_receipt_successor_version_stock_snapshot_version_fk" FOREIGN KEY ("successor_version") REFERENCES "fixture_inventory"."stock_snapshot"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."operation_receipt" ADD CONSTRAINT "operation_receipt_transfer_request_id_transfer_request_request_id_fk" FOREIGN KEY ("transfer_request_id") REFERENCES "fixture_inventory"."transfer_request"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."operation_receipt" ADD CONSTRAINT "operation_receipt_operation_fk" FOREIGN KEY ("organization","operation_id") REFERENCES "fixture_inventory"."operation"("organization","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."stock_head" ADD CONSTRAINT "stock_head_version_stock_snapshot_version_fk" FOREIGN KEY ("version") REFERENCES "fixture_inventory"."stock_snapshot"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."transfer_request" ADD CONSTRAINT "transfer_request_option_id_transfer_option_option_id_fk" FOREIGN KEY ("option_id") REFERENCES "fixture_inventory"."transfer_option"("option_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_inventory"."transfer_request" ADD CONSTRAINT "transfer_request_reservation_fk" FOREIGN KEY ("stock_version","reservation_id") REFERENCES "fixture_inventory"."reservation"("snapshot_version","reservation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_demand"."demand_head" ADD CONSTRAINT "demand_head_version_demand_snapshot_version_fk" FOREIGN KEY ("version") REFERENCES "fixture_demand"."demand_snapshot"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Current heads for inputs seeded before this migration, by the same rule as
-- the owner initializers (ADR 0005): a PO's highest integer revision, and the
-- only stock or demand snapshot of its SKU and warehouse or organization.
-- Opaque version labels have no order, so several snapshots stop the migration
-- rather than guess. Source rows, the clock and the seed marker are untouched.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "fixture_inventory"."stock_snapshot"
              GROUP BY "organization", "sku", "warehouse" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'several stock snapshots for one SKU and warehouse; state the current version explicitly';
  END IF;
  IF EXISTS (SELECT 1 FROM "fixture_demand"."demand_snapshot"
              GROUP BY "organization" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'several demand snapshots for one organization; state the current version explicitly';
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "fixture_purchasing"."po_head" ("po_number", "organization", "revision")
SELECT DISTINCT ON ("po_number") "po_number", "organization", "revision"
  FROM "fixture_purchasing"."po_revision"
 ORDER BY "po_number", "revision" DESC;
--> statement-breakpoint
INSERT INTO "fixture_inventory"."stock_head" ("organization", "sku", "warehouse", "version")
SELECT "organization", "sku", "warehouse", "version" FROM "fixture_inventory"."stock_snapshot";
--> statement-breakpoint
INSERT INTO "fixture_demand"."demand_head" ("organization", "version")
SELECT "organization", "version" FROM "fixture_demand"."demand_snapshot";
