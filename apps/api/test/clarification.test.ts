// Clarification, correction and reply/resume (ADR 0014) at the API
// boundary, on its own disposable database. An ambiguous supplier email
// pauses with no model provider; the buyer asks a question (a local draft,
// never sent) that waits across an API restart; wrong-case, wrong-sender,
// wrong-basis, duplicate, conflicting and stale replies have no effect; a
// correction must cite the supplier's own words for every field it trusts;
// a supported correction or valid reply creates a new assessment, and an
// earlier approval never authorizes the replacement plan. Expected values are
// oracle literals: the corrected terms reach the C-01 arithmetic (70 covered,
// 50 short before transfer, 50 by transfer, EUR 160).
import { randomUUID } from "node:crypto";
import { ScriptedProvider, TOOL_NAMES, evidenceText } from "@supplier-disruption/agent";
import type { CaseDetail } from "@supplier-disruption/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseWorkflow, resumeInterruptedCases } from "../src/cases/workflow.js";
import {
  ORG_NDL,
  call,
  rows,
  sourceEffects,
  startCaseStack,
  type CaseStack,
} from "./case-support.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";

const db = new DisposableDatabase("clarify");
let stack: CaseStack;

const NO_EFFECTS = { purchasing: 0, inventory: 0, requests: 0, po_revision: 3, wh_b: "INV-B@1" };
const SENDER = "orders@kestrel-fasteners.test";

/** The remainder has no date: the email cannot support a delivery promise for it. */
const AMBIGUOUS = {
  sender: SENDER,
  subject: "PO-120 line 10: partial delivery",
  text:
    "Hello,\n\nRegarding PO-120 (revision 3), line 10, item KF-A-01: we can deliver 40 EA " +
    "to your warehouse on 23 October 2026. The remaining 80 EA will follow later.\n\n" +
    "Best regards,\nKestrel Fasteners order desk",
};
const REPLY_TEXT = "The remaining 80 EA will arrive at your warehouse on 26 October 2026.";

beforeAll(
  async () => {
    await db.start();
    // No agent provider: every email pauses before any model call.
    stack = await startCaseStack(db);
  },
  START_TIMEOUT_MS + 2 * COMPOSE_TIMEOUT_MS,
);

afterAll(async () => {
  await stack?.close();
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

const post = (path: string, body: unknown, cookie = stack.buyer) =>
  call(stack, cookie, "POST", path, body);
const detailOf = async (caseId: string) =>
  (await call(stack, stack.buyer, "GET", `/api/cases/${caseId}`)).body as unknown as CaseDetail;

type Delivery = { deliveryId: string; contentSha256: string };

const cite = (delivery: Delivery, quote: string) => ({
  deliveryId: delivery.deliveryId,
  contentSha256: delivery.contentSha256,
  quote,
});
/** Every field from the email, the remainder cited as undated. */
const emailChanges = (emailDelivery: Delivery) => [
  { field: "poNumber", value: "PO-120", citation: cite(emailDelivery, "PO-120 (revision 3)") },
  { field: "poLine", value: "10", citation: cite(emailDelivery, "line 10") },
  { field: "baseRevision", value: "3", citation: cite(emailDelivery, "(revision 3)") },
  { field: "vendorItem", value: "KF-A-01", citation: cite(emailDelivery, "item KF-A-01") },
  { field: "uom", value: "EA", citation: cite(emailDelivery, "deliver 40 EA") },
  { field: "segments[0].quantity", value: "40", citation: cite(emailDelivery, "deliver 40 EA") },
  {
    field: "segments[0].arrival",
    value: "2026-10-23",
    citation: cite(emailDelivery, "deliver 40 EA to your warehouse on 23 October 2026"),
  },
  {
    field: "segments[1].quantity",
    value: "80",
    citation: cite(emailDelivery, "The remaining 80 EA will follow later."),
  },
  {
    field: "segments[1].arrival",
    value: "undated",
    citation: cite(emailDelivery, "The remaining 80 EA will follow later."),
  },
];

describe("clarification, correction and reply/resume", () => {
  let caseId: string;
  let emailDelivery: { deliveryId: string; contentSha256: string };
  let staleReply: { deliveryId: string; contentSha256: string };
  let reply: { deliveryId: string; contentSha256: string };
  let firstPlanSha: string;
  let secondPlanSha: string;

  const replyBody = (overrides: Record<string, unknown> = {}) => ({
    actorId: "supplier-1",
    deliveryId: randomUUID(),
    caseRef: "CASE-1",
    questionRef: "Q-1",
    basisAssessment: 0,
    sender: SENDER,
    subject: "Re: CASE-1 Q-1",
    text: REPLY_TEXT,
    ...overrides,
  });
  /** Every field from the email, the remainder cited as undated. */
  const fromEmail = () => emailChanges(emailDelivery);

  it("pauses the ambiguous email for the buyer with no candidate", async () => {
    const created = await post("/api/cases/emails", {
      organizationId: ORG_NDL,
      deliveryId: randomUUID(),
      ...AMBIGUOUS,
    });
    expect(created.status).toBe(201);
    caseId = created.body.caseId as string;
    expect(await stack.workflow.advance(caseId)).toEqual({
      state: "needs_clarification",
      retry: false,
    });
    const detail = await detailOf(caseId);
    expect(detail.case).toMatchObject({
      caseRef: "CASE-1",
      state: "needs_clarification",
      reason: "agent_provider_unavailable",
      owner: "buyer",
    });
    expect(detail).toMatchObject({ basisAssessment: 0, candidate: null, plan: null });
    const email = detail.evidence[0]!;
    emailDelivery = { deliveryId: email.deliveryId, contentSha256: email.contentSha256 };
  });

  it("asks a question as a local draft and keeps it waiting across an API restart", async () => {
    const question = {
      actorId: "buyer-1",
      basisAssessment: 0,
      fields: ["segments[1].arrival"],
      question: "When will the remaining 80 EA arrive at warehouse A?",
    };
    // Only the buyer asks; a note is not a question and changes nothing.
    expect(
      (await post(`/api/cases/${caseId}/clarifications`, { ...question, actorId: "cs-1" })).status,
    ).toBe(403);
    const note = await post(`/api/cases/${caseId}/notes`, {
      actorId: "cs-1",
      note: "80 EA by Monday?",
    });
    expect(note.body).toEqual({ recorded: "note", state: "needs_clarification" });

    const asked = await post(`/api/cases/${caseId}/clarifications`, question);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({
      questionRef: "Q-1",
      sent: false,
      state: "needs_clarification",
      draft: { to: SENDER, subject: "CASE-1 Q-1: clarification requested" },
    });
    expect((await post(`/api/cases/${caseId}/clarifications`, question)).body).toMatchObject({
      error: "clarification_open",
      questionRef: "Q-1",
    });

    await stack.stopApi();
    await stack.startApi();
    // A restarted API queues no job for a case that waits on a person.
    expect(await resumeInterruptedCases(stack.db, stack.boss)).not.toContain(caseId);
    const detail = await detailOf(caseId);
    expect(detail.case).toMatchObject({
      state: "needs_clarification",
      reason: "awaiting_supplier_reply",
      owner: "buyer",
      nextAction: "Record the supplier's reply to the open question; its draft was not sent",
    });
    expect(detail.clarifications).toMatchObject([
      { questionRef: "Q-1", status: "awaiting_reply", sent: false, basisAssessment: 0 },
    ]);
    // The draft can never be marked sent, even by the migrator.
    await expect(
      stack.observer.query("UPDATE app.case_clarification SET sent = true"),
    ).rejects.toThrow(/case_clarification_not_sent_check/);
  });

  it("refuses replies for another case, from another sender or role, without effect", async () => {
    expect(
      (await post(`/api/cases/${caseId}/replies`, replyBody({ caseRef: "CASE-9" }))).body,
    ).toEqual({
      error: "reply_case_mismatch",
    });
    expect(
      (await post(`/api/cases/${caseId}/replies`, replyBody({ questionRef: "Q-7" }))).body,
    ).toEqual({
      error: "reply_case_mismatch",
    });
    const stranger = await post(
      `/api/cases/${caseId}/replies`,
      replyBody({ sender: "sales@other-vendor.test" }),
    );
    expect(stranger).toEqual({ status: 422, body: { error: "unverified_sender" } });
    expect(
      (await post(`/api/cases/${caseId}/replies`, replyBody({ actorId: "buyer-1" }))).status,
    ).toBe(403);
    expect((await detailOf(caseId)).case).toMatchObject({ reason: "awaiting_supplier_reply" });
  });

  it("keeps an unsupported or incomplete correction blocked", async () => {
    const path = `/api/cases/${caseId}/corrections`;
    const [, , , , , , , , undated] = fromEmail();
    // Not the buyer: refused before anything is recorded.
    expect(
      (await post(path, { actorId: "cs-1", basisAssessment: 0, changes: fromEmail() })).status,
    ).toBe(403);
    // No candidate exists, so one field alone is not a proposal.
    const partial = await post(path, {
      actorId: "buyer-1",
      basisAssessment: 0,
      changes: [undated],
    });
    expect(partial.status).toBe(422);
    expect(partial.body.error).toBe("correction_invalid");
    // A date the email does not state, and a quote that is not in it.
    const unsupported = fromEmail().map((change) =>
      change.field === "segments[1].arrival"
        ? { ...change, value: "2026-10-26" }
        : change.field === "segments[0].quantity"
          ? { ...change, citation: cite(emailDelivery, "deliver 41 EA") }
          : change,
    );
    const refused = await post(path, {
      actorId: "buyer-1",
      basisAssessment: 0,
      changes: unsupported,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: "correction_unsupported", correctionRef: "COR-2" });
    expect(refused.body.diagnostics).toEqual([
      "segments[0].quantity: the quote does not occur verbatim in the cited message",
      "segments[1].arrival: the quote does not state 2026-10-26",
    ]);
    const detail = await detailOf(caseId);
    expect(detail.case).toMatchObject({
      state: "needs_clarification",
      reason: "awaiting_supplier_reply",
    });
    expect(detail.corrections.map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(detail.plan).toBeNull();
  });

  it("assesses a correction cited from the email and makes the open question stale", async () => {
    const corrected = await post(`/api/cases/${caseId}/corrections`, {
      actorId: "buyer-1",
      basisAssessment: 0,
      changes: fromEmail(),
      note: "Transcribed from the email; the remainder is undated.",
    });
    expect(corrected.status).toBe(201);
    expect(corrected.body).toMatchObject({
      outcome: "accepted",
      correctionRef: "COR-3",
      state: "awaiting_approval",
      planVersion: 1,
    });
    const detail = await detailOf(caseId);
    expect(detail.basisAssessment).toBe(1);
    expect(detail.impact!.totals).toMatchObject({
      preTransferCoverage: { state: "known", value: "70" },
      preTransferShortage: { state: "known", value: "50" },
      conditionalTransfer: { state: "known", value: "50" },
      conditionalShortage: { state: "known", value: "0" },
    });
    expect(detail.plan!.payload.authorization.cost).toEqual({
      minorUnits: 16_000,
      currency: "EUR",
    });
    expect(detail.plan!.payload.proposal.terms.segments).toEqual([
      { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
      { sequence: 2, quantity: "80", arrival: { state: "undated" } },
    ]);
    firstPlanSha = detail.plan!.sha256;
    // Before and after are linked, and each locator slices the stored email's text.
    const correction = detail.corrections[2]!;
    expect(correction).toMatchObject({ status: "accepted", before: null, planVersion: 1 });
    expect(correction.after!.unresolvedFields).toEqual(["segments[1].arrival"]);
    const text = evidenceText(AMBIGUOUS);
    for (const locator of correction.locators) {
      expect(locator.deliveryId).toBe(emailDelivery.deliveryId);
      expect(text.slice(locator.start, locator.end)).toBe(locator.quote);
    }
    expect(correction.locators).toHaveLength(9);
    // The original email is unchanged; the corrected input is its own record.
    // Under the fixed business clock every delivery has the same instant, so compare as sets.
    expect(detail.evidence.map((item) => item.disposition).sort()).toEqual(["accept", "evidence"]);
    expect(detail.evidence.find((item) => item.disposition === "evidence")!.contentSha256).toBe(
      emailDelivery.contentSha256,
    );
    expect(
      await rows(
        stack.observer,
        "SELECT source_system, sender FROM fixture_reference.supplier_input WHERE message_id = $1",
        [correction.input!.messageId],
      ),
    ).toEqual([{ source_system: "operator-correction", sender: SENDER }]);
    expect(detail.clarifications).toMatchObject([
      { questionRef: "Q-1", status: "superseded", closedReason: "superseded_by_correction" },
    ]);

    // The reply to Q-1 now arrives after a newer plan: kept as evidence, no effect.
    const late = await post(`/api/cases/${caseId}/replies`, replyBody());
    expect(late).toEqual({
      status: 409,
      body: { error: "stale_reply", state: "awaiting_approval" },
    });
    const after = await detailOf(caseId);
    expect(after.plan!.sha256).toBe(firstPlanSha);
    expect(after.case.state).toBe("awaiting_approval");
    const kept = after.evidence.find((item) => item.reason === "stale_reply")!;
    expect(kept).toMatchObject({ disposition: "reply", inputVersion: 1 });
    staleReply = { deliveryId: kept.deliveryId, contentSha256: kept.contentSha256 };
    // A stale reply supports nothing.
    const fromStale = await post(`/api/cases/${caseId}/corrections`, {
      actorId: "buyer-1",
      basisAssessment: 1,
      changes: [
        {
          field: "segments[1].arrival",
          value: "2026-10-26",
          citation: cite(staleReply, "arrive at your warehouse on 26 October 2026"),
        },
      ],
    });
    expect(fromStale.body).toMatchObject({
      error: "correction_unsupported",
      diagnostics: [
        "segments[1].arrival: the cited delivery is not supplier evidence of this case",
      ],
    });
  });

  it("resumes once on a valid reply, and an old approval never authorizes the new plan", async () => {
    const approved = await post(
      `/api/cases/${caseId}/decisions`,
      { actorId: "manager-1", decision: "approve", planSha256: firstPlanSha },
      stack.manager,
    );
    expect(approved.body).toMatchObject({ outcome: "accepted", state: "awaiting_acknowledgement" });

    const asked = await post(`/api/cases/${caseId}/clarifications`, {
      actorId: "buyer-1",
      basisAssessment: 1,
      fields: ["segments[1].arrival"],
      question: "Please confirm the arrival date of the remaining 80 EA.",
    });
    expect(asked.body).toMatchObject({ questionRef: "Q-2", state: "needs_clarification" });

    const body = replyBody({ questionRef: "Q-2", basisAssessment: 1, subject: "Re: CASE-1 Q-2" });
    // A reply naming another basis answers different facts.
    const wrongBasis = await post(`/api/cases/${caseId}/replies`, {
      ...body,
      deliveryId: randomUUID(),
      basisAssessment: 0,
    });
    expect(wrongBasis.body).toEqual({
      error: "reply_basis_mismatch",
      state: "needs_clarification",
    });

    const answered = await post(`/api/cases/${caseId}/replies`, body);
    expect(answered.status).toBe(201);
    expect(answered.body).toMatchObject({
      questionRef: "Q-2",
      state: "awaiting_approval",
      planVersion: 2,
    });
    // The same delivery, the same words again and different words: no effect.
    expect((await post(`/api/cases/${caseId}/replies`, body)).body).toMatchObject({
      replayed: true,
      disposition: "reply",
    });
    expect(
      (await post(`/api/cases/${caseId}/replies`, { ...body, deliveryId: randomUUID() })).body,
    ).toEqual({
      disposition: "duplicate",
      reason: null,
      state: "awaiting_approval",
    });
    const conflicting = await post(`/api/cases/${caseId}/replies`, {
      ...body,
      deliveryId: randomUUID(),
      text: "The remaining 80 EA will arrive at your warehouse on 27 October 2026.",
    });
    expect(conflicting).toEqual({
      status: 409,
      body: { error: "reply_conflict", state: "awaiting_approval" },
    });

    const detail = await detailOf(caseId);
    expect(detail.plans.map((plan) => plan.planVersion)).toEqual([1, 2]);
    expect(detail.clarifications[1]).toMatchObject({ status: "answered", questionRef: "Q-2" });
    reply = { deliveryId: body.deliveryId, contentSha256: "" };
    reply.contentSha256 = detail.evidence.find(
      (item) => item.deliveryId === body.deliveryId,
    )!.contentSha256;
    secondPlanSha = detail.plan!.sha256;
    expect(secondPlanSha).not.toBe(firstPlanSha);
    // The manager's approval of plan 1 was superseded and authorizes nothing now.
    expect(detail.decisions.filter((decision) => decision.kind === "approval")).toMatchObject([
      {
        planSha256: firstPlanSha,
        status: "superseded",
        invalidatedReason: "clarification_requested",
      },
    ]);
    expect(
      detail.actions
        .filter((action) => action.planSha256 === firstPlanSha)
        .map((action) => [action.state, action.reason]),
    ).toEqual([
      ["failed", "clarification_requested"],
      ["failed", "clarification_requested"],
      ["failed", "clarification_requested"],
    ]);
    const old = await post(
      `/api/cases/${caseId}/decisions`,
      { actorId: "manager-1", decision: "approve", planSha256: firstPlanSha },
      stack.manager,
    );
    expect(old).toEqual({ status: 409, body: { error: "plan_mismatch" } });
    expect(detail.case).toMatchObject({ state: "awaiting_approval" });
  });

  it("applies a reply-supported correction under a new plan with before and after evidence", async () => {
    const path = `/api/cases/${caseId}/corrections`;
    const change = {
      field: "segments[1].arrival",
      value: "2026-10-26",
      citation: cite(reply, "arrive at your warehouse on 26 October 2026"),
    };
    // Prepared against the earlier basis: refused, nothing recorded.
    expect(
      (await post(path, { actorId: "buyer-1", basisAssessment: 1, changes: [change] })).body,
    ).toEqual({
      error: "stale_basis",
      basisAssessment: 2,
    });
    const corrected = await post(path, {
      actorId: "buyer-1",
      basisAssessment: 2,
      changes: [change],
    });
    expect(corrected.body).toMatchObject({
      outcome: "accepted",
      state: "awaiting_approval",
      planVersion: 3,
    });
    // The same correction again finds a newer basis and creates nothing.
    expect(
      (await post(path, { actorId: "buyer-1", basisAssessment: 2, changes: [change] })).status,
    ).toBe(409);

    const detail = await detailOf(caseId);
    expect(detail.plans.map((plan) => plan.planVersion)).toEqual([1, 2, 3]);
    const correction = detail.corrections.at(-1)!;
    expect(correction.before!.segments[1]!.arrival).toEqual({ state: "undated" });
    expect(correction.after!.segments[1]!.arrival).toEqual({ state: "dated", date: "2026-10-26" });
    expect(correction.after!.unresolvedFields).toEqual([]);
    expect(correction.locators).toMatchObject([
      { field: "segments[1].arrival", deliveryId: reply.deliveryId, value: "2026-10-26" },
    ]);
    expect(detail.plan!.payload.proposal.terms.segments[1]).toEqual({
      sequence: 2,
      quantity: "80",
      arrival: { state: "dated", date: "2026-10-26" },
    });
    expect(detail.impact!.totals).toMatchObject({
      preTransferCoverage: { state: "known", value: "70" },
      conditionalTransfer: { state: "known", value: "50" },
    });
    // Neither earlier hash authorizes plan 3; only a fresh approval of its own hash can.
    for (const planSha256 of [firstPlanSha, secondPlanSha]) {
      const refused = await post(
        `/api/cases/${caseId}/decisions`,
        { actorId: "manager-1", decision: "approve", planSha256 },
        stack.manager,
      );
      expect(refused).toEqual({ status: 409, body: { error: "plan_mismatch" } });
    }
    const fresh = await post(
      `/api/cases/${caseId}/decisions`,
      { actorId: "manager-1", decision: "approve", planSha256: detail.plan!.sha256 },
      stack.manager,
    );
    expect(fresh.body).toMatchObject({ outcome: "accepted", state: "awaiting_acknowledgement" });
    // Nothing in this flow wrote a source record or sent a message.
    expect(await sourceEffects(stack.observer)).toEqual(NO_EFFECTS);
    expect(
      await rows(
        stack.observer,
        "SELECT count(*)::int AS n FROM app.case_clarification WHERE sent",
      ),
    ).toEqual([{ n: 0 }]);
  });

  it("refuses a reply after escalation: the case stays closed with no new plan", async () => {
    const before = await detailOf(caseId);
    const basis = before.basisAssessment;
    const asked = await post(`/api/cases/${caseId}/clarifications`, {
      actorId: "buyer-1",
      basisAssessment: basis,
      fields: ["segments[1].arrival"],
      question: "Can the remaining 80 EA arrive earlier?",
    });
    expect(asked.body).toMatchObject({ questionRef: "Q-3", state: "needs_clarification" });
    const escalated = await post(`/api/cases/${caseId}/escalations`, {
      actorId: "buyer-1",
      note: "Handled outside this case.",
    });
    expect(escalated.body).toEqual({ state: "escalated" });

    const deliveryId = randomUUID();
    const refused = await post(
      `/api/cases/${caseId}/replies`,
      replyBody({ deliveryId, questionRef: "Q-3", basisAssessment: basis }),
    );
    expect(refused).toEqual({
      status: 409,
      body: { error: "invalid_case_state", state: "escalated" },
    });
    const after = await detailOf(caseId);
    expect(after.case).toMatchObject({ state: "escalated", reason: "manual_escalation" });
    expect(after.basisAssessment).toBe(basis);
    expect(after.plans).toHaveLength(before.plans.length);
    expect(after.clarifications.at(-1)).toMatchObject({
      questionRef: "Q-3",
      status: "superseded",
      closedReason: "manual_escalation",
    });
    // Refused before anything is recorded: the reply's bytes are not stored.
    expect(after.evidence.some((item) => item.deliveryId === deliveryId)).toBe(false);
  });
});

describe("a paused agent proposal", () => {
  it("is trusted for nothing: a correction must cite every field", async () => {
    // A scripted model (no provider call) proposes the email's terms with a
    // low-confidence undated remainder; the run pauses with the proposal kept.
    const proposal = {
      poNumber: { value: "PO-120", quote: "PO-120 (revision 3)", confidence: "high" },
      poLine: { value: "10", cite: { source: "email", quote: "line 10" }, confidence: "high" },
      baseRevision: {
        value: "3",
        cite: { source: "email", quote: "(revision 3)" },
        confidence: "high",
      },
      vendorItem: { value: "KF-A-01", quote: "item KF-A-01", confidence: "high" },
      uom: { value: "EA", quote: "deliver 40 EA", confidence: "high" },
      segments: [
        {
          quantity: { value: "40", quote: "deliver 40 EA", confidence: "high" },
          arrival: {
            state: "dated",
            date: "2026-10-23",
            quote: "deliver 40 EA to your warehouse on 23 October 2026",
            confidence: "high",
          },
        },
        {
          quantity: {
            value: "80",
            quote: "The remaining 80 EA will follow later.",
            confidence: "high",
          },
          arrival: { state: "undated", quote: "will follow later", confidence: "low" },
        },
      ],
      rationale: "The remainder has no date.",
    };
    const workflow = new CaseWorkflow({
      ...stack.workflow.deps,
      agent: {
        provider: new ScriptedProvider("claude-haiku-5-5", [
          {
            content: [
              { type: "tool_use", id: randomUUID(), name: TOOL_NAMES.propose, input: proposal },
            ],
            stopReason: "tool_use",
          } as never,
        ]),
        costCapMicroUsd: 50_000,
      },
    });
    const created = await workflow.extraction.ingestEmail({
      organizationId: ORG_NDL,
      deliveryId: randomUUID(),
      ...AMBIGUOUS,
      subject: "PO-120 line 10: partial delivery (second email)",
    });
    const caseId = created.body.caseId as string;
    expect(await workflow.advance(caseId)).toEqual({ state: "needs_clarification", retry: false });
    const detail = await detailOf(caseId);
    expect(detail.case.reason).toBe("agent_low_confidence");
    expect(detail.candidate).toMatchObject({ source: "agent_run", supported: false });
    const email = detail.evidence[0] as { deliveryId: string; contentSha256: string };

    const partial = await post(`/api/cases/${caseId}/corrections`, {
      actorId: "buyer-1",
      basisAssessment: 0,
      changes: [
        {
          field: "segments[1].arrival",
          value: "undated",
          citation: {
            deliveryId: email.deliveryId,
            contentSha256: email.contentSha256,
            quote: "The remaining 80 EA will follow later.",
          },
        },
      ],
    });
    expect(partial.status).toBe(422);
    expect(partial.body.error).toBe("correction_incomplete");
    expect(partial.body.diagnostics).toHaveLength(8);
    expect((await detailOf(caseId)).plan).toBeNull();
  });
});

describe("a reply never restores earlier terms", () => {
  it("waits for a correction when no plan exists or intake blocked the latest terms", async () => {
    const created = await post("/api/cases/emails", {
      organizationId: ORG_NDL,
      deliveryId: randomUUID(),
      ...AMBIGUOUS,
      subject: "PO-120 line 10: partial delivery (third email)",
    });
    const caseId = created.body.caseId as string;
    await stack.workflow.advance(caseId);
    const start = await detailOf(caseId);
    const caseRef = start.case.caseRef;
    const email = start.evidence[0]!;
    const ask = (questionRef: string, basisAssessment: number) =>
      post(`/api/cases/${caseId}/clarifications`, {
        actorId: "buyer-1",
        basisAssessment,
        fields: ["baseRevision"],
        question: `Which order revision does this delivery follow? (${questionRef})`,
      });
    const answer = (questionRef: string, basisAssessment: number, text: string) =>
      post(`/api/cases/${caseId}/replies`, {
        actorId: "supplier-1",
        deliveryId: randomUUID(),
        caseRef,
        questionRef,
        basisAssessment,
        sender: SENDER,
        subject: `Re: ${caseRef} ${questionRef}`,
        text,
      });

    // A valid reply on a planless case states no terms: it waits for a correction.
    expect((await ask("Q-1", 0)).status).toBe(201);
    const first = await answer("Q-1", 0, "This delivery follows revision 2 of the order.");
    expect(first.body).toMatchObject({ questionRef: "Q-1", state: "needs_clarification" });
    let detail = await detailOf(caseId);
    expect(detail.case).toMatchObject({ reason: "correction_required", owner: "buyer" });
    expect(detail).toMatchObject({ plan: null, plans: [], basisAssessment: 0 });
    const reply = detail.evidence.find((item) => item.disposition === "reply")!;

    // Terms cited from the email are assessed under plan 1.
    const accepted = await post(`/api/cases/${caseId}/corrections`, {
      actorId: "buyer-1",
      basisAssessment: 0,
      changes: emailChanges(email),
    });
    expect(accepted.body).toMatchObject({ outcome: "accepted", planVersion: 1 });

    // The supplier's own words support revision 2, but intake blocks a stale base.
    const blocked = await post(`/api/cases/${caseId}/corrections`, {
      actorId: "buyer-1",
      basisAssessment: 1,
      changes: [{ field: "baseRevision", value: "2", citation: cite(reply, "revision 2") }],
    });
    expect(blocked.body).toMatchObject({ outcome: "blocked", state: "needs_clarification" });
    detail = await detailOf(caseId);
    expect(detail.plan).toBeNull();
    expect(detail.candidate).toMatchObject({ source: "correction", supported: true });
    expect(detail.candidate!.terms.baseRevision).toBe("2");

    // A later valid reply must not reassess the plan 1 terms from before the block.
    expect((await ask("Q-2", 2)).status).toBe(201);
    const second = await answer("Q-2", 2, "Yes, revision 2 is the one we confirmed.");
    expect(second.body).toMatchObject({ questionRef: "Q-2", state: "needs_clarification" });
    detail = await detailOf(caseId);
    expect(detail.case).toMatchObject({ reason: "correction_required", owner: "buyer" });
    expect(detail.plan).toBeNull();
    expect(detail.plans.map((plan) => plan.planVersion)).toEqual([1]);
    expect(detail.basisAssessment).toBe(2);
  });
});
