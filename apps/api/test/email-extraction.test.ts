// End to end: the C-01 supplier email through a recorded extraction
// run (the live smoke run's replay, offline), the PostgreSQL checkpoint, the
// derived structured input and the unchanged intake and assessment, to the
// same plan as the structured fixture: 70 covered, 50 short, 50 by transfer,
// EUR 160. The real worker runs the case job. Pauses are checked with
// scripted providers on the same database.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ProviderError,
  ReplayProvider,
  ScriptedProvider,
  TOOL_NAMES,
  type ModelProvider,
  type RecordedExchange,
} from "@supplier-disruption/agent";
import { AGENT_CHECKPOINT_SCHEMA, ModelSpendLedger } from "@supplier-disruption/db";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseWorkflow } from "../src/cases/workflow.js";
import { C01_RECORDED_RUN } from "../src/demonstration/c01-recorded-run.js";
import {
  ORG_NDL,
  TestWorker,
  call,
  rows,
  sourceEffects,
  startCaseStack,
  waitForState,
  type CaseStack,
} from "./case-support.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import { REPO_ROOT } from "./support.js";

const db = new DisposableDatabase("email");
const worker = new TestWorker();
let stack: CaseStack;

const replay = JSON.parse(
  readFileSync(join(REPO_ROOT, "evaluation/replays/smoke-2/D01.json"), "utf8"),
) as { exchanges: RecordedExchange[] };

/** The C-01 email as the smoke run read it (evaluation/scenarios/dev/D01.json). */
const C01 = JSON.parse(
  readFileSync(join(REPO_ROOT, "evaluation/scenarios/dev/D01.json"), "utf8"),
) as { email: { sender: string; subject: string; text: string } };

beforeAll(
  async () => {
    await db.start();
    stack = await startCaseStack(db, {
      agent: (pool) => ({
        provider: new ReplayProvider(replay.exchanges),
        checkpointer: new PostgresSaver(pool, undefined, { schema: AGENT_CHECKPOINT_SCHEMA }),
        costCapMicroUsd: 50_000,
      }),
    });
    await worker.start(db, stack.baseUrl);
  },
  START_TIMEOUT_MS + 3 * COMPOSE_TIMEOUT_MS,
);

afterAll(async () => {
  await worker.stop();
  await stack?.close();
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

const emailBody = (email: { sender: string; subject: string; text: string }) => ({
  organizationId: ORG_NDL,
  deliveryId: randomUUID(),
  ...email,
});

const RUN_CAP = 50_000;
/** The reconciled project total carried into this database (ADR 0017). */
const OPENING = 30_763;

/** The operator's view of the ledger, as the migrator role. */
const owner = () => new ModelSpendLedger(db.pool("migrator", "email-spend-owner"));

/** A workflow with a metered provider admitted through the project ledger. */
function metered(provider: ModelProvider, totalCostCapMicroUsd?: number): CaseWorkflow {
  return new CaseWorkflow({
    ...stack.workflow.deps,
    agent: {
      provider,
      costCapMicroUsd: RUN_CAP,
      spendLedger: new ModelSpendLedger(stack.workflow.deps.sourcePool),
      ...(totalCostCapMicroUsd === undefined ? {} : { totalCostCapMicroUsd }),
    },
  });
}

async function emailCase(workflow: CaseWorkflow, subject: string): Promise<string> {
  const created = await workflow.extraction.ingestEmail(emailBody({ ...C01.email, subject }));
  return created.body.caseId as string;
}

const reservations = () =>
  rows<{ source: string; status: string; reserved: number; settled: number | null }>(
    stack.observer,
    `SELECT source, status, reserved_micro_usd::int AS reserved, settled_micro_usd::int AS settled
       FROM app.model_spend_reservation ORDER BY reserved_at, key`,
  );

describe("C-01 email through the extraction agent", () => {
  it("reaches the C-01 plan from the email, with every field located in the stored text", async () => {
    const created = await call(
      stack,
      stack.buyer,
      "POST",
      "/api/cases/emails",
      emailBody(C01.email),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ disposition: "evidence", state: "received" });
    const caseId = created.body.caseId as string;

    const detail = await waitForState(stack, stack.buyer, caseId, "awaiting_approval");
    const plan = detail.plan as {
      payload: { authorization: { cost: unknown }; actions: { kind: string }[] };
    };
    expect(plan.payload.authorization.cost).toEqual({ minorUnits: 16_000, currency: "EUR" });
    expect(plan.payload.actions.map((action) => action.kind)).toEqual([
      "amend_schedule",
      "reserve",
      "create_transfer_request",
    ]);
    expect((detail.impact as { totals: unknown }).totals).toMatchObject({
      preTransferCoverage: { state: "known", value: "70" },
      preTransferShortage: { state: "known", value: "50" },
      conditionalTransfer: { state: "known", value: "50" },
      conditionalShortage: { state: "known", value: "0" },
    });
    expect(
      (detail.fields as { proposal: { terms: { segments: unknown } } }).proposal.terms.segments,
    ).toEqual([
      { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
      { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
    ]);

    const run = detail.agentRun as {
      status: string;
      model: string;
      provider: string;
      toolCalls: number;
      costMicroUsd: number;
      evidenceText: string;
      locators: { source: string; field: string; quote?: string; start?: number; end?: number }[];
      steps: { kind: string; accepted: boolean }[];
    };
    expect(run).toMatchObject({
      status: "proposed",
      provider: "replay",
      model: "claude-haiku-5-5",
    });
    expect(run.toolCalls).toBeLessThanOrEqual(10);
    expect(run.costMicroUsd).toBeGreaterThan(0);
    expect(run.steps.length).toBeGreaterThan(0);
    for (const locator of run.locators) {
      if (locator.source !== "email") continue;
      expect(run.evidenceText.slice(locator.start, locator.end)).toBe(locator.quote);
    }
    expect(new Set(run.locators.map((locator) => locator.field)).size).toBe(9);

    // The derived input is stored once and the intake receipt binds it; no source effect yet.
    const messageId = (detail.case as { messageId: string }).messageId;
    expect(messageId).toMatch(/^EML-[0-9a-f]{16}$/);
    expect(
      await rows(
        stack.observer,
        "SELECT sender, proposal_id FROM fixture_reference.supplier_input WHERE message_id = $1",
        [messageId],
      ),
    ).toEqual([{ sender: "orders@kestrel-fasteners.test", proposal_id: `PROP-${messageId}` }]);
    const dispositions = await rows<{ disposition: string }>(
      stack.observer,
      "SELECT disposition FROM app.supplier_message WHERE case_id = $1 ORDER BY received_at, disposition",
      [caseId],
    );
    expect(dispositions.map((row) => row.disposition).sort()).toEqual(["accept", "evidence"]);
    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 0,
      inventory: 0,
      requests: 0,
      po_revision: 3,
      wh_b: "INV-B@1",
    });
    // The graph checkpointed in PostgreSQL under the run's thread.
    const [checkpoints] = await rows<{ n: number }>(
      stack.observer,
      "SELECT count(*)::int AS n FROM agent_checkpoint.checkpoints c JOIN app.agent_run r ON r.id::text = c.thread_id WHERE r.case_id = $1",
      [caseId],
    );
    expect(checkpoints!.n).toBeGreaterThan(0);

    // The same email again is one message, one case and one run.
    const again = await call(stack, stack.buyer, "POST", "/api/cases/emails", emailBody(C01.email));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ disposition: "duplicate", caseId });
    expect(await rows(stack.observer, "SELECT count(*)::int AS n FROM app.agent_run")).toEqual([
      { n: 1 },
    ]);
  });

  it("pauses malformed output and a missing provider for the buyer, with no plan", async () => {
    // These cases run their job directly, so the worker must not take it first.
    await worker.stop();
    const malformed = { poNumber: "PO-120", segments: "forty then eighty" };
    const use = (input: unknown) =>
      ({
        content: [{ type: "tool_use", id: randomUUID(), name: TOOL_NAMES.propose, input }],
        stopReason: "tool_use",
      }) as never;
    const scripted = new CaseWorkflow({
      ...stack.workflow.deps,
      agent: {
        provider: new ScriptedProvider("claude-haiku-5-5", [
          use(malformed),
          use(malformed),
          use(malformed),
        ]),
        costCapMicroUsd: 50_000,
      },
    });
    const disabled = new CaseWorkflow({
      ...stack.workflow.deps,
      agent: { provider: null, costCapMicroUsd: 50_000 },
    });
    const cases: [CaseWorkflow, string, string][] = [
      [scripted, "PO-120 rev 3: unreadable schedule", "agent_malformed_output"],
      [disabled, "PO-120 rev 3: no provider", "agent_provider_unavailable"],
    ];
    for (const [workflow, subject, reason] of cases) {
      const email = { ...C01.email, subject };
      const created = await workflow.extraction.ingestEmail(emailBody(email));
      const caseId = created.body.caseId as string;
      const outcome = await workflow.advance(caseId);
      expect(outcome).toEqual({ state: "needs_clarification", retry: false });
      const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
      expect(detail.case).toMatchObject({ state: "needs_clarification", reason, owner: "buyer" });
      expect(detail.plan).toBeNull();
      expect(detail.agentRun).toMatchObject({
        status: "paused",
        pauseReason: reason,
        owner: "buyer",
      });
    }
  });

  // Metered runs admit through the project spend ledger (ADR 0017); replays are not spend.
  it("pauses a metered run before any model call until the project ledger admits it", async () => {
    // The replayed C-01 run above reserved nothing.
    expect(await reservations()).toEqual([]);
    const malformed = {
      content: [
        { type: "tool_use", id: randomUUID(), name: TOOL_NAMES.propose, input: { poNumber: "x" } },
      ],
      stopReason: "tool_use",
    } as never;
    const scripted = new ScriptedProvider("claude-haiku-5-5", [malformed, malformed, malformed], {
      metered: true,
    });
    const cases: [number | undefined, string, string, RegExp][] = [
      [undefined, "PO-120 rev 3: ledger not opened", "agent_spend_cap_reached", /no reconciled/],
      [OPENING + RUN_CAP - 1, "PO-120 rev 3: over the limit", "agent_spend_cap_reached", /limit/],
      [OPENING + RUN_CAP, "PO-120 rev 3: within the limit", "agent_malformed_output", /x/],
    ];
    for (const [limit, subject, reason, detail] of cases) {
      const workflow = metered(scripted, limit);
      const caseId = await emailCase(workflow, subject);
      expect(await workflow.advance(caseId)).toEqual({
        state: "needs_clarification",
        retry: false,
      });
      const run = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body.agentRun as {
        pauseDetail: string;
      };
      expect(run).toMatchObject({ status: "paused", pauseReason: reason });
      if (reason === "agent_spend_cap_reached") {
        expect(run.pauseDetail).toMatch(detail);
        expect(run.pauseDetail).toContain("no model was called");
        expect(scripted.requests).toHaveLength(0);
      }
      if (limit === undefined) await owner().open(OPENING, "spend ledger test opening");
    }
    // Only the admitted run called the model, and it settled with its reported usage.
    expect(scripted.requests).toHaveLength(3);
    expect(await reservations()).toEqual([
      { source: "api", status: "settled", reserved: RUN_CAP, settled: 3 * 150 },
    ]);
  });

  it("keeps the reservation of a timed-out call and of a stopped attempt", async () => {
    const before = await reservations();
    const timedOut = new ScriptedProvider(
      "claude-haiku-5-5",
      [new ProviderError("provider timed out")],
      { metered: true },
    );
    const failedCase = await emailCase(metered(timedOut), "PO-120 rev 3: provider timeout");
    await metered(timedOut).advance(failedCase);
    expect(
      (await call(stack, stack.buyer, "GET", `/api/cases/${failedCase}`)).body.agentRun,
    ).toMatchObject({ status: "paused", pauseReason: "agent_provider_failure" });

    // An attempt that stopped after admission left its run running and reserved.
    const malformed = {
      content: [
        { type: "tool_use", id: randomUUID(), name: TOOL_NAMES.propose, input: { poNumber: "x" } },
      ],
      stopReason: "tool_use",
    } as never;
    const resumed = new ScriptedProvider("claude-haiku-5-5", [malformed, malformed, malformed], {
      metered: true,
    });
    const stoppedCase = await emailCase(metered(resumed), "PO-120 rev 3: stopped attempt");
    const [stopped] = await rows<{ id: string }>(
      stack.observer,
      "UPDATE app.agent_run SET status = 'running' WHERE case_id = $1 RETURNING id",
      [stoppedCase],
    );
    await stack.observer.query(
      `INSERT INTO app.model_spend_reservation (key, source, reference, model, reserved_micro_usd, status)
       VALUES ($1, 'api', $2, 'claude-haiku-5-5', $3, 'reserved')`,
      [`api:${stopped!.id}:stopped`, stopped!.id, RUN_CAP],
    );
    await metered(resumed).advance(stoppedCase);

    expect((await reservations()).slice(before.length)).toEqual([
      { source: "api", status: "uncertain", reserved: RUN_CAP, settled: null },
      { source: "api", status: "uncertain", reserved: RUN_CAP, settled: null },
      { source: "api", status: "settled", reserved: RUN_CAP, settled: 3 * 150 },
    ]);
    // Unknown usage stays counted at the full run cap; nothing was refunded.
    const status = await new ModelSpendLedger(stack.workflow.deps.sourcePool).status();
    expect(status.uncertainMicroUsd).toBe(2 * RUN_CAP);
    expect(status.committedMicroUsd).toBe(OPENING + 2 * 3 * 150 + 2 * RUN_CAP);
  });
});

describe("demonstration recording", () => {
  it("packages exactly the committed C-01 recording", () => {
    expect(C01_RECORDED_RUN).toEqual(replay);
  });
});
