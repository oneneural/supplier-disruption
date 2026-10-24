-- A new reservation starts reserved, with no settled cost or resolution
-- (ADR 0017), whoever inserts it.
CREATE FUNCTION "app"."model_spend_reservation_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.status <> 'reserved' OR NEW.settled_micro_usd IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
		RAISE EXCEPTION 'model spend reservation % must start reserved and unsettled', NEW.key USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "model_spend_reservation_insert_guard" BEFORE INSERT ON "app"."model_spend_reservation"
	FOR EACH ROW EXECUTE FUNCTION "app"."model_spend_reservation_insert_guard"();
--> statement-breakpoint
-- As in 0009, plus: unknown usage is settled only by the table owner, the
-- operator's migrator role reconciling with evidence, never by a runtime role.
CREATE OR REPLACE FUNCTION "app"."model_spend_reservation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
	IF OLD.status = 'uncertain' AND NEW.status = 'settled'
		AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID), 'MEMBER') THEN
		RAISE EXCEPTION 'only the operator settles uncertain model spend reservation %', OLD.key USING ERRCODE = '42501';
	END IF;
	RETURN NEW;
END
$$;
