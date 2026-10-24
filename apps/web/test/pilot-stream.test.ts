import {
  PILOT_STREAM_EVENT,
  PILOT_STREAM_EVENT_COUNT,
  type PilotStreamEvent,
} from "@supplier-disruption/contracts";
import { describe, expect, it } from "vitest";
import {
  RESUME_DELAYS_MS,
  SseParser,
  followPilotStream,
  type StreamOutcome,
} from "../lib/pilot-stream";

const OPERATION = "0b6f1c1e-5a7d-4c55-9a3e-2f4d8f1b9c01";

function frame(seq: number): string {
  const event: PilotStreamEvent = {
    seq,
    operationId: OPERATION,
    state: "queued",
    emittedAt: new Date(0).toISOString(),
    final: seq === PILOT_STREAM_EVENT_COUNT,
  };
  return `id: ${OPERATION}:${String(seq)}\nevent: ${PILOT_STREAM_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

const stream = (...chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

type Answer = Response | Error;

/** A scripted fetch: each call takes the next answer and records its Last-Event-ID. */
function scripted(answers: Answer[]) {
  const sent: (string | null)[] = [];
  const request = ((_url: string, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get("last-event-id"));
    const answer = answers.shift() ?? new Error("unexpected request");
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }) as typeof fetch;
  return { request, sent };
}

async function follow(answers: Answer[]) {
  const { request, sent } = scripted(answers);
  const seqs: number[] = [];
  const waits: number[] = [];
  const outcome: StreamOutcome = await followPilotStream("/events", {
    signal: new AbortController().signal,
    onEvent: (event) => seqs.push(event.seq),
    fetch: request,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  return { outcome, sent, seqs, waits };
}

describe("SseParser", () => {
  it("dispatches on blank lines across chunk and CRLF boundaries and keeps the last ID", () => {
    const parser = new SseParser();
    expect(parser.push(": comment\r\nid: a:1\r")).toEqual([]);
    expect(parser.push("\nevent: status\r\ndata: one\ndata: two\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "status", data: "one\ntwo", lastEventId: "a:1" }]);
    expect(parser.push("data: three\n\n")).toEqual([
      { event: "message", data: "three", lastEventId: "a:1" },
    ]);
  });
});

describe("followPilotStream", () => {
  it("reads a whole stream once and stops at the final event", async () => {
    const result = await follow([stream(frame(1), frame(2), frame(3), frame(4), frame(5))]);
    expect(result).toEqual({
      outcome: { kind: "ended" },
      sent: [null],
      seqs: [1, 2, 3, 4, 5],
      waits: [],
    });
  });

  it("resumes after an interruption from the last event ID, without duplicates", async () => {
    const result = await follow([
      stream(frame(1), frame(2)),
      // A network failure before anything arrives keeps the same resume point.
      new TypeError("network"),
      stream(frame(2), frame(3), frame(4), frame(5)),
    ]);
    expect(result.outcome).toEqual({ kind: "ended" });
    expect(result.sent).toEqual([null, `${OPERATION}:2`, `${OPERATION}:2`]);
    expect(result.seqs).toEqual([1, 2, 3, 4, 5]);
    expect(result.waits).toEqual([RESUME_DELAYS_MS[0], RESUME_DELAYS_MS[1]]);
  });

  it("classifies a 204 reconnect as ended and makes no further request", async () => {
    const result = await follow([
      stream(frame(1), frame(2), frame(3), frame(4)),
      new Response(null, { status: 204 }),
    ]);
    expect(result.outcome).toEqual({ kind: "ended" });
    expect(result.sent).toEqual([null, `${OPERATION}:4`]);
  });

  it.each([400, 401, 404])("stops when a reconnect is refused with %i", async (status) => {
    const result = await follow([
      stream(frame(1), frame(2)),
      Response.json({ error: "refused" }, { status }),
    ]);
    expect(result.outcome).toEqual({ kind: "refused", status });
    expect(result.sent).toHaveLength(2);
  });

  it("gives up after the bounded reconnects deliver nothing", async () => {
    const result = await follow([
      stream(frame(1)),
      new Response(null, { status: 503 }),
      new TypeError("network"),
      stream(),
    ]);
    expect(result.outcome).toEqual({ kind: "interrupted" });
    expect(result.sent).toEqual([null, `${OPERATION}:1`, `${OPERATION}:1`, `${OPERATION}:1`]);
    expect(result.waits).toEqual([...RESUME_DELAYS_MS]);
  });

  it("makes no request once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { request, sent } = scripted([]);
    const outcome = await followPilotStream("/events", {
      signal: controller.signal,
      onEvent: () => undefined,
      fetch: request,
    });
    expect(outcome).toEqual({ kind: "aborted" });
    expect(sent).toEqual([]);
  });
});
