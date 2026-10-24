import { randomUUID } from "node:crypto";
import {
  emailBytes,
  emailMessageKey,
  evidenceText,
  inspectCheckpoint,
  runExtraction,
  sha256Hex,
  type AgentOutcome,
  type CheckpointInspection,
  type ExtractionOptions,
  type ExtractionResult,
  type ModelProvider,
  type RunUsage,
  type SupplierEmail,
  type ToolHost,
} from "@supplier-disruption/agent";
import {
  AGENT_DEFAULT_TOOL_BUDGET,
  DOMAIN_CONTRACT_VERSION,
  type AgentPauseReason,
  type AgentRunRecord,
  type AgentStepRecord,
  type EmailIngestCommand,
  type EvidenceLocator,
  type SupplierInputIdentity,
  type SupplierProposalTerms,
} from "@supplier-disruption/contracts";
import {
  agentRun,
  agentStep,
  supplierCase,
  supplierContentSha256,
  supplierMessage,
  type ModelSpendLedger,
  type SpendUsage,
} from "@supplier-disruption/db";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { and, asc, eq, sql } from "drizzle-orm";
import { CASE_FIXTURE } from "./fixture.js";
import {
  appendEvent,
  CaseStateConflict,
  isoInstant,
  lockCase,
  transition,
  type Db,
  type Tx,
} from "./store.js";
import type { CaseResult, CaseWorkflow } from "./workflow.js";

/**
 * Email intake through the bounded extraction agent (ADR 0011).
 *
 * 1. `ingestEmail` stores the email's exact bytes as evidence, opens a case in
 *    `received` and queues one agent run in the same transaction.
 * 2. `extract` (the case job) runs or resumes the checkpointed graph with
 *    case-scoped read tools, then records every step and the totals.
 * 3. A validated proposal becomes a structured supplier input with a
 *    server-stated identity, and the existing ingest runs intake and
 *    assessment on it exactly as for a fixture message. Any pause moves the
 *    case to `needs_clarification` with the reason and the buyer as owner.
 *
 * Recovery (ADR 0019): one delivery of a case's job runs the graph at
 * a time. A run a stopped process left unfinished resumes from its PostgreSQL
 * checkpoint under the same contract, admitted for what its cost cap has
 * left, or pauses `agent_checkpoint_incompatible` with the checkpoint kept.
 * A case that left `received` meanwhile is never handed a proposal: the
 * hand-off checks it first, and intake itself refuses to assess a case that
 * is no longer `received`, so an escalation committed in between still wins.
 */
export interface AgentSettings {
  /** Null when no provider is configured: every run pauses `agent_provider_unavailable`. */
  provider: ModelProvider | null;
  /** The PostgreSQL saver in production; tests may omit it to checkpoint in memory. */
  checkpointer?: BaseCheckpointSaver;
  toolBudget?: number;
  costCapMicroUsd: number;
  /**
   * The application's limit on the project spend total (ADR 0017), never
   * above the owner's USD 15 pause, which applies when this is unset.
   */
  totalCostCapMicroUsd?: number;
  /**
   * The project-wide spend ledger. A metered run reserves its cost cap here
   * before any provider call and pauses `agent_spend_cap_reached` when the
   * reservation is refused or no ledger is configured. Replays are not metered.
   */
  spendLedger?: ModelSpendLedger;
}

/**
 * What this attempt reported: the run's cumulative usage less what its
 * checkpoint already held when the attempt started, so a resumed attempt never
 * settles the earlier attempt's known usage again.
 */
function spendUsage(result: ExtractionResult, before: RunUsage | null): SpendUsage {
  const less = (field: keyof SpendUsage) => result.usage[field] - (before?.[field] ?? 0);
  return {
    inputTokens: less("inputTokens"),
    outputTokens: less("outputTokens"),
    cacheReadTokens: less("cacheReadTokens"),
    cacheWriteTokens: less("cacheWriteTokens"),
    costMicroUsd: less("costMicroUsd"),
  };
}

/** Run statuses of a graph that has not reached an outcome. */
const UNFINISHED = ["queued", "running"];

const organization = CASE_FIXTURE.label;

export class EmailExtraction {
  constructor(
    private readonly workflow: CaseWorkflow,
    private readonly settings: AgentSettings,
  ) {}

  private get db(): Db {
    return this.workflow.deps.db;
  }

  async ingestEmail(command: EmailIngestCommand): Promise<CaseResult> {
    const organizationId = command.organizationId;
    if (organizationId !== CASE_FIXTURE.organization.id) {
      return { status: 404, body: { error: "organization_not_served" } };
    }
    const email: SupplierEmail = {
      sender: command.sender,
      subject: command.subject,
      text: command.text,
      ...(command.attachmentText === undefined ? {} : { attachmentText: command.attachmentText }),
    };
    const key = emailMessageKey(email);
    const delivery = {
      organizationId,
      deliveryId: command.deliveryId,
      sourceSystem: key.sourceSystem,
      messageId: key.messageId,
      inputVersion: key.inputVersion,
    };
    const replay = await this.workflow.recordedDelivery(this.db, organizationId, delivery);
    if (replay !== null) return replay;
    const content = emailBytes(email);
    const text = evidenceText(email);

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`case-ingest:${organizationId}`}))`,
      );
      const again = await this.workflow.recordedDelivery(tx, organizationId, delivery);
      if (again !== null) return again;
      const at = await this.workflow.deps.clock.now();
      const [existing] = await tx
        .select()
        .from(supplierCase)
        .where(
          and(
            eq(supplierCase.organizationId, organizationId),
            eq(supplierCase.sourceSystem, key.sourceSystem),
            eq(supplierCase.messageId, key.messageId),
          ),
        )
        .for("update");
      const message = {
        id: randomUUID(),
        organizationId,
        deliveryId: command.deliveryId,
        sourceSystem: key.sourceSystem,
        messageId: key.messageId,
        inputVersion: key.inputVersion,
        content,
        contentSha256: key.bytesSha256,
        receivedAt: at,
      };
      const detail = {
        deliveryId: command.deliveryId,
        messageSha256: key.bytesSha256,
        byteLength: content.length,
      };
      if (existing !== undefined) {
        // The same email again: one message, one case, one run (SD-01).
        await tx
          .insert(supplierMessage)
          .values({ ...message, disposition: "duplicate", reason: null, caseId: existing.id });
        await appendEvent(tx, existing, at, { kind: "duplicate_delivery", detail });
        return { status: 200, body: this.body(existing, "duplicate") };
      }
      const caseNumber = await this.workflow.nextCaseNumber(tx, organizationId);
      const row = await this.workflow.openCase(tx, {
        id: randomUUID(),
        organizationId,
        caseNumber,
        key: { sourceSystem: key.sourceSystem, messageId: key.messageId, inputVersion: 1 },
        at,
      });
      await tx
        .update(supplierCase)
        .set({ nextAction: "Extract the supplier email" })
        .where(eq(supplierCase.id, row.id));
      await tx
        .insert(supplierMessage)
        .values({ ...message, disposition: "evidence", reason: null, caseId: row.id });
      await appendEvent(tx, row, at, { kind: "delivery_stored", detail });
      const runId = randomUUID();
      await tx.insert(agentRun).values({
        id: runId,
        caseId: row.id,
        status: "queued",
        provider: this.settings.provider?.name ?? "none",
        model: this.settings.provider?.model ?? null,
        toolBudget: this.settings.toolBudget ?? AGENT_DEFAULT_TOOL_BUDGET,
        costCapMicroUsd: this.settings.costCapMicroUsd,
        evidenceText: text,
        evidenceSha256: sha256Hex(text),
        startedAt: at,
      });
      await appendEvent(tx, row, at, { kind: "extraction_queued", detail: { runId } });
      await this.workflow.enqueue(tx, row.id);
      return { status: 201, body: this.body(row, "evidence") };
    });
  }

  private body(row: { id: string; caseNumber: number; state: string }, disposition: string) {
    return {
      disposition,
      reason: null,
      caseId: row.id,
      caseRef: `CASE-${String(row.caseNumber)}`,
      state: row.state,
    };
  }

  /**
   * Whether the case's next job step is extraction rather than application:
   * an email case still `received`, or one that left `received` while its run
   * was unfinished, so the run is closed rather than left running.
   */
  async pending(caseId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ state: supplierCase.state, status: agentRun.status })
      .from(supplierCase)
      .innerJoin(agentRun, eq(agentRun.caseId, supplierCase.id))
      .where(eq(supplierCase.id, caseId));
    if (row === undefined) return false;
    return row.state === "received" || UNFINISHED.includes(row.status);
  }

  /**
   * Runs (or resumes) the case's extraction and hands a validated proposal to
   * intake. Safe to repeat: a finished run is not re-run, the derived input is
   * appended once and the structured ingest replays by its delivery ID. A
   * session advisory lock admits one delivery of the case's job at a time; a
   * duplicate delivery returns `retry` without touching the run, and the lock
   * ends with the session of a process that stops.
   */
  async extract(caseId: string): Promise<{ state: string; retry: boolean }> {
    const client = await this.workflow.deps.sourcePool.connect();
    const lockKey = `case-extract:${caseId}`;
    let broken: Error | undefined;
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [lockKey],
      );
      if (rows[0]?.locked !== true) {
        const [row] = await this.db
          .select({ state: supplierCase.state })
          .from(supplierCase)
          .where(eq(supplierCase.id, caseId));
        return { state: row?.state ?? "missing", retry: true };
      }
      try {
        return await this.extractLocked(caseId);
      } finally {
        await client
          .query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey])
          .catch((error: unknown) => {
            // The session may still hold the lock: the pool discards it rather than reuse it.
            broken = error instanceof Error ? error : new Error(String(error));
          });
      }
    } finally {
      client.release(broken);
    }
  }

  /** Records on the case that the run's proposal was not handed to intake. */
  private async notHandedOff(caseId: string, runId: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const locked = await lockCase(tx, caseId);
      if (locked === null || locked.state === "received") return locked?.state ?? "missing";
      const at = await this.workflow.deps.clock.now();
      await appendEvent(tx, locked, at, {
        kind: "extraction_not_handed_off",
        detail: { runId, state: locked.state },
      });
      return locked.state;
    });
  }

  private async extractLocked(caseId: string): Promise<{ state: string; retry: boolean }> {
    const [run] = await this.db.select().from(agentRun).where(eq(agentRun.caseId, caseId));
    const [row] = await this.db.select().from(supplierCase).where(eq(supplierCase.id, caseId));
    if (run === undefined || row === undefined)
      return { state: row?.state ?? "missing", retry: false };
    if (row.state !== "received") {
      if (UNFINISHED.includes(run.status)) await this.closeInterrupted(run, row.state);
      return { state: row.state, retry: false };
    }

    let outcome: AgentOutcome;
    if (run.status === "proposed" && run.terms !== null) {
      outcome = {
        kind: "proposed",
        terms: run.terms as SupplierProposalTerms,
        locators: run.locators as EvidenceLocator[],
        rationale: run.rationale ?? "",
      };
    } else if (run.status === "paused") {
      outcome = {
        kind: "paused",
        reason: run.pauseReason as AgentPauseReason,
        detail: run.pauseDetail ?? "",
      };
    } else {
      outcome = await this.runAgent(run);
    }

    if (outcome.kind === "paused") {
      const state = await this.db.transaction(async (tx) => {
        const locked = await lockCase(tx, caseId);
        if (locked === null || locked.state !== "received") return locked?.state ?? "missing";
        const at = await this.workflow.deps.clock.now();
        await transition(
          tx,
          locked,
          at,
          { state: "needs_clarification", reason: outcome.reason, owner: "buyer" },
          { kind: "extraction_paused", detail: { runId: run.id, detail: outcome.detail } },
        );
        return locked.state;
      });
      return { state, retry: false };
    }

    // The proposal was formed before any wait, so the case's authority is read
    // again: a case escalated meanwhile never receives it.
    const current = await this.notHandedOff(caseId, run.id);
    if (current !== "received") return { state: current, retry: false };

    const email = await this.email(caseId);
    if (email === null) throw new Error("an email case keeps its evidence message");
    const terms = outcome.terms;
    const identity: SupplierInputIdentity = {
      contractVersion: DOMAIN_CONTRACT_VERSION,
      sourceSystem: row.sourceSystem,
      messageId: row.messageId,
      inputVersion: row.inputVersion,
      contentSha256: supplierContentSha256(terms),
      // The envelope sender as received; the model never states identity.
      sender: email.sender,
      proposalId: `PROP-${row.messageId}`,
      evidenceRef: `${row.messageId}@${String(row.inputVersion)}`,
      authoredAt: { state: "unknown" },
      receivedAt: { state: "unknown" },
    };
    // Intake reads the input back from its reference owner, so it is stored first.
    await this.workflow.sources.reference.recordSupplierInput({ identity, terms });
    let result: CaseResult;
    try {
      result = await this.workflow.ingest({
        organizationId: row.organizationId,
        // The run ID makes a retried hand-off replay the recorded intake outcome.
        deliveryId: run.id,
        sourceSystem: row.sourceSystem,
        messageId: row.messageId,
        inputVersion: row.inputVersion,
        supplierText: run.evidenceText.slice(0, 20_000),
      });
    } catch (thrown) {
      // The case left `received` after the check above (an escalation, for
      // example): intake rolled back and the case keeps its state.
      if (!(thrown instanceof CaseStateConflict)) throw thrown;
      return { state: await this.notHandedOff(caseId, run.id), retry: false };
    }
    if (result.status >= 500) return { state: row.state, retry: true };
    const [after] = await this.db
      .select({ state: supplierCase.state })
      .from(supplierCase)
      .where(eq(supplierCase.id, caseId));
    return { state: after?.state ?? row.state, retry: false };
  }

  private async email(caseId: string): Promise<SupplierEmail | null> {
    const [message] = await this.db
      .select({ content: supplierMessage.content })
      .from(supplierMessage)
      .where(and(eq(supplierMessage.caseId, caseId), eq(supplierMessage.disposition, "evidence")));
    return message === undefined
      ? null
      : (JSON.parse(message.content.toString("utf8")) as SupplierEmail);
  }

  /**
   * Closes a run a stopped process left unfinished on a case that has since
   * left `received` (an escalation while the API was down, for example). The
   * run is not resumed, its checkpoint is kept and any unsettled attempt
   * stays counted as uncertain usage.
   */
  private async closeInterrupted(run: typeof agentRun.$inferSelect, state: string) {
    await this.settings.spendLedger?.abandon(
      run.id,
      `the run was not resumed: its case is ${state}`,
    );
    const at = await this.workflow.deps.clock.now();
    await this.db
      .update(agentRun)
      .set({
        status: "paused",
        pauseReason: null,
        pauseDetail: `the case became ${state} before this interrupted run resumed; it was not resumed and its checkpoint is kept`,
        finishedAt: at,
      })
      .where(and(eq(agentRun.id, run.id), sql`${agentRun.status} in ('queued', 'running')`));
  }

  /** Pauses a run before any model call. */
  private async pauseBeforeCall(
    run: typeof agentRun.$inferSelect,
    reason: AgentPauseReason,
    detail: string,
  ): Promise<AgentOutcome> {
    const at = await this.workflow.deps.clock.now();
    await this.db
      .update(agentRun)
      .set({ status: "paused", pauseReason: reason, pauseDetail: detail, finishedAt: at })
      .where(eq(agentRun.id, run.id));
    return { kind: "paused", reason, detail };
  }

  /**
   * Reserves a metered run's cost cap in the project ledger (ADR 0017).
   * Returns the reservation key, or the refusal detail; nothing is reserved
   * on refusal. An earlier attempt for this run that never settled belongs to
   * a process that stopped, so its reservation becomes uncertain first and
   * stays counted.
   */
  private async admit(
    run: typeof agentRun.$inferSelect,
    provider: ModelProvider,
    ledger: ModelSpendLedger,
    amountMicroUsd: number,
  ): Promise<{ key: string } | { refused: string }> {
    await ledger.abandon(run.id, "an earlier attempt for this run stopped before settling");
    const key = `api:${run.id}:${randomUUID()}`;
    const admission = await ledger.admit({
      key,
      source: "api",
      reference: run.id,
      model: provider.model,
      amountMicroUsd,
      ...(this.settings.totalCostCapMicroUsd === undefined
        ? {}
        : { limitMicroUsd: this.settings.totalCostCapMicroUsd }),
    });
    return admission.admitted ? { key } : { refused: admission.detail };
  }

  private async runAgent(run: typeof agentRun.$inferSelect): Promise<AgentOutcome> {
    const provider = this.settings.provider;
    if (provider === null) {
      return this.pauseBeforeCall(
        run,
        "agent_provider_unavailable",
        "no model provider is configured",
      );
    }
    const email = await this.email(run.caseId);
    const options: ExtractionOptions = {
      provider,
      host: this.host(email?.sender ?? ""),
      evidence: { text: run.evidenceText, sha256: run.evidenceSha256 },
      threadId: run.id,
      ...(this.settings.checkpointer === undefined
        ? {}
        : { checkpointer: this.settings.checkpointer }),
      toolBudget: run.toolBudget,
      costCapMicroUsd: run.costCapMicroUsd,
    };
    // Read before any admission, so an incompatible checkpoint calls nothing
    // and a resumed run reserves only what its cost cap has left.
    const checkpoint: CheckpointInspection = await inspectCheckpoint(options);
    if (checkpoint.kind === "incompatible") {
      await this.settings.spendLedger?.abandon(
        run.id,
        "an earlier attempt left a checkpoint this run cannot resume",
      );
      return this.pauseBeforeCall(
        run,
        "agent_checkpoint_incompatible",
        `${checkpoint.detail}; the checkpoint is kept and no model was called`,
      );
    }
    const before = checkpoint.kind === "none" ? null : checkpoint;
    const remaining = run.costCapMicroUsd - (before?.usage.costMicroUsd ?? 0);
    let reservation: { key: string; ledger: ModelSpendLedger } | null = null;
    // A finished checkpoint, or a spent cap, makes no further call to admit.
    if (provider.metered !== false && checkpoint.kind !== "finished" && remaining > 0) {
      const ledger = this.settings.spendLedger;
      if (ledger === undefined) {
        return this.pauseBeforeCall(
          run,
          "agent_spend_cap_reached",
          "no project spend ledger is configured; no model was called",
        );
      }
      const admitted = await this.admit(run, provider, ledger, remaining);
      if ("refused" in admitted) {
        return this.pauseBeforeCall(run, "agent_spend_cap_reached", admitted.refused);
      }
      reservation = { key: admitted.key, ledger };
    } else if (provider.metered !== false) {
      await this.settings.spendLedger?.abandon(
        run.id,
        "an earlier attempt for this run stopped before settling",
      );
    }
    await this.db.update(agentRun).set({ status: "running" }).where(eq(agentRun.id, run.id));
    let result: ExtractionResult;
    try {
      result = await runExtraction(options);
    } catch (error) {
      // What the failed attempt spent is unknown; its reservation stays counted.
      await reservation?.ledger
        .markUncertain(reservation.key, "the run failed before reporting its usage")
        .catch(() => undefined);
      throw error;
    }
    if (reservation !== null) {
      const usage = spendUsage(result, before?.usage ?? null);
      // A resumable checkpoint never holds uncertain usage: every uncertain call pauses.
      if (result.usageUncertain) {
        const detail = result.outcome.kind === "paused" ? result.outcome.detail : "proposed";
        await reservation.ledger.markUncertain(
          reservation.key,
          `a call may have been billed without reported usage: ${detail}`,
          usage,
        );
      } else {
        await reservation.ledger.settle(reservation.key, usage);
      }
    }
    const outcome = result.outcome;
    const proposal = outcome.kind === "proposed" ? outcome : (outcome.proposal ?? null);
    const finishedAt = await this.workflow.deps.clock.now();
    await this.db.transaction(async (tx) => {
      if (result.steps.length > 0) {
        await tx
          .insert(agentStep)
          .values(result.steps.map((step) => ({ runId: run.id, ...step })))
          .onConflictDoNothing();
      }
      await tx
        .update(agentRun)
        .set({
          status: outcome.kind,
          toolCalls: result.toolCalls,
          modelCalls: result.modelCalls,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheWriteTokens: result.usage.cacheWriteTokens,
          costMicroUsd: result.usage.costMicroUsd,
          latencyMs: result.usage.latencyMs,
          pauseReason: outcome.kind === "paused" ? outcome.reason : null,
          pauseDetail: outcome.kind === "paused" ? outcome.detail : null,
          terms: proposal?.terms ?? null,
          locators: proposal?.locators ?? null,
          rationale: proposal?.rationale ?? null,
          finishedAt,
        })
        .where(eq(agentRun.id, run.id));
    });
    return outcome;
  }

  /**
   * Case-scoped reads. The vendor comes from the registered sender, never the
   * model, and only that vendor's orders are readable.
   */
  private host(sender: string): ToolHost {
    const { sources } = this.workflow;
    const vendorOf = async () => {
      const registered = await sources.reference.readRegisteredVendor({ organization, sender });
      return registered.status === "ok" ? registered.data.vendorId : null;
    };
    const orderOf = async (poNumber: string) => {
      const vendorId = await vendorOf();
      if (vendorId === null) {
        return {
          status: "not_permitted" as const,
          detail: "the sender is not a registered vendor contact",
        };
      }
      try {
        const read = await sources.purchasing.readPurchaseOrder({ organization, poNumber });
        if (read.record.vendorId !== vendorId) {
          return {
            status: "not_permitted" as const,
            detail: "the order belongs to another vendor",
          };
        }
        return { status: "ok" as const, data: read.record };
      } catch (error) {
        const reason = (error as { reason?: unknown }).reason;
        return reason === "source.not_found"
          ? { status: "not_found" as const, detail: "no such purchase order" }
          : { status: "unavailable" as const, detail: "the purchasing read failed" };
      }
    };
    return {
      readPurchaseOrder: orderOf,
      async inspectDemandAndStock(poNumber, poLine) {
        const order = await orderOf(poNumber);
        if (order.status !== "ok") return order;
        const line = order.data.lines.find((candidate) => candidate.lineNumber === poLine);
        if (line === undefined) return { status: "not_found", detail: "no such line on the order" };
        try {
          const demand = await sources.demand.readDemand({ organization });
          const stock = await sources.inventory.readStock({
            organization,
            sku: line.sku,
            warehouse: line.destination,
          });
          return {
            status: "ok",
            data: {
              demand: demand.record.lines.filter((demandLine) =>
                demandLine.supplyLinks.some(
                  (link) => link.poNumber === poNumber && link.poLine === poLine,
                ),
              ),
              stock: stock.record,
            },
          };
        } catch {
          return { status: "unavailable", detail: "the demand or stock read failed" };
        }
      },
    };
  }

  /** The case view's agent run, or null for a structured message case. */
  async record(caseId: string): Promise<AgentRunRecord | null> {
    const [run] = await this.db.select().from(agentRun).where(eq(agentRun.caseId, caseId));
    if (run === undefined) return null;
    const steps = await this.db
      .select()
      .from(agentStep)
      .where(eq(agentStep.runId, run.id))
      .orderBy(asc(agentStep.sequence));
    return {
      runId: run.id,
      status: run.status as AgentRunRecord["status"],
      provider: run.provider,
      model: run.model,
      toolBudget: run.toolBudget,
      toolCalls: run.toolCalls,
      modelCalls: run.modelCalls,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      cacheWriteTokens: run.cacheWriteTokens,
      costMicroUsd: run.costMicroUsd,
      latencyMs: run.latencyMs,
      pauseReason: run.pauseReason as AgentRunRecord["pauseReason"],
      pauseDetail: run.pauseDetail,
      owner: run.status === "paused" ? "buyer" : null,
      evidenceSha256: run.evidenceSha256,
      evidenceText: run.evidenceText,
      locators: (run.locators as EvidenceLocator[] | null) ?? [],
      rationale: run.rationale,
      startedAt: isoInstant(run.startedAt),
      finishedAt: run.finishedAt === null ? null : isoInstant(run.finishedAt),
      steps: steps.map((step): AgentStepRecord => ({
        sequence: step.sequence,
        kind: step.kind as AgentStepRecord["kind"],
        tool: step.tool,
        input: step.input,
        result: step.result,
        accepted: step.accepted,
        reason: step.reason,
        latencyMs: step.latencyMs,
        model: step.model,
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        cacheReadTokens: step.cacheReadTokens,
        cacheWriteTokens: step.cacheWriteTokens,
        costMicroUsd: step.costMicroUsd,
      })),
    };
  }
}

export type { Tx };
