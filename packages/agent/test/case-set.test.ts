// The external case-set loader (ADR 0011) against a synthetic directory in the
// frozen-set layout, built from development scenarios: cases/<ID>.json,
// evaluator-only cases/oracles/<ID>.json, cases/evidence/<ID>.txt and .json,
// case-index.json and MANIFEST.sha256. Every mismatch must throw.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CaseSetError,
  emailBytes,
  evidenceText,
  loadExternalSet,
  loadRepositorySet,
} from "../src/index.js";

const DEV = fileURLToPath(new URL("../../../evaluation/scenarios/dev/", import.meta.url));
const IDS = ["D01", "D10", "D11", "D18"];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Writes a valid synthetic set and returns its root. */
function buildSet(): string {
  const root = mkdtempSync(join(tmpdir(), "sd-case-set-"));
  roots.push(root);
  for (const dir of ["cases/oracles", "cases/evidence"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const entries = IDS.map((id) => {
    const bytes = readFileSync(join(DEV, `${id}.json`));
    const scenario = JSON.parse(bytes.toString("utf8")) as {
      email: Parameters<typeof evidenceText>[0];
    };
    const text = evidenceText(scenario.email);
    writeFileSync(join(root, "cases", `${id}.json`), bytes);
    writeFileSync(join(root, "cases/evidence", `${id}.txt`), text);
    writeFileSync(join(root, "cases/evidence", `${id}.json`), JSON.stringify(scenario.email));
    writeFileSync(
      join(root, "cases/oracles", `${id}.json`),
      JSON.stringify({
        id,
        scenarioSha256: sha(bytes),
        evidenceFile: `cases/evidence/${id}.txt`,
        evidenceSha256: sha(text),
        emailCanonicalBytesSha256: sha(emailBytes(scenario.email)),
        requiredFieldExpectations: { poNumber: "PO-120" },
        structuralExpectations: { segments: 2 },
        authorNote: "unknown fields are tolerated",
      }),
    );
    return {
      id,
      category: "synthetic",
      scenario: `cases/${id}.json`,
      oracle: `cases/oracles/${id}.json`,
      evidence: [`cases/evidence/${id}.txt`, `cases/evidence/${id}.json`],
      expected: "see case",
      requiredFieldUnits: 9,
    };
  });
  writeFileSync(
    join(root, "case-index.json"),
    JSON.stringify({
      set: "synthetic-dev",
      entries,
      requiredFieldDenominator: 36,
      expectedSegments: 8,
      proposed: 3,
      paused: 1,
    }),
  );
  writeManifest(root);
  return root;
}

/** sha256sum-style manifest of every file except itself. */
function writeManifest(root: string) {
  const files = ["case-index.json"];
  for (const dir of ["cases", "cases/oracles", "cases/evidence"]) {
    for (const name of readdirSync(join(root, dir))) {
      if (name.includes(".")) files.push(`${dir}/${name}`);
    }
  }
  const lines = files.sort().map((file) => `${sha(readFileSync(join(root, file)))}  ${file}`);
  writeFileSync(join(root, "MANIFEST.sha256"), `${lines.join("\n")}\n`);
}

describe("external case set", () => {
  it("loads a frozen set in place and verifies every declared digest", () => {
    const root = buildSet();
    const set = loadExternalSet(root);
    expect(set.kind).toBe("external");
    expect(set.scenarios.map((scenario) => scenario.id)).toEqual(IDS);
    expect(set.setHashSource).toBe("MANIFEST.sha256");
    expect(set.setSha256).toBe(sha(readFileSync(join(root, "MANIFEST.sha256"))));
    expect(set.manifestEntriesVerified).toBe(1 + IDS.length * 4);
    expect(set.oracles.size).toBe(IDS.length);
    expect(set.oracles.get("D01")).toMatchObject({ authorNote: "unknown fields are tolerated" });
    expect(set.index).toMatchObject({ set: "synthetic-dev", requiredFieldDenominator: 36 });
    expect(set.checks.notes).toEqual([]);
    // The manifests digest is computed as for the repository set.
    const repository = loadRepositorySet(DEV);
    expect(repository.scenarios.length).toBeGreaterThan(IDS.length);
  });

  it("refuses a file that no longer matches MANIFEST.sha256", () => {
    const root = buildSet();
    writeFileSync(join(root, "cases/evidence/D01.txt"), "changed");
    expect(() => loadExternalSet(root)).toThrow(/D01\.txt does not match its digest/);
  });

  it("refuses a case outside the strict scenario format", () => {
    const root = buildSet();
    const path = join(root, "cases/D10.json");
    const scenario = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...scenario, extra: true }));
    writeManifest(root);
    expect(() => loadExternalSet(root)).toThrow(CaseSetError);
    expect(() => loadExternalSet(root)).toThrow(/strict scenario format/);
  });

  it("refuses an oracle whose scenario digest differs", () => {
    const root = buildSet();
    const path = join(root, "cases/oracles/D11.json");
    const oracle = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...oracle, scenarioSha256: "0".repeat(64) }));
    writeManifest(root);
    expect(() => loadExternalSet(root)).toThrow(/scenarioSha256 does not match/);
  });

  it("refuses a case without an oracle once oracles are declared", () => {
    const root = buildSet();
    rmSync(join(root, "cases/oracles/D18.json"));
    writeManifest(root);
    expect(() => loadExternalSet(root)).toThrow(/no oracle for D18/);
  });

  it("refuses an index whose entries differ from the cases or name missing files", () => {
    const root = buildSet();
    const path = join(root, "case-index.json");
    const index = JSON.parse(readFileSync(path, "utf8")) as {
      entries: { id: string; evidence: string[] }[];
    };
    writeFileSync(path, JSON.stringify({ ...index, entries: index.entries.slice(1) }));
    writeManifest(root);
    expect(() => loadExternalSet(root)).toThrow(/do not match cases/);

    index.entries[0]!.evidence = ["cases/evidence/missing.txt"];
    writeFileSync(path, JSON.stringify(index));
    writeManifest(root);
    expect(() => loadExternalSet(root)).toThrow(/names cases\/evidence\/missing\.txt/);
  });

  it("refuses a set without MANIFEST.sha256", () => {
    const root = buildSet();
    rmSync(join(root, "MANIFEST.sha256"));
    expect(() => loadExternalSet(root)).toThrow(/MANIFEST\.sha256: missing/);
  });

  it("refuses a file under cases/ that MANIFEST.sha256 does not list", () => {
    const root = buildSet();
    writeFileSync(join(root, "cases/D99.json"), readFileSync(join(root, "cases/D01.json")));
    expect(() => loadExternalSet(root)).toThrow(/does not list cases\/D99\.json/);
  });

  it("refuses an unlisted file in a nested directory of cases/", () => {
    const root = buildSet();
    mkdirSync(join(root, "cases/evidence/extra"));
    writeFileSync(join(root, "cases/evidence/extra/note"), "unlisted");
    expect(() => loadExternalSet(root)).toThrow(/does not list cases\/evidence\/extra\/note/);
  });

  it("refuses an oracle whose canonical email digest differs", () => {
    const root = buildSet();
    const path = join(root, "cases/oracles/D01.json");
    const oracle = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...oracle, emailCanonicalBytesSha256: "1".repeat(64) }));
    writeManifest(root);
    expect(() => loadExternalSet(root)).toThrow(/emailCanonicalBytesSha256 does not match/);
  });

  it("refuses an oracle without scenarioSha256", () => {
    const root = buildSet();
    const path = join(root, "cases/oracles/D10.json");
    const oracle = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete oracle.scenarioSha256;
    writeFileSync(path, JSON.stringify(oracle));
    writeManifest(root);
    expect(() => loadExternalSet(root)).toThrow(/scenarioSha256 is required/);
  });

  it("refuses a manifest entry that points outside the set", () => {
    const root = buildSet();
    const manifest = readFileSync(join(root, "MANIFEST.sha256"), "utf8");
    writeFileSync(join(root, "MANIFEST.sha256"), `${manifest}${"0".repeat(64)}  ../outside\n`);
    expect(() => loadExternalSet(root)).toThrow(/\.\.\/outside is missing/);
  });
});
