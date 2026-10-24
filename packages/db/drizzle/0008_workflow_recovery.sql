ALTER TABLE "app"."case_decision" DROP CONSTRAINT "case_decision_status_check";--> statement-breakpoint
ALTER TABLE "app"."case_action" ADD COLUMN "request_digest" text;--> statement-breakpoint
ALTER TABLE "app"."case_action" ADD COLUMN "attempt_key" text;--> statement-breakpoint
ALTER TABLE "app"."case_action" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."case_action" ADD CONSTRAINT "case_action_request_digest_check" CHECK ("app"."case_action"."request_digest" is null or "app"."case_action"."request_digest" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "app"."case_decision" ADD CONSTRAINT "case_decision_status_check" CHECK ("app"."case_decision"."status" in ('current', 'stale', 'expired', 'superseded', 'revoked', 'void'));