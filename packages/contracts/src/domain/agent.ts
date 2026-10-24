import { z } from "zod";
import { businessDateSchema, labelSchema, sha256Schema, uomSchema } from "./primitives.js";

/**
 * Extraction agent contracts (ADR 0011). One bounded investigation
 * turns an unstructured supplier email into the structured supplier proposal
 * terms, with an evidence locator for every proposed field. The agent's output
 * is a candidate only: deterministic code validates every locator, and the
 * Intake and assessment decide what happens next (ADRs 0008 and 0007).
 */
export const AGENT_CONTRACT_VERSION = "extraction-agent.v1";

/** Source system of an email an operator pasted or loaded in the workbench. */
export const OPERATOR_EMAIL_SOURCE = "operator-email";

/** Default and hard tool-call limits per run (SPEC "Rules and agent responsibilities"). */
export const AGENT_DEFAULT_TOOL_BUDGET = 10;
export const AGENT_TOOL_CEILING = 12;

/**
 * Submit one supplier email. `sender` is the envelope sender as received,
 * matched exactly against registered senders by intake; the message text is
 * evidence only and is never parsed for identity, permissions or tools.
 */
export const emailIngestCommandSchema = z.strictObject({
  organizationId: z.uuid(),
  deliveryId: z.uuid(),
  sender: z.email().max(320),
  subject: z.string().max(300),
  text: z.string().min(1).max(12_000),
  /** An attachment-like text block (for example a pasted delivery schedule). */
  attachmentText: z.string().max(6_000).optional(),
});

/** A quoted span of the stored evidence text. */
const quoteSchema = z.string().min(1).max(400);

/** Where a proposed value came from, as the model states it. */
export const agentCitationSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("email"), quote: quoteSchema }),
  /** A value read from the purchase order record this run fetched, never from text similarity. */
  z.strictObject({
    source: z.literal("purchase_order"),
    field: z.enum(["revision", "lineNumber"]),
  }),
]);

const textCited = <T extends z.ZodType>(value: T) =>
  z.strictObject({ value, quote: quoteSchema, confidence: z.enum(["high", "low"]) });
const cited = <T extends z.ZodType>(value: T) =>
  z.strictObject({ value, cite: agentCitationSchema, confidence: z.enum(["high", "low"]) });

/** The structured proposal the model submits through `propose_supplier_terms`. */
export const agentProposalInputSchema = z.strictObject({
  poNumber: textCited(labelSchema),
  poLine: cited(labelSchema),
  baseRevision: cited(z.string().regex(/^[1-9][0-9]{0,8}$/)),
  vendorItem: textCited(labelSchema),
  uom: textCited(uomSchema),
  segments: z
    .array(
      z.strictObject({
        quantity: textCited(z.string().regex(/^[1-9][0-9]{0,17}$/)),
        arrival: z.discriminatedUnion("state", [
          z.strictObject({
            state: z.literal("dated"),
            date: businessDateSchema,
            quote: quoteSchema,
            confidence: z.enum(["high", "low"]),
          }),
          z.strictObject({
            state: z.literal("undated"),
            quote: quoteSchema,
            confidence: z.enum(["high", "low"]),
          }),
        ]),
      }),
    )
    .min(1)
    .max(8),
  /** Short reason for the proposal, shown to the operator. */
  rationale: z.string().min(1).max(600),
});

/** A validated locator: the field path, the cited span and its offsets in the stored text. */
export const evidenceLocatorSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("email"),
    field: z.string().min(1).max(80),
    value: z.string(),
    quote: z.string(),
    start: z.int().min(0),
    end: z.int().min(1),
    evidenceSha256: sha256Schema,
  }),
  z.strictObject({
    source: z.literal("purchase_order"),
    field: z.string().min(1).max(80),
    value: z.string(),
    poNumber: labelSchema,
    revision: z.string(),
    recordField: z.enum(["revision", "lineNumber"]),
  }),
]);

export const agentRunStatusSchema = z.enum(["queued", "running", "proposed", "paused"]);

/** Why a run paused. Every pause names the buyer as owner (SD-16). */
export const agentPauseReasonSchema = z.enum([
  "agent_escalated",
  "agent_low_confidence",
  "agent_malformed_output",
  "agent_unsupported_evidence",
  "agent_budget_exhausted",
  "agent_cost_cap_reached",
  "agent_spend_cap_reached",
  "agent_provider_failure",
  "agent_provider_unavailable",
  /** The model declined the request (stop reason `refusal`). */
  "agent_model_refused",
  /** The configured model does not exist at the provider or has no configured price. */
  "agent_model_unavailable",
  /** An unfinished checkpoint was written under another contract, model or evidence (ADR 0019). */
  "agent_checkpoint_incompatible",
]);

/** One recorded step: a model turn or a tool call, with why it was accepted or rejected. */
export interface AgentStepRecord {
  sequence: number;
  kind: "model" | "tool";
  tool: string | null;
  input: unknown;
  result: unknown;
  accepted: boolean;
  reason: string;
  latencyMs: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costMicroUsd: number | null;
}

/** The agent run as the case view shows it. */
export interface AgentRunRecord {
  runId: string;
  status: z.infer<typeof agentRunStatusSchema>;
  provider: string;
  model: string | null;
  toolBudget: number;
  toolCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  pauseReason: z.infer<typeof agentPauseReasonSchema> | null;
  pauseDetail: string | null;
  owner: "buyer" | null;
  evidenceSha256: string;
  evidenceText: string;
  locators: EvidenceLocator[];
  rationale: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: AgentStepRecord[];
}

export type EmailIngestCommand = z.infer<typeof emailIngestCommandSchema>;
export type AgentCitation = z.infer<typeof agentCitationSchema>;
export type AgentProposalInput = z.infer<typeof agentProposalInputSchema>;
export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentPauseReason = z.infer<typeof agentPauseReasonSchema>;
