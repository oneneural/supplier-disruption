import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appSchema, organization } from "./app.js";
import { user } from "./auth.js";

/**
 * Durable case workflow records (ADR 0009). These are application
 * coordination records owned by the API; source effects live only in the
 * fixture authorities. Business times come from the injected clock.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const businessTime = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

const ACTOR_ROLES = sql.raw(
  "('buyer', 'procurement_manager', 'warehouse_planner', 'customer_service_owner', 'supplier_contact')",
);
const CASE_STATES = sql.raw(
  "('received', 'needs_clarification', 'assessing', 'awaiting_approval', 'awaiting_acknowledgement', 'applying', 'partially_applied', 'verifying', 'plan_verified', 'escalated', 'superseded')",
);

/**
 * Simulated actors an authenticated user may act as. This is the trusted
 * membership a role decision is checked against; the request only names the
 * actor. Clearing `active` withdraws the authority.
 */
export const caseActor = appSchema.table(
  "case_actor",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    actorId: text("actor_id").notNull(),
    role: text("role").notNull(),
    /** The vendor a supplier contact speaks for; null for internal roles. */
    vendorId: text("vendor_id"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    simulated: boolean("simulated").notNull().default(true),
    active: boolean("active").notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.actorId] }),
    index("case_actor_user_id_idx").on(table.userId),
    check("case_actor_role_check", sql`${table.role} in ${ACTOR_ROLES}`),
    check(
      "case_actor_vendor_check",
      sql`(${table.role} = 'supplier_contact') = (${table.vendorId} is not null)`,
    ),
    check("case_actor_simulated_check", sql`${table.simulated}`),
  ],
);

/**
 * One case per supplier message key. The retained intake receipt makes a
 * later delivery of the same message a duplicate.
 */
export const supplierCase = appSchema.table(
  "supplier_case",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    /** Per-organization sequence: the case is `CASE-<n>` and its plan `PLAN-<n>`. */
    caseNumber: integer("case_number").notNull(),
    sourceSystem: text("source_system").notNull(),
    messageId: text("message_id").notNull(),
    inputVersion: integer("input_version").notNull(),
    proposalId: text("proposal_id"),
    vendorId: text("vendor_id"),
    /** The accepted input's terms digest; null unless intake accepted it. */
    contentSha256: text("content_sha256"),
    intakeReceipt: jsonb("intake_receipt"),
    state: text("state").notNull(),
    reason: text("reason"),
    owner: text("owner"),
    nextAction: text("next_action").notNull(),
    currentPlanId: uuid("current_plan_id"),
    /**
     * A later supplier revision of a verified case opens a successor case
     * linked both ways; the predecessor becomes `superseded` and keeps its
     * plan, decisions, actions and effects (ADR 0015).
     */
    predecessorCaseId: uuid("predecessor_case_id"),
    successorCaseId: uuid("successor_case_id"),
    /**
     * Until when the last matching read-back supports `plan_verified`; null
     * once a recheck no longer matches. Past it the case stays recorded as
     * verified, but nothing currently confirms it (VERIFY-1@1, ADR 0015).
     */
    verifiedUntil: businessTime("verified_until"),
    planVersion: integer("plan_version").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
    openedAt: businessTime("opened_at").notNull(),
    updatedAt: businessTime("updated_at").notNull(),
  },
  (table) => [
    unique("supplier_case_message_unique").on(
      table.organizationId,
      table.sourceSystem,
      table.messageId,
    ),
    unique("supplier_case_number_unique").on(table.organizationId, table.caseNumber),
    unique("supplier_case_predecessor_unique").on(table.predecessorCaseId),
    unique("supplier_case_successor_unique").on(table.successorCaseId),
    foreignKey({
      name: "supplier_case_predecessor_fk",
      columns: [table.predecessorCaseId],
      foreignColumns: [table.id],
    }),
    foreignKey({
      name: "supplier_case_successor_fk",
      columns: [table.successorCaseId],
      foreignColumns: [table.id],
    }),
    check("supplier_case_state_check", sql`${table.state} in ${CASE_STATES}`),
    check(
      "supplier_case_owner_check",
      sql`${table.owner} is null or ${table.owner} in ${ACTOR_ROLES}`,
    ),
  ],
);

/** Every delivery of a supplier message, with its exact bytes. Append-only. */
export const supplierMessage = appSchema.table(
  "supplier_message",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    deliveryId: uuid("delivery_id").notNull(),
    sourceSystem: text("source_system").notNull(),
    messageId: text("message_id").notNull(),
    inputVersion: integer("input_version").notNull(),
    /**
     * The delivered message as received: UTF-8 canonical JSON of identity,
     * proposal and text, or of a supplier email. An email is stored with
     * disposition `evidence`; intake decides on the structured input derived
     * from it, recorded as its own delivery (ADR 0011). A supplier reply to a
     * question is stored with disposition `reply` (ADR 0014).
     */
    content: bytea("content").notNull(),
    /** SHA-256 of `content` exactly. */
    contentSha256: text("content_sha256").notNull(),
    disposition: text("disposition").notNull(),
    reason: text("reason"),
    caseId: uuid("case_id").references(() => supplierCase.id),
    receivedAt: businessTime("received_at").notNull(),
  },
  (table) => [
    unique("supplier_message_delivery_unique").on(table.organizationId, table.deliveryId),
    index("supplier_message_case_id_idx").on(table.caseId),
    check("supplier_message_digest_check", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "supplier_message_disposition_check",
      sql`${table.disposition} in ('accept', 'duplicate', 'blocked', 'evidence', 'reply')`,
    ),
  ],
);

/** Append-only case history: state transitions, decisions, attempts and read-backs. */
export const caseEvent = appSchema.table(
  "case_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supplierCase.id),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    reason: text("reason"),
    owner: text("owner"),
    actorId: text("actor_id"),
    detail: jsonb("detail").notNull(),
    occurredAt: businessTime("occurred_at").notNull(),
  },
  (table) => [unique("case_event_sequence_unique").on(table.caseId, table.sequence)],
);

/** One intake and assessment run of a case. Append-only. */
export const caseAssessment = appSchema.table(
  "case_assessment",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supplierCase.id),
    /** Per-case run order; business times can be equal under a controlled clock. */
    sequence: integer("sequence").notNull(),
    intake: jsonb("intake").notNull(),
    assessment: jsonb("assessment"),
    assessedAt: businessTime("assessed_at").notNull(),
  },
  (table) => [unique("case_assessment_sequence_unique").on(table.caseId, table.sequence)],
);

/** An immutable proposed plan and the SHA-256 of its canonical payload. */
export const casePlan = appSchema.table(
  "case_plan",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supplierCase.id),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => caseAssessment.id),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    sha256: text("sha256").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: businessTime("created_at").notNull(),
  },
  (table) => [
    unique("case_plan_version_unique").on(table.caseId, table.planVersion),
    check("case_plan_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A role decision or simulated acknowledgement bound to one plan. Only
 * `status` and the invalidation columns change after insert, when a later
 * check makes an accepted decision stale, expired or superseded, or an
 * explicit revocation (ADR 0016) revokes an approval.
 */
export const caseDecision = appSchema.table(
  "case_decision",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supplierCase.id),
    planRowId: uuid("plan_row_id").references(() => casePlan.id),
    kind: text("kind").notNull(),
    actorId: text("actor_id").notNull(),
    role: text("role").notNull(),
    userId: text("user_id").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    status: text("status").notNull(),
    binding: jsonb("binding").notNull(),
    submitted: jsonb("submitted").notNull(),
    simulated: boolean("simulated").notNull(),
    occurredAt: businessTime("occurred_at").notNull(),
    invalidatedAt: businessTime("invalidated_at"),
    invalidatedReason: text("invalidated_reason"),
  },
  (table) => [
    index("case_decision_case_id_idx").on(table.caseId),
    check(
      "case_decision_kind_check",
      sql`${table.kind} in ('approval', 'rejection', 'supplier_acknowledgement', 'warehouse_planner_confirmation', 'escalation')`,
    ),
    check(
      "case_decision_outcome_check",
      sql`${table.outcome} in ('accepted', 'rejected', 'non_matching')`,
    ),
    check(
      "case_decision_status_check",
      sql`${table.status} in ('current', 'stale', 'expired', 'superseded', 'revoked', 'void')`,
    ),
  ],
);

/**
 * The action journal: one row per plan action with a stable operation ID.
 * State moves through planned, authorized, pending, confirmed, failed or
 * unknown; attempts and read-backs are also recorded as case events. The
 * first claim fixes the source command and its SHA-256, which every later
 * attempt reuses unchanged; `attempt_key` names the latest attempt and
 * `reconcile_attempts` counts read-backs that could not prove an outcome
 * (ADR 0016).
 */
export const caseAction = appSchema.table(
  "case_action",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supplierCase.id),
    planRowId: uuid("plan_row_id")
      .notNull()
      .references(() => casePlan.id),
    actionId: text("action_id").notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    operationId: text("operation_id").notNull(),
    state: text("state").notNull(),
    reason: text("reason"),
    command: jsonb("command"),
    receipt: jsonb("receipt"),
    readback: jsonb("readback"),
    attempts: integer("attempts").notNull().default(0),
    requestDigest: text("request_digest"),
    attemptKey: text("attempt_key"),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    updatedAt: businessTime("updated_at").notNull(),
  },
  (table) => [
    unique("case_action_plan_action_unique").on(table.planRowId, table.actionId),
    check(
      "case_action_request_digest_check",
      sql`${table.requestDigest} is null or ${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    unique("case_action_operation_unique").on(table.operationId),
    check(
      "case_action_state_check",
      sql`${table.state} in ('planned', 'authorized', 'pending', 'confirmed', 'failed', 'unknown')`,
    ),
  ],
);

/**
 * A question to the supplier (ADR 0014). The draft is local: `sent` admits
 * only false, so no row can claim a transmitted message. Only `status`, the
 * reply link and the closing columns change after insert.
 */
export const caseClarification = appSchema.table(
  "case_clarification",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supplierCase.id),
    /** Per-case order: the question is `Q-<n>`. */
    sequence: integer("sequence").notNull(),
    status: text("status").notNull(),
    fields: jsonb("fields").notNull(),
    question: text("question").notNull(),
    draft: jsonb("draft").notNull(),
    sent: boolean("sent").notNull().default(false),
    /** The case assessment sequence the question was asked against. */
    basisAssessment: integer("basis_assessment").notNull(),
    planVersion: integer("plan_version").notNull(),
    actorId: text("actor_id").notNull(),
    userId: text("user_id").notNull(),
    requestedAt: businessTime("requested_at").notNull(),
    replyMessageId: uuid("reply_message_id").references(() => supplierMessage.id),
    closedAt: businessTime("closed_at"),
    closedReason: text("closed_reason"),
  },
  (table) => [
    unique("case_clarification_sequence_unique").on(table.caseId, table.sequence),
    check(
      "case_clarification_status_check",
      sql`${table.status} in ('awaiting_reply', 'answered', 'superseded')`,
    ),
    check("case_clarification_not_sent_check", sql`not ${table.sent}`),
  ],
);

/**
 * A proposed field correction (ADR 0014): who proposed it against which
 * basis, the terms before and after, the cited evidence locators and what
 * intake made of it. Append-only; a correction never edits evidence.
 */
export const caseCorrection = appSchema.table(
  "case_correction",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supplierCase.id),
    /** Per-case order: the correction is `COR-<n>`. */
    sequence: integer("sequence").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    diagnostics: jsonb("diagnostics").notNull(),
    actorId: text("actor_id").notNull(),
    userId: text("user_id").notNull(),
    basisAssessment: integer("basis_assessment").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    changes: jsonb("changes").notNull(),
    locators: jsonb("locators").notNull(),
    /** The corrected supplier input's key, when intake decided on one. */
    input: jsonb("input"),
    assessmentId: uuid("assessment_id").references(() => caseAssessment.id),
    planVersion: integer("plan_version"),
    note: text("note"),
    occurredAt: businessTime("occurred_at").notNull(),
  },
  (table) => [
    unique("case_correction_sequence_unique").on(table.caseId, table.sequence),
    check(
      "case_correction_status_check",
      sql`${table.status} in ('rejected', 'blocked', 'accepted')`,
    ),
  ],
);
