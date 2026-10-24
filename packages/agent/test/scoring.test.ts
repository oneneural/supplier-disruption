// Evaluation scoring (ADR 0011): semantic provenance of each proposed
// field, required-field counts, the oracle-normalized input and the
// downstream verdict against a manifest's machine-checkable note.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  baselineExtract,
  downstreamVerdict,
  oracleOutcome,
  parseDownstream,
  scenarioSchema,
  scoreScenario,
  semanticProvenance,
  worldGapMisses,
} from "../src/index.js";

const scenario = (set: string, id: string) =>
  scenarioSchema.parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../evaluation/scenarios/${set}/${id}.json`, import.meta.url)),
        "utf8",
      ),
    ),
  );

describe("semantic provenance", () => {
  const d01 = scenario("dev", "D01");
  const outcome = baselineExtract(d01);
  if (outcome.kind !== "proposed") throw new Error("the baseline must propose D01");

  it("counts every required field whose span and value are right", () => {
    const result = semanticProvenance(d01, outcome.terms, outcome.locators);
    expect(result).toEqual({ fields: 9, correct: 9, misses: [] });
    expect(scoreScenario(d01, outcome, null).requiredFields).toEqual({ expected: 9, exact: 9 });
  });

  it("misses a locator whose offsets no longer reproduce its quote", () => {
    const locators = outcome.locators.map((each) =>
      each.field === "segments[0].quantity" && each.source === "email"
        ? { ...each, start: each.start + 1, end: each.end + 1 }
        : each,
    );
    const result = semanticProvenance(d01, outcome.terms, locators);
    expect(result.correct).toBe(8);
    expect(result.misses).toEqual([
      "segments[0].quantity: the span does not reproduce the quote in the stored evidence",
    ]);
  });

  it("misses a correctly located value that is not the expected one", () => {
    const changed = { ...d01, expected: { ...d01.expected, terms: { ...d01.expected.terms! } } };
    changed.expected.terms.vendorItem = "KF-A-99";
    const result = semanticProvenance(changed, outcome.terms, outcome.locators);
    expect(result.misses).toEqual([
      "vendorItem: located value KF-A-01 is not the expected KF-A-99",
    ]);
  });
});

describe("oracle-normalized input", () => {
  it("proposes declared terms even where a pause is allowed", () => {
    const d19 = scenario("dev", "D19");
    expect(d19.expected.outcomes).toContain("paused");
    expect(oracleOutcome(d19).kind).toBe("proposed");
  });

  it("has no normalized input for a case without declared terms", () => {
    expect(oracleOutcome(scenario("dev", "D15"))).toMatchObject({
      kind: "paused",
      detail: "oracle: no declared terms",
    });
  });
});

describe("downstream verdict", () => {
  const note = parseDownstream(
    "intake blocked unverified_sender; case needs_clarification (unverified_sender)",
  );
  const paused = {
    intake: "not_invoked" as const,
    intakeReason: null,
    caseState: "needs_clarification",
    caseReason: "agent_escalated",
  };

  it("reads only machine-checkable statements from the note", () => {
    expect(note).toEqual({
      intake: "blocked",
      states: ["needs_clarification"],
      reasons: ["unverified_sender"],
    });
  });

  it("agrees when intake blocks with the stated reason", () => {
    const blocked = {
      intake: "blocked" as const,
      intakeReason: "unverified_sender",
      caseState: "needs_clarification",
      caseReason: "unverified_sender",
    };
    expect(downstreamVerdict(note, blocked)).toMatchObject({ verdict: "agree", misses: [] });
  });

  it("counts a pause the manifest does not allow as a disagreement", () => {
    const result = downstreamVerdict(note, paused, { pauseAllowed: false });
    expect(result.verdict).toBe("disagree");
    expect(result.misses).toContain("intake not_invoked, expected blocked");
  });

  it("compares only the case state when the manifest allows the pause", () => {
    expect(downstreamVerdict(note, paused, { pauseAllowed: true })).toEqual({
      verdict: "agree",
      stateAgrees: true,
      misses: [],
      pausedAsAllowed: true,
    });
  });
});

describe("world or setup gaps", () => {
  const note = parseDownstream(
    "intake accept; case awaiting_approval (policy_plan_ready_for_approval)",
  );
  // The declared terms through the workflow: intake accepts, but the seeded
  // demand differs, so the case escalates (as holdout H01 does).
  const oracle = downstreamVerdict(note, {
    intake: "accept",
    intakeReason: null,
    caseState: "escalated",
    caseReason: "unresolved_shortage",
  });

  it("flags only the misses the oracle-normalized arm has for the same case", () => {
    const blocked = downstreamVerdict(note, {
      intake: "blocked",
      intakeReason: "stale_base_revision",
      caseState: "escalated",
      caseReason: "unresolved_shortage",
    });
    // Intake, state and reason all miss; only the state miss reads as the oracle arm's.
    expect(blocked.misses).toHaveLength(3);
    expect(worldGapMisses(blocked.misses, oracle.misses)).toEqual([
      "case escalated, expected awaiting_approval",
    ]);
  });

  it("flags every miss when the arm misses exactly as the oracle arm does", () => {
    expect(worldGapMisses(oracle.misses, oracle.misses)).toEqual(oracle.misses);
  });

  it("flags nothing when the oracle-normalized arm agrees", () => {
    const paused = downstreamVerdict(note, {
      intake: "not_invoked",
      intakeReason: null,
      caseState: "needs_clarification",
      caseReason: "agent_escalated",
    });
    expect(paused.verdict).toBe("disagree");
    expect(worldGapMisses(paused.misses, [])).toEqual([]);
  });
});
