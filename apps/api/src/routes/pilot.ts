import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  API_ERRORS,
  PILOT_STREAM_EVENT,
  PILOT_STREAM_EVENT_COUNT,
  PILOT_STREAM_INTERVAL_MS,
  PILOT_STREAM_MAX_MS,
  pilotDigestInput,
  pilotOperationCommandSchema,
  type PilotOperation,
  type PilotOperationCommand,
  type PilotStreamEvent,
  type SessionResponse,
} from "@supplier-disruption/contracts";
import {
  PILOT_QUEUE,
  PILOT_JOB_OPTIONS,
  membership,
  organization,
  pilotOperation,
  type PilotJobData,
} from "@supplier-disruption/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fromDrizzle, type Db, type PgBoss } from "pg-boss";
import { z } from "zod";
import type { Auth } from "../auth.js";
import {
  pilotEventId,
  resumePoint,
  type PilotStreams,
  type StreamCloseReason,
} from "../streams.js";

/**
 * Test-only fault hooks. Production wiring never supplies them; integration
 * tests pass them to buildApp to interrupt the enqueue transaction.
 */
export interface PilotFaultHooks {
  /** Wraps the transaction-bound database handed to pg-boss `send`. */
  wrapSendDatabase?: (db: Db) => Db;
  /** Runs after `send` returned a job ID, before the transaction commits. */
  afterSend?: (operationId: string) => Promise<void>;
  /** Runs before a status stream reads the state for event `seq`. */
  beforeStreamEvent?: (operationId: string, seq: number) => Promise<void>;
}

export interface PilotRouteOptions {
  db: NodePgDatabase;
  auth: Auth;
  boss: PgBoss;
  appOrigin: string;
  streams: PilotStreams;
  faults: PilotFaultHooks | undefined;
}

type OperationRow = typeof pilotOperation.$inferSelect;

class NullSendError extends Error {}

const operationParamsSchema = z.strictObject({ id: z.uuid() });

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function toOperationResponse(row: OperationRow): PilotOperation {
  return {
    contractVersion: row.contractVersion as PilotOperation["contractVersion"],
    operationId: row.operationId,
    organizationId: row.organizationId,
    payload: row.payload as PilotOperation["payload"],
    state: row.state,
    receipt:
      row.receiptId !== null && row.receiptRecordedAt !== null
        ? { receiptId: row.receiptId, recordedAt: row.receiptRecordedAt.toISOString() }
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function deny(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error });
}

export function pilotRoutes(
  app: FastifyInstance,
  options: PilotRouteOptions,
  done: (error?: Error) => void,
): void {
  const { db, auth, boss, appOrigin, streams, faults } = options;

  async function sessionUser(request: FastifyRequest) {
    const result = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      // A read only: the refresh route alone slides a session, because only it
      // sends the renewed cookie back to the browser (ADR 0020).
      query: { disableCookieCache: true, disableRefresh: true },
    });
    return result?.user ?? null;
  }

  async function roleIn(userId: string, organizationId: string) {
    const [row] = await db
      .select({ role: membership.role })
      .from(membership)
      .where(and(eq(membership.userId, userId), eq(membership.organizationId, organizationId)));
    return row?.role ?? null;
  }

  async function loadOperation(operationId: string) {
    const [row] = await db
      .select()
      .from(pilotOperation)
      .where(eq(pilotOperation.operationId, operationId));
    return row ?? null;
  }

  /**
   * Resolves a command against an operation that already exists. The caller
   * has already been authorized as a manager of the submitted organization.
   */
  function resolveExisting(
    reply: FastifyReply,
    existing: OperationRow,
    command: PilotOperationCommand,
    digest: string,
  ) {
    if (existing.organizationId !== command.organizationId) {
      // Fixed generic denial: reveals nothing about the owner, payload, state or receipt.
      return deny(reply, 409, API_ERRORS.operationIdUnavailable);
    }
    if (existing.payloadSha256 !== digest) {
      return deny(reply, 409, API_ERRORS.operationPayloadConflict);
    }
    return reply.status(200).send(toOperationResponse(existing));
  }

  app.get("/api/session", async (request, reply) => {
    const current = await sessionUser(request);
    if (current === null) {
      return deny(reply, 401, API_ERRORS.unauthenticated);
    }
    const memberships = await db
      .select({
        organizationId: membership.organizationId,
        organizationName: organization.name,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(organization, eq(organization.id, membership.organizationId))
      .where(eq(membership.userId, current.id))
      .orderBy(organization.name);
    const body: SessionResponse = {
      user: { id: current.id, email: current.email, name: current.name },
      memberships,
    };
    return reply.send(body);
  });

  app.get("/api/pilot/operations/:id", async (request, reply) => {
    const current = await sessionUser(request);
    if (current === null) {
      return deny(reply, 401, API_ERRORS.unauthenticated);
    }
    const params = operationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return deny(reply, 400, API_ERRORS.invalidRequest);
    }
    const existing = await loadOperation(params.data.id);
    // A non-member cannot distinguish another organization's operation from a missing one.
    if (existing === null || (await roleIn(current.id, existing.organizationId)) === null) {
      return deny(reply, 404, API_ERRORS.operationNotFound);
    }
    return reply.send(toOperationResponse(existing));
  });

  /**
   * Bounded status stream for one operation, authorized like the operation
   * read. Events are written to the response as they are produced; nothing
   * is buffered until the end. When the client goes away, Fastify destroys
   * the body stream, which stops the timers and unregisters the stream.
   *
   * The session and membership are read again before every event, so a
   * revoked or expired session, or a removed membership, closes the stream
   * before its next event (ADR 0020). A reconnect with Last-Event-ID resumes
   * after that event of the same bounded sequence; states are read fresh.
   */
  // No automatic HEAD route: Fastify would drain the stream for HEAD without
  // ever closing it, so it would run to its end with nobody reading.
  app.get(
    "/api/pilot/operations/:id/events",
    { exposeHeadRoute: false },
    async (request, reply) => {
      const current = await sessionUser(request);
      if (current === null) {
        return deny(reply, 401, API_ERRORS.unauthenticated);
      }
      const params = operationParamsSchema.safeParse(request.params);
      if (!params.success) {
        return deny(reply, 400, API_ERRORS.invalidRequest);
      }
      const operationId = params.data.id;
      const existing = await loadOperation(operationId);
      if (existing === null || (await roleIn(current.id, existing.organizationId)) === null) {
        return deny(reply, 404, API_ERRORS.operationNotFound);
      }
      const resume = resumePoint(request.headers["last-event-id"], operationId);
      if (resume.kind === "invalid") {
        return deny(reply, 400, API_ERRORS.invalidRequest);
      }
      if (resume.kind === "complete") {
        // 204 tells an EventSource that reconnects after the final event to stop.
        return reply.status(204).send();
      }

      // The stream ID appears only in the server log, never in an event.
      const log = request.log.child({ stream: randomUUID(), operationId });
      const body = new PassThrough();
      const openedAt = Date.now();
      const first = resume.kind === "resume" ? resume.after : 0;
      let seq = first;
      let closed = false;
      let next: NodeJS.Timeout | undefined;

      const close = (reason: StreamCloseReason) => {
        if (closed) return;
        closed = true;
        clearTimeout(next);
        clearTimeout(bound);
        untrack();
        log.info({ reason, events: seq - first, lastSeq: seq }, "pilot stream closed");
        if (!body.destroyed) body.end();
      };
      const bound = setTimeout(() => close("max_duration"), PILOT_STREAM_MAX_MS);
      const untrack = streams.track(close);
      // Fires after a normal end too; close() has already run then and ignores it.
      body.once("close", () => close("client_disconnect"));

      /** The same session, still current, and its user still a member of the organization. */
      const stillAuthorized = async () => {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(request.headers),
          // A read only: polling must not slide the session's expiry.
          query: { disableCookieCache: true, disableRefresh: true },
        });
        return (
          session?.user.id === current.id &&
          (await roleIn(current.id, existing.organizationId)) !== null
        );
      };

      const emit = async () => {
        await faults?.beforeStreamEvent?.(operationId, seq + 1);
        const row = await loadOperation(operationId);
        if (closed) return;
        // The first event of a stream follows the checks above; later ones
        // recheck last, so nothing awaits between the check and the write.
        if (seq > first && !(await stillAuthorized())) {
          close("revoked");
          return;
        }
        if (closed) return;
        seq += 1;
        const event: PilotStreamEvent = {
          seq,
          operationId,
          state: (row ?? existing).state,
          emittedAt: new Date().toISOString(),
          final: seq === PILOT_STREAM_EVENT_COUNT,
        };
        body.write(
          `id: ${pilotEventId(operationId, seq)}\nevent: ${PILOT_STREAM_EVENT}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        log.info({ seq }, "pilot stream event");
        if (event.final) {
          close("completed");
          return;
        }
        // Scheduled from the opening time, so the interval does not drift.
        next = setTimeout(
          () => void emitSafely(),
          Math.max(0, openedAt + (seq - first) * PILOT_STREAM_INTERVAL_MS - Date.now()),
        );
      };
      const emitSafely = async () => {
        try {
          await emit();
        } catch (error) {
          log.error({ err: error }, "pilot stream event failed");
          close("error");
        }
      };

      void reply
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache, no-transform")
        .header("x-accel-buffering", "no");
      void emitSafely();
      return reply.send(body);
    },
  );

  app.post("/api/pilot/operations", async (request, reply) => {
    if (request.headers.origin !== appOrigin) {
      return deny(reply, 403, API_ERRORS.originRejected);
    }
    const current = await sessionUser(request);
    if (current === null) {
      return deny(reply, 401, API_ERRORS.unauthenticated);
    }
    const parsed = pilotOperationCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      return deny(reply, 400, API_ERRORS.invalidRequest);
    }
    const command = parsed.data;

    // Fresh membership read on every command; no cached role.
    if ((await roleIn(current.id, command.organizationId)) !== "manager") {
      return deny(reply, 403, API_ERRORS.forbidden);
    }

    const digest = sha256(pilotDigestInput(command));
    const existing = await loadOperation(command.operationId);
    if (existing !== null) {
      return resolveExisting(reply, existing, command, digest);
    }

    let created: OperationRow | null;
    try {
      created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(pilotOperation)
          .values({
            operationId: command.operationId,
            organizationId: command.organizationId,
            submittedBy: current.id,
            contractVersion: command.contractVersion,
            payload: command.payload,
            payloadSha256: digest,
          })
          .onConflictDoNothing({ target: pilotOperation.operationId })
          .returning();
        if (row === undefined) {
          // A concurrent request committed this operation ID first.
          return null;
        }

        const txDb = fromDrizzle(tx, sql);
        const data: PilotJobData = { operationId: command.operationId };
        const jobId = await boss.send(PILOT_QUEUE, data, {
          ...PILOT_JOB_OPTIONS,
          singletonKey: command.operationId,
          db: faults?.wrapSendDatabase ? faults.wrapSendDatabase(txDb) : txDb,
        });
        if (jobId === null) {
          // Never ignored: roll back and resolve against whatever operation exists.
          throw new NullSendError();
        }
        await faults?.afterSend?.(command.operationId);

        const [updated] = await tx
          .update(pilotOperation)
          .set({ jobId })
          .where(eq(pilotOperation.operationId, command.operationId))
          .returning();
        if (updated === undefined) {
          throw new Error("operation row vanished inside its own transaction");
        }
        return updated;
      });
    } catch (error) {
      if (!(error instanceof NullSendError)) {
        request.log.error({ err: error, operationId: command.operationId }, "pilot enqueue failed");
        return deny(reply, 503, API_ERRORS.enqueueFailed);
      }
      created = null;
    }

    if (created !== null) {
      return reply.status(202).send(toOperationResponse(created));
    }
    const winner = await loadOperation(command.operationId);
    if (winner === null) {
      request.log.error({ operationId: command.operationId }, "pilot enqueue returned no job");
      return deny(reply, 503, API_ERRORS.enqueueFailed);
    }
    return resolveExisting(reply, winner, command, digest);
  });
  done();
}
