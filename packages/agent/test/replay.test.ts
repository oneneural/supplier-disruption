// The committed live runs, replayed offline: every case must reach the
// outcome the committed report recorded, and every request must match its
// recording (so a prompt or tool change shows up here first).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RecordedRunProvider,
  ReplayProvider,
  evidenceText,
  runExtraction,
  scenarioSchema,
  scoreScenario,
  sha256Hex,
  worldHost,
} from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../evaluation/", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as unknown;

/**
 * The latest committed live run per set under the current system prompt: its
 * label, scenario set and minimum case count. Earlier runs (dev-1, dev-2,
 * holdout-1, holdout-2-regression, holdout-amended-regression) replay only at
 * their own prompt; holdout-1, the untouched held-out run, also only at its
 * own revision, as the later revision-pattern fix changes two outcomes.
 */
const RUNS = [
  { label: "dev-3", set: "dev", minimum: 25 },
  { label: "holdout-amended-regression-2", set: "holdout", minimum: 10 },
] as const;

describe.each(RUNS)("recorded live run $label", ({ label, set, minimum }) => {
  const report = read(`reports/${label}-live.json`) as {
    rows: {
      summary: { mode: string };
      scores: { id: string; outcome: string; reason: string | null; exactMatch: boolean | null }[];
    }[];
  };
  const recorded = report.rows.find((row) => row.summary.mode.startsWith("model"))!.scores;
  const scenarios = readdirSync(join(ROOT, "scenarios", set))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => scenarioSchema.parse(read(`scenarios/${set}/${name}`)));

  it("covers every scenario in its set", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(minimum);
    expect(recorded.map((score) => score.id)).toEqual(scenarios.map((scenario) => scenario.id));
  });

  it.each(scenarios.map((scenario) => [scenario.id, scenario] as const))(
    "%s replays to its recorded outcome",
    async (id, scenario) => {
      const replay = read(`replays/${label}/${id}.json`) as {
        exchanges: ConstructorParameters<typeof ReplayProvider>[0];
      };
      const provider = new ReplayProvider(replay.exchanges);
      const text = evidenceText(scenario.email);
      const result = await runExtraction({
        provider,
        host: worldHost(scenario.email.sender),
        evidence: { text, sha256: sha256Hex(text) },
        threadId: `${label}-${id}`,
        costCapMicroUsd: 50_000,
      });
      const score = scoreScenario(scenario, result.outcome, result);
      const expected = recorded.find((each) => each.id === id)!;
      expect({
        outcome: score.outcome,
        reason: score.reason,
        exactMatch: score.exactMatch,
      }).toEqual({
        outcome: expected.outcome,
        reason: expected.reason,
        exactMatch: expected.exactMatch,
      });
      expect(score.criticalViolations).toEqual([]);
      expect(provider.digestMismatches).toBe(0);
    },
  );
});

// The demonstration mode serves the recorded C-01 run by request digest
// (ADR 0012): the recorded email reaches its proposal, any other text pauses.
describe("recorded run provider", () => {
  const replay = read("replays/smoke-2/D01.json") as {
    exchanges: ConstructorParameters<typeof RecordedRunProvider>[0];
  };
  const scenario = scenarioSchema.parse(read("scenarios/dev/D01.json"));
  const provider = new RecordedRunProvider(replay.exchanges);
  const run = (text: string) =>
    runExtraction({
      provider,
      host: worldHost(scenario.email.sender),
      evidence: { text, sha256: sha256Hex(text) },
      threadId: `recorded-${sha256Hex(text).slice(0, 8)}`,
      costCapMicroUsd: 50_000,
    });

  it("replays the recorded email to its proposal, twice from one provider", async () => {
    const text = evidenceText(scenario.email);
    const [first, second] = [await run(text), await run(text)];
    expect([first.outcome.kind, second.outcome.kind]).toEqual(["proposed", "proposed"]);
  });

  it("pauses as a provider failure for any other email", async () => {
    const text = evidenceText({ ...scenario.email, text: scenario.email.text.replace("80", "90") });
    const result = await run(text);
    expect(result.outcome).toMatchObject({ kind: "paused", reason: "agent_provider_failure" });
  });
});
