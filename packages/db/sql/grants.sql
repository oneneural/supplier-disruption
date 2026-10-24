-- Runtime grants, applied by the migration command as the schema owner after
-- Drizzle and pg-boss migrations. Idempotent. {{api}} and {{worker}} are
-- replaced with validated role identifiers.
--
-- Status: observed, not verified least privilege. The pg-boss grants were
-- derived from pg-boss 12.38.0's SQL plans and the statements the pilot
-- exercises (producer send/getJobById, consumer fetch/complete/fail and
-- supervision with stats, warnings and instance registry disabled). The role
-- tests in packages/db/test exercise the G3 role boundaries described in ADR 0001.

-- Start from nothing so a rerun also removes drift. The command sends this
-- file as one statement batch, which PostgreSQL runs as one transaction.
REVOKE ALL ON SCHEMA auth, app, agent_checkpoint, worker, pgboss, drizzle FROM PUBLIC, {{api}}, {{worker}};
REVOKE ALL ON ALL TABLES IN SCHEMA auth, app, agent_checkpoint, worker, pgboss, drizzle FROM PUBLIC, {{api}}, {{worker}};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth, app, agent_checkpoint, worker, pgboss, drizzle FROM PUBLIC, {{api}}, {{worker}};
REVOKE ALL ON SCHEMA fixture_purchasing, fixture_inventory, fixture_demand, fixture_reference
  FROM PUBLIC, {{api}}, {{worker}};
REVOKE ALL ON ALL TABLES IN SCHEMA fixture_purchasing, fixture_inventory, fixture_demand, fixture_reference
  FROM PUBLIC, {{api}}, {{worker}};
-- pg-boss queue administration functions are for the migrator only.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC, {{api}}, {{worker}};

-- API: authentication and business records.
GRANT USAGE ON SCHEMA auth, app TO {{api}};
GRANT SELECT, INSERT, UPDATE, DELETE ON auth."user", auth.session, auth.account, auth.verification TO {{api}};
GRANT SELECT ON app.organization, app.membership TO {{api}};
GRANT SELECT, INSERT, UPDATE ON app.pilot_operation TO {{api}};
GRANT SELECT, INSERT ON app.pilot_receipt_attempt TO {{api}};
GRANT SELECT, INSERT ON app.pilot_handler_attempt TO {{api}};
-- Durable case workflow (ADR 0009). Messages, events, assessments, plans and
-- the journal's history are append-only; the API updates only the case's
-- current state, a decision's validity and an action's journal state.
-- Simulated actors are seeded by the migrator and only read by the API.
GRANT SELECT ON app.case_actor TO {{api}};
-- A claim locks the approver's actor row FOR SHARE (ADR 0013), which PostgreSQL
-- permits only with UPDATE on some column. The only such column is
-- `simulated`, whose check constraint admits nothing but true.
GRANT UPDATE (simulated) ON app.case_actor TO {{api}};
GRANT SELECT, INSERT, UPDATE ON app.supplier_case, app.case_decision, app.case_action TO {{api}};
GRANT SELECT, INSERT ON app.supplier_message, app.case_event, app.case_assessment, app.case_plan
  TO {{api}};
-- Clarification and correction (ADR 0014). Corrections are append-only; a
-- question changes only its status, reply link and closing columns, never its
-- text, draft or `sent`, which its check constraint holds false.
GRANT SELECT, INSERT ON app.case_correction TO {{api}};
GRANT SELECT, INSERT ON app.case_clarification TO {{api}};
GRANT UPDATE (status, reply_message_id, closed_at, closed_reason) ON app.case_clarification
  TO {{api}};
-- Extraction agent (ADR 0011): the run row carries status and totals, steps
-- are appended once. The LangGraph saver upserts and prunes its own
-- checkpoint rows; the API role never creates schema objects.
GRANT SELECT, INSERT, UPDATE ON app.agent_run TO {{api}};
GRANT SELECT, INSERT ON app.agent_step TO {{api}};
-- Project spend ledger (ADR 0017). The API reads the opening balance that
-- only the migrator writes, inserts reservations and moves them to uncertain
-- or settled; a trigger keeps identity and amount fixed and settled final.
-- Nothing is deleted. The evaluation runner admits with this role too.
GRANT SELECT ON app.model_spend_account TO {{api}};
GRANT SELECT, INSERT ON app.model_spend_reservation TO {{api}};
GRANT UPDATE (status, settled_micro_usd, usage, detail, resolved_at) ON app.model_spend_reservation
  TO {{api}};
GRANT USAGE ON SCHEMA agent_checkpoint TO {{api}};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agent_checkpoint TO {{api}};
-- Readiness: the API compares the recorded schema tag with its own build.
GRANT SELECT ON app.schema_tag TO {{api}};
-- Aggregate readiness reads the current-boot worker heartbeat. The API never
-- writes it, and the worker keeps no access to auth or business tables.
GRANT USAGE ON SCHEMA worker TO {{api}};
GRANT SELECT ON worker.heartbeat TO {{api}};

-- Fixture source authorities and reference data (ADRs 0004 and 0005): the API
-- reads the named source and reference tables, including the controlled
-- business clock row. Its purchasing and inventory source modules append
-- revisions, snapshots, reservations, requests, operations and receipts
-- (INSERT only) and move the current-version heads (UPDATE only). Demand and
-- reference stay read-only apart from the supplier-input append below, and
-- nothing is ever deleted. This is record
-- ownership, not isolation: the API role could bypass its own modules. The
-- worker has no access.
GRANT USAGE ON SCHEMA fixture_purchasing, fixture_inventory, fixture_demand, fixture_reference TO {{api}};
GRANT SELECT, INSERT ON fixture_purchasing.po_revision, fixture_purchasing.po_line,
  fixture_purchasing.po_line_segment, fixture_purchasing.operation,
  fixture_purchasing.operation_receipt TO {{api}};
GRANT SELECT, UPDATE ON fixture_purchasing.po_head TO {{api}};
GRANT SELECT, INSERT ON fixture_inventory.stock_snapshot, fixture_inventory.reservation,
  fixture_inventory.transfer_request, fixture_inventory.operation,
  fixture_inventory.operation_receipt TO {{api}};
GRANT SELECT, UPDATE ON fixture_inventory.stock_head TO {{api}};
GRANT SELECT ON fixture_inventory.transfer_option, fixture_inventory.in_transit TO {{api}};
-- Transfer observations (ADR 0015) are simulated warehouse events the API
-- reads as evidence and never writes.
GRANT SELECT ON fixture_inventory.transfer_observation TO {{api}};
GRANT SELECT ON fixture_demand.demand_snapshot, fixture_demand.demand_line,
  fixture_demand.supply_link, fixture_demand.demand_head TO {{api}};
GRANT SELECT ON fixture_reference.organization_alias, fixture_reference.vendor,
  fixture_reference.vendor_contact, fixture_reference.item, fixture_reference.item_mapping,
  fixture_reference.actor, fixture_reference.policy, fixture_reference.supplier_input,
  fixture_reference.scenario_timing, fixture_reference.business_clock TO {{api}};
-- Email intake (ADR 0011): after an extraction proposal passes validation, the
-- API records the derived structured input in the supplier-input store, as a
-- mail connector would, then runs intake on it. INSERT only: a stored input is
-- never changed or deleted, and no other reference table is writable.
GRANT INSERT ON fixture_reference.supplier_input TO {{api}};
-- The reference reads and the scoped transfer-option collection (ADR 0006)
-- need only the SELECT grants above; they add no privilege.
-- The seed marker is seed bookkeeping that no API code reads; the API gets no access.

-- Worker: its own heartbeat only. No auth or app access.
GRANT USAGE ON SCHEMA worker TO {{worker}};
GRANT SELECT, INSERT, UPDATE ON worker.heartbeat TO {{worker}};

-- pg-boss: queue producer (API) and consumer/supervisor (worker).
GRANT USAGE ON SCHEMA pgboss TO {{api}}, {{worker}};
GRANT EXECUTE ON FUNCTION pgboss.job_now() TO {{api}}, {{worker}};
GRANT SELECT ON pgboss.version, pgboss.queue TO {{api}};
GRANT SELECT, INSERT ON pgboss.job, pgboss.job_common TO {{api}};
GRANT SELECT, UPDATE ON pgboss.version, pgboss.queue TO {{worker}};
-- Claims and completion are updates. Failing a job (handler error or expiry)
-- deletes it and re-inserts it in the retry or failed state, so the worker
-- also needs INSERT; retention deletes old jobs.
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.job, pgboss.job_common TO {{worker}};
-- Maintenance cleanup deletes orphaned flow dependencies; BAM status is read only.
GRANT SELECT, DELETE ON pgboss.job_dependency TO {{worker}};
GRANT SELECT ON pgboss.bam TO {{worker}};
-- Supervision prunes the instance registry even when this instance does not
-- register. Its trim locks rows with FOR UPDATE SKIP LOCKED, which PostgreSQL
-- permits only with UPDATE privilege.
GRANT SELECT, UPDATE, DELETE ON pgboss.instance TO {{worker}};
