// Maps the independently written held-out cases into scenario manifests,
// mechanically and without judgment, and records what could not be mapped.
//   node evaluation/adapt-holdout.mjs <holdout-dir>
// Reads <holdout-dir>/cases/H*.json (never edits them) and writes
// evaluation/scenarios/holdout/H*.json plus evaluation/holdout-mapping.json.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
if (source === undefined) throw new Error("usage: node evaluation/adapt-holdout.mjs <holdout-dir>");
const out = join(ROOT, "scenarios", "holdout");
mkdirSync(out, { recursive: true });

/** Source fields the scenario format has no place for; the extractor is scored without them. */
const UNMAPPED_FIELDS = [
  "raw_email.to",
  "raw_email.sent_time",
  "setup",
  "expected_evidence",
  "expected_sender",
  "expected_authored_at",
  "expected_case",
  "expected_assessment",
  "rule_basis",
];

/** Source fields the manifest carries (terms, outcome rule and the downstream note). */
const MAPPED = new Set([
  "expected_structured_proposal",
  "expected_intake_decision",
  "expected_case_state",
]);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const files = readdirSync(join(source, "cases"))
  .filter((name) => /^H\d{2}\.json$/.test(name))
  .sort();
const mapping = { readmeSha256: sha256(readFileSync(join(source, "README.md"))), cases: [] };

for (const name of files) {
  const raw = readFileSync(join(source, "cases", name));
  const c = JSON.parse(raw.toString("utf8"));
  const proposal = c.expected_structured_proposal;
  const intake = c.expected_intake_decision;
  // Rule 1: a proposal is expected unless the source says intake is not invoked.
  const paused = intake.invoke_intake === false;
  // Rule 2: terms are expected only when they are valid terms (no null quantity).
  const valid = proposal.segments.every((segment) => segment.quantity !== null);
  const { unresolvedFields, ...terms } = proposal;
  const forbidden = ["unregistered_tool_executed"];
  // Rule 3: an expected pause forbids any proposal.
  if (paused) forbidden.unshift("proposal");
  // Rule 4: `dated_arrival` means "any dated arrival", so it applies only when every segment is undated.
  if (valid && terms.segments.every((segment) => segment.arrival.state === "undated")) {
    forbidden.push("dated_arrival");
  }
  const caseReason = c.expected_case?.reason ?? null;
  const scenario = {
    id: c.id,
    family: c.family,
    note: `Held-out ${c.id} (${c.language}): ${c.description}`,
    email: {
      sender: c.raw_email.from,
      subject: c.raw_email.subject,
      text: c.raw_email.body_text,
      ...(c.raw_email.attachment_text === undefined
        ? {}
        : { attachmentText: c.raw_email.attachment_text }),
    },
    expected: {
      outcomes: [paused ? "paused" : "proposed"],
      ...(paused || !valid ? {} : { terms }),
      downstream: `intake ${intake.disposition}${intake.reason ? ` ${intake.reason}` : ""}; case ${c.expected_case_state}${caseReason ? ` (${caseReason})` : ""}`,
    },
    forbidden,
  };
  writeFileSync(join(out, name), `${JSON.stringify(scenario, null, 2)}\n`);

  const unmapped = UNMAPPED_FIELDS.filter((path) => {
    const [head, tail] = path.split(".");
    return tail === undefined ? c[head] !== undefined : c[head]?.[tail] !== undefined;
  });
  for (const key of Object.keys(c)) {
    if (key.startsWith("expected_") && !unmapped.includes(key) && !MAPPED.has(key)) {
      unmapped.push(key);
    }
  }
  const notes = [];
  if (unresolvedFields.length > 0) {
    notes.push(
      `unresolvedFields ${JSON.stringify(unresolvedFields)} not compared (scorer derives them)`,
    );
  }
  if (!valid) notes.push("nullable candidate terms not representable; mapped to an expected pause");
  if (paused)
    notes.push(`intake reason ${intake.reason} applies only to a forced submission; not scored`);
  const undatedSome =
    valid && terms.segments.some((segment) => segment.arrival.state === "undated");
  if (undatedSome && !forbidden.includes("dated_arrival")) {
    notes.push(
      "forbidden date invention for the undated segment is caught by exact match, not as a critical violation",
    );
  }
  notes.push(
    `${c.forbidden_effects.length} forbidden_effects texts; only those listed in forbidden are scored`,
  );
  mapping.cases.push({ id: c.id, sourceSha256: sha256(raw), forbidden, unmapped, notes });
}

writeFileSync(join(ROOT, "holdout-mapping.json"), `${JSON.stringify(mapping, null, 2)}\n`);
console.log(`mapped ${String(files.length)} cases into ${out}`);
