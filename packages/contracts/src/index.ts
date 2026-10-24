import { z } from "zod";

export * from "./domain/index.js";

/**
 * Pilot operation contracts. The operation is a deliberately non-procurement
 * placeholder used to prove sessions, authorization, atomic enqueue and replay.
 */
export const PILOT_CONTRACT_VERSION = "pilot-operation.v1";

/**
 * Upper bound for `holdMs`: inside the pilot job's 30-second expiry and the
 * worker's 10 s shutdown drain, so a held job started just before a container
 * stop still records its receipt (ADR 0002).
 */
export const PILOT_MAX_HOLD_MS = 8_000;

export const pilotPayloadSchema = z.strictObject({
  note: z.string().min(1).max(200),
  /**
   * How long the worker handler waits before recording its receipt. Part of
   * the pilot placeholder contract in every mode, so container tests can hold
   * a job in flight without test hooks. Absent means 0. Being optional rather
   * than defaulted keeps the digest of payloads without it unchanged.
   */
  holdMs: z.number().int().min(0).max(PILOT_MAX_HOLD_MS).optional(),
});

export const pilotOperationCommandSchema = z.strictObject({
  contractVersion: z.literal(PILOT_CONTRACT_VERSION),
  operationId: z.uuid(),
  organizationId: z.uuid(),
  payload: pilotPayloadSchema,
});

export type PilotOperationCommand = z.infer<typeof pilotOperationCommandSchema>;

export const pilotOperationStateSchema = z.enum(["queued", "completed"]);

export const pilotReceiptSchema = z.strictObject({
  receiptId: z.uuid(),
  recordedAt: z.iso.datetime({ offset: true }),
});

export const pilotOperationSchema = z.strictObject({
  contractVersion: z.literal(PILOT_CONTRACT_VERSION),
  operationId: z.uuid(),
  organizationId: z.uuid(),
  payload: pilotPayloadSchema,
  state: pilotOperationStateSchema,
  receipt: pilotReceiptSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type PilotOperation = z.infer<typeof pilotOperationSchema>;

/**
 * Bounded pilot status stream (`GET /api/pilot/operations/:id/events`): the
 * first event goes out as soon as the stream opens, then one per interval,
 * five in total, then the server closes it. Replay after an event ID is not
 * part of the pilot; a reconnect starts a new stream.
 */
export const PILOT_STREAM_EVENT_COUNT = 5;
export const PILOT_STREAM_INTERVAL_MS = 1_000;
/**
 * Every pilot stream closes within this bound, whatever happens. It leaves a
 * margin under the web service's 10 s s6 kill timeout, so a stream opened
 * just before a stop ends before the Next server could be killed (ADR 0003).
 */
export const PILOT_STREAM_MAX_MS = 8_000;
/** The SSE event name of every pilot stream event. */
export const PILOT_STREAM_EVENT = "status";

/**
 * One stream event. It carries the operation ID and its current state only:
 * no job, receipt, session or user identifier.
 */
export const pilotStreamEventSchema = z.strictObject({
  seq: z.number().int().min(1).max(PILOT_STREAM_EVENT_COUNT),
  operationId: z.uuid(),
  state: pilotOperationStateSchema,
  /** Server clock when the event was written to the response. */
  emittedAt: z.iso.datetime({ offset: true }),
  /** True on the last event; the client closes its connection then. */
  final: z.boolean(),
});

export type PilotStreamEvent = z.infer<typeof pilotStreamEventSchema>;

export const membershipRoleSchema = z.enum(["buyer", "manager"]);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const sessionResponseSchema = z.strictObject({
  user: z.strictObject({
    id: z.string(),
    email: z.string(),
    name: z.string(),
  }),
  memberships: z.array(
    z.strictObject({
      organizationId: z.uuid(),
      organizationName: z.string(),
      role: membershipRoleSchema,
    }),
  ),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** Stable error codes returned by the API. Bodies are `{ "error": code }`. */
export const API_ERRORS = {
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  originRejected: "origin_rejected",
  invalidRequest: "invalid_request",
  operationIdUnavailable: "operation_id_unavailable",
  operationPayloadConflict: "operation_payload_conflict",
  operationNotFound: "operation_not_found",
  enqueueFailed: "enqueue_failed",
} as const;

export type ApiErrorCode = (typeof API_ERRORS)[keyof typeof API_ERRORS];

/**
 * Canonical JSON: object keys sorted by code point at every level, no
 * insignificant whitespace. Used as the input to payload digests so that key
 * order or formatting never changes an operation's identity.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJson does not accept non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson does not accept ${typeof value}`);
}

/**
 * The immutable fields that define an operation's payload digest. The
 * submitting actor is recorded separately and deliberately not hashed.
 */
export function pilotDigestInput(command: PilotOperationCommand): string {
  return canonicalJson({
    contractVersion: command.contractVersion,
    organizationId: command.organizationId,
    payload: command.payload,
  });
}
