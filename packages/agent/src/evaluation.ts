import {
  caseStateSchema,
  supplierProposalTermsSchema,
  type EvidenceLocator,
  type PurchaseOrderRevision,
  type SupplierProposalTerms,
} from "@supplier-disruption/contracts";
import { z } from "zod";
import { evidenceText, sha256Hex } from "./evidence.js";
import type { AgentOutcome, ExtractionResult } from "./graph.js";
import type { ToolHost } from "./tools.js";
import { validateProposal } from "./validate.js";

/**
 * Offline evaluation support (SD-18): scenario manifests, the fixture world
 * the tools read, a deterministic baseline extractor and scoring. Manifests
 * state expected outcomes, fields and forbidden effects; they are written
 * before prompt tuning and are never shown to the model.
 */
export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[A-Z][0-9]{2}$/),
  family: z.string().min(1),
  note: z.string().optional(),
  email: z.strictObject({
    sender: z.email(),
    subject: z.string(),
    text: z.string().min(1),
    attachmentText: z.string().optional(),
  }),
  expected: z.strictObject({
    /** Acceptable agent outcomes. A proposal must equal `terms` exactly. */
    outcomes: z.array(z.enum(["proposed", "paused"])).min(1),
    terms: supplierProposalTermsSchema.omit({ unresolvedFields: true }).optional(),
    /** What deterministic intake and assessment should then do (documentation for reviewers). */
    downstream: z.string(),
  }),
  /** Effects that are critical violations if they occur. */
  forbidden: z.array(z.enum(["proposal", "dated_arrival", "unregistered_tool_executed"])),
});

export type Scenario = z.infer<typeof scenarioSchema>;

const unknown = { state: "unknown" } as const;
function order(
  poNumber: string,
  revision: string,
  vendorId: string,
  lines: PurchaseOrderRevision["lines"],
): PurchaseOrderRevision {
  return {
    contractVersion: "supplier-domain.v1",
    organization: "ORG-NDL",
    poNumber,
    revision,
    vendorId,
    observedAt: unknown,
    effectiveDate: unknown,
    lines,
  };
}
const line = (
  lineNumber: string,
  sku: string,
  ordered: string,
  received = "0",
  date = "2026-10-23",
) => ({
  lineNumber,
  sku,
  uom: "EA",
  destination: "WH-A",
  ordered,
  received,
  canceled: "0",
  acceptedSegments: [
    {
      sequence: 1,
      quantity: String(Number(ordered) - Number(received)),
      arrival: { state: "dated" as const, date },
    },
  ],
});

/** The evaluation world: registered senders and purchase orders (fictional). */
export const EVALUATION_WORLD = {
  senders: {
    "orders@kestrel-fasteners.test": "V-100",
    "sales@harbor-supply.test": "V-200",
  } as Record<string, string>,
  orders: [
    order("PO-120", "3", "V-100", [line("10", "PART-A", "120")]),
    order("PO-121", "2", "V-100", [line("10", "PART-C", "200", "50", "2026-10-24")]),
    order("PO-122", "1", "V-100", [line("10", "PART-A", "60"), line("20", "PART-A", "60")]),
    order("PO-123", "4", "V-100", [line("10", "PART-D", "240", "0", "2026-10-24")]),
    order("PO-220", "1", "V-200", [line("10", "PART-H", "500")]),
  ],
};

/** Tool reads against the evaluation world, scoped to the sender's registered vendor. */
export function worldHost(sender: string): ToolHost {
  const vendorId = EVALUATION_WORLD.senders[sender];
  return {
    readPurchaseOrder(poNumber) {
      if (vendorId === undefined) {
        return Promise.resolve({
          status: "not_permitted",
          detail: "the sender is not a registered vendor contact",
        });
      }
      const record = EVALUATION_WORLD.orders.find((po) => po.poNumber === poNumber);
      if (record === undefined) {
        return Promise.resolve({ status: "not_found", detail: "no such purchase order" });
      }
      if (record.vendorId !== vendorId) {
        return Promise.resolve({
          status: "not_permitted",
          detail: "the order belongs to another vendor",
        });
      }
      return Promise.resolve({ status: "ok", data: record });
    },
    inspectDemandAndStock(poNumber, poLine) {
      const record = EVALUATION_WORLD.orders.find((po) => po.poNumber === poNumber);
      if (vendorId === undefined || record?.vendorId !== vendorId) {
        return Promise.resolve({ status: "not_permitted", detail: "not this vendor's order" });
      }
      return Promise.resolve({
        status: "ok",
        data: {
          line: poLine,
          demand: [{ salesOrder: "SO-201", line: "10", open: "70", cutoff: "2026-10-23" }],
          eligibleStock: { warehouse: "WH-A", eligible: "30" },
        },
      });
    },
  };
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * The deterministic baseline: regular expressions over the email text, with
 * the same validation as the model. It recognizes only plainly stated
 * schedules ("40 EA ... on 23 October 2026") and pauses otherwise.
 */
export function baselineExtract(scenario: Scenario): AgentOutcome {
  const text = evidenceText(scenario.email);
  const pause = (detail: string): AgentOutcome => ({
    kind: "paused",
    reason: "agent_escalated",
    detail,
  });
  const po = /\bPO[- ]?(\d{2,})\b/.exec(text);
  const lineMatch = /\bline\s+(\d+)\b/i.exec(text);
  const rev = /\b(rev(?:ision)?\.?\s*(\d+))\b/i.exec(text);
  const item = /\b([A-Z]{2}-[A-Z]-\d{2})\b/.exec(text);
  if (po === null || lineMatch === null || rev === null || item === null) {
    return pause("baseline: no PO, line, revision or item pattern");
  }
  // One segment per clause that states a quantity, a unit, a delivery word and a full date.
  const clauses = text.split(/[.;\n]|,\s*(?:and|then|but)\s/);
  const segments = clauses.flatMap((clause) => {
    const quantity = /\b(\d+)\s*(EA|pcs|pieces|units|cartons|CTN|boxes)\b/i.exec(clause);
    const date = /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/.exec(clause);
    const delivery = /\b(deliver(?:ed|y)?|arriv(?:e|es|al))\b/i.test(clause);
    const shipping = /\b(ship|ships|shipped|dispatch(?:ed)?)\b/i.test(clause);
    if (quantity === null || date === null || !delivery || shipping) return [];
    const month = MONTH_NAMES.indexOf((date[2] ?? "").slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return [];
    return [{ quantity, date, clause: clause.trim(), month }];
  });
  if (segments.length === 0) return pause("baseline: no dated delivery pattern");
  const first = segments[0]!.quantity;
  const unitWord = (first[2] ?? "").toLowerCase();
  const uom = unitWord.startsWith("c") ? "CTN" : unitWord.startsWith("b") ? "BOX" : "EA";
  const proposal = {
    poNumber: { value: `PO-${po[1]!}`, quote: po[0], confidence: "high" },
    poLine: {
      value: lineMatch[1]!,
      cite: { source: "email", quote: lineMatch[0] },
      confidence: "high",
    },
    baseRevision: { value: rev[2]!, cite: { source: "email", quote: rev[1]! }, confidence: "high" },
    vendorItem: { value: item[1]!, quote: item[0], confidence: "high" },
    uom: { value: uom, quote: first[0], confidence: "high" },
    segments: segments.map(({ quantity, date, clause, month }) => ({
      quantity: { value: quantity[1]!, quote: quantity[0], confidence: "high" },
      arrival: {
        state: "dated",
        date: `${date[3]!}-${String(month).padStart(2, "0")}-${date[1]!.padStart(2, "0")}`,
        quote: clause,
        confidence: "high",
      },
    })),
    rationale: "Baseline pattern match.",
  };
  const validation = validateProposal(proposal, {
    evidenceText: text,
    evidenceSha256: sha256Hex(text),
    purchaseOrders: {},
  });
  if (!validation.ok) return pause(`baseline: ${validation.diagnostics.join("; ")}`);
  return {
    kind: "proposed",
    terms: validation.terms,
    locators: validation.locators,
    rationale: validation.rationale,
  };
}

/**
 * The oracle-normalized row: the manifest's expected terms as the extraction,
 * isolating extraction errors. Whenever terms are declared they are proposed,
 * even where a pause is also allowed, so the real workflow downstream decides
 * the outcome; only a case with no declared terms has no normalized input.
 */
export function oracleOutcome(scenario: Scenario): AgentOutcome {
  if (scenario.expected.terms !== undefined) {
    return {
      kind: "proposed",
      terms: withUnresolved(scenario.expected.terms),
      locators: [],
      rationale: "oracle",
    };
  }
  return { kind: "paused", reason: "agent_escalated", detail: "oracle: no declared terms" };
}

function withUnresolved(
  terms: Omit<SupplierProposalTerms, "unresolvedFields">,
): SupplierProposalTerms {
  return {
    ...terms,
    unresolvedFields: terms.segments
      .map((segment, index) =>
        segment.arrival.state === "undated" ? `segments[${String(index)}].arrival` : null,
      )
      .filter((path): path is string => path !== null),
  };
}

export interface ScenarioScore {
  id: string;
  family: string;
  outcome: AgentOutcome["kind"];
  reason: string | null;
  outcomeCorrect: boolean;
  /** Proposal equals the expected terms (null when no proposal was expected or made). */
  exactMatch: boolean | null;
  /** Every field of an accepted proposal has a locator. */
  provenanceComplete: boolean | null;
  /**
   * Semantic provenance of a proposal's required fields: a field is correct
   * when its locator reproduces the cited span (or record field) and the
   * located value is the expected one. Null when nothing was proposed.
   */
  provenance: { fields: number; correct: number; misses: string[] } | null;
  /**
   * Expected required fields and how many the outcome states exactly, for a
   * case that expects a proposal and allows no pause; null otherwise.
   */
  requiredFields: { expected: number; exact: number } | null;
  unnecessaryEscalation: boolean;
  criticalViolations: string[];
  unregisteredToolAttempts: number;
  toolCalls: number;
  modelCalls: number;
  latencyMs: number;
  costMicroUsd: number;
}

const REQUIRED_FIELDS = (terms: SupplierProposalTerms) => [
  "poNumber",
  "poLine",
  "baseRevision",
  "vendorItem",
  "uom",
  ...terms.segments.flatMap((_, index) => [
    `segments[${String(index)}].quantity`,
    `segments[${String(index)}].arrival`,
  ]),
];

/** A required field's value in a set of terms, as a locator states it. */
function fieldValue(terms: SupplierProposalTerms, field: string): string | undefined {
  const segment = /^segments\[(\d+)\]\.(quantity|arrival)$/.exec(field);
  if (segment !== null) {
    const entry = terms.segments[Number(segment[1])];
    if (entry === undefined) return undefined;
    if (segment[2] === "quantity") return entry.quantity;
    return entry.arrival.state === "dated" ? entry.arrival.date : "undated";
  }
  const value = (terms as unknown as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Checks each required field of a proposal independently of the validator:
 * the email span at the locator's offsets must equal its quote under the
 * evidence digest, a record citation must name the evaluation world's order
 * at that revision, and the located value must equal the expected value.
 */
export function semanticProvenance(
  scenario: Scenario,
  terms: SupplierProposalTerms,
  locators: readonly EvidenceLocator[],
): { fields: number; correct: number; misses: string[] } {
  const text = evidenceText(scenario.email);
  const digest = sha256Hex(text);
  const expected =
    scenario.expected.terms === undefined ? undefined : withUnresolved(scenario.expected.terms);
  const fields = REQUIRED_FIELDS(terms);
  // Without expected terms no located value can be the expected one.
  if (expected === undefined) {
    return { fields: fields.length, correct: 0, misses: ["no proposal was expected"] };
  }
  const misses: string[] = [];
  for (const field of fields) {
    const proposed = fieldValue(terms, field);
    const locator = locators.find((each) => each.field === field);
    if (locator === undefined) {
      misses.push(`${field}: no locator`);
      continue;
    }
    if (locator.value !== proposed) {
      misses.push(
        `${field}: the locator states ${locator.value}, the proposal ${String(proposed)}`,
      );
      continue;
    }
    if (locator.source === "email") {
      if (
        locator.evidenceSha256 !== digest ||
        text.slice(locator.start, locator.end) !== locator.quote
      ) {
        misses.push(`${field}: the span does not reproduce the quote in the stored evidence`);
        continue;
      }
    } else {
      const order = EVALUATION_WORLD.orders.find(
        (each) => each.poNumber === locator.poNumber && each.revision === locator.revision,
      );
      const recordValue =
        locator.recordField === "revision"
          ? order?.revision
          : order?.lines.length === 1
            ? order.lines[0]?.lineNumber
            : undefined;
      if (recordValue !== locator.value) {
        misses.push(`${field}: the cited record does not state ${locator.value}`);
        continue;
      }
    }
    const wanted = fieldValue(expected, field);
    if (wanted !== proposed) {
      misses.push(
        `${field}: located value ${String(proposed)} is not the expected ${String(wanted)}`,
      );
      continue;
    }
  }
  return { fields: fields.length, correct: fields.length - misses.length, misses };
}

export function scoreScenario(
  scenario: Scenario,
  outcome: AgentOutcome,
  run: Pick<ExtractionResult, "steps" | "toolCalls" | "modelCalls" | "usage"> | null,
): ScenarioScore {
  const expected = scenario.expected;
  const proposed = outcome.kind === "proposed" ? outcome : null;
  const expectedTerms = expected.terms === undefined ? undefined : withUnresolved(expected.terms);
  const exactMatch =
    proposed === null || expectedTerms === undefined
      ? null
      : JSON.stringify(proposed.terms) === JSON.stringify(expectedTerms);
  let outcomeCorrect = expected.outcomes.includes(outcome.kind);
  if (proposed !== null && expectedTerms !== undefined && exactMatch === false)
    outcomeCorrect = false;
  if (proposed !== null && expectedTerms === undefined) outcomeCorrect = false;

  const violations: string[] = [];
  if (proposed !== null && scenario.forbidden.includes("proposal")) violations.push("proposal");
  if (
    proposed !== null &&
    scenario.forbidden.includes("dated_arrival") &&
    proposed.terms.segments.some((segment) => segment.arrival.state === "dated")
  ) {
    violations.push("dated_arrival");
  }
  const steps = run?.steps ?? [];
  const unregistered = steps.filter(
    (step) => step.kind === "tool" && step.reason === "tool is not registered",
  );
  if (unregistered.some((step) => step.accepted)) violations.push("unregistered_tool_executed");

  const fields = proposed === null ? [] : REQUIRED_FIELDS(proposed.terms);
  const located = new Set(proposed?.locators.map((locator) => locator.field) ?? []);
  return {
    id: scenario.id,
    family: scenario.family,
    outcome: outcome.kind,
    reason: outcome.kind === "paused" ? outcome.reason : null,
    outcomeCorrect,
    exactMatch,
    provenanceComplete:
      proposed === null || proposed.locators.length === 0
        ? null
        : fields.every((field) => located.has(field)),
    // The oracle-normalized row carries no locators; it has no provenance to check.
    provenance:
      proposed === null || proposed.locators.length === 0
        ? null
        : semanticProvenance(scenario, proposed.terms, proposed.locators),
    requiredFields:
      expectedTerms === undefined || expected.outcomes.includes("paused")
        ? null
        : {
            expected: REQUIRED_FIELDS(expectedTerms).length,
            exact:
              proposed === null
                ? 0
                : REQUIRED_FIELDS(expectedTerms).filter((field) => {
                    const value = fieldValue(proposed.terms, field);
                    return value !== undefined && value === fieldValue(expectedTerms, field);
                  }).length,
          },
    unnecessaryEscalation: outcome.kind === "paused" && !expected.outcomes.includes("paused"),
    criticalViolations: violations,
    unregisteredToolAttempts: unregistered.length,
    toolCalls: run?.toolCalls ?? 0,
    modelCalls: run?.modelCalls ?? 0,
    latencyMs: run?.usage.latencyMs ?? 0,
    costMicroUsd: run?.usage.costMicroUsd ?? 0,
  };
}

export interface ModeSummary {
  mode: string;
  cases: number;
  outcomeCorrect: number;
  /** Proposals expected on supported unambiguous inputs, and how many matched exactly. */
  extractionExpected: number;
  extractionExact: number;
  /** Required fields over the same cases, and how many were extracted exactly (SPEC target 90%). */
  requiredFieldsExpected: number;
  requiredFieldsExact: number;
  provenanceComplete: number;
  provenanceChecked: number;
  /** Required fields of every proposal, and how many carry correct semantic provenance. */
  provenanceFields: number;
  provenanceCorrect: number;
  completed: number;
  escalated: number;
  unnecessaryEscalations: number;
  criticalViolations: number;
  unregisteredToolAttempts: number;
  toolCalls: number;
  meanToolCalls: number;
  latencyMs: number;
  costMicroUsd: number;
}

export function summarize(
  mode: string,
  scenarios: Scenario[],
  scores: ScenarioScore[],
): ModeSummary {
  const proposalOnly = scenarios.filter(
    (scenario) =>
      scenario.expected.terms !== undefined && !scenario.expected.outcomes.includes("paused"),
  );
  const byId = new Map(scores.map((score) => [score.id, score]));
  const sum = (pick: (score: ScenarioScore) => number) =>
    scores.reduce((total, score) => total + pick(score), 0);
  return {
    mode,
    cases: scores.length,
    outcomeCorrect: scores.filter((score) => score.outcomeCorrect).length,
    extractionExpected: proposalOnly.length,
    extractionExact: proposalOnly.filter((scenario) => byId.get(scenario.id)?.exactMatch === true)
      .length,
    requiredFieldsExpected: proposalOnly.reduce(
      (total, scenario) => total + (byId.get(scenario.id)?.requiredFields?.expected ?? 0),
      0,
    ),
    requiredFieldsExact: proposalOnly.reduce(
      (total, scenario) => total + (byId.get(scenario.id)?.requiredFields?.exact ?? 0),
      0,
    ),
    provenanceComplete: scores.filter((score) => score.provenanceComplete === true).length,
    provenanceChecked: scores.filter((score) => score.provenanceComplete !== null).length,
    provenanceFields: sum((score) => score.provenance?.fields ?? 0),
    provenanceCorrect: sum((score) => score.provenance?.correct ?? 0),
    completed: scores.filter((score) => score.outcome === "proposed").length,
    escalated: scores.filter((score) => score.outcome === "paused").length,
    unnecessaryEscalations: scores.filter((score) => score.unnecessaryEscalation).length,
    criticalViolations: sum((score) => score.criticalViolations.length),
    unregisteredToolAttempts: sum((score) => score.unregisteredToolAttempts),
    toolCalls: sum((score) => score.toolCalls),
    meanToolCalls: scores.length === 0 ? 0 : sum((score) => score.toolCalls) / scores.length,
    latencyMs: sum((score) => score.latencyMs),
    costMicroUsd: sum((score) => score.costMicroUsd),
  };
}

/** What a manifest's free-text downstream note states in machine-checkable terms. */
export interface DownstreamExpectation {
  /** `intake accept`, `intake blocked`/`blocks` or `intake duplicate`, when stated. */
  intake: "accept" | "blocked" | "duplicate" | null;
  /** Case states named in the note. */
  states: string[];
  /** Other snake_case codes named in the note: block and case reasons. */
  reasons: string[];
}

const CASE_STATES: readonly string[] = caseStateSchema.options;

/**
 * Reads the downstream note conservatively: only an explicit "intake <word>",
 * case state names and snake_case reason codes count. Anything else in the
 * note stays prose for reviewers and is not scored.
 */
export function parseDownstream(note: string): DownstreamExpectation {
  const intakeWord = /\bintake\s+(accept|accepts|accepted|blocked|blocks|duplicate)\b/i.exec(note);
  const word = intakeWord?.[1]?.toLowerCase();
  const intake =
    word === undefined
      ? null
      : word.startsWith("accept")
        ? "accept"
        : word === "duplicate"
          ? "duplicate"
          : "blocked";
  const codes = [...new Set(note.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? [])];
  return {
    intake,
    states: codes.filter((code) => CASE_STATES.includes(code)),
    reasons: codes.filter((code) => !CASE_STATES.includes(code)),
  };
}

/** The downstream result of one arm for one case, as the workflow recorded it. */
export interface DownstreamObservation {
  /** `not_invoked` when the extraction paused before intake. */
  intake: "accept" | "blocked" | "duplicate" | "not_invoked";
  intakeReason: string | null;
  caseState: string;
  caseReason: string | null;
}

/**
 * `agree` when every machine-checkable statement of the note holds,
 * `disagree` when one does not, `unstated` when the note states none.
 * The state alone is reported separately, so a safe pause with a different
 * reason stays distinguishable from a wrong plan.
 *
 * When the manifest allows a pause and the arm paused before intake, the
 * note's intake disposition and reason codes describe an intake that never
 * ran; only the case state is compared, and `pausedAsAllowed` says so.
 */
export function downstreamVerdict(
  expected: DownstreamExpectation,
  observed: DownstreamObservation,
  options: { pauseAllowed?: boolean } = {},
): {
  verdict: "agree" | "disagree" | "unstated";
  stateAgrees: boolean | null;
  misses: string[];
  pausedAsAllowed: boolean;
} {
  const misses: string[] = [];
  let checks = 0;
  const pausedAsAllowed = observed.intake === "not_invoked" && options.pauseAllowed === true;
  if (pausedAsAllowed) {
    expected = { ...expected, intake: null, reasons: [] };
  }
  if (expected.intake !== null) {
    checks += 1;
    if (observed.intake !== expected.intake) {
      misses.push(`intake ${observed.intake}, expected ${expected.intake}`);
    }
  }
  let stateAgrees: boolean | null = null;
  if (expected.states.length > 0) {
    checks += 1;
    stateAgrees = expected.states.includes(observed.caseState);
    if (!stateAgrees) {
      misses.push(`case ${observed.caseState}, expected ${expected.states.join(" or ")}`);
    }
  }
  if (expected.reasons.length > 0) {
    checks += 1;
    const seen = [observed.intakeReason, observed.caseReason].filter(
      (reason): reason is string => reason !== null,
    );
    if (!seen.some((reason) => expected.reasons.includes(reason))) {
      misses.push(
        `reason ${seen.join("/") || "none"}, expected one of ${expected.reasons.join(", ")}`,
      );
    }
  }
  return {
    verdict: checks === 0 ? "unstated" : misses.length === 0 ? "agree" : "disagree",
    stateAgrees,
    misses,
    pausedAsAllowed,
  };
}

/**
 * The downstream misses of one arm's case that the oracle-normalized arm also
 * has for that case, word for word. Only these are world or setup gaps: the
 * declared terms through the real workflow miss the note in the same way.
 * Any other miss of the arm stays its own.
 */
export function worldGapMisses(
  misses: readonly string[],
  oracleMisses: readonly string[],
): string[] {
  return misses.filter((miss) => oracleMisses.includes(miss));
}
