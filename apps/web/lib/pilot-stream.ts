import { PILOT_STREAM_EVENT, type PilotStreamEvent } from "@supplier-disruption/contracts";

/** One dispatched server-sent event: its type, data and the stream's last event ID. */
export interface SseMessage {
  event: string;
  data: string;
  lastEventId: string;
}

/**
 * An incremental `text/event-stream` parser for the fields the pilot stream
 * uses (`id`, `event`, `data`), following the HTML event-stream rules: a
 * blank line dispatches, a comment line is ignored, and the last event ID
 * persists across events.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  lastEventId: string;

  constructor(lastEventId = "") {
    this.lastEventId = lastEventId;
  }

  push(chunk: string): SseMessage[] {
    const text = this.buffer + chunk;
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\n") {
        lines.push(text.slice(start, index));
        start = index + 1;
      } else if (char === "\r") {
        // A chunk ending in \r may be half of a \r\n; wait for the next one.
        if (index + 1 === text.length) break;
        lines.push(text.slice(start, index));
        if (text[index + 1] === "\n") index += 1;
        start = index + 1;
      }
    }
    this.buffer = text.slice(start);
    const messages: SseMessage[] = [];
    for (const line of lines) {
      if (line === "") {
        if (this.data.length > 0) {
          messages.push({
            event: this.event === "" ? "message" : this.event,
            data: this.data.join("\n"),
            lastEventId: this.lastEventId,
          });
        }
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
      else if (field === "id" && !value.includes("\0")) this.lastEventId = value;
    }
    return messages;
  }
}

/**
 * Waits before each reconnect after an interruption. A reconnect that
 * delivers an event starts the count again; three in a row that deliver
 * nothing end the attempt.
 */
export const RESUME_DELAYS_MS = [500, 1_000, 2_000] as const;

/** How the stream route answered a (re)connect (ADR 0020). */
export function classifyStreamStatus(status: number): "stream" | "ended" | "refused" | "retry" {
  if (status === 200) return "stream";
  // 204 answers a Last-Event-ID for the final event: nothing is left to send.
  if (status === 204) return "ended";
  // A revoked or expired session (401), a lost membership (404) or an ID the
  // API will not resume (400): reconnecting cannot help.
  if (status === 400 || status === 401 || status === 403 || status === 404) return "refused";
  return "retry";
}

export type StreamOutcome =
  | { kind: "ended" }
  | { kind: "refused"; status: number }
  | { kind: "interrupted" }
  | { kind: "aborted" };

export interface FollowOptions {
  signal: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: PilotStreamEvent) => void;
  /** Called before each wait for a reconnect, with its 1-based attempt number. */
  onReconnecting?: (attempt: number) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function drain(reader: ReadableStreamDefaultReader<string>): Promise<void> {
  try {
    while (!(await reader.read()).done);
  } catch {
    // Aborted or failed after the final event: nothing is left to read.
  }
}

/**
 * Follows one operation's bounded status stream. After an interruption it
 * reconnects with `Last-Event-ID` set to the last ID received, so the API
 * continues the same 5-event sequence after that event, reading states
 * fresh. That is a continuation, not a replay: there is no event log, and a
 * missed state is not recovered. It stops at the final event, on 204, on a
 * refusal, or after the bounded reconnects deliver nothing.
 */
export async function followPilotStream(
  url: string,
  options: FollowOptions,
): Promise<StreamOutcome> {
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const { signal } = options;
  let lastEventId = "";
  let lastSeq = 0;
  let failures = 0;

  while (!signal.aborted) {
    if (failures > 0) {
      const delay = RESUME_DELAYS_MS[failures - 1];
      if (delay === undefined) return { kind: "interrupted" };
      options.onReconnecting?.(failures);
      await sleep(delay, signal);
      if (signal.aborted) break;
    }
    let delivered = false;
    let reader: ReadableStreamDefaultReader<string> | undefined;
    try {
      const response = await request(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "text/event-stream",
          ...(lastEventId === "" ? {} : { "last-event-id": lastEventId }),
        },
        signal,
      });
      const kind = classifyStreamStatus(response.status);
      if (kind === "ended") return { kind: "ended" };
      if (kind === "refused") return { kind: "refused", status: response.status };
      if (kind === "stream" && response.body !== null) {
        options.onOpen?.();
        const parser = new SseParser(lastEventId);
        reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const message of parser.push(value)) {
            if (message.event !== PILOT_STREAM_EVENT) continue;
            const event = JSON.parse(message.data) as PilotStreamEvent;
            lastEventId = message.lastEventId;
            // A resumed stream starts after the last event; never show one twice.
            if (event.seq <= lastSeq) continue;
            lastSeq = event.seq;
            delivered = true;
            options.onEvent(event);
            if (event.final) {
              // The server ends the response right after its final event. Let it
              // finish rather than cancel it, so the request completes normally.
              void drain(reader);
              return { kind: "ended" };
            }
          }
        }
      }
    } catch {
      // Release the failed response before reconnecting, so it holds no connection.
      void reader?.cancel().catch(() => undefined);
      if (signal.aborted) break;
    }
    // The stream ended or failed before its final event, or never opened.
    failures = delivered ? 1 : failures + 1;
  }
  return { kind: "aborted" };
}
