// Extraction evaluation runner (ADR 0011, SD-18). Build first: corepack pnpm build.
//
//   node --env-file-if-exists=.env evaluation/run.mjs --label dev-1
//        (--set dev | --cases <external set dir>) [--mode baseline|replay|live]
//        [--downstream none|postgres] [--model claude-haiku-5-5] [--only D01,D02]
//        [--run-cap-usd 1] [--case-cap-usd 0.05] [--replay-label <label>]
//        [--output-dir <dir>] [--spend-record <file>]
//
// Three arms read the same declared evidence, each case's email: the
// deterministic regex baseline, the oracle-normalized arm (the manifest's
// expected terms) and the model (`--mode replay` from recordings, offline;
// `--mode live` calls the model and records replays). `--set` reads
// evaluation/scenarios/<set>; `--cases` reads an external frozen set in place
// (cases/<ID>.json in the same strict format, optional cases/oracles,
// cases/evidence, case-index.json and MANIFEST.sha256) and copies nothing.
//
// `--downstream postgres` then sends every proposal of every arm through the
// real API workflow (intake and assessment) on a disposable, seeded database
// (evaluation/downstream.mjs); a paused arm never reaches intake. Rows whose
// order or sender is not in the seeded world are reported in-memory only.
//
// Each live case is first admitted through the project spend ledger the API
// also uses (ADR 0017), reached with the API role from DATABASE_URL_API(_FILE),
// and the ignored evaluation/.spend-ledger.json keeps a host-side lower bound
// of reported spend. The key is read from ANTHROPIC_API_KEY_FILE and never
// printed. `--output-dir` moves only reports and replays out of evaluation/;
// the host record moves only with an explicit `--spend-record`, for tests.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AnthropicProvider,
  baselineExtract,
  downstreamVerdict,
  EVALUATION_WORLD,
  evidenceText,
  loadExternalSet,
  loadRepositorySet,
  oracleOutcome,
  parseDownstream,
  RecordingProvider,
  ReplayProvider,
  runExtraction,
  scoreScenario,
  sha256Hex,
  summarize,
  SYSTEM_PROMPT,
  TOOLS,
  worldGapMisses,
  worldHost,
} from "../packages/agent/dist/index.js";
import { AGENT_DEFAULT_TOOL_BUDGET, AGENT_TOOL_CEILING } from "../packages/contracts/dist/index.js";
import { connectSpendLedger, OWNER_PAUSE_MICRO_USD } from "../packages/db/dist/spend.js";
import { classify, PostgresDownstream } from "./downstream.mjs";
import { renderMarkdown } from "./report.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    set: { type: "string" },
    cases: { type: "string" },
    label: { type: "string" },
    mode: { type: "string", default: "baseline" },
    downstream: { type: "string", default: "none" },
    model: { type: "string", default: "claude-haiku-5-5" },
    only: { type: "string" },
    "run-cap-usd": { type: "string", default: "1" },
    "case-cap-usd": { type: "string", default: "0.05" },
    "replay-label": { type: "string" },
    "output-dir": { type: "string" },
    "spend-record": { type: "string" },
  },
});
const OUT = values["output-dir"] === undefined ? ROOT : resolve(values["output-dir"]);
/** Host-side record of reported live spend; a floor the project ledger must not be below. */
const LEDGER =
  values["spend-record"] === undefined
    ? join(ROOT, ".spend-ledger.json")
    : resolve(values["spend-record"]);
if (values.label === undefined) throw new Error("--label is required");
const mode = values.mode;
if (!["baseline", "replay", "live"].includes(mode)) throw new Error(`unknown mode ${mode}`);
if (!["none", "postgres"].includes(values.downstream)) {
  throw new Error(`unknown downstream ${values.downstream}`);
}
if ((values.set === undefined) === (values.cases === undefined)) {
  throw new Error("give exactly one of --set and --cases");
}

const caseSet =
  values.cases !== undefined
    ? loadExternalSet(values.cases)
    : loadRepositorySet(
        existsSync(values.set) ? resolve(values.set) : join(ROOT, "scenarios", values.set),
      );
const only = values.only?.split(",");
if (only !== undefined) {
  const unknown = only.filter((id) => !caseSet.scenarios.some((scenario) => scenario.id === id));
  if (unknown.length > 0) throw new Error(`--only names unknown cases: ${unknown.join(", ")}`);
}
const scenarios = caseSet.scenarios.filter(
  (scenario) => only === undefined || only.includes(scenario.id),
);

// Pathspecs are relative to the repository root, not to evaluation/.
const git = (...args) =>
  execFileSync("git", args, { cwd: join(ROOT, ".."), encoding: "utf8" }).trim();
const revision = git("rev-parse", "HEAD");
// Everything a report's numbers come from: the agent and its contracts, and the
// API workflow, database adapters and domain rules the downstream stage runs.
const EVIDENCE_PATHS = [
  "packages/agent",
  "packages/contracts",
  "packages/domain",
  "packages/db",
  "apps/api",
  "evaluation/scenarios",
  "evaluation/*.mjs",
];
const dirty = git("status", "--porcelain", "--", ...EVIDENCE_PATHS) !== "";
// A live run is evidence for its revision, so it must be that revision exactly.
if (mode === "live" && dirty) {
  throw new Error(`live mode needs a clean ${EVIDENCE_PATHS.join(", ")}; commit first`);
}

/** The newest modification time of any file under a directory, or 0. */
function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .reduce(
      (newest, entry) => Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs),
      0,
    );
}

// Nothing proves a dist was compiled from HEAD; this cheap check refuses the
// obvious case, a source file changed after its package's newest build output.
if (mode === "live" && values.downstream === "postgres") {
  const stale = [
    "packages/agent",
    "packages/contracts",
    "packages/domain",
    "packages/db",
    "apps/api",
  ]
    .map((pkg) => join(ROOT, "..", pkg))
    .filter((pkg) => newestMtime(join(pkg, "src")) > newestMtime(join(pkg, "dist")));
  if (stale.length > 0) {
    throw new Error(
      `build output is older than its sources in ${stale.map((pkg) => basename(pkg)).join(", ")}; run corepack pnpm build:packages (add tsc -b --force if the sources did not change)`,
    );
  }
}

const runCap = Math.round(Number(values["run-cap-usd"]) * 1_000_000);
const caseCap = Math.round(Number(values["case-cap-usd"]) * 1_000_000);
const config = {
  model: values.model,
  systemPromptSha256: sha256Hex(SYSTEM_PROMPT),
  toolsSha256: sha256Hex(JSON.stringify(TOOLS)),
  toolBudget: AGENT_DEFAULT_TOOL_BUDGET,
  toolCeiling: AGENT_TOOL_CEILING,
  caseCapMicroUsd: caseCap,
  runCapMicroUsd: runCap,
  downstream: values.downstream,
};

function readLedger() {
  return existsSync(LEDGER)
    ? JSON.parse(readFileSync(LEDGER, "utf8"))
    : { cumulativeMicroUsd: 0, entries: [] };
}

/** The API role's connection string, from DATABASE_URL_API or the file DATABASE_URL_API_FILE names. */
function apiDatabaseUrl() {
  const inline = process.env.DATABASE_URL_API;
  const file = process.env.DATABASE_URL_API_FILE;
  if (inline && file) throw new Error("set only one of DATABASE_URL_API and DATABASE_URL_API_FILE");
  if (inline) return inline;
  if (!file) throw new Error("live mode needs DATABASE_URL_API_FILE for the project spend ledger");
  return readFileSync(resolve(process.cwd(), file), "utf8").trim();
}

/** The project limit: AGENT_TOTAL_COST_CAP_USD when set, never above the owner pause. */
function projectLimitMicroUsd() {
  const raw = process.env.AGENT_TOTAL_COST_CAP_USD;
  if (raw === undefined || raw === "") return OWNER_PAUSE_MICRO_USD;
  const micro = Math.round(Number(raw) * 1_000_000);
  if (!(micro >= 0 && micro <= OWNER_PAUSE_MICRO_USD)) {
    throw new Error("AGENT_TOTAL_COST_CAP_USD must be from 0 to 15");
  }
  return micro;
}

/** Arms in report order, each with its outcome per case. */
const arms = [
  {
    label: "baseline",
    outcomes: new Map(scenarios.map((s) => [s.id, { outcome: baselineExtract(s), run: null }])),
  },
  {
    label: "oracle-normalized",
    outcomes: new Map(scenarios.map((s) => [s.id, { outcome: oracleOutcome(s), run: null }])),
  },
];

let spend = null;
let replayDigestMismatches = 0;
if (mode !== "baseline") {
  const replayDir = join(
    values["replay-label"] === undefined ? OUT : ROOT,
    "replays",
    values["replay-label"] ?? values.label,
  );
  let apiKey = null;
  let spendLedger = null;
  let projectLimit = OWNER_PAUSE_MICRO_USD;
  let committedBefore = 0;
  if (mode === "live") {
    const keyFile = process.env.ANTHROPIC_API_KEY_FILE;
    if (keyFile === undefined) throw new Error("ANTHROPIC_API_KEY_FILE is not set");
    projectLimit = projectLimitMicroUsd();
    console.log(`spend record: ${LEDGER}`);
    spendLedger = connectSpendLedger(apiDatabaseUrl(), "sd-evaluation");
    const status = await spendLedger.ledger.status();
    committedBefore = status.committedMicroUsd;
    console.log(`project ledger committed before: ${String(committedBefore)} micro-USD`);
    // A project ledger below the host record was recreated or opened short.
    const hostFloor = readLedger().cumulativeMicroUsd;
    if (status.opened && status.committedMicroUsd < hostFloor) {
      await spendLedger.close();
      throw new Error(
        `the project spend ledger (${String(status.committedMicroUsd)} micro-USD) is below the host record (${String(hostFloor)} micro-USD); reconcile it before a live run`,
      );
    }
    apiKey = readFileSync(resolve(process.cwd(), keyFile), "utf8").trim();
    mkdirSync(replayDir, { recursive: true });
  }
  const outcomes = new Map();
  let runSpent = 0;
  let uncertainCases = 0;
  for (const scenario of scenarios) {
    let provider;
    let reservation = null;
    if (mode === "live") {
      // The per-run cap is this runner's own limit, separate from the project total.
      if (runSpent + caseCap > runCap) {
        console.log(`stopping before ${scenario.id}: the run cap would be exceeded`);
        break;
      }
      const key = `evaluation:${values.label}:${scenario.id}:${randomUUID()}`;
      const admission = await spendLedger.ledger.admit({
        key,
        source: "evaluation",
        reference: `${values.label}/${scenario.id}`,
        model: values.model,
        amountMicroUsd: caseCap,
        limitMicroUsd: projectLimit,
      });
      if (!admission.admitted) {
        console.log(`stopping before ${scenario.id}: ${admission.detail}`);
        break;
      }
      reservation = key;
      provider = new RecordingProvider(new AnthropicProvider({ apiKey, model: values.model }));
    } else {
      const file = join(replayDir, `${scenario.id}.json`);
      if (!existsSync(file)) {
        console.log(`no replay for ${scenario.id}`);
        continue;
      }
      provider = new ReplayProvider(JSON.parse(readFileSync(file, "utf8")).exchanges);
    }
    const text = evidenceText(scenario.email);
    let result;
    try {
      result = await runExtraction({
        provider,
        host: worldHost(scenario.email.sender),
        evidence: { text, sha256: sha256Hex(text) },
        threadId: `${values.label}-${scenario.id}`,
        costCapMicroUsd: caseCap,
      });
    } catch (error) {
      // What the failed case spent is unknown; its reservation stays counted.
      if (reservation !== null) {
        await spendLedger.ledger.markUncertain(
          reservation,
          "the case failed before reporting usage",
        );
      }
      throw error;
    }
    outcomes.set(scenario.id, { outcome: result.outcome, run: result });
    const verdict =
      result.outcome.kind === "paused" ? `paused ${result.outcome.reason}` : "proposed";
    console.log(
      `${scenario.id} ${verdict} tools=${result.toolCalls} cost=${result.usage.costMicroUsd}µ$`,
    );
    if (mode === "live") {
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicroUsd } =
        result.usage;
      const usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicroUsd };
      if (result.usageUncertain) {
        // Unknown usage keeps the whole case cap, here and in the project ledger.
        uncertainCases += 1;
        runSpent += caseCap;
        await spendLedger.ledger.markUncertain(
          reservation,
          "a call may have been billed without reported usage",
          usage,
        );
        console.log(`${scenario.id} usage unknown: the case cap stays reserved until reconciled`);
      } else {
        runSpent += costMicroUsd;
        await spendLedger.ledger.settle(reservation, usage);
      }
      const ledger = readLedger();
      ledger.cumulativeMicroUsd += costMicroUsd;
      ledger.entries.push({
        label: values.label,
        scenario: scenario.id,
        model: values.model,
        at: new Date().toISOString(),
        costMicroUsd,
        key: reservation,
        ...(result.usageUncertain ? { usageUncertain: true } : {}),
      });
      writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
      writeFileSync(
        join(replayDir, `${scenario.id}.json`),
        `${JSON.stringify({ scenario: scenario.id, model: values.model, revision, systemPromptSha256: config.systemPromptSha256, exchanges: provider.exchanges }, null, 2)}\n`,
      );
    } else {
      replayDigestMismatches += provider.digestMismatches;
    }
  }
  arms.push({ label: `model (${mode}, ${values.model})`, outcomes });
  if (mode === "live") {
    const after = await spendLedger.ledger.status();
    await spendLedger.close();
    console.log(`project ledger committed after: ${String(after.committedMicroUsd)} micro-USD`);
    spend = {
      runMicroUsd: runSpent,
      uncertainCases,
      projectLimitMicroUsd: projectLimit,
      cumulativeBeforeMicroUsd: committedBefore,
      cumulativeAfterMicroUsd: after.committedMicroUsd,
    };
  }
}

/**
 * Downstream outcome of one arm for one case. A pause never reaches intake:
 * the API leaves an email case in needs_clarification with the pause reason
 * for the buyer. A proposal runs through the workflow on PostgreSQL when its
 * order and sender are in the seeded world; otherwise it is in-memory only.
 */
let postgres = null;
const downstreamCache = new Map();
async function downstreamOf(scenario, outcome) {
  if (outcome.kind === "paused") {
    return {
      where: "no-intake",
      observation: {
        intake: "not_invoked",
        intakeReason: null,
        caseState: "needs_clarification",
        caseReason: outcome.reason,
      },
    };
  }
  const place = classify(scenario, outcome.terms.poNumber, EVALUATION_WORLD.senders);
  if (place.world !== "postgres")
    return { where: "in-memory-only", why: place.why, observation: null };
  if (postgres === null)
    return { where: "postgres-not-run", why: "--downstream none", observation: null };
  const key = `${scenario.id}:${sha256Hex(JSON.stringify(outcome.terms))}`;
  if (!downstreamCache.has(key)) {
    downstreamCache.set(
      key,
      await postgres.ingest(scenario, outcome.terms, evidenceText(scenario.email)),
    );
  }
  return { where: "postgres", observation: downstreamCache.get(key) };
}

if (values.downstream === "postgres") {
  postgres = new PostgresDownstream();
  console.log(`downstream database: Compose project ${postgres.project}`);
  await postgres.start();
}

const rows = [];
try {
  for (const arm of arms) {
    const covered = scenarios.filter((scenario) => arm.outcomes.has(scenario.id));
    const scores = [];
    for (const scenario of covered) {
      const { outcome, run } = arm.outcomes.get(scenario.id);
      const score = scoreScenario(scenario, outcome, run);
      const downstream = await downstreamOf(scenario, outcome);
      const expected = parseDownstream(scenario.expected.downstream);
      score.downstream = {
        where: downstream.where,
        ...(downstream.why === undefined ? {} : { why: downstream.why }),
        observation: downstream.observation,
        ...(downstream.observation === null
          ? { verdict: "not_run", stateAgrees: null, misses: [] }
          : downstreamVerdict(expected, downstream.observation, {
              pauseAllowed: scenario.expected.outcomes.includes("paused"),
            })),
      };
      scores.push(score);
    }
    const summary = summarize(arm.label, covered, scores);
    const ran = scores.filter((score) => score.downstream.verdict !== "not_run");
    const accepted = scores.filter(
      (score) => score.downstream.observation?.intake === "accept" && score.provenance !== null,
    );
    summary.downstream = {
      postgres: scores.filter((score) => score.downstream.where === "postgres").length,
      noIntake: scores.filter((score) => score.downstream.where === "no-intake").length,
      inMemoryOnly: scores.filter((score) => score.downstream.where === "in-memory-only").length,
      notRun: scores.filter((score) => score.downstream.where === "postgres-not-run").length,
      agree: ran.filter((score) => score.downstream.verdict === "agree").length,
      disagree: ran.filter((score) => score.downstream.verdict === "disagree").length,
      unstated: ran.filter((score) => score.downstream.verdict === "unstated").length,
      stateChecked: ran.filter((score) => score.downstream.stateAgrees !== null).length,
      stateAgree: ran.filter((score) => score.downstream.stateAgrees === true).length,
      // Provenance of proposals intake accepted, the fields a plan is built on.
      acceptedFields: accepted.reduce((total, score) => total + score.provenance.fields, 0),
      acceptedFieldsCorrect: accepted.reduce((total, score) => total + score.provenance.correct, 0),
    };
    rows.push({ summary, scores });
  }
} finally {
  await postgres?.close();
}

// A downstream miss the oracle-normalized arm has word for word for the same
// case is not an extraction error: the declared terms themselves, through the
// real workflow, miss the note in the same way, so the seeded world or a
// setup the scenario format cannot carry (an earlier delivery, changed
// demand) differs. Such misses stay listed and counted, each flagged as a
// world or setup gap; an arm's other misses stay its own. A disagreement
// counts as a world or setup gap only when every one of its misses is shared.
const oracleRow = rows.find((row) => row.summary.mode === "oracle-normalized");
const oracleMisses = new Map(
  (oracleRow?.scores ?? []).map((score) => [score.id, score.downstream.misses]),
);
const worldGaps = new Set(
  (oracleRow?.scores ?? [])
    .filter((score) => score.downstream.verdict === "disagree")
    .map((score) => score.id),
);
for (const { summary, scores } of rows) {
  for (const score of scores) {
    score.downstream.worldGapMisses = worldGapMisses(
      score.downstream.misses,
      oracleMisses.get(score.id) ?? [],
    );
  }
  summary.downstream.disagreeWorldGap = scores.filter(
    (score) =>
      score.downstream.verdict === "disagree" &&
      score.downstream.worldGapMisses.length === score.downstream.misses.length,
  ).length;
  summary.downstream.pausedAsAllowed = scores.filter(
    (score) => score.downstream.pausedAsAllowed === true,
  ).length;
}

// The index's declared denominators against what this runner scores; a
// difference is reported loudly, never reconciled silently.
if (caseSet.index !== null) {
  const oracleScores = oracleRow?.scores ?? [];
  const counted = oracleRow?.summary.requiredFieldsExpected ?? 0;
  const declared = caseSet.index.requiredFieldDenominator;
  if (declared !== null && only === undefined && declared !== counted) {
    caseSet.checks.notes.push(
      `case-index.json declares a required-field denominator of ${String(declared)}; this runner counts ${String(counted)}`,
    );
  }
  for (const [id, units] of Object.entries(caseSet.index.requiredFieldUnits)) {
    const score = oracleScores.find((each) => each.id === id);
    const runnerUnits = score?.requiredFields?.expected ?? 0;
    if (score !== undefined && runnerUnits !== units) {
      caseSet.checks.notes.push(
        `${id}: case-index.json declares ${String(units)} required-field units; this runner counts ${String(runnerUnits)}`,
      );
    }
  }
  for (const note of caseSet.checks.notes) console.log(`set note: ${note}`);
}

/** One line per case: which world its downstream rows ran in. */
const world = scenarios.map((scenario) => {
  const places = rows
    .map((row) => row.scores.find((score) => score.id === scenario.id)?.downstream)
    .filter((each) => each !== undefined);
  const reasons = [...new Set(places.map((each) => each.why).filter(Boolean))];
  const kinds = new Set(places.map((each) => each.where));
  const classification = kinds.has("in-memory-only")
    ? "in-memory-only"
    : kinds.has("postgres-not-run")
      ? "postgres-not-run"
      : kinds.has("postgres")
        ? "postgres"
        : "no-intake";
  if (worldGaps.has(scenario.id)) {
    reasons.push("the oracle-normalized arm also misses the downstream note: world or setup gap");
  }
  return { id: scenario.id, classification, reasons };
});

const report = {
  label: values.label,
  mode,
  set: caseSet.kind === "external" ? basename(caseSet.root) : values.set,
  setKind: caseSet.kind,
  setSha256: caseSet.setSha256,
  setHashSource: caseSet.setHashSource,
  manifestsSha256: caseSet.manifestsSha256,
  setChecks: caseSet.checks,
  caseIndex: caseSet.index,
  scenarioCount: scenarios.length,
  revision,
  workingTreeChanged: dirty,
  generatedAt: new Date().toISOString(),
  config,
  replayDigestMismatches: mode === "replay" ? replayDigestMismatches : null,
  spend,
  world,
  rows,
};
const reportDir = join(OUT, "reports");
mkdirSync(reportDir, { recursive: true });
const base = join(reportDir, `${values.label}-${mode}`);
writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${base}.md`, renderMarkdown(report));
console.log(`report: ${base}.md`);
// The digest of the written report, for run records.
console.log(
  `report sha256: ${createHash("sha256")
    .update(readFileSync(`${base}.json`))
    .digest("hex")}`,
);
