CREATE TABLE "app"."model_spend_account" (
	"id" smallint PRIMARY KEY NOT NULL,
	"opening_micro_usd" bigint NOT NULL,
	"opening_evidence" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_spend_account_singleton_check" CHECK ("app"."model_spend_account"."id" = 1),
	CONSTRAINT "model_spend_account_opening_check" CHECK ("app"."model_spend_account"."opening_micro_usd" >= 0),
	CONSTRAINT "model_spend_account_evidence_check" CHECK (length("app"."model_spend_account"."opening_evidence") > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."model_spend_reservation" (
	"key" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"reference" text NOT NULL,
	"model" text NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"status" text NOT NULL,
	"settled_micro_usd" bigint,
	"usage" jsonb,
	"detail" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "model_spend_reservation_source_check" CHECK ("app"."model_spend_reservation"."source" in ('api', 'evaluation')),
	CONSTRAINT "model_spend_reservation_status_check" CHECK ("app"."model_spend_reservation"."status" in ('reserved', 'uncertain', 'settled')),
	CONSTRAINT "model_spend_reservation_amount_check" CHECK ("app"."model_spend_reservation"."reserved_micro_usd" > 0),
	CONSTRAINT "model_spend_reservation_settled_check" CHECK (("app"."model_spend_reservation"."status" = 'settled') = ("app"."model_spend_reservation"."settled_micro_usd" is not null) and coalesce("app"."model_spend_reservation"."settled_micro_usd", 0) >= 0)
);
--> statement-breakpoint
CREATE INDEX "model_spend_reservation_reference_idx" ON "app"."model_spend_reservation" USING btree ("reference");--> statement-breakpoint
-- A reservation's identity and amount never change, a settled reservation is
-- final and unknown usage never returns to an ordinary reservation (ADR 0017).
CREATE FUNCTION "app"."model_spend_reservation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status = 'settled' THEN
		RAISE EXCEPTION 'model spend reservation % is already settled', OLD.key USING ERRCODE = '23514';
	END IF;
	IF NEW.status = 'reserved' AND OLD.status <> 'reserved' THEN
		RAISE EXCEPTION 'model spend reservation % cannot return to reserved', OLD.key USING ERRCODE = '23514';
	END IF;
	IF NEW.key <> OLD.key OR NEW.source <> OLD.source OR NEW.reference <> OLD.reference
		OR NEW.model <> OLD.model OR NEW.reserved_micro_usd <> OLD.reserved_micro_usd
		OR NEW.reserved_at <> OLD.reserved_at THEN
		RAISE EXCEPTION 'model spend reservation % keeps its identity and amount', OLD.key USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "model_spend_reservation_guard" BEFORE UPDATE ON "app"."model_spend_reservation"
	FOR EACH ROW EXECUTE FUNCTION "app"."model_spend_reservation_guard"();
