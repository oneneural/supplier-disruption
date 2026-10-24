// Markdown rendering of an evaluation report (evaluation/run.mjs).

function usd(micro) {
  return `USD ${(micro / 1_000_000).toFixed(4)}`;
}

const ratio = (part, whole) =>
  whole === 0
    ? `${String(part)} / 0`
    : `${String(part)} / ${String(whole)} (${((100 * part) / whole).toFixed(1)}%)`;

/** Every way a scored case fell short, in words; empty when it met every expectation. */
function missesOf(score) {
  const misses = [];
  if (!score.outcomeCorrect) {
    misses.push(
      `outcome ${score.outcome}${score.reason ? ` (${score.reason})` : ""}${score.exactMatch === false ? ", terms not exact" : ""}`,
    );
  }
  if (score.requiredFields !== null && score.requiredFields.exact < score.requiredFields.expected) {
    misses.push(
      `required fields ${String(score.requiredFields.exact)} / ${String(score.requiredFields.expected)}`,
    );
  }
  for (const miss of score.provenance?.misses ?? []) misses.push(`provenance ${miss}`);
  // Later reports flag each shared miss; earlier ones flagged every miss of a case (ADR 0011).
  const shared = score.downstream?.worldGapMisses;
  for (const miss of score.downstream?.misses ?? []) {
    const gap = shared === undefined ? score.downstream?.worldGap === true : shared.includes(miss);
    misses.push(`downstream ${miss}${gap ? " (world or setup gap)" : ""}`);
  }
  for (const violation of score.criticalViolations) misses.push(`CRITICAL ${violation}`);
  return misses;
}

/** Renders a report JSON as the committed Markdown summary. */
export function renderMarkdown(r) {
  const lines = [
    `# Extraction evaluation: ${r.label} (${r.mode})`,
    "",
    "Prototype evaluation on fictional fixtures. Targets are prototype acceptance targets, not observed production performance.",
    "",
    `- Revision: \`${r.revision}\`${r.workingTreeChanged ? " (agent, scenario or runner files changed in the working tree)" : ""}`,
    `- Scenario set: \`${r.set}\` (${r.setKind}), ${String(r.scenarioCount)} cases; set SHA-256 \`${r.setSha256}\` (${r.setHashSource}); manifests SHA-256 \`${r.manifestsSha256}\``,
    `- Model \`${r.config.model}\`; system prompt SHA-256 \`${r.config.systemPromptSha256}\`; tools SHA-256 \`${r.config.toolsSha256}\``,
    `- Tool budget ${String(r.config.toolBudget)} (ceiling ${String(r.config.toolCeiling)}); case cap ${usd(r.config.caseCapMicroUsd)}; run cap ${usd(r.config.runCapMicroUsd)}; downstream ${r.config.downstream}`,
    `- Generated: ${r.generatedAt}`,
  ];
  if (r.provenanceNote !== undefined) lines.push(`- Provenance: ${r.provenanceNote}`);
  for (const check of r.setChecks?.verified ?? []) lines.push(`- Set check: ${check}`);
  for (const note of r.setChecks?.notes ?? []) lines.push(`- Set note: ${note}`);
  if (r.caseIndex !== null && r.caseIndex !== undefined) {
    lines.push(
      `- Case index: required-field denominator ${String(r.caseIndex.requiredFieldDenominator)}, expected segments ${String(r.caseIndex.expectedSegments)}, proposed ${String(r.caseIndex.proposed)}, paused ${String(r.caseIndex.paused)}`,
    );
  }
  if (r.spend !== null) {
    lines.push(
      `- Metered spend this run: ${usd(r.spend.runMicroUsd)}; project ledger committed ${usd(r.spend.cumulativeBeforeMicroUsd)} before, ${usd(r.spend.cumulativeAfterMicroUsd)} after`,
      `- Project ledger limit ${usd(r.spend.projectLimitMicroUsd)}; cases with unknown usage, counted at their full case cap: ${String(r.spend.uncertainCases)}`,
    );
  }
  if (r.replayDigestMismatches !== null) {
    lines.push(
      `- Replay requests differing from the recording: ${String(r.replayDigestMismatches)}`,
      "- Cost in a replay report is the cost the recorded live run spent; replaying it makes no model call and spends nothing.",
    );
  }
  const cost = r.mode === "replay" ? "Recorded cost (no new spend)" : "Cost";
  lines.push(
    "",
    "## Summary",
    "",
    `| Arm | Cases | Outcome correct | Exact proposals | Required fields exact | Semantic provenance | Accepted-plan provenance | Completed / escalated | Unnecessary escalations | Critical violations | Unregistered tool attempts | Mean tool calls | Latency | ${cost} |`,
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const { summary: s } of r.rows) {
    const d = s.downstream;
    lines.push(
      `| ${s.mode} | ${String(s.cases)} | ${String(s.outcomeCorrect)} | ${String(s.extractionExact)} / ${String(s.extractionExpected)} | ${ratio(s.requiredFieldsExact, s.requiredFieldsExpected)} | ${s.provenanceFields === 0 ? "n/a" : ratio(s.provenanceCorrect, s.provenanceFields)} | ${d.acceptedFields === 0 ? "n/a" : ratio(d.acceptedFieldsCorrect, d.acceptedFields)} | ${String(s.completed)} / ${String(s.escalated)} | ${String(s.unnecessaryEscalations)} | ${String(s.criticalViolations)} | ${String(s.unregisteredToolAttempts)} | ${s.meanToolCalls.toFixed(1)} | ${(s.latencyMs / 1000).toFixed(1)} s | ${usd(s.costMicroUsd)} |`,
    );
  }
  lines.push(
    "",
    "Exact proposals and required fields count only cases whose manifest expects a proposal and allows no pause (supported, unambiguous inputs); a pause scores zero fields. Semantic provenance checks, for every proposed required field, that the locator reproduces the cited email span or record field and that the located value is the expected one. Accepted-plan provenance restricts that to proposals intake accepted on PostgreSQL. The oracle-normalized arm carries the manifest's expected terms and no locators; it is scored downstream, where the real workflow decides.",
    "",
    "## Downstream",
    "",
    "| Arm | PostgreSQL | Paused before intake | Pause allowed | In-memory only | Not run | Agree | Disagree | Of which world or setup gap | Unstated | Case state agrees |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const { summary: s } of r.rows) {
    const d = s.downstream;
    lines.push(
      `| ${s.mode} | ${String(d.postgres)} | ${String(d.noIntake)} | ${String(d.pausedAsAllowed ?? "")} | ${String(d.inMemoryOnly)} | ${String(d.notRun)} | ${String(d.agree)} | ${String(d.disagree)} | ${String(d.disagreeWorldGap ?? "")} | ${String(d.unstated)} | ${String(d.stateAgree)} / ${String(d.stateChecked)} |`,
    );
  }
  lines.push(
    "",
    "A proposal runs through the API workflow's intake and assessment on a fresh clone of the seeded PostgreSQL database; a paused arm leaves the case in needs_clarification with its pause reason and never reaches intake. Agreement compares only what the manifest's downstream note states in machine-checkable terms (an `intake <disposition>`, case state names and snake_case reason codes); prose is not scored. When the manifest allows a pause and the arm paused, only the case state is compared (pause allowed). A downstream miss the oracle-normalized arm has word for word for the same case is flagged as a world or setup gap, and a disagreement counts as one only when all its misses are: the declared terms through the real workflow miss the note too, because the seeded world or a setup the scenario format cannot carry (an earlier delivery, changed demand) differs. The seeded world holds PO-120 and its registered sender only, so other rows are in-memory only.",
    "",
    "| Case | World | Why |",
    "| --- | --- | --- |",
  );
  for (const row of r.world) {
    lines.push(`| ${row.id} | ${row.classification} | ${row.reasons.join("; ")} |`);
  }
  for (const { summary, scores } of r.rows) {
    lines.push("", `## ${summary.mode}: every miss`, "");
    const missed = scores
      .map((score) => ({ score, misses: missesOf(score) }))
      .filter((each) => each.misses.length > 0);
    if (missed.length === 0) {
      lines.push("None.");
      continue;
    }
    lines.push("| Case | Family | Downstream observed | Misses |", "| --- | --- | --- | --- |");
    for (const { score, misses } of missed) {
      const o = score.downstream?.observation;
      const observed =
        o === null || o === undefined
          ? (score.downstream?.where ?? "")
          : `intake ${o.intake}${o.intakeReason ? ` ${o.intakeReason}` : ""}; case ${o.caseState}${o.caseReason ? ` (${o.caseReason})` : ""}`;
      lines.push(`| ${score.id} | ${score.family} | ${observed} | ${misses.join("; ")} |`);
    }
  }
  const model = r.rows[2];
  if (model !== undefined) {
    lines.push(
      "",
      "## Model-backed cases",
      "",
      `| Case | Outcome | Reason | Tools | Model calls | Latency | ${cost} |`,
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const s of model.scores) {
      lines.push(
        `| ${s.id} | ${s.outcome} | ${s.reason ?? ""} | ${String(s.toolCalls)} | ${String(s.modelCalls)} | ${(s.latencyMs / 1000).toFixed(1)} s | ${usd(s.costMicroUsd)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
