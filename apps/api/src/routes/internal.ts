import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { API_ERRORS, pilotPayloadSchema } from "@supplier-disruption/contracts";
import {
  CASE_QUEUE,
  PILOT_QUEUE,
  pilotHandlerAttempt,
  pilotOperation,
  pilotReceiptAttempt,
  type CaseJobData,
  type PilotJobData,
} from "@supplier-disruption/db";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Job, PgBoss } from "pg-boss";
import { z } from "zod";
import type { CaseWorkflow } from "../cases/workflow.js";

export const INTERNAL_ERRORS = {
  browserSessionRejected: "browser_session_rejected",
  serviceTokenRequired: "service_token_required",
  jobNotMatched: "job_not_matched",
} as const;

export interface InternalRouteOptions {
  db: NodePgDatabase;
  boss: PgBoss;
  workerServiceToken: string;
  workflow: CaseWorkflow;
}

const paramsSchema = z.strictObject({ id: z.uuid() });
const bodySchema = z.strictObject({
  jobId: z.uuid(),
  workerBootId: z.uuid(),
});

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Worker-only routes. Reachable on the loopback API listener only, never
 * proxied by the web app, and authenticated solely by WORKER_SERVICE_TOKEN.
 */
export function internalRoutes(
  app: FastifyInstance,
  options: InternalRouteOptions,
  done: (error?: Error) => void,
): void {
  const { db, boss } = options;
  const expected = digest(options.workerServiceToken);

  function authenticate(request: FastifyRequest, reply: FastifyReply): boolean {
    // Browser credentials are refused outright, even alongside a valid token.
    if (request.headers.cookie !== undefined) {
      void reply.status(403).send({ error: INTERNAL_ERRORS.browserSessionRejected });
      return false;
    }
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    // Compare fixed-length digests so the comparison time does not depend on the token.
    if (token === undefined || !timingSafeEqual(digest(token), expected)) {
      void reply.status(401).send({ error: INTERNAL_ERRORS.serviceTokenRequired });
      return false;
    }
    return true;
  }

  /**
   * The job named in a worker call, if it is the active job stored for this
   * operation. Scope comes from the stored operation and its job, never from
   * the request alone.
   */
  async function activeJobFor(
    operation: typeof pilotOperation.$inferSelect,
    jobId: string,
  ): Promise<Job<PilotJobData> | null> {
    const job = await boss.getJobById<PilotJobData>(PILOT_QUEUE, jobId);
    if (
      operation.jobId !== jobId ||
      job === null ||
      job.data.operationId !== operation.operationId ||
      job.state !== "active"
    ) {
      return null;
    }
    return job;
  }

  /**
   * Records that a worker handler started an attempt, before it does any work,
   * and returns the stored payload's pilot hold. The worker has no business-table
   * access, so it learns the hold from the API rather than from the job data.
   */
  app.post("/internal/pilot/operations/:id/start", async (request, reply) => {
    if (!authenticate(request, reply)) {
      return reply;
    }
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: API_ERRORS.invalidRequest });
    }
    const operationId = params.data.id;
    const { jobId, workerBootId } = body.data;

    const outcome = await db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(pilotOperation)
        .where(eq(pilotOperation.operationId, operationId));
      if (operation === undefined) {
        return { status: 404, body: { error: API_ERRORS.operationNotFound } } as const;
      }
      const job = await activeJobFor(operation, jobId);
      if (job === null) {
        return { status: 409, body: { error: INTERNAL_ERRORS.jobNotMatched } } as const;
      }
      const [attempt] = await tx
        .insert(pilotHandlerAttempt)
        .values({ operationId, jobId, jobRetryCount: job.retryCount, workerBootId })
        .returning({ id: pilotHandlerAttempt.id, startedAt: pilotHandlerAttempt.startedAt });
      if (attempt === undefined) {
        throw new Error("handler attempt insert did not persist");
      }
      // Validated on submission; reparsed so a stored row can never widen the bound.
      const payload = pilotPayloadSchema.safeParse(operation.payload);
      return {
        status: 201,
        body: {
          attemptId: attempt.id,
          startedAt: attempt.startedAt.toISOString(),
          holdMs: payload.success ? (payload.data.holdMs ?? 0) : 0,
        },
      } as const;
    });

    return reply.status(outcome.status).send(outcome.body);
  });

  app.post("/internal/pilot/operations/:id/receipt", async (request, reply) => {
    if (!authenticate(request, reply)) {
      return reply;
    }
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: API_ERRORS.invalidRequest });
    }
    const operationId = params.data.id;
    const { jobId, workerBootId } = body.data;

    const outcome = await db.transaction(async (tx) => {
      // Row lock serializes concurrent receipt calls for one operation.
      const [operation] = await tx
        .select()
        .from(pilotOperation)
        .where(eq(pilotOperation.operationId, operationId))
        .for("update");
      if (operation === undefined) {
        return { status: 404, body: { error: API_ERRORS.operationNotFound } } as const;
      }

      const job = await activeJobFor(operation, jobId);
      if (job === null) {
        return { status: 409, body: { error: INTERNAL_ERRORS.jobNotMatched } } as const;
      }

      if (operation.receiptId !== null && operation.receiptRecordedAt !== null) {
        await tx.insert(pilotReceiptAttempt).values({
          operationId,
          jobId,
          jobRetryCount: job.retryCount,
          workerBootId,
          outcome: "existing",
          receiptId: operation.receiptId,
        });
        return {
          status: 200,
          body: {
            receiptId: operation.receiptId,
            recordedAt: operation.receiptRecordedAt.toISOString(),
            outcome: "existing",
          },
        } as const;
      }

      const receiptId = randomUUID();
      const [updated] = await tx
        .update(pilotOperation)
        .set({
          state: "completed",
          receiptId,
          receiptRecordedAt: new Date(),
          receiptJobId: jobId,
          updatedAt: new Date(),
        })
        .where(eq(pilotOperation.operationId, operationId))
        .returning();
      if (updated?.receiptRecordedAt == null) {
        throw new Error("receipt update did not persist");
      }
      await tx.insert(pilotReceiptAttempt).values({
        operationId,
        jobId,
        jobRetryCount: job.retryCount,
        workerBootId,
        outcome: "recorded",
        receiptId,
      });
      return {
        status: 201,
        body: {
          receiptId,
          recordedAt: updated.receiptRecordedAt.toISOString(),
          outcome: "recorded",
        },
      } as const;
    });

    return reply.status(outcome.status).send(outcome.body);
  });
  /**
   * Runs one case application job: the API applies, reconciles and verifies
   * the case's approved actions through the source modules. The job must be
   * the active case job for this case. `retry` asks the worker to fail the
   * attempt so pg-boss retries it after an uncertain outcome.
   */
  app.post("/internal/cases/:id/apply", async (request, reply) => {
    if (!authenticate(request, reply)) {
      return reply;
    }
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: API_ERRORS.invalidRequest });
    }
    const caseId = params.data.id;
    const job = await boss.getJobById<CaseJobData>(CASE_QUEUE, body.data.jobId);
    if (job === null || job.data.caseId !== caseId || job.state !== "active") {
      return reply.status(409).send({ error: INTERNAL_ERRORS.jobNotMatched });
    }
    const outcome = await options.workflow.advance(caseId);
    request.log.info({ caseId, jobId: job.id, ...outcome }, "case application run");
    return reply.status(200).send(outcome);
  });
  done();
}
