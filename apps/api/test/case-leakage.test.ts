// Case boundaries on a disposable database (ADR 0020): a corrected
// delivery for an escalated blocked case is refused with 409 rather than a
// 500, and private model reasoning and a provider key stay out of case
// evidence, agent-step records and error responses. Scripted providers and a
// loopback stand-in answer every model call; no live provider is called.
// MSG-LEAK is a synthetic test input, not a frozen oracle case.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  AnthropicProvider,
  ScriptedProvider,
  TOOL_NAMES,
  type ModelProvider,
  type ModelRequest,
} from "@supplier-disruption/agent";
import {
  DOMAIN_CONTRACT_VERSION,
  type SupplierProposalTerms,
} from "@supplier-disruption/contracts";
import { supplierContentSha256 } from "@supplier-disruption/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseWorkflow } from "../src/cases/workflow.js";
import { ORG_NDL, call, rows, startCaseStack, type CaseStack } from "./case-support.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import { C01_PROPOSAL } from "./fake-anthropic.js";
import { REPO_ROOT } from "./support.js";

const db = new DisposableDatabase("leak");
let stack: CaseStack;

const C01 = JSON.parse(
  readFileSync(join(REPO_ROOT, "evaluation/scenarios/dev/D01.json"), "utf8"),
) as { email: { sender: string; subject: string; text: string } };

const SOURCE = "fixture-supplier-mail";
const REGISTERED = "orders@kestrel-fasteners.test";
const C01_TERMS: SupplierProposalTerms = {
  poNumber: "PO-120",
  poLine: "10",
  baseRevision: "3",
  vendorItem: "KF-A-01",
  uom: "EA",
  segments: [
    { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
    { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
  ],
  unresolvedFields: [],
};

beforeAll(
  async () => {
    await db.start();
    stack = await startCaseStack(db);
  },
  START_TIMEOUT_MS + 3 * COMPOSE_TIMEOUT_MS,
);

afterAll(async () => {
  await stack?.close();
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

async function recordInput(messageId: string, inputVersion: number, sender: string) {
  await stack.workflow.sources.reference.recordSupplierInput({
    identity: {
      contractVersion: DOMAIN_CONTRACT_VERSION,
      sourceSystem: SOURCE,
      messageId,
      inputVersion,
      contentSha256: supplierContentSha256(C01_TERMS),
      sender,
      proposalId: `PROP-${messageId}-${String(inputVersion)}`,
      evidenceRef: `${messageId}@${String(inputVersion)}`,
      authoredAt: { state: "unknown" },
      receivedAt: { state: "unknown" },
    },
    terms: C01_TERMS,
  });
}

const ingest = (messageId: string, inputVersion: number, deliveryId = randomUUID()) =>
  call(stack, stack.buyer, "POST", "/api/cases/ingest", {
    organizationId: ORG_NDL,
    deliveryId,
    sourceSystem: SOURCE,
    messageId,
    inputVersion,
  });

describe("a corrected delivery for an escalated blocked case", () => {
  // Runs first: an accepted C-01 input below would make intake treat the same
  // terms as a possible duplicate instead.
  it("is refused with 409 and the current state, and stores nothing", async () => {
    await recordInput("MSG-LEAK", 1, "orders@unregistered.test");
    const blocked = await ingest("MSG-LEAK", 1);
    expect(blocked.status).toBe(201);
    expect(blocked.body).toMatchObject({ disposition: "blocked", state: "needs_clarification" });
    const caseId = blocked.body.caseId as string;
    const escalated = await call(stack, stack.buyer, "POST", `/api/cases/${caseId}/escalations`, {
      actorId: "buyer-1",
      note: "Handled by phone",
    });
    expect(escalated.body).toEqual({ state: "escalated" });

    await recordInput("MSG-LEAK", 2, REGISTERED);
    const deliveryId = randomUUID();
    const corrected = await ingest("MSG-LEAK", 2, deliveryId);
    expect(corrected).toEqual({
      status: 409,
      body: { error: "invalid_case_state", state: "escalated" },
    });
    expect(
      await rows(stack.observer, "SELECT 1 FROM app.supplier_message WHERE delivery_id = $1", [
        deliveryId,
      ]),
    ).toEqual([]);
    const detail = await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`);
    expect(detail.body.case).toMatchObject({ state: "escalated", reason: "manual_escalation" });
    expect(detail.body.plan).toBeNull();
  });
});

describe("private reasoning and provider secrets", () => {
  const THINKING = `private-reasoning-${randomUUID()}`;
  const SIGNATURE = `thinking-signature-${randomUUID()}`;
  const REDACTED = `redacted-thinking-${randomUUID()}`;
  const KEY = `sk-ant-canary-${randomUUID()}`;
  let echo: Server;
  const receivedKeys: string[] = [];

  beforeAll(async () => {
    // A provider stand-in that echoes the key it was sent in its error.
    echo = createServer((request, response) => {
      request.resume();
      const key = String(request.headers["x-api-key"]);
      receivedKeys.push(key);
      response.writeHead(401, { "content-type": "application/json", "x-echo-key": key });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: `invalid x-api-key ${key}` },
        }),
      );
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  const turn = (request: ModelRequest, tool: { name: string; input: unknown }) =>
    ({
      content: [
        {
          type: "thinking",
          thinking: `${THINKING} turn ${String(request.messages.length)}`,
          signature: SIGNATURE,
        },
        { type: "redacted_thinking", data: REDACTED },
        { type: "tool_use", id: randomUUID(), name: tool.name, input: tool.input },
      ],
      stopReason: "tool_use",
    }) as never;

  async function emailCase(provider: ModelProvider, subject: string) {
    const workflow = new CaseWorkflow({
      ...stack.workflow.deps,
      agent: { provider, costCapMicroUsd: 50_000 },
    });
    const created = await workflow.extraction.ingestEmail({
      organizationId: ORG_NDL,
      deliveryId: randomUUID(),
      ...C01.email,
      subject,
    });
    const caseId = created.body.caseId as string;
    await workflow.advance(caseId);
    return caseId;
  }

  /** Everything the browser can read about the case, and refusals around it. */
  async function responsesFor(caseId: string) {
    const reads = [
      await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`),
      await call(stack, stack.buyer, "GET", `/api/cases?organizationId=${ORG_NDL}`),
      await call(stack, stack.buyer, "GET", `/api/cases/actors?organizationId=${ORG_NDL}`),
      await call(stack, stack.buyer, "GET", `/api/cases/${randomUUID()}`),
      await call(stack, stack.buyer, "GET", `/api/cases/not-a-uuid`),
      await call(stack, stack.buyer, "POST", `/api/cases/${caseId}/decisions`, {
        actorId: "buyer-1",
        decision: "approve",
        planSha256: "0".repeat(64),
      }),
      await call(stack, stack.buyer, "POST", `/api/cases/${caseId}/notes`, { malformed: true }),
    ];
    expect(reads[0]!.status).toBe(200);
    expect(reads.slice(3).every((read) => read.status >= 400)).toBe(true);
    return { text: JSON.stringify(reads), detail: reads[0]!.body };
  }

  it("keeps thinking blocks out of case evidence, agent steps and errors", async () => {
    const provider = new ScriptedProvider("claude-haiku-5-5", [
      (request) => turn(request, { name: TOOL_NAMES.readEvidence, input: {} }),
      (request) =>
        turn(request, { name: TOOL_NAMES.readPurchaseOrder, input: { poNumber: "PO-120" } }),
      (request) => turn(request, { name: TOOL_NAMES.propose, input: C01_PROPOSAL }),
    ]);
    const caseId = await emailCase(provider, "PO-120 rev 3: reasoning canary");
    // The premise: the reasoning was in the run's conversation, sent back each turn.
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests.at(-1)!.messages)).toContain(THINKING);

    const { text, detail: body } = await responsesFor(caseId);
    const detail = body as unknown as {
      case: { state: string };
      agentRun: { status: string; steps: unknown[] };
    };
    expect(detail.agentRun).toMatchObject({ status: "proposed" });
    expect(detail.agentRun.steps.length).toBeGreaterThanOrEqual(6);
    expect(detail.case.state).toBe("awaiting_approval");
    for (const canary of [THINKING, SIGNATURE, REDACTED]) expect(text).not.toContain(canary);
    // Nor in the stored step records the response is built from.
    const stored = await rows(
      stack.observer,
      `SELECT s.input::text || s.result::text || coalesce(s.reason, '') AS text
         FROM app.agent_step s JOIN app.agent_run r ON r.id = s.run_id WHERE r.case_id = $1`,
      [caseId],
    );
    for (const canary of [THINKING, SIGNATURE, REDACTED]) {
      expect(stored.some((row) => String(row.text).includes(canary))).toBe(false);
    }
  });

  it("keeps a provider key echoed in a provider error out of the paused case", async () => {
    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${String((echo.address() as AddressInfo).port)}`;
    let real: AnthropicProvider;
    try {
      real = new AnthropicProvider({ apiKey: KEY, model: "claude-haiku-5-5", timeoutMs: 5_000 });
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous;
    }
    // The real adapter, outside the spend ledger: the stand-in costs nothing.
    const provider: ModelProvider = {
      name: real.name,
      model: real.model,
      metered: false,
      complete: (request) => real.complete(request),
    };
    const caseId = await emailCase(provider, "PO-120 rev 3: key canary");
    const { text, detail: body } = await responsesFor(caseId);
    const detail = body as unknown as {
      agentRun: { status: string; pauseReason: string; steps: unknown[] };
    };
    // The premise: the call reached the stand-in and failed there.
    expect(detail.agentRun).toMatchObject({ status: "paused" });
    expect(receivedKeys).toContain(KEY);
    expect(text).toContain("provider returned 401");
    expect(text).not.toContain(KEY);
    // Nor in the stored run and step records the response is built from.
    const stored = await rows(
      stack.observer,
      `SELECT coalesce(r.pause_detail, '') || coalesce(s.input::text, '') ||
              coalesce(s.result::text, '') || coalesce(s.reason, '') AS text
         FROM app.agent_run r LEFT JOIN app.agent_step s ON s.run_id = r.id
        WHERE r.case_id = $1`,
      [caseId],
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.some((row) => String(row.text).includes("provider returned 401"))).toBe(true);
    expect(stored.some((row) => String(row.text).includes(KEY))).toBe(false);
  });
});
