import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { emailBytes, evidenceText, sha256Hex } from "./evidence.js";
import { scenarioSchema, type Scenario } from "./evaluation.js";

/**
 * A scenario set read in place (ADR 0011): either the repository's
 * `evaluation/scenarios/<set>/*.json`, or an external directory frozen
 * outside the repository with `cases/<ID>.json` in the same strict scenario
 * format, optional evaluator-only `cases/oracles/<ID>.json`, evidence files
 * under `cases/evidence/`, and a required `case-index.json` and
 * `MANIFEST.sha256` that lists every file under `cases/` and the index.
 * Nothing is copied. Any schema or integrity mismatch throws, naming the
 * file, so no case is ever skipped silently.
 */
export interface CaseSet {
  kind: "repository" | "external";
  root: string;
  scenarios: Scenario[];
  /** SHA-256 of the case manifests joined by newlines, as every earlier report computed it. */
  manifestsSha256: string;
  /** SHA-256 of MANIFEST.sha256 when present; otherwise the manifests digest. */
  setSha256: string;
  setHashSource: "MANIFEST.sha256" | "manifests";
  /** Files checked against MANIFEST.sha256. */
  manifestEntriesVerified: number;
  /** From case-index.json when present. */
  index: CaseIndexSummary | null;
  oracles: Map<string, Oracle>;
  /** Integrity checks run, and informational comparisons that are reported but never fail. */
  checks: { verified: string[]; notes: string[] };
}

export interface CaseIndexSummary {
  set: string | null;
  requiredFieldDenominator: number | null;
  expectedSegments: number | null;
  proposed: number | null;
  paused: number | null;
  categoryCounts: Record<string, number> | null;
  categories: Record<string, string>;
  requiredFieldUnits: Record<string, number>;
}

/**
 * The oracle fields the runner reads. Every other field is tolerated and
 * kept for the report only; scoring uses the case's own expectations.
 */
const oracleSchema = z.looseObject({
  id: z.string().optional(),
  scenarioFile: z.string().optional(),
  scenarioSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  evidenceFile: z.string().optional(),
  evidenceSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  emailCanonicalBytesSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  primaryCategory: z.string().optional(),
  requiredFieldExpectations: z.unknown().optional(),
});
export type Oracle = z.infer<typeof oracleSchema>;

const indexSchema = z.looseObject({
  set: z.string().optional(),
  entries: z.array(
    z.looseObject({
      id: z.string(),
      category: z.string().optional(),
      scenario: z.string().optional(),
      oracle: z.string().optional(),
      evidence: z.union([z.string(), z.array(z.string())]).optional(),
      requiredFieldUnits: z.number().int().nonnegative().optional(),
    }),
  ),
  categoryCounts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  requiredFieldDenominator: z.number().int().nonnegative().optional(),
  expectedSegments: z.number().int().nonnegative().optional(),
  proposed: z.number().int().nonnegative().optional(),
  paused: z.number().int().nonnegative().optional(),
});

export class CaseSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseSetError";
  }
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

function parseJson(path: string, bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new CaseSetError(`${path}: not valid JSON (${(error as Error).message})`);
  }
}

function strictScenario(path: string, bytes: Buffer, id: string): Scenario {
  const parsed = scenarioSchema.safeParse(parseJson(path, bytes));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new CaseSetError(
      `${path}: does not match the strict scenario format: ${issues.join("; ")}`,
    );
  }
  if (parsed.data.id !== id) {
    throw new CaseSetError(`${path}: id ${parsed.data.id} does not match its file name`);
  }
  return parsed.data;
}

/** Reads `<dir>/*.json` in the repository's scenario format. */
export function loadRepositorySet(dir: string): CaseSet {
  const root = resolve(dir);
  const names = readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (names.length === 0) throw new CaseSetError(`${root}: no scenario manifests`);
  const texts = names.map((name) => readFileSync(join(root, name)));
  const scenarios = names.map((name, index) =>
    strictScenario(join(root, name), texts[index]!, name.slice(0, -".json".length)),
  );
  const manifestsSha256 = sha256Hex(texts.map((bytes) => bytes.toString("utf8")).join("\n"));
  return {
    kind: "repository",
    root,
    scenarios,
    manifestsSha256,
    setSha256: manifestsSha256,
    setHashSource: "manifests",
    manifestEntriesVerified: 0,
    index: null,
    oracles: new Map(),
    checks: { verified: [], notes: [] },
  };
}

/** Every regular file under a directory, recursively, as absolute paths. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return [path];
  });
}

/** Resolves a path an oracle names, inside the set only. */
function inside(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const path = resolve(candidate);
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (isFile(path)) return path;
  }
  return null;
}

/** Reads an external set in place and verifies every declared digest. */
export function loadExternalSet(dir: string): CaseSet {
  const root = resolve(dir);
  const casesDir = join(root, "cases");
  if (!existsSync(casesDir)) throw new CaseSetError(`${root}: no cases/ directory`);
  const names = readdirSync(casesDir)
    .filter((name) => name.endsWith(".json") && isFile(join(casesDir, name)))
    .sort();
  if (names.length === 0) throw new CaseSetError(`${casesDir}: no case files`);
  const verified: string[] = [];
  const notes: string[] = [];

  // MANIFEST.sha256 (sha256sum format) is required and is the set hash. Every
  // listed file must exist inside the set and match, and every file under
  // cases/ and case-index.json must be listed: an unlisted file fails.
  const manifestPath = join(root, "MANIFEST.sha256");
  if (!isFile(manifestPath)) throw new CaseSetError(`${manifestPath}: missing; it is required`);
  const manifest = readFileSync(manifestPath);
  const setSha256 = sha256Hex(manifest);
  const listed = new Set<string>();
  for (const raw of manifest.toString("utf8").split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const entry = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (entry === null) throw new CaseSetError(`${manifestPath}: unreadable line "${line}"`);
    const path = inside(root, [join(root, entry[2]!)]);
    if (path === null) throw new CaseSetError(`${manifestPath}: ${entry[2]!} is missing`);
    if (listed.has(path)) throw new CaseSetError(`${manifestPath}: ${entry[2]!} is listed twice`);
    if (sha256Hex(readFileSync(path)) !== entry[1]) {
      throw new CaseSetError(`${manifestPath}: ${entry[2]!} does not match its digest`);
    }
    listed.add(path);
  }
  const indexFile = join(root, "case-index.json");
  if (!isFile(indexFile)) throw new CaseSetError(`${indexFile}: missing; it is required`);
  const unlisted = [indexFile, ...filesUnder(casesDir)].filter((path) => !listed.has(path));
  if (unlisted.length > 0) {
    throw new CaseSetError(
      `${manifestPath}: does not list ${unlisted.map((path) => relative(root, path)).join(", ")}`,
    );
  }
  const manifestEntriesVerified = listed.size;
  verified.push(
    `MANIFEST.sha256: ${String(manifestEntriesVerified)} files match; every file under cases/ and case-index.json is listed`,
  );

  const texts: Buffer[] = [];
  const scenarios: Scenario[] = [];
  const oracles = new Map<string, Oracle>();
  for (const name of names) {
    const path = join(casesDir, name);
    const bytes = readFileSync(path);
    const id = name.slice(0, -".json".length);
    const scenario = strictScenario(path, bytes, id);
    texts.push(bytes);
    scenarios.push(scenario);

    const oraclePath = join(casesDir, "oracles", name);
    if (!isFile(oraclePath)) {
      // Once a set declares oracles, every case must have one.
      if (existsSync(join(casesDir, "oracles"))) {
        throw new CaseSetError(`${oraclePath}: missing; cases/oracles/ has no oracle for ${id}`);
      }
      continue;
    }
    const parsed = oracleSchema.safeParse(parseJson(oraclePath, readFileSync(oraclePath)));
    if (!parsed.success) {
      throw new CaseSetError(
        `${oraclePath}: unreadable oracle: ${parsed.error.issues[0]?.message ?? ""}`,
      );
    }
    const oracle = parsed.data;
    if (oracle.id !== undefined && oracle.id !== id) {
      throw new CaseSetError(`${oraclePath}: id ${oracle.id} does not match ${id}`);
    }
    if (oracle.scenarioSha256 === undefined) {
      throw new CaseSetError(`${oraclePath}: scenarioSha256 is required`);
    }
    if (oracle.scenarioSha256 !== sha256Hex(bytes)) {
      throw new CaseSetError(`${oraclePath}: scenarioSha256 does not match ${path}`);
    }
    if (oracle.evidenceFile !== undefined) {
      const evidence = inside(root, [
        join(root, oracle.evidenceFile),
        join(casesDir, oracle.evidenceFile),
        join(casesDir, "oracles", oracle.evidenceFile),
      ]);
      if (evidence === null) {
        throw new CaseSetError(`${oraclePath}: evidence file ${oracle.evidenceFile} is missing`);
      }
      const evidenceBytes = readFileSync(evidence);
      if (
        oracle.evidenceSha256 !== undefined &&
        sha256Hex(evidenceBytes) !== oracle.evidenceSha256
      ) {
        throw new CaseSetError(`${oraclePath}: evidenceSha256 does not match ${evidence}`);
      }
      // Which form the evidence file takes is the author's choice; it is reported, not enforced.
      const asText = evidenceBytes.toString("utf8");
      const form =
        asText === evidenceText(scenario.email)
          ? "the agent's evidence text"
          : evidenceBytes.equals(emailBytes(scenario.email))
            ? "the canonical email bytes"
            : asText === scenario.email.text
              ? "the email body"
              : null;
      if (form === null)
        notes.push(`${id}: evidence file differs from the case email as the runner reads it`);
    }
    // The email the runner sends must be the email the author hashed.
    if (
      oracle.emailCanonicalBytesSha256 !== undefined &&
      oracle.emailCanonicalBytesSha256 !== sha256Hex(emailBytes(scenario.email))
    ) {
      throw new CaseSetError(
        `${oraclePath}: emailCanonicalBytesSha256 does not match the canonical bytes of ${path}`,
      );
    }
    oracles.set(id, oracle);
  }
  const oraclesDir = join(casesDir, "oracles");
  if (existsSync(oraclesDir)) {
    const orphans = readdirSync(oraclesDir).filter(
      (each) => each.endsWith(".json") && !names.includes(each),
    );
    if (orphans.length > 0) {
      throw new CaseSetError(`${oraclesDir}: oracles without a case: ${orphans.join(", ")}`);
    }
  }
  verified.push(`${String(scenarios.length)} cases match the strict scenario format`);
  if (oracles.size > 0)
    verified.push(`${String(oracles.size)} oracles: ids and declared digests match`);

  const indexPath = indexFile;
  const parsed = indexSchema.safeParse(parseJson(indexPath, readFileSync(indexPath)));
  if (!parsed.success) {
    throw new CaseSetError(
      `${indexPath}: unreadable index: ${parsed.error.issues[0]?.message ?? ""}`,
    );
  }
  const ids = parsed.data.entries.map((entry) => entry.id).sort();
  const caseIds = scenarios.map((scenario) => scenario.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(caseIds)) {
    throw new CaseSetError(
      `${indexPath}: entries ${ids.join(",")} do not match cases ${caseIds.join(",")}`,
    );
  }
  // Paths an entry names must exist inside the set; its scenario must be its case file.
  for (const entry of parsed.data.entries) {
    const named = [
      ...(entry.scenario === undefined ? [] : [entry.scenario]),
      ...(entry.oracle === undefined ? [] : [entry.oracle]),
      ...(entry.evidence === undefined ? [] : [entry.evidence].flat()),
    ];
    for (const each of named) {
      if (inside(root, [join(root, each)]) === null) {
        throw new CaseSetError(`${indexPath}: ${entry.id} names ${each}, which is missing`);
      }
    }
    if (
      entry.scenario !== undefined &&
      resolve(root, entry.scenario) !== join(casesDir, `${entry.id}.json`)
    ) {
      throw new CaseSetError(
        `${indexPath}: ${entry.id} names scenario ${entry.scenario}, not cases/${entry.id}.json`,
      );
    }
  }
  const index: CaseIndexSummary = {
    set: parsed.data.set ?? null,
    requiredFieldDenominator: parsed.data.requiredFieldDenominator ?? null,
    expectedSegments: parsed.data.expectedSegments ?? null,
    proposed: parsed.data.proposed ?? null,
    paused: parsed.data.paused ?? null,
    categoryCounts: parsed.data.categoryCounts ?? null,
    categories: Object.fromEntries(
      parsed.data.entries.flatMap((entry) =>
        entry.category === undefined ? [] : [[entry.id, entry.category]],
      ),
    ),
    requiredFieldUnits: Object.fromEntries(
      parsed.data.entries.flatMap((entry) =>
        entry.requiredFieldUnits === undefined ? [] : [[entry.id, entry.requiredFieldUnits]],
      ),
    ),
  };
  verified.push("case-index.json: entries match the cases");

  const manifestsSha256 = sha256Hex(texts.map((bytes) => bytes.toString("utf8")).join("\n"));
  return {
    kind: "external",
    root,
    scenarios,
    manifestsSha256,
    setSha256,
    setHashSource: "MANIFEST.sha256",
    manifestEntriesVerified,
    index,
    oracles,
    checks: { verified, notes },
  };
}
