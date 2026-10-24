import type {
  AssessmentTotals,
  EligibilityResult,
  DemandAssessment,
  PlanPayload,
  Shortfall,
  SourceBinding,
  SubstituteAssessment,
  SupplyBucket,
  TransferOptionAssessment,
} from "./assessment.js";
import type { AgentRunRecord } from "./agent.js";
import type { ActionState, CaseActor, CaseState, CaseSummary } from "./cases.js";
import type { IntakeDecision } from "./intake.js";
import type { SupplierProposalTerms } from "./sources.js";

/**
 * Read models the workbench renders (ADR 0010). They describe the
 * responses of `GET /api/cases`, `GET /api/cases/actors` and
 * `GET /api/cases/:id` as the API composes them from its own records; the
 * browser displays them and never derives authority from them.
 */
export interface CaseListResponse {
  simulated: string;
  cases: CaseSummary[];
}

export interface CaseActorsResponse {
  simulated: string;
  actors: CaseActor[];
}

/** One stored delivery with its exact bytes as UTF-8 text. */
export interface CaseEvidence {
  deliveryId: string;
  messageId: string;
  inputVersion: number;
  disposition: "accept" | "duplicate" | "blocked" | "evidence" | "reply";
  reason: string | null;
  receivedAt: string;
  contentSha256: string;
  byteLength: number;
  content: string;
}

export interface CaseDecisionRecord {
  decisionId: string;
  planSha256: string | null;
  kind: string;
  actorId: string;
  role: string;
  simulated: boolean;
  outcome: string;
  reason: string | null;
  status: string;
  binding: Record<string, unknown> | null;
  occurredAt: string;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
}

export interface CaseActionRecord {
  planSha256: string | null;
  actionId: string;
  kind: string;
  operationId: string;
  state: ActionState;
  reason: string | null;
  attempts: number;
  receipt: Record<string, unknown> | null;
  readback: Record<string, unknown> | null;
  updatedAt: string;
}

export interface CaseTimelineEvent {
  sequence: number;
  kind: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  owner: string | null;
  actorId: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

/** Where a corrected value was found: the exact span of one stored supplier message. */
export interface CorrectionLocator {
  field: string;
  value: string;
  deliveryId: string;
  messageId: string;
  /** SHA-256 of the cited message's stored bytes. */
  contentSha256: string;
  /** SHA-256 of the evidence text the offsets index. */
  evidenceSha256: string;
  quote: string;
  start: number;
  end: number;
}

/** A question to the supplier (ADR 0014). Its draft is local and never transmitted. */
export interface CaseClarificationRecord {
  questionRef: string;
  status: "awaiting_reply" | "answered" | "superseded";
  fields: string[];
  question: string;
  draft: { to: string | null; subject: string; body: string };
  sent: false;
  basisAssessment: number;
  planVersion: number;
  requestedBy: string;
  requestedAt: string;
  replyDeliveryId: string | null;
  closedAt: string | null;
  closedReason: string | null;
}

/** A proposed field correction with its before and after terms and the evidence it cites. */
export interface CaseCorrectionRecord {
  correctionRef: string;
  status: "rejected" | "blocked" | "accepted";
  reason: string | null;
  diagnostics: string[];
  actorId: string;
  basisAssessment: number;
  before: SupplierProposalTerms | null;
  after: SupplierProposalTerms | null;
  locators: CorrectionLocator[];
  /** The corrected supplier input intake decided on, when the correction was supported. */
  input: { sourceSystem: string; messageId: string; inputVersion: number } | null;
  planVersion: number | null;
  note: string | null;
  occurredAt: string;
}

/**
 * The candidate terms a correction starts from. `supported` candidates came
 * through intake (a plan or an accepted correction); an unsupported one is an
 * agent proposal kept for review, so a correction must cite every field.
 */
export interface CaseCandidate {
  source: "plan" | "correction" | "agent_run";
  supported: boolean;
  terms: SupplierProposalTerms;
}

/** One recorded read-back of a plan, or an attempt that could not read (ADR 0015). */
export interface VerificationEntry {
  sequence: number;
  occurredAt: string;
  actorId: string | null;
  recheck: boolean;
  /** `verified`, a mismatch reason such as `verification_mismatch`, or `unavailable`. */
  outcome: string;
  planSha256: string | null;
  bundleTime: string | null;
  validUntil: string | null;
  failedChecks: string[];
  missing: string[];
}

/**
 * Whether the current plan's verification holds now, beside every earlier
 * read-back. `current` lasts four hours from the read-back's bundle time.
 */
export interface VerificationStatus {
  status: "current" | "expired" | "mismatch" | "unavailable" | "superseded" | "none";
  currentUntil: string | null;
  lastVerified: VerificationEntry | null;
  lastAttempt: VerificationEntry | null;
  history: VerificationEntry[];
  /** Whether the API would accept a recheck of the current plan now. */
  recheckable: boolean;
}

/** A predecessor or successor case of a later supplier revision (ADR 0015). */
export interface LinkedCase {
  caseId: string;
  caseRef: string;
  state: CaseState;
  messageId: string;
  planId: string | null;
  planSha256: string | null;
}

export interface CaseDetail {
  simulated: string;
  case: CaseSummary;
  /** The case basis commands must name: the latest assessment sequence, 0 before any. */
  basisAssessment: number;
  candidate: CaseCandidate | null;
  clarifications: CaseClarificationRecord[];
  corrections: CaseCorrectionRecord[];
  evidence: CaseEvidence[];
  fields: {
    proposal: PlanPayload["proposal"];
    current: SourceBinding | null;
  } | null;
  intake: IntakeDecision | null;
  impact: {
    demand: DemandAssessment[];
    totals: AssessmentTotals;
    shortfalls: Shortfall[];
    supply: SupplyBucket[];
    eligibility: EligibilityResult[];
  } | null;
  options: {
    transferOptions: TransferOptionAssessment[];
    substitutes: SubstituteAssessment[];
  } | null;
  plan: { planId: string; planVersion: number; sha256: string; payload: PlanPayload } | null;
  plans: { planId: string; planVersion: number; sha256: string; current: boolean }[];
  decisions: CaseDecisionRecord[];
  actions: CaseActionRecord[];
  verification: Record<string, unknown> | null;
  verificationStatus: VerificationStatus;
  lineage: { predecessor: LinkedCase | null; successor: LinkedCase | null };
  physicalDelivery: {
    supplierReceipt: "not_recorded";
    transferReceipt: "not_recorded";
    note: string;
  };
  timeline: CaseTimelineEvent[];
  /** The latest extraction agent run for an email case; null for a structured message. */
  agentRun: AgentRunRecord | null;
}

/**
 * `GET /api/demonstration` (ADR 0012). Outside the demonstration mode only
 * `active: false`. In it, the simulated business clock the API uses, the
 * labelled controls it accepts and the recorded agent run it replays.
 */
export type DemonstrationStatus =
  | { active: false }
  | {
      active: true;
      notice: string;
      businessClock: string;
      agentProvider: "replay";
      controls: readonly DemonstrationControl[];
    };

/** A labelled demonstration control: a simulated source change or fault, never a case command. */
export type DemonstrationControl = "foreign_reservation" | "uncertain_reservation_write";
