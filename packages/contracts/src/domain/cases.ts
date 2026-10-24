import { z } from "zod";
import {
  actorRoleSchema,
  businessDateSchema,
  labelSchema,
  positiveQuantitySchema,
  sha256Schema,
  versionNumberSchema,
} from "./primitives.js";
import { scheduleSegmentSchema } from "./sources.js";

/**
 * Durable case workflow contracts (ADR 0009): the case and action
 * states of the SPEC's "Workflow and state" table and the commands the API
 * accepts from an authenticated operator. Every role decision names the
 * simulated actor it is made as; the server resolves that actor's role from
 * its own trusted records, never from the request.
 */
export const CASE_CONTRACT_VERSION = "supplier-case.v1";

export const caseStateSchema = z.enum([
  "received",
  "needs_clarification",
  "assessing",
  "awaiting_approval",
  "awaiting_acknowledgement",
  "applying",
  "partially_applied",
  "verifying",
  "plan_verified",
  "escalated",
  "superseded",
]);

export const actionStateSchema = z.enum([
  "planned",
  "authorized",
  "pending",
  "confirmed",
  "failed",
  "unknown",
]);

/**
 * Ingest one stored fixture supplier message. `deliveryId` identifies this
 * delivery attempt: repeating it returns the recorded outcome, while a new
 * delivery of the same message is a duplicate observation.
 */
export const ingestMessageCommandSchema = z.strictObject({
  organizationId: z.uuid(),
  deliveryId: z.uuid(),
  sourceSystem: labelSchema,
  messageId: labelSchema,
  inputVersion: versionNumberSchema,
  /** Opaque evidence text kept beside the structured input; never parsed for authority. */
  supplierText: z.string().max(20_000).optional(),
});

/** Approve or reject the exact plan hash, as a named simulated actor. */
export const planDecisionCommandSchema = z.strictObject({
  actorId: labelSchema,
  decision: z.enum(["approve", "reject"]),
  planSha256: sha256Schema,
  note: z.string().min(1).max(500).optional(),
});

/**
 * A structured simulated acknowledgement or confirmation. A sent message or a
 * reply without these references never satisfies a wait.
 */
export const acknowledgementCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("supplier_acknowledgement"),
    actorId: labelSchema,
    /** Null for a reply that references no proposal, such as "Thanks, noted". */
    proposalId: labelSchema.nullable(),
    poNumber: labelSchema.nullable(),
    poLine: labelSchema.nullable(),
    segments: z.array(scheduleSegmentSchema),
  }),
  z.strictObject({
    kind: z.literal("warehouse_planner_confirmation"),
    actorId: labelSchema,
    planSha256: sha256Schema,
    optionId: labelSchema,
    quantity: positiveQuantitySchema,
    arrivalDate: businessDateSchema,
  }),
]);

export const escalationCommandSchema = z.strictObject({
  actorId: labelSchema,
  note: z.string().min(1).max(500),
});

/**
 * Revokes the current approval of the exact plan hash (ADR 0016). Only the
 * approver who gave it or a procurement manager may revoke it. An action
 * already submitted is reconciled, never resubmitted; nothing unclaimed runs.
 */
export const revocationCommandSchema = z.strictObject({
  actorId: labelSchema,
  planSha256: sha256Schema,
  note: z.string().min(1).max(500),
});

/**
 * A recorded operator note on a case. It is never evidence and never
 * authority: it changes no field, state, decision or plan (ADR 0014). A
 * correction, a question and a supplier reply are separate commands.
 */
export const caseNoteCommandSchema = z.strictObject({
  actorId: labelSchema,
  /** The field the note concerns, such as `segments[1].arrival`. */
  field: z.string().min(1).max(120).optional(),
  note: z.string().min(1).max(500),
});

/**
 * A candidate field a question or correction can name: the proposal terms the
 * deterministic intake checks, one schedule segment at a time.
 */
export const candidateFieldSchema = z
  .string()
  .regex(/^(poNumber|poLine|baseRevision|vendorItem|uom|segments\[[0-7]\]\.(quantity|arrival))$/);

/**
 * The case basis a command was prepared against: the sequence of the case's
 * latest assessment run, 0 before any. A newer assessment makes the command
 * stale; it is refused rather than applied to different facts.
 */
const basisSchema = z.int().min(0);

/**
 * Ask the supplier a targeted question (ADR 0014). The API stores a local
 * draft and pauses the case in `needs_clarification` for the buyer; nothing is
 * ever transmitted. Only the buyer may ask.
 */
export const clarificationRequestCommandSchema = z.strictObject({
  actorId: labelSchema,
  basisAssessment: basisSchema,
  fields: z.array(candidateFieldSchema).min(1).max(12),
  question: z.string().min(1).max(1000),
});

/**
 * Record a supplier's reply to one question, as the simulated supplier
 * contact. The reply names the case, the question and the basis it answers;
 * its exact bytes become evidence. A reply never approves, acknowledges or
 * converts anything by itself.
 */
export const supplierReplyCommandSchema = z.strictObject({
  actorId: labelSchema,
  /** This delivery attempt: repeating it returns the recorded outcome. */
  deliveryId: z.uuid(),
  caseRef: labelSchema,
  questionRef: labelSchema,
  basisAssessment: basisSchema,
  /** The envelope sender as received; it must be registered for the case's vendor. */
  sender: z.email().max(320),
  subject: z.string().max(300),
  text: z.string().min(1).max(12_000),
});

/** Where a corrected value is stated: a quoted span of one stored supplier message. */
export const correctionCitationSchema = z.strictObject({
  deliveryId: z.uuid(),
  /** SHA-256 of the cited message's exact stored bytes. */
  contentSha256: sha256Schema,
  quote: z.string().min(1).max(400),
});

/**
 * Propose corrected candidate fields, each citing the supplier's own words
 * (ADR 0014). Values are text: a label, a whole quantity, a date or `undated`.
 * Only the buyer may propose; the API validates every citation, then runs the
 * unchanged intake and assessment on the corrected terms.
 */
export const fieldCorrectionCommandSchema = z.strictObject({
  actorId: labelSchema,
  basisAssessment: basisSchema,
  changes: z
    .array(
      z.strictObject({
        field: candidateFieldSchema,
        value: z.string().min(1).max(64),
        citation: correctionCitationSchema,
      }),
    )
    .min(1)
    .max(20),
  note: z.string().min(1).max(500).optional(),
});

/**
 * Reads back a verified plan's source records again (ADR 0015). It never
 * writes a source; a match renews the four-hour validity, a mismatch or a
 * missing record ends it, and unavailable evidence is recorded apart.
 */
export const verificationCheckCommandSchema = z.strictObject({ actorId: labelSchema });

/** A simulated actor the signed-in user may act as, from the server's own records. */
export const caseActorSchema = z.strictObject({
  actorId: labelSchema,
  role: actorRoleSchema,
  vendorId: labelSchema.nullable(),
  simulated: z.literal(true),
});

/** One case in the exception queue. */
export const caseSummarySchema = z.strictObject({
  caseId: z.uuid(),
  caseRef: labelSchema,
  organizationId: z.uuid(),
  state: caseStateSchema,
  reason: z.string().nullable(),
  owner: actorRoleSchema.nullable(),
  nextAction: z.string(),
  messageId: labelSchema,
  proposalId: labelSchema.nullable(),
  openedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  /** Business-clock seconds since the case was opened. */
  ageSeconds: z.int().min(0),
});

export type CaseState = z.infer<typeof caseStateSchema>;
export type ActionState = z.infer<typeof actionStateSchema>;
export type IngestMessageCommand = z.infer<typeof ingestMessageCommandSchema>;
export type PlanDecisionCommand = z.infer<typeof planDecisionCommandSchema>;
export type AcknowledgementCommand = z.infer<typeof acknowledgementCommandSchema>;
export type EscalationCommand = z.infer<typeof escalationCommandSchema>;
export type RevocationCommand = z.infer<typeof revocationCommandSchema>;
export type CaseNoteCommand = z.infer<typeof caseNoteCommandSchema>;
export type VerificationCheckCommand = z.infer<typeof verificationCheckCommandSchema>;
export type CandidateField = z.infer<typeof candidateFieldSchema>;
export type ClarificationRequestCommand = z.infer<typeof clarificationRequestCommandSchema>;
export type SupplierReplyCommand = z.infer<typeof supplierReplyCommandSchema>;
export type CorrectionCitation = z.infer<typeof correctionCitationSchema>;
export type FieldCorrectionCommand = z.infer<typeof fieldCorrectionCommandSchema>;
export type CaseActor = z.infer<typeof caseActorSchema>;
export type CaseSummary = z.infer<typeof caseSummarySchema>;
export type CaseActorRole = z.infer<typeof actorRoleSchema>;
