import { PILOT_STREAM_EVENT_COUNT } from "@supplier-disruption/contracts";

export type StreamCloseReason =
  "completed" | "client_disconnect" | "max_duration" | "shutdown" | "error" | "revoked";

/**
 * The pilot status streams this API process has open. Each stream registers
 * a close function; the count is exposed on the internal health surface, and
 * shutdown closes every stream so the server does not wait for them.
 */
export class PilotStreams {
  private readonly open = new Set<(reason: StreamCloseReason) => void>();

  get count(): number {
    return this.open.size;
  }

  /** Registers an open stream. The returned function unregisters it. */
  track(close: (reason: StreamCloseReason) => void): () => void {
    this.open.add(close);
    return () => {
      this.open.delete(close);
    };
  }

  closeAll(reason: StreamCloseReason): void {
    for (const close of [...this.open]) close(reason);
  }
}

/**
 * The SSE `id:` of pilot stream event `seq`. It names the operation, so an ID
 * sent back on another operation's stream is refused rather than resumed
 * (ADR 0020).
 */
export function pilotEventId(operationId: string, seq: number): string {
  return `${operationId}:${String(seq)}`;
}

export type ResumePoint =
  | { kind: "start" }
  | { kind: "resume"; after: number }
  | { kind: "complete" }
  | { kind: "invalid" };

/**
 * Where a reconnecting client resumes, from its Last-Event-ID header. Only an
 * ID this stream could have sent for this operation is accepted; the next
 * event is `after + 1`, read fresh. Nothing older is replayed: the pilot
 * stream keeps no event log.
 */
export function resumePoint(
  header: string | string[] | undefined,
  operationId: string,
): ResumePoint {
  if (header === undefined) return { kind: "start" };
  if (typeof header !== "string") return { kind: "invalid" };
  const match = /^([0-9a-f-]{36}):([1-9][0-9]?)$/.exec(header);
  if (match === null || match[1] !== operationId) return { kind: "invalid" };
  const after = Number(match[2]);
  if (after > PILOT_STREAM_EVENT_COUNT) return { kind: "invalid" };
  return after === PILOT_STREAM_EVENT_COUNT ? { kind: "complete" } : { kind: "resume", after };
}
