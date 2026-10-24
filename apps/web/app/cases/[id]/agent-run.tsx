import type { AgentRunRecord, EvidenceLocator } from "@supplier-disruption/contracts";
import type { ReactNode } from "react";
import { Badge } from "../../../components/ui/badge";
import { Notice, Panel } from "../../../components/ui/panel";
import { Table, Td, Th } from "../../../components/ui/table";
import { codeLabel, instant, locatorId, shortHash } from "../../../lib/format";

type EmailLocator = Extract<EvidenceLocator, { source: "email" }>;

const usd = (micro: number) => `USD ${(micro / 1_000_000).toFixed(4)}`;

/** The evidence text with each cited span marked and anchored by its field. */
function CitedText({ text, locators }: { text: string; locators: EmailLocator[] }) {
  const spans = [...locators].sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue; // An overlapping citation is listed in the table only.
    parts.push(text.slice(at, span.start));
    parts.push(
      <mark
        key={`${span.field}-${String(span.start)}`}
        id={locatorId(`agent-${span.field}`)}
        title={span.field}
        className="rounded-sm bg-suggested-bg px-0.5 text-suggested-fg"
      >
        {text.slice(span.start, span.end)}
      </mark>,
    );
    at = span.end;
  }
  parts.push(text.slice(at));
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-border bg-surface-muted p-3 text-xs whitespace-pre-wrap">
      {parts}
    </pre>
  );
}

/**
 * The extraction agent's run for an email case: status, budget, usage, the
 * pause reason and owner, every step, and each extracted field with the span
 * of the stored email (or the purchase order field) that supports it.
 */
export function AgentRunPanel({ run }: { run: AgentRunRecord }) {
  // A replayed run repeats the recorded responses and their recorded usage.
  const replay = run.provider === "replay";
  const emailLocators = run.locators.filter(
    (locator): locator is EmailLocator => locator.source === "email",
  );
  return (
    <Panel
      id="agent-run"
      title="Extraction agent run"
      description="A model proposal, validated by code against the stored email. It approves and changes nothing."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge
            tone={
              run.status === "proposed" ? "verified" : run.status === "paused" ? "warning" : "info"
            }
          >
            {codeLabel(run.status)}
          </Badge>
          <span>
            {run.provider}
            {run.model === null ? "" : ` / ${run.model}`}
          </span>
          {replay && (
            <Badge tone="suggested" data-agent-replay>
              Recorded replay, no model call
            </Badge>
          )}
          <span className="text-muted">
            {run.toolCalls} of {run.toolBudget} tool calls, {run.modelCalls} model calls
          </span>
        </div>
        {run.status === "paused" && (
          <Notice tone="warning">
            Paused: {codeLabel(run.pauseReason)}. Owner: buyer. {run.pauseDetail}
          </Notice>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted">
          <dt>Tokens</dt>
          <dd>
            {run.inputTokens} in, {run.outputTokens} out, {run.cacheReadTokens} cache read,{" "}
            {run.cacheWriteTokens} cache write
          </dd>
          <dt>{replay ? "Recorded cost (replay, no new spend)" : "Metered cost"}</dt>
          <dd>{usd(run.costMicroUsd)}</dd>
          <dt>Latency</dt>
          <dd>{run.latencyMs} ms</dd>
          <dt>Evidence SHA-256</dt>
          <dd className="font-mono break-all">{shortHash(run.evidenceSha256)}</dd>
          <dt>Started</dt>
          <dd>{instant(run.startedAt)}</dd>
          <dt>Finished</dt>
          <dd>{run.finishedAt === null ? "not yet" : instant(run.finishedAt)}</dd>
        </dl>

        <CitedText text={run.evidenceText} locators={emailLocators} />

        {run.locators.length > 0 && (
          <Table label="Each extracted field and its supporting evidence">
            <thead>
              <tr>
                <Th>Field</Th>
                <Th>Value</Th>
                <Th>Evidence</Th>
              </tr>
            </thead>
            <tbody>
              {run.locators.map((locator) => (
                <tr key={`${locator.field}-${locator.source}`}>
                  <Td className="font-mono text-xs">{locator.field}</Td>
                  <Td className="font-mono">{locator.value}</Td>
                  <Td>
                    {locator.source === "email" ? (
                      <a href={`#${locatorId(`agent-${locator.field}`)}`} className="underline">
                        &ldquo;{locator.quote}&rdquo; (characters {locator.start} to {locator.end})
                      </a>
                    ) : (
                      <span>
                        {locator.poNumber} revision {locator.revision}, {locator.recordField}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <Table label="Steps, in order">
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Step</Th>
              <Th>Outcome</Th>
              <Th>{replay ? "Recorded cost" : "Cost"}</Th>
            </tr>
          </thead>
          <tbody>
            {run.steps.map((step) => (
              <tr key={step.sequence}>
                <Td>{step.sequence}</Td>
                <Td className="font-mono text-xs">
                  {step.kind === "model" ? `model ${step.model ?? ""}` : step.tool}
                </Td>
                <Td>
                  <Badge tone={step.accepted ? "neutral" : "blocked"}>
                    {step.accepted ? "Accepted" : "Rejected"}
                  </Badge>{" "}
                  <span className="text-xs">{step.reason}</span>
                </Td>
                <Td className="text-xs">
                  {step.costMicroUsd === null ? "" : usd(step.costMicroUsd)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Panel>
  );
}
