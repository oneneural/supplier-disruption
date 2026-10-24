// Job and retry path through an outage: the API goes down right after
// ACT-2's reservation commits with its response lost, for longer than a short
// fixed retry window. The real worker keeps the job in retry instead of
// failing it. Then both processes restart with the job lost to an older
// exhausted policy, and the API's startup sweep queues the case again; the
// worker reconciles ACT-2 by operation ID and finishes once.
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resumeInterruptedCases } from "../src/cases/workflow.js";
import {
  MSG_0001,
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

const db = new DisposableDatabase("outage");
let worker = new TestWorker();
let stack: CaseStack;
let outage: Promise<void> | null = null;

const SCHEDULE = [
  { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
  { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
];

beforeAll(
  async () => {
    await db.start();
    stack = await startCaseStack(db, {
      faults: {
        afterSourceWrite({ actionId }) {
          if (actionId === "ACT-2" && outage === null) {
            // The API goes away right after the reservation committed; the
            // in-flight request still answers before the server closes.
            outage = stack.stopApi();
            return Promise.reject(new Error("simulated crash after the reservation committed"));
          }
          return Promise.resolve();
        },
      },
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

async function caseJobs() {
  return rows<{ state: string; retry_count: number }>(
    stack.observer,
    "SELECT state::text AS state, retry_count FROM pgboss.job WHERE name = 'case-application' ORDER BY created_on",
  );
}

describe("case application through an API outage", () => {
  it("keeps retrying, is requeued by the startup sweep and verifies without a duplicate effect", async () => {
    const created = await call(stack, stack.buyer, "POST", "/api/cases/ingest", {
      organizationId: ORG_NDL,
      deliveryId: randomUUID(),
      ...MSG_0001,
    });
    const caseId = created.body.caseId as string;
    const detail = (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body;
    const planSha256 = (detail.plan as { sha256: string }).sha256;
    const commands: Array<[string, string, unknown]> = [
      [stack.manager, "decisions", { actorId: "manager-1", decision: "approve", planSha256 }],
      [
        stack.manager,
        "acknowledgements",
        {
          kind: "warehouse_planner_confirmation",
          actorId: "planner-1",
          planSha256,
          optionId: "TRO-1",
          quantity: "50",
          arrivalDate: "2026-10-23",
        },
      ],
      [
        stack.buyer,
        "acknowledgements",
        {
          kind: "supplier_acknowledgement",
          actorId: "supplier-1",
          proposalId: "PROP-1",
          poNumber: "PO-120",
          poLine: "10",
          segments: SCHEDULE,
        },
      ],
    ];
    for (const [cookie, route, body] of commands) {
      const result = await call(stack, cookie, "POST", `/api/cases/${caseId}/${route}`, body);
      expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
    }

    // The worker's first run commits ACT-1 and ACT-2, then the API goes down.
    const deadline = Date.now() + 30_000;
    while (outage === null && Date.now() < deadline) await delay(100);
    expect(outage).not.toBeNull();
    await outage;
    // Twelve seconds without an API: twice the old window of five retries a second apart.
    await delay(12_000);
    const during = await caseJobs();
    expect(during).toHaveLength(1);
    expect(["retry", "created", "active"]).toContain(during[0]?.state);
    expect(during[0]?.retry_count).toBeGreaterThanOrEqual(2);
    expect(
      await rows(stack.observer, "SELECT state, reason FROM app.supplier_case WHERE id = $1", [
        caseId,
      ]),
    ).toEqual([{ state: "partially_applied", reason: "outcome_unknown" }]);
    expect(await sourceEffects(stack.observer)).toMatchObject({
      purchasing: 1,
      inventory: 1,
      requests: 0,
    });

    // Both processes stop, and the job is lost as an exhausted older policy would leave it.
    await worker.stop();
    await stack.observer.query(
      "UPDATE pgboss.job SET state = 'failed' WHERE name = 'case-application' AND state <> 'completed'",
    );

    // A restarted API's startup sweep queues the case once; a repeat is deduplicated.
    await stack.startApi();
    expect(await resumeInterruptedCases(stack.db, stack.boss)).toEqual([caseId]);
    expect(await resumeInterruptedCases(stack.db, stack.boss)).toEqual([]);
    worker = new TestWorker();
    await worker.start(db, stack.baseUrl);

    const verified = await waitForState(stack, stack.buyer, caseId, "plan_verified", 90_000);
    expect(
      (verified.actions as Array<{ actionId: string; state: string; attempts: number }>).map(
        ({ actionId, state, attempts }) => [actionId, state, attempts],
      ),
    ).toEqual([
      ["ACT-1", "confirmed", 1],
      ["ACT-2", "confirmed", 1],
      ["ACT-3", "confirmed", 1],
    ]);
    expect(await sourceEffects(stack.observer)).toEqual({
      purchasing: 1,
      inventory: 2,
      requests: 1,
      po_revision: 4,
      wh_b: "INV-B@1.ACT-2",
    });
    const kinds = (verified.timeline as Array<{ kind: string }>).map((event) => event.kind);
    expect(kinds).toContain("action_reconciled");
  }, 180_000);
});
