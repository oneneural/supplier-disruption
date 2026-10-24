// A local stand-in for the Anthropic Messages API, for the checkpoint recovery
// gates. The built API reaches it through the SDK's ANTHROPIC_BASE_URL, so
// the real provider adapter, spend admission and PostgreSQL checkpoint run
// unchanged while nothing leaves this machine. It answers the C-01 email's
// investigation turn by turn (read the evidence, read PO-120, propose) and can
// hold a turn's request unanswered, so a test can stop the API while that
// model call is in flight.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const q = (value: string, quote: string) => ({ value, quote, confidence: "high" });

/** A proposal whose every quote occurs in the C-01 email (evaluation/scenarios/dev/D01.json). */
export const C01_PROPOSAL = {
  poNumber: q("PO-120", "purchase order PO-120 (revision 3), line 10"),
  poLine: {
    value: "10",
    cite: { source: "email", quote: "PO-120 (revision 3), line 10" },
    confidence: "high",
  },
  baseRevision: {
    value: "3",
    cite: { source: "email", quote: "PO-120 (revision 3)" },
    confidence: "high",
  },
  vendorItem: q("KF-A-01", "our item KF-A-01"),
  uom: q("EA", "40 EA"),
  segments: [
    {
      quantity: q("40", "We can deliver 40 EA"),
      arrival: {
        state: "dated",
        date: "2026-10-23",
        quote: "We can deliver 40 EA to your warehouse on 23 October 2026",
        confidence: "high",
      },
    },
    {
      quantity: q("80", "the remaining 80 EA"),
      arrival: {
        state: "dated",
        date: "2026-10-26",
        quote: "the remaining 80 EA will arrive on 26 October 2026",
        confidence: "high",
      },
    },
  ],
  rationale: "The email splits line 10 into 40 EA on 23 October and 80 EA on 26 October.",
};

/** The tool each turn calls; turn n is the request with 2n - 1 messages. */
const TURNS: Record<number, { name: string; input: unknown }> = {
  1: { name: "read_case_evidence", input: {} },
  2: { name: "read_purchase_order", input: { poNumber: "PO-120" } },
  3: { name: "propose_supplier_terms", input: C01_PROPOSAL },
};

/** Usage every answer reports: 1,000 input and 100 output tokens, 150 micro-USD on Haiku. */
export const TURN_COST_MICRO_USD = 150;

export interface ReceivedRequest {
  turn: number;
  /** The email's subject line once the evidence was read (empty in turn 1). */
  subject: string;
  body: { model: string; messages: unknown[] };
}

export class FakeAnthropic {
  readonly requests: ReceivedRequest[] = [];
  private server: Server | null = null;
  private readonly holds = new Set<number>();
  private held: { request: ReceivedRequest; response: ServerResponse }[] = [];
  private waiters: (() => void)[] = [];

  get baseUrl(): string {
    const { port } = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** Leaves the next request for `turn` unanswered until `release`. */
  hold(turn: number): void {
    this.holds.add(turn);
  }

  /** Waits until a request for `turn` is held. */
  async heldTurn(turn: number, timeoutMs = 60_000): Promise<ReceivedRequest> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.held.find((entry) => entry.request.turn === turn);
      if (found !== undefined) return found.request;
      if (Date.now() > deadline) throw new Error(`no request for turn ${String(turn)} was held`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  /** Answers every held request whose caller is still waiting. */
  release(): void {
    const held = this.held;
    this.held = [];
    for (const { request, response } of held) this.answer(request, response);
  }

  /** Requests received for `turn` (and `subject`, when given). */
  turns(turn: number, subject?: string): ReceivedRequest[] {
    return this.requests.filter(
      (request) => request.turn === turn && (subject === undefined || request.subject === subject),
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReceivedRequest["body"];
    // The evidence tool result carries the email; turn 1 has only the fixed prompt.
    const subject = /Subject: ([^\\]*)/.exec(JSON.stringify(body.messages))?.[1] ?? "";
    const received: ReceivedRequest = { turn: (body.messages.length + 1) / 2, subject, body };
    this.requests.push(received);
    if (this.holds.delete(received.turn)) {
      const entry = { request: received, response };
      this.held.push(entry);
      // A held call whose caller stopped is gone; only answerable calls stay held.
      response.once("close", () => {
        this.held = this.held.filter((other) => other !== entry);
      });
      for (const wake of this.waiters.splice(0)) wake();
      return;
    }
    this.answer(received, response);
  }

  private answer(request: ReceivedRequest, response: ServerResponse): void {
    const tool = TURNS[request.turn];
    if (tool === undefined) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `msg_fake_${String(this.requests.length)}`,
        type: "message",
        role: "assistant",
        model: request.body.model,
        content: [
          {
            type: "tool_use",
            id: `toolu_fake_turn_${String(request.turn)}`,
            name: tool.name,
            input: tool.input,
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    );
  }
}
