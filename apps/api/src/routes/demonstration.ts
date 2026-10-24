import {
  API_ERRORS,
  type DemonstrationStatus,
  type PlanPayload,
} from "@supplier-disruption/contracts";
import { casePlan, membership } from "@supplier-disruption/db";
import { SourceRejectedError } from "@supplier-disruption/db/inventory";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { CASE_FIXTURE } from "../cases/fixture.js";
import { appendEvent, lockCase } from "../cases/store.js";
import { CASE_ERRORS, type CaseWorkflow } from "../cases/workflow.js";
import {
  DEMONSTRATION_CONTROLS,
  DEMONSTRATION_NOTICE,
  FOREIGN_RESERVATION,
  type Demonstration,
} from "../demonstration/index.js";

export interface DemonstrationRouteOptions {
  db: NodePgDatabase;
  auth: Auth;
  appOrigin: string;
  workflow: CaseWorkflow;
  /** Null outside the demonstration mode: the status says so and every control is 404. */
  demonstration: Demonstration | null;
}

const paramsSchema = z.strictObject({ id: z.uuid() });
const controlSchema = z.strictObject({
  control: z.enum(["foreign_reservation", "uncertain_reservation_write"]),
});

/** States in which the case's application has not claimed its reservation yet. */
const BEFORE_APPLICATION = ["awaiting_approval", "awaiting_acknowledgement"];

/**
 * The demonstration status and its two labelled controls (ADR 0012). A
 * control is a simulated source change or fault, recorded on the case as a
 * `demonstration_control` event; it never decides, acknowledges or applies.
 */
export function demonstrationRoutes(
  app: FastifyInstance,
  options: DemonstrationRouteOptions,
  done: (error?: Error) => void,
): void {
  const { db, auth, appOrigin, workflow, demonstration } = options;

  // Public, like the sign-in page that shows it: it carries no case or identity data.
  app.get("/api/demonstration", async (_request, reply) => {
    const status: DemonstrationStatus =
      demonstration === null
        ? { active: false }
        : {
            active: true,
            notice: DEMONSTRATION_NOTICE,
            businessClock: await app.businessClock.now(),
            agentProvider: "replay",
            controls: DEMONSTRATION_CONTROLS,
          };
    return reply.send(status);
  });

  async function member(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers.origin !== appOrigin) {
      await reply.status(403).send({ error: API_ERRORS.originRejected });
      return null;
    }
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      // A read only: the refresh route alone slides a session, because only it
      // sends the renewed cookie back to the browser (ADR 0020).
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (session === null) {
      await reply.status(401).send({ error: API_ERRORS.unauthenticated });
      return null;
    }
    const params = paramsSchema.safeParse(request.params);
    const body = controlSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      await reply.status(400).send({ error: API_ERRORS.invalidRequest });
      return null;
    }
    const [row] = await db
      .select({ role: membership.role })
      .from(membership)
      .where(
        and(
          eq(membership.userId, session.user.id),
          eq(membership.organizationId, CASE_FIXTURE.organization.id),
        ),
      );
    if (row === undefined) {
      await reply.status(404).send({ error: CASE_ERRORS.caseNotFound });
      return null;
    }
    return { caseId: params.data.id, control: body.data.control };
  }

  app.post("/api/demonstration/cases/:id/controls", async (request, reply) => {
    if (demonstration === null) {
      return reply.status(404).send({ error: "demonstration_inactive" });
    }
    const found = await member(request, reply);
    if (found === null) return reply;
    const { caseId, control } = found;

    if (control === "uncertain_reservation_write") {
      return db.transaction(async (tx) => {
        const row = await lockCase(tx, caseId);
        if (row?.organizationId !== CASE_FIXTURE.organization.id) {
          return reply.status(404).send({ error: CASE_ERRORS.caseNotFound });
        }
        const [plan] =
          row.currentPlanId === null
            ? []
            : await tx.select().from(casePlan).where(eq(casePlan.id, row.currentPlanId));
        const reserves = (plan?.payload as PlanPayload | undefined)?.actions.some(
          (action) => action.kind === "reserve",
        );
        if (!BEFORE_APPLICATION.includes(row.state) || reserves !== true) {
          return reply.status(409).send({ error: CASE_ERRORS.invalidState, state: row.state });
        }
        demonstration.arm(caseId);
        await appendEvent(tx, row, await workflow.deps.clock.now(), {
          kind: "demonstration_control",
          detail: {
            control,
            simulated: true,
            note: "The next ACT-2 reservation write of this case loses its response after the source commits it.",
          },
        });
        return reply.status(201).send({ control, recorded: true, state: row.state });
      });
    }

    // Another order reserves 20 EA at WH-B through the inventory authority:
    // the stock version moves and WH-B's eligible stock falls from 50 to 30.
    const { inventory } = workflow.sources;
    const organization = CASE_FIXTURE.label;
    const earlier = await inventory.lookupOperation({
      organization,
      operationId: FOREIGN_RESERVATION.operationId,
    });
    let receipt: { priorVersion: string; successorVersion: string } | null = null;
    if (earlier === null) {
      const head = await inventory.readStock({
        organization,
        sku: FOREIGN_RESERVATION.sku,
        warehouse: FOREIGN_RESERVATION.warehouse,
      });
      try {
        const result = await inventory.reserveUnrelated({
          ...FOREIGN_RESERVATION,
          organization,
          expectedVersion: head.currentVersion,
        });
        receipt = result.receipt;
      } catch (thrown) {
        if (!(thrown instanceof SourceRejectedError)) throw thrown;
        return reply.status(409).send({ error: "source_rejected", reason: thrown.reason });
      }
    }
    return db.transaction(async (tx) => {
      const row = await lockCase(tx, caseId);
      if (row?.organizationId !== CASE_FIXTURE.organization.id) {
        return reply.status(404).send({ error: CASE_ERRORS.caseNotFound });
      }
      if (receipt === null) {
        return reply.status(200).send({ control, recorded: false, state: row.state });
      }
      await appendEvent(tx, row, await workflow.deps.clock.now(), {
        kind: "demonstration_control",
        detail: {
          control,
          simulated: true,
          operationId: FOREIGN_RESERVATION.operationId,
          warehouse: FOREIGN_RESERVATION.warehouse,
          quantity: FOREIGN_RESERVATION.quantity,
          priorVersion: receipt.priorVersion,
          successorVersion: receipt.successorVersion,
          note: "Another order reserved 20 EA of PART-A at WH-B (simulated source change).",
        },
      });
      return reply.status(201).send({ control, recorded: true, state: row.state });
    });
  });

  done();
}
