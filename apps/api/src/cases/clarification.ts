import { createHash, randomUUID } from "node:crypto";
import { evidenceText, sha256Hex } from "@supplier-disruption/agent";
import {
  canonicalJson,
  DOMAIN_CONTRACT_VERSION,
  type CaseCandidate,
  type CaseClarificationRecord,
  type CaseCorrectionRecord,
  type CaseState,
  type ClarificationRequestCommand,
  type CorrectionLocator,
  type FieldCorrectionCommand,
  type IntakeReceipt,
  type PlanPayload,
  type SupplierInputIdentity,
  type SupplierProposalTerms,
  type SupplierReplyCommand,
} from "@supplier-disruption/contracts";
import {
  agentRun,
  caseAction,
  caseAssessment,
  caseClarification,
  caseCorrection,
  caseDecision,
  casePlan,
  supplierCase,
  supplierContentSha256,
  supplierMessage,
} from "@supplier-disruption/db";
import { intakeAndAssess } from "@supplier-disruption/domain";
import { and, asc, desc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import {
  applyChanges,
  candidateFields,
  fieldValue,
  unsupportedReason,
} from "./correction-support.js";
import { CASE_FIXTURE } from "./fixture.js";
import { composeIntake, deliveryOf, readStoredInput } from "./sources.js";
import {
  actorFor,
  appendEvent,
  currentPlan,
  isoInstant,
  lockCase,
  transition,
  type CaseRow,
  type Db,
  type Executor,
  type Tx,
} from "./store.js";
import type { CaseResult, CaseWorkflow } from "./workflow.js";

/**
 * Clarification, correction and reply/resume (ADR 0014).
 *
 * - A question is a local draft, never transmitted. Asking supersedes the
 *   current plan's decisions and pauses the case in `needs_clarification`
 *   (`awaiting_supplier_reply`) with the buyer as owner.
 * - A reply is ingested explicitly as the simulated supplier contact. It
 *   must name this case, an open question and the basis that question was
 *   asked against, and come from a sender registered for the case's vendor.
 *   Its exact bytes become evidence. A valid reply resumes the case once: a
 *   planned case is reassessed under a new plan version; a case without
 *   accepted terms waits for a correction.
 * - A correction changes candidate fields, each citing a quoted span of the
 *   supplier's stored words. Supported terms become a new supplier input
 *   that the unchanged intake and assessment decide on. Original evidence is
 *   never edited, and earlier decisions never carry over to a new plan.
 */

/** Where a corrected input comes from: the buyer's cited transcription, not a supplier message. */
export const CORRECTION_SOURCE = "operator-correction";
/** Where a recorded supplier reply comes from. */
export const REPLY_SOURCE = "supplier-reply";

/** States in which a question or correction may change the case. */
const OPEN_STATES: readonly CaseState[] = [
  "needs_clarification",
  "awaiting_approval",
  "awaiting_acknowledgement",
];

/** Closed cases: a reply to one is refused before anything is recorded. */
const TERMINAL_STATES: readonly CaseState[] = ["plan_verified", "escalated", "superseded"];

const error = (status: number, code: string, extra: Record<string, unknown> = {}): CaseResult => ({
  status,
  body: { error: code, ...extra },
});

const caseRefOf = (row: CaseRow) => `CASE-${String(row.caseNumber)}`;

/** The stored text a quote may cite: an email or a reply, as its locators index it. */
function citeableText(content: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    return null;
  }
  const message = parsed as {
    kind?: unknown;
    sender?: unknown;
    subject?: unknown;
    text?: unknown;
    attachmentText?: unknown;
  };
  if (
    (message.kind !== "supplier_email" && message.kind !== "supplier_reply") ||
    typeof message.sender !== "string" ||
    typeof message.subject !== "string" ||
    typeof message.text !== "string"
  ) {
    return null;
  }
  return evidenceText({
    sender: message.sender,
    subject: message.subject,
    text: message.text,
    ...(typeof message.attachmentText === "string"
      ? { attachmentText: message.attachmentText }
      : {}),
  });
}

/** The exact bytes of a recorded reply: UTF-8 canonical JSON, like a stored email. */
function replyBytes(command: SupplierReplyCommand): Buffer {
  return Buffer.from(
    canonicalJson({
      kind: "supplier_reply",
      sender: command.sender,
      subject: command.subject,
      text: command.text,
    }),
    "utf8",
  );
}

export class CaseClarifications {
  constructor(private readonly workflow: CaseWorkflow) {}

  private get db(): Db {
    return this.workflow.deps.db;
  }

  /** The case basis: the sequence of its latest assessment run, 0 before any. */
  async basisOf(db: Executor, caseId: string): Promise<number> {
    const [row] = await db
      .select({ last: max(caseAssessment.sequence) })
      .from(caseAssessment)
      .where(eq(caseAssessment.caseId, caseId));
    return row?.last ?? 0;
  }

  /** The buyer actor this user may act as, or the refusal. */
  private async buyer(tx: Tx, row: CaseRow, actorId: string, userId: string) {
    const actor = await actorFor(tx, row.organizationId, actorId, userId);
    if (actor === null || actor.role !== "buyer") return null;
    return actor;
  }

  /**
   * The supplier's envelope sender for this case: the accepted input's
   * sender, else the stored email's. Never a value from a reply or a note.
   */
  private async originalSender(db: Executor, row: CaseRow): Promise<string | null> {
    const receipt = row.intakeReceipt as IntakeReceipt | null;
    if (receipt !== null) return receipt.sender;
    const messages = await db
      .select({ content: supplierMessage.content, disposition: supplierMessage.disposition })
      .from(supplierMessage)
      .where(
        and(
          eq(supplierMessage.caseId, row.id),
          inArray(supplierMessage.disposition, ["evidence", "accept", "blocked"]),
        ),
      )
      .orderBy(asc(supplierMessage.receivedAt));
    for (const message of messages) {
      const parsed = JSON.parse(message.content.toString("utf8")) as {
        sender?: unknown;
        identity?: { sender?: unknown };
      };
      const sender = message.disposition === "evidence" ? parsed.sender : parsed.identity?.sender;
      if (typeof sender === "string") return sender;
    }
    return null;
  }

  /** The case's vendor: from intake, else from the registered original sender. */
  private async caseVendor(
    row: CaseRow,
    sender: string | null,
  ): Promise<{ vendorId: string | null; unavailable: boolean }> {
    if (row.vendorId !== null) return { vendorId: row.vendorId, unavailable: false };
    if (sender === null) return { vendorId: null, unavailable: false };
    return this.registeredVendor(sender);
  }

  private async registeredVendor(sender: string) {
    const read = await this.workflow.sources.reference.readRegisteredVendor({
      organization: CASE_FIXTURE.label,
      sender,
    });
    if (read.status === "ok") return { vendorId: read.data.vendorId, unavailable: false };
    return { vendorId: null, unavailable: read.status === "unavailable" };
  }

  private async openQuestion(db: Executor, caseId: string) {
    const [question] = await db
      .select()
      .from(caseClarification)
      .where(
        and(eq(caseClarification.caseId, caseId), eq(caseClarification.status, "awaiting_reply")),
      );
    return question ?? null;
  }

  /**
   * Ends the current plan's authority: current decisions are superseded and
   * unclaimed actions fail before any effect, as for a conflict before a
   * claim (ADR 0013). The plan itself stays in history.
   */
  private async supersedeCurrentPlan(tx: Tx, row: CaseRow, at: string, reason: string) {
    if (row.currentPlanId === null) return;
    await tx
      .update(caseDecision)
      .set({ status: "superseded", invalidatedAt: at, invalidatedReason: reason })
      .where(
        and(eq(caseDecision.planRowId, row.currentPlanId), eq(caseDecision.status, "current")),
      );
    await tx
      .update(caseAction)
      .set({ state: "failed", reason, updatedAt: at })
      .where(
        and(
          eq(caseAction.planRowId, row.currentPlanId),
          inArray(caseAction.state, ["planned", "authorized"]),
        ),
      );
  }

  // Questions ----------------------------------------------------------------

  async request(
    userId: string,
    caseId: string,
    command: ClarificationRequestCommand,
  ): Promise<CaseResult> {
    return this.db.transaction(async (tx) => {
      const row = await lockCase(tx, caseId);
      if (row === null) return error(404, "case_not_found");
      const actor = await this.buyer(tx, row, command.actorId, userId);
      if (actor === null) return error(403, "actor_not_permitted");
      if (!OPEN_STATES.includes(row.state as CaseState)) return error(409, "invalid_case_state");
      const open = await this.openQuestion(tx, row.id);
      if (open !== null) {
        return error(409, "clarification_open", { questionRef: `Q-${String(open.sequence)}` });
      }
      const basis = await this.basisOf(tx, row.id);
      if (command.basisAssessment !== basis) {
        return error(409, "stale_basis", { basisAssessment: basis });
      }
      const at = await this.workflow.now();
      const [last] = await tx
        .select({ last: max(caseClarification.sequence) })
        .from(caseClarification)
        .where(eq(caseClarification.caseId, row.id));
      const sequence = (last?.last ?? 0) + 1;
      const questionRef = `Q-${String(sequence)}`;
      const caseRef = caseRefOf(row);
      const fields = [...new Set(command.fields)];
      const draft = {
        to: await this.originalSender(tx, row),
        subject: `${caseRef} ${questionRef}: clarification requested`,
        body: [
          command.question,
          "",
          `Fields: ${fields.join(", ")}`,
          `Please reply quoting ${caseRef} ${questionRef} (basis ${String(basis)}).`,
        ].join("\n"),
      };
      await tx.insert(caseClarification).values({
        id: randomUUID(),
        caseId: row.id,
        sequence,
        status: "awaiting_reply",
        fields,
        question: command.question,
        draft,
        sent: false,
        basisAssessment: basis,
        planVersion: row.planVersion,
        actorId: actor.actorId,
        userId,
        requestedAt: at,
      });
      await this.supersedeCurrentPlan(tx, row, at, "clarification_requested");
      await transition(
        tx,
        row,
        at,
        { state: "needs_clarification", reason: "awaiting_supplier_reply", owner: "buyer" },
        {
          kind: "clarification_requested",
          actorId: actor.actorId,
          detail: {
            questionRef,
            fields,
            basisAssessment: basis,
            planVersion: row.planVersion,
            sent: false,
            note: "The question is a local draft; nothing was transmitted.",
          },
        },
      );
      return { status: 201, body: { questionRef, sent: false, draft, state: row.state } };
    });
  }

  // Replies ------------------------------------------------------------------

  async reply(userId: string, caseId: string, command: SupplierReplyCommand): Promise<CaseResult> {
    const content = replyBytes(command);
    const digest = sha256Hex(content);
    return this.db.transaction(async (tx) => {
      const row = await lockCase(tx, caseId);
      if (row === null) return error(404, "case_not_found");
      const actor = await actorFor(tx, row.organizationId, command.actorId, userId);
      if (actor === null || actor.role !== "supplier_contact") {
        return error(403, "actor_not_permitted");
      }
      // The same delivery again returns what was recorded for it.
      const [prior] = await tx
        .select()
        .from(supplierMessage)
        .where(
          and(
            eq(supplierMessage.organizationId, row.organizationId),
            eq(supplierMessage.deliveryId, command.deliveryId),
          ),
        );
      if (prior !== undefined) {
        if (prior.caseId !== row.id || prior.contentSha256 !== digest) {
          return error(409, "delivery_conflict");
        }
        return {
          status: 200,
          body: {
            replayed: true,
            disposition: prior.disposition,
            reason: prior.reason,
            state: row.state,
          },
        };
      }
      // A closed case takes no reply: nothing is recorded and nothing resumes.
      if (TERMINAL_STATES.includes(row.state as CaseState)) {
        return error(409, "invalid_case_state", { state: row.state });
      }
      // A reply names its case and question; one for another case is not recorded here.
      const match = /^Q-([1-9][0-9]{0,8})$/.exec(command.questionRef);
      const [question] =
        command.caseRef !== caseRefOf(row) || match === null
          ? []
          : await tx
              .select()
              .from(caseClarification)
              .where(
                and(
                  eq(caseClarification.caseId, row.id),
                  eq(caseClarification.sequence, Number(match[1])),
                ),
              );
      if (question === undefined) return error(409, "reply_case_mismatch");

      const at = await this.workflow.now();
      const refuse = async (status: number, reason: string) => {
        await appendEvent(tx, row, at, {
          kind: "reply_refused",
          reason,
          actorId: actor.actorId,
          detail: { questionRef: command.questionRef, messageSha256: digest, simulated: true },
        });
        return error(status, reason);
      };
      const vendor = await this.caseVendor(row, await this.originalSender(tx, row));
      if (vendor.unavailable) return error(503, "source_unavailable");
      if (vendor.vendorId === null) return refuse(422, "vendor_unresolved");
      if (actor.vendorId !== vendor.vendorId) return refuse(422, "vendor_mismatch");
      const sender = await this.registeredVendor(command.sender);
      if (sender.unavailable) return error(503, "source_unavailable");
      if (sender.vendorId === null) return refuse(422, "unverified_sender");
      if (sender.vendorId !== vendor.vendorId) return refuse(422, "vendor_mismatch");

      const basis = await this.basisOf(tx, row.id);
      let disposition: "reply" | "duplicate" = "reply";
      let reason: string | null = null;
      if (question.status === "answered") {
        const [accepted] =
          question.replyMessageId === null
            ? []
            : await tx
                .select({ contentSha256: supplierMessage.contentSha256 })
                .from(supplierMessage)
                .where(eq(supplierMessage.id, question.replyMessageId));
        if (accepted?.contentSha256 === digest) disposition = "duplicate";
        else reason = "reply_conflict";
      } else if (command.basisAssessment !== question.basisAssessment) {
        reason = "reply_basis_mismatch";
      } else if (
        question.status === "superseded" ||
        question.basisAssessment !== basis ||
        // Only the owned pause the question opened can resume.
        row.state !== "needs_clarification" ||
        row.reason !== "awaiting_supplier_reply"
      ) {
        reason = "stale_reply";
      }
      const messageId = randomUUID();
      await tx.insert(supplierMessage).values({
        id: messageId,
        organizationId: row.organizationId,
        deliveryId: command.deliveryId,
        sourceSystem: REPLY_SOURCE,
        messageId: `RPL-${digest.slice(0, 16)}`,
        inputVersion: 1,
        content,
        contentSha256: digest,
        disposition,
        reason,
        caseId: row.id,
        receivedAt: at,
      });
      const detail = {
        questionRef: command.questionRef,
        deliveryId: command.deliveryId,
        messageSha256: digest,
        byteLength: content.length,
        simulated: true,
      };
      if (disposition === "duplicate") {
        await appendEvent(tx, row, at, { kind: "duplicate_reply", actorId: actor.actorId, detail });
        return { status: 200, body: { disposition, reason: null, state: row.state } };
      }
      if (reason !== null) {
        // Kept as evidence, with no effect on the case or its question.
        await appendEvent(tx, row, at, {
          kind: "reply_rejected",
          reason,
          actorId: actor.actorId,
          detail,
        });
        return error(409, reason, { state: row.state });
      }

      await tx
        .update(caseClarification)
        .set({
          status: "answered",
          replyMessageId: messageId,
          closedAt: at,
          closedReason: "answered",
        })
        .where(eq(caseClarification.id, question.id));
      await appendEvent(tx, row, at, { kind: "reply_recorded", actorId: actor.actorId, detail });
      await this.resume(tx, row, at, command.questionRef);
      return {
        status: 201,
        body: {
          disposition,
          questionRef: command.questionRef,
          state: row.state,
          planVersion: row.planVersion,
        },
      };
    });
  }

  /**
   * Resumes a case after a valid reply, once. Accepted terms whose plan came
   * from the latest assessment are reassessed from fresh reads under a new
   * plan version. Otherwise (no plan yet, or a later blocked correction or
   * planless assessment) the reply alone states no terms, so the case waits
   * for a cited correction and never falls back to earlier terms.
   */
  private async resume(tx: Tx, row: CaseRow, at: string, questionRef: string) {
    const plan = await currentPlan(tx, row);
    const latest = await this.latestAssessmentId(tx, row.id);
    if (row.intakeReceipt !== null && plan !== null && plan.assessmentId === latest) {
      await appendEvent(tx, row, at, {
        kind: "clarification_resumed",
        detail: { questionRef, resumedWith: "reassessment" },
      });
      await this.workflow.reassess(tx, row);
      return;
    }
    await transition(
      tx,
      row,
      at,
      { state: "needs_clarification", reason: "correction_required", owner: "buyer" },
      { kind: "clarification_resumed", detail: { questionRef, resumedWith: "correction" } },
    );
  }

  // Corrections --------------------------------------------------------------

  /** The terms a correction starts from; see `CaseCandidate`. */
  async candidate(db: Executor, row: CaseRow): Promise<CaseCandidate | null> {
    const [correction] = await db
      .select({ after: caseCorrection.after })
      .from(caseCorrection)
      .where(
        and(
          eq(caseCorrection.caseId, row.id),
          inArray(caseCorrection.status, ["accepted", "blocked"]),
        ),
      )
      .orderBy(desc(caseCorrection.sequence))
      .limit(1);
    if (correction?.after != null) {
      return {
        source: "correction",
        supported: true,
        terms: correction.after as SupplierProposalTerms,
      };
    }
    const [plan] = await db
      .select({ payload: casePlan.payload })
      .from(casePlan)
      .where(eq(casePlan.caseId, row.id))
      .orderBy(desc(casePlan.planVersion))
      .limit(1);
    if (plan !== undefined) {
      return {
        source: "plan",
        supported: true,
        terms: (plan.payload as PlanPayload).proposal.terms,
      };
    }
    const [run] = await db
      .select({ terms: agentRun.terms })
      .from(agentRun)
      .where(eq(agentRun.caseId, row.id));
    if (run?.terms != null) {
      return { source: "agent_run", supported: false, terms: run.terms as SupplierProposalTerms };
    }
    return null;
  }

  async correct(
    userId: string,
    caseId: string,
    command: FieldCorrectionCommand,
  ): Promise<CaseResult> {
    const { sources } = this.workflow;
    return this.db.transaction(async (tx) => {
      // Intake's candidate lookup is serialized with every ingest, as there.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`case-ingest:${CASE_FIXTURE.organization.id}`}))`,
      );
      const row = await lockCase(tx, caseId);
      if (row === null) return error(404, "case_not_found");
      const actor = await this.buyer(tx, row, command.actorId, userId);
      if (actor === null) return error(403, "actor_not_permitted");
      if (!OPEN_STATES.includes(row.state as CaseState)) return error(409, "invalid_case_state");
      const basis = await this.basisOf(tx, row.id);
      if (command.basisAssessment !== basis) {
        return error(409, "stale_basis", { basisAssessment: basis });
      }
      const at = await this.workflow.now();
      const [last] = await tx
        .select({ last: max(caseCorrection.sequence) })
        .from(caseCorrection)
        .where(eq(caseCorrection.caseId, row.id));
      const sequence = (last?.last ?? 0) + 1;
      const correctionRef = `COR-${String(sequence)}`;
      const candidate = await this.candidate(tx, row);
      const before = candidate?.terms ?? null;
      const correctionId = randomUUID();
      const record = {
        id: correctionId,
        caseId: row.id,
        sequence,
        actorId: actor.actorId,
        userId,
        basisAssessment: basis,
        before,
        changes: command.changes,
        note: command.note ?? null,
        occurredAt: at,
      };
      const reject = async (reason: string, diagnostics: string[], after: unknown = null) => {
        await tx.insert(caseCorrection).values({
          ...record,
          status: "rejected",
          reason,
          diagnostics,
          after,
          locators: [],
        });
        await appendEvent(tx, row, at, {
          kind: "correction_rejected",
          reason,
          actorId: actor.actorId,
          detail: { correctionRef, diagnostics },
        });
        return error(422, reason, { correctionRef, diagnostics, state: row.state });
      };

      const applied = applyChanges(before, command.changes);
      if (!applied.ok) return reject("correction_invalid", applied.diagnostics);
      const after = applied.terms;
      if (candidate?.supported === true && canonicalJson(after) === canonicalJson(before)) {
        return reject("correction_no_change", ["the corrected terms equal the current terms"]);
      }
      // An unsupported candidate (a paused agent proposal) is trusted for nothing.
      const changed = new Set(command.changes.map((change) => change.field));
      if (candidate?.supported !== true) {
        const missing = candidateFields(after).filter((field) => !changed.has(field));
        if (missing.length > 0) {
          return reject(
            "correction_incomplete",
            missing.map((field) => `${field}: no supported value; cite the supplier's words`),
            after,
          );
        }
      }

      // Every changed value must be stated by its cited span of supplier evidence.
      const citeable = await tx
        .select()
        .from(supplierMessage)
        .where(
          and(
            eq(supplierMessage.caseId, row.id),
            or(
              eq(supplierMessage.disposition, "evidence"),
              and(eq(supplierMessage.disposition, "reply"), isNull(supplierMessage.reason)),
            ),
          ),
        );
      const diagnostics: string[] = [];
      const locators: CorrectionLocator[] = [];
      for (const change of command.changes) {
        const message = citeable.find((item) => item.deliveryId === change.citation.deliveryId);
        const text =
          message === undefined || message.contentSha256 !== change.citation.contentSha256
            ? null
            : citeableText(message.content);
        if (message === undefined || text === null) {
          diagnostics.push(
            `${change.field}: the cited delivery is not supplier evidence of this case`,
          );
          continue;
        }
        const start = text.indexOf(change.citation.quote);
        if (start < 0) {
          diagnostics.push(
            `${change.field}: the quote does not occur verbatim in the cited message`,
          );
          continue;
        }
        const value = fieldValue(after, change.field) ?? change.value;
        const unsupported = unsupportedReason(change.field, value, change.citation.quote, text);
        if (unsupported !== null) {
          diagnostics.push(`${change.field}: ${unsupported}`);
          continue;
        }
        locators.push({
          field: change.field,
          value,
          deliveryId: message.deliveryId,
          messageId: message.messageId,
          contentSha256: message.contentSha256,
          evidenceSha256: sha256Hex(text),
          quote: change.citation.quote,
          start,
          end: start + change.citation.quote.length,
        });
      }
      if (diagnostics.length > 0) return reject("correction_unsupported", diagnostics, after);

      const sender = await this.originalSender(tx, row);
      if (sender === null) {
        return reject("correction_sender_unknown", ["the case has no supplier sender"], after);
      }
      // The corrected terms become a new supplier input under their own key;
      // the message that opened the case and its bytes stay as they were.
      const messageId = `COR-${createHash("sha256")
        .update(`${row.id}\n${canonicalJson(after)}`)
        .digest("hex")
        .slice(0, 16)}`;
      const key = { sourceSystem: CORRECTION_SOURCE, messageId, inputVersion: 1 };
      const identity: SupplierInputIdentity = {
        contractVersion: DOMAIN_CONTRACT_VERSION,
        ...key,
        contentSha256: supplierContentSha256(after),
        sender,
        proposalId: `PROP-${messageId}`,
        evidenceRef: `${caseRefOf(row)}-${correctionRef}`,
        authoredAt: { state: "unknown" },
        receivedAt: { state: "unknown" },
      };
      // A correction is a revision of its PO line like any other (ADR 0015).
      const lineage = await this.workflow.revisionLineage(tx, row.organizationId, after, row);
      if (lineage.kind === "conflict") {
        return reject(
          "revision_conflict",
          [`CASE-${String(lineage.open.caseNumber)} is an open revision of this PO line`],
          after,
        );
      }
      try {
        await sources.reference.recordSupplierInput({ identity, terms: after });
      } catch {
        return error(503, "source_unavailable");
      }
      const stored = await readStoredInput(sources, key);
      if (stored.status !== "ok") return error(503, "source_unavailable");
      const delivery = deliveryOf(stored.identity, stored.terms, undefined);
      const input = await composeIntake(sources, stored, delivery, {
        receiptId: `RCPT-${String(row.caseNumber)}-${correctionRef}`,
        caseId: row.id,
        planId: `PLAN-${String(row.caseNumber)}`,
        planVersion: row.planVersion + 1,
        assessedAt: at,
        priorAcceptance: await this.workflow.priorAcceptance(
          tx,
          row.organizationId,
          stored.identity,
          undefined,
        ),
        ...(lineage.kind === "successor"
          ? {
              priorCommitments: await this.workflow.priorCommitmentsOf(tx, lineage.predecessor, at),
            }
          : {}),
      });
      const outcome = intakeAndAssess(input);
      const intake = outcome.intake;
      const deliveryBytes = Buffer.from(canonicalJson(delivery), "utf8");
      const blockedReason =
        intake.disposition === "accept"
          ? null
          : intake.disposition === "blocked"
            ? intake.decision.reason
            : "intake_possible_duplicate";
      await tx.insert(supplierMessage).values({
        id: randomUUID(),
        organizationId: row.organizationId,
        deliveryId: correctionId,
        ...key,
        content: deliveryBytes,
        contentSha256: sha256Hex(deliveryBytes),
        disposition: intake.disposition === "accept" ? "accept" : "blocked",
        reason: blockedReason,
        caseId: row.id,
        receivedAt: at,
      });

      await this.supersedeCurrentPlan(tx, row, at, "superseded_by_correction");
      const open = await this.openQuestion(tx, row.id);
      if (open !== null) {
        await tx
          .update(caseClarification)
          .set({ status: "superseded", closedAt: at, closedReason: "superseded_by_correction" })
          .where(eq(caseClarification.id, open.id));
      }
      await appendEvent(tx, row, at, {
        kind: "correction_recorded",
        actorId: actor.actorId,
        detail: {
          correctionRef,
          input: key,
          before: before === null ? null : supplierContentSha256(before),
          after: supplierContentSha256(after),
          locators: locators.map(({ field, value, messageId: cited, start, end }) => ({
            field,
            value,
            messageId: cited,
            start,
            end,
          })),
          ...(open === null ? {} : { supersededQuestion: `Q-${String(open.sequence)}` }),
        },
      });

      if (intake.disposition !== "accept") {
        // Supported by evidence, but intake blocks it: no plan, the buyer owns the reason.
        const reason = blockedReason ?? "intake_possible_duplicate";
        await this.workflow.storeAssessment(tx, row, at, intake, null);
        await transition(
          tx,
          row,
          at,
          { state: "needs_clarification", reason, owner: "buyer" },
          {
            kind: "intake_blocked",
            detail:
              intake.disposition === "blocked"
                ? { correctionRef, subject: intake.subject, diagnostics: intake.diagnostics }
                : { correctionRef },
          },
        );
        await tx.insert(caseCorrection).values({
          ...record,
          status: "blocked",
          reason,
          diagnostics: intake.disposition === "blocked" ? intake.diagnostics : [],
          after,
          locators,
          input: key,
          assessmentId: await this.latestAssessmentId(tx, row.id),
        });
        return {
          status: 201,
          body: { outcome: "blocked", reason, correctionRef, state: row.state },
        };
      }

      const receipt: IntakeReceipt = intake.proposedReceipt;
      Object.assign(row, {
        intakeReceipt: receipt,
        contentSha256: intake.contentSha256,
        proposalId: intake.proposal.proposalId,
        vendorId: intake.vendorId,
      });
      await tx
        .update(supplierCase)
        .set({
          intakeReceipt: receipt,
          contentSha256: intake.contentSha256,
          proposalId: intake.proposal.proposalId,
          vendorId: intake.vendorId,
        })
        .where(eq(supplierCase.id, row.id));
      await transition(
        tx,
        row,
        at,
        { state: "assessing" },
        { kind: "intake_accepted", detail: { correctionRef, association: intake.association } },
      );
      if (lineage.kind === "successor") await this.workflow.linkSuccessor(tx, row, lineage, at);
      if (outcome.assessment === null) throw new Error("an accepted input is always assessed");
      await this.workflow.recordAssessment(tx, row, at, intake, outcome.assessment);
      await tx.insert(caseCorrection).values({
        ...record,
        status: "accepted",
        reason: null,
        diagnostics: [],
        after,
        locators,
        input: key,
        assessmentId: await this.latestAssessmentId(tx, row.id),
        planVersion: row.currentPlanId === null ? null : row.planVersion,
      });
      return {
        status: 201,
        body: {
          outcome: "accepted",
          correctionRef,
          state: row.state,
          planVersion: row.currentPlanId === null ? null : row.planVersion,
        },
      };
    });
  }

  private async latestAssessmentId(tx: Tx, caseId: string): Promise<string | null> {
    const [latest] = await tx
      .select({ id: caseAssessment.id })
      .from(caseAssessment)
      .where(eq(caseAssessment.caseId, caseId))
      .orderBy(desc(caseAssessment.sequence))
      .limit(1);
    return latest?.id ?? null;
  }

  // Read model ---------------------------------------------------------------

  async detail(row: CaseRow): Promise<{
    basisAssessment: number;
    candidate: CaseCandidate | null;
    clarifications: CaseClarificationRecord[];
    corrections: CaseCorrectionRecord[];
  }> {
    const [basisAssessment, candidate, questions, corrections, replies] = await Promise.all([
      this.basisOf(this.db, row.id),
      this.candidate(this.db, row),
      this.db
        .select()
        .from(caseClarification)
        .where(eq(caseClarification.caseId, row.id))
        .orderBy(asc(caseClarification.sequence)),
      this.db
        .select()
        .from(caseCorrection)
        .where(eq(caseCorrection.caseId, row.id))
        .orderBy(asc(caseCorrection.sequence)),
      this.db
        .select({ id: supplierMessage.id, deliveryId: supplierMessage.deliveryId })
        .from(supplierMessage)
        .where(and(eq(supplierMessage.caseId, row.id), eq(supplierMessage.disposition, "reply"))),
    ]);
    return {
      basisAssessment,
      candidate,
      clarifications: questions.map((question) => ({
        questionRef: `Q-${String(question.sequence)}`,
        status: question.status as CaseClarificationRecord["status"],
        fields: question.fields as string[],
        question: question.question,
        draft: question.draft as CaseClarificationRecord["draft"],
        sent: false,
        basisAssessment: question.basisAssessment,
        planVersion: question.planVersion,
        requestedBy: question.actorId,
        requestedAt: isoInstant(question.requestedAt),
        replyDeliveryId:
          replies.find((reply) => reply.id === question.replyMessageId)?.deliveryId ?? null,
        closedAt: question.closedAt === null ? null : isoInstant(question.closedAt),
        closedReason: question.closedReason,
      })),
      corrections: corrections.map((correction) => ({
        correctionRef: `COR-${String(correction.sequence)}`,
        status: correction.status as CaseCorrectionRecord["status"],
        reason: correction.reason,
        diagnostics: correction.diagnostics as string[],
        actorId: correction.actorId,
        basisAssessment: correction.basisAssessment,
        before: correction.before as SupplierProposalTerms | null,
        after: correction.after as SupplierProposalTerms | null,
        locators: correction.locators as CorrectionLocator[],
        input: correction.input as CaseCorrectionRecord["input"],
        planVersion: correction.planVersion,
        note: correction.note,
        occurredAt: isoInstant(correction.occurredAt),
      })),
    };
  }
}
