import {
  API_ERRORS,
  acknowledgementCommandSchema,
  caseNoteCommandSchema,
  clarificationRequestCommandSchema,
  emailIngestCommandSchema,
  escalationCommandSchema,
  fieldCorrectionCommandSchema,
  ingestMessageCommandSchema,
  planDecisionCommandSchema,
  revocationCommandSchema,
  supplierReplyCommandSchema,
  verificationCheckCommandSchema,
  type CaseActor,
  type CaseSummary,
  type PlanPayload,
} from "@supplier-disruption/contracts";
import {
  caseAction,
  caseActor,
  caseAssessment,
  caseDecision,
  caseEvent,
  casePlan,
  membership,
  supplierCase,
  supplierMessage,
} from "@supplier-disruption/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { recheckable } from "../cases/apply.js";
import { expiredNextAction, verificationCurrency } from "../cases/currency.js";
import { CaseStateConflict, isoInstant, type CaseRow } from "../cases/store.js";
import { CASE_ERRORS, type CaseResult, type CaseWorkflow } from "../cases/workflow.js";

export interface CaseRouteOptions {
  db: NodePgDatabase;
  auth: Auth;
  appOrigin: string;
  workflow: CaseWorkflow;
}

const caseParamsSchema = z.strictObject({ id: z.uuid() });
const listQuerySchema = z.strictObject({ organizationId: z.uuid() });

/** Every role and actor label in a case response is a simulated fixture identity. */
const SIMULATED_NOTICE =
  "Synthetic fixture data. Roles are simulated actors, not enterprise identities; source adapters are simulated.";

function deny(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error });
}

function summary(row: CaseRow, now: string): CaseSummary {
  const openedAt = isoInstant(row.openedAt);
  return {
    caseId: row.id,
    caseRef: `CASE-${String(row.caseNumber)}`,
    organizationId: row.organizationId,
    state: row.state as CaseSummary["state"],
    reason: row.reason,
    owner: row.owner as CaseSummary["owner"],
    // An expired verification is no longer current success (ADR 0015).
    nextAction: expiredNextAction(row, now) ?? row.nextAction,
    messageId: row.messageId,
    proposalId: row.proposalId,
    openedAt,
    updatedAt: isoInstant(row.updatedAt),
    ageSeconds: Math.max(0, Math.floor((Date.parse(now) - Date.parse(openedAt)) / 1000)),
  };
}

/**
 * Workbench routes for supplier cases. Every route needs a session and a
 * fresh membership read; role decisions are additionally checked against the
 * simulated actor the user may act as (ADR 0009). The browser never reaches
 * the database or the source adapters.
 */
export function caseRoutes(
  app: FastifyInstance,
  options: CaseRouteOptions,
  done: (error?: Error) => void,
): void {
  const { db, auth, appOrigin, workflow } = options;

  async function sessionUser(request: FastifyRequest) {
    const result = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      // A read only: the refresh route alone slides a session, because only it
      // sends the renewed cookie back to the browser (ADR 0020).
      query: { disableCookieCache: true, disableRefresh: true },
    });
    return result?.user ?? null;
  }

  async function isMember(userId: string, organizationId: string) {
    const [row] = await db
      .select({ role: membership.role })
      .from(membership)
      .where(and(eq(membership.userId, userId), eq(membership.organizationId, organizationId)));
    return row !== undefined;
  }

  /** The session user and the case, if the user is a member of its organization. */
  async function authorizedCase(request: FastifyRequest, reply: FastifyReply) {
    const user = await sessionUser(request);
    if (user === null) {
      await deny(reply, 401, API_ERRORS.unauthenticated);
      return null;
    }
    const params = caseParamsSchema.safeParse(request.params);
    if (!params.success) {
      await deny(reply, 400, API_ERRORS.invalidRequest);
      return null;
    }
    const [row] = await db.select().from(supplierCase).where(eq(supplierCase.id, params.data.id));
    // A non-member cannot tell another organization's case from a missing one.
    if (row === undefined || !(await isMember(user.id, row.organizationId))) {
      await deny(reply, 404, CASE_ERRORS.caseNotFound);
      return null;
    }
    return { user, row };
  }

  function send(reply: FastifyReply, result: CaseResult) {
    return reply.status(result.status).send(result.body);
  }

  /** Commands must come from the application origin, like every other state change. */
  function originAllowed(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.headers.origin === appOrigin) return true;
    void deny(reply, 403, API_ERRORS.originRejected);
    return false;
  }

  app.get("/api/cases", async (request, reply) => {
    const user = await sessionUser(request);
    if (user === null) return deny(reply, 401, API_ERRORS.unauthenticated);
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    if (!(await isMember(user.id, query.data.organizationId))) {
      return deny(reply, 403, API_ERRORS.forbidden);
    }
    const now = await app.businessClock.now();
    const rows = await db
      .select()
      .from(supplierCase)
      .where(eq(supplierCase.organizationId, query.data.organizationId))
      .orderBy(asc(supplierCase.caseNumber));
    return reply.send({ simulated: SIMULATED_NOTICE, cases: rows.map((row) => summary(row, now)) });
  });

  app.get("/api/cases/actors", async (request, reply) => {
    const user = await sessionUser(request);
    if (user === null) return deny(reply, 401, API_ERRORS.unauthenticated);
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    if (!(await isMember(user.id, query.data.organizationId))) {
      return deny(reply, 403, API_ERRORS.forbidden);
    }
    const rows = await db
      .select({ actorId: caseActor.actorId, role: caseActor.role, vendorId: caseActor.vendorId })
      .from(caseActor)
      .where(
        and(
          eq(caseActor.organizationId, query.data.organizationId),
          eq(caseActor.userId, user.id),
          eq(caseActor.active, true),
        ),
      )
      .orderBy(asc(caseActor.actorId));
    const actors: CaseActor[] = rows.map((row) => ({
      actorId: row.actorId,
      role: row.role as CaseActor["role"],
      vendorId: row.vendorId,
      simulated: true,
    }));
    return reply.send({ simulated: SIMULATED_NOTICE, actors });
  });

  app.get("/api/cases/:id", async (request, reply) => {
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const { row } = found;
    const now = await app.businessClock.now();
    const [messages, assessments, plans, decisions, actions, events] = await Promise.all([
      db
        .select()
        .from(supplierMessage)
        .where(eq(supplierMessage.caseId, row.id))
        .orderBy(asc(supplierMessage.receivedAt)),
      db
        .select()
        .from(caseAssessment)
        .where(eq(caseAssessment.caseId, row.id))
        .orderBy(desc(caseAssessment.sequence)),
      db
        .select()
        .from(casePlan)
        .where(eq(casePlan.caseId, row.id))
        .orderBy(asc(casePlan.planVersion)),
      db
        .select()
        .from(caseDecision)
        .where(eq(caseDecision.caseId, row.id))
        .orderBy(asc(caseDecision.occurredAt)),
      db
        .select()
        .from(caseAction)
        .where(eq(caseAction.caseId, row.id))
        .orderBy(asc(caseAction.planRowId), asc(caseAction.sequence)),
      db
        .select()
        .from(caseEvent)
        .where(eq(caseEvent.caseId, row.id))
        .orderBy(asc(caseEvent.sequence)),
    ]);
    const plan = plans.find((entry) => entry.id === row.currentPlanId) ?? null;
    const payload = plan === null ? null : (plan.payload as PlanPayload);
    const latest = assessments[0] ?? null;
    const verification = [...events].reverse().find((event) => event.kind === "verification");
    const clarification = await workflow.clarifications.detail(row);
    const linked = async (caseId: string | null) => {
      if (caseId === null) return null;
      const [other] = await db.select().from(supplierCase).where(eq(supplierCase.id, caseId));
      if (other === undefined) return null;
      const [otherPlan] =
        other.currentPlanId === null
          ? []
          : await db.select().from(casePlan).where(eq(casePlan.id, other.currentPlanId));
      return {
        caseId: other.id,
        caseRef: `CASE-${String(other.caseNumber)}`,
        state: other.state,
        messageId: other.messageId,
        planId: otherPlan?.planId ?? null,
        planSha256: otherPlan?.sha256 ?? null,
      };
    };
    return reply.send({
      simulated: SIMULATED_NOTICE,
      case: summary(row, now),
      ...clarification,
      evidence: messages.map((message) => ({
        deliveryId: message.deliveryId,
        messageId: message.messageId,
        inputVersion: message.inputVersion,
        disposition: message.disposition,
        reason: message.reason,
        receivedAt: isoInstant(message.receivedAt),
        contentSha256: message.contentSha256,
        byteLength: message.content.length,
        // The exact stored bytes, as UTF-8 text; the operator can read the original.
        content: message.content.toString("utf8"),
      })),
      fields:
        payload === null
          ? null
          : {
              proposal: payload.proposal,
              current:
                payload.bindings.find((binding) => binding.kind === "purchase_order") ?? null,
            },
      intake: latest?.intake ?? null,
      impact:
        latest?.assessment === null || latest === null
          ? null
          : (() => {
              const assessment = latest.assessment as {
                demand: unknown;
                totals: unknown;
                shortfalls: unknown;
                supply: unknown;
                eligibility: unknown;
              };
              return {
                demand: assessment.demand,
                totals: assessment.totals,
                shortfalls: assessment.shortfalls,
                supply: assessment.supply,
                eligibility: assessment.eligibility,
              };
            })(),
      options:
        payload === null
          ? null
          : { transferOptions: payload.transferOptions, substitutes: payload.candidateOffers },
      plan:
        plan === null
          ? null
          : {
              planId: plan.planId,
              planVersion: plan.planVersion,
              sha256: plan.sha256,
              payload: plan.payload,
            },
      plans: plans.map((entry) => ({
        planId: entry.planId,
        planVersion: entry.planVersion,
        sha256: entry.sha256,
        current: entry.id === row.currentPlanId,
      })),
      decisions: decisions.map((decision) => ({
        decisionId: decision.id,
        planSha256: plans.find((entry) => entry.id === decision.planRowId)?.sha256 ?? null,
        kind: decision.kind,
        actorId: decision.actorId,
        role: decision.role,
        simulated: decision.simulated,
        outcome: decision.outcome,
        reason: decision.reason,
        status: decision.status,
        binding: decision.binding,
        occurredAt: isoInstant(decision.occurredAt),
        invalidatedAt: decision.invalidatedAt === null ? null : isoInstant(decision.invalidatedAt),
        invalidatedReason: decision.invalidatedReason,
      })),
      actions: actions.map((action) => ({
        planSha256: plans.find((entry) => entry.id === action.planRowId)?.sha256 ?? null,
        actionId: action.actionId,
        kind: action.kind,
        operationId: action.operationId,
        state: action.state,
        reason: action.reason,
        attempts: action.attempts,
        receipt: action.receipt,
        readback: action.readback,
        updatedAt: isoInstant(action.updatedAt),
      })),
      verification: verification?.detail ?? null,
      verificationStatus: verificationCurrency(
        row,
        plan?.sha256 ?? null,
        events,
        now,
        await recheckable(db, row, plan ?? null),
      ),
      lineage: {
        predecessor: await linked(row.predecessorCaseId),
        successor: await linked(row.successorCaseId),
      },
      physicalDelivery: {
        supplierReceipt: "not_recorded",
        transferReceipt: "not_recorded",
        note: "A verified plan is not evidence of physical delivery or customer impact.",
      },
      timeline: events.map((event) => ({
        sequence: event.sequence,
        kind: event.kind,
        fromState: event.fromState,
        toState: event.toState,
        reason: event.reason,
        owner: event.owner,
        actorId: event.actorId,
        detail: event.detail,
        occurredAt: isoInstant(event.occurredAt),
      })),
      agentRun: await workflow.extraction.record(row.id),
    });
  });

  /**
   * Submits one supplier email for extraction. The sender is the envelope
   * sender as received; the text is evidence only. The case opens in
   * `received` and the extraction runs as the case's job.
   */
  app.post("/api/cases/emails", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const user = await sessionUser(request);
    if (user === null) return deny(reply, 401, API_ERRORS.unauthenticated);
    const command = emailIngestCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    if (!(await isMember(user.id, command.data.organizationId))) {
      return deny(reply, 403, API_ERRORS.forbidden);
    }
    return send(reply, await workflow.extraction.ingestEmail(command.data));
  });

  app.post("/api/cases/ingest", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const user = await sessionUser(request);
    if (user === null) return deny(reply, 401, API_ERRORS.unauthenticated);
    const command = ingestMessageCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    if (!(await isMember(user.id, command.data.organizationId))) {
      return deny(reply, 403, API_ERRORS.forbidden);
    }
    try {
      return send(reply, await workflow.ingest(command.data));
    } catch (thrown) {
      // The existing case is no longer open to intake (an escalated blocked
      // case, for example); the ingest rolled back and stored nothing.
      if (!(thrown instanceof CaseStateConflict)) throw thrown;
      return reply.status(409).send({ error: CASE_ERRORS.invalidState, state: thrown.state });
    }
  });

  app.post("/api/cases/:id/decisions", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const command = planDecisionCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    return send(reply, await workflow.decide(found.user.id, found.row.id, command.data));
  });

  app.post("/api/cases/:id/acknowledgements", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const command = acknowledgementCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    return send(reply, await workflow.acknowledge(found.user.id, found.row.id, command.data));
  });

  app.post("/api/cases/:id/escalations", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const command = escalationCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    return send(reply, await workflow.escalate(found.user.id, found.row.id, command.data));
  });

  // N-08 revocation of the current approval (ADR 0016); it never reverses an effect.
  app.post("/api/cases/:id/revocations", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const command = revocationCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    return send(reply, await workflow.revoke(found.user.id, found.row.id, command.data));
  });

  app.post("/api/cases/:id/notes", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const command = caseNoteCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    return send(reply, await workflow.note(found.user.id, found.row.id, command.data));
  });

  app.post("/api/cases/:id/verifications", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const command = verificationCheckCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    return send(
      reply,
      await workflow.recheckVerification(found.user.id, found.row.id, command.data),
    );
  });

  // Clarification, correction and reply (ADR 0014). Each command checks the
  // simulated actor's role and the case basis it names; none sends anything.
  app.post("/api/cases/:id/clarifications", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const command = clarificationRequestCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    return send(
      reply,
      await workflow.clarifications.request(found.user.id, found.row.id, command.data),
    );
  });

  app.post("/api/cases/:id/replies", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const command = supplierReplyCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    return send(
      reply,
      await workflow.clarifications.reply(found.user.id, found.row.id, command.data),
    );
  });

  app.post("/api/cases/:id/corrections", async (request, reply) => {
    if (!originAllowed(request, reply)) return reply;
    const found = await authorizedCase(request, reply);
    if (found === null) return reply;
    const command = fieldCorrectionCommandSchema.safeParse(request.body);
    if (!command.success) return deny(reply, 400, API_ERRORS.invalidRequest);
    return send(
      reply,
      await workflow.clarifications.correct(found.user.id, found.row.id, command.data),
    );
  });

  done();
}
