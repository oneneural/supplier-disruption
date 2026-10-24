import type { CaseDetail, SupplierProposalTerms } from "@supplier-disruption/contracts";
import { Badge, type Tone } from "../../../components/ui/badge";
import { Notice, Panel } from "../../../components/ui/panel";
import { Table, Td, Th } from "../../../components/ui/table";
import { arrival, codeLabel, instant } from "../../../lib/format";
import { deliveryAnchor } from "./evidence";

const QUESTION_TONES: Record<string, Tone> = {
  awaiting_reply: "warning",
  answered: "verified",
  superseded: "neutral",
};
const CORRECTION_TONES: Record<string, Tone> = {
  accepted: "verified",
  blocked: "warning",
  rejected: "blocked",
};

function termsText(terms: SupplierProposalTerms | null): string {
  if (terms === null) return "none";
  const segments = terms.segments
    .map((segment) => `${segment.quantity} ${terms.uom} arriving ${arrival(segment.arrival)}`)
    .join("; ");
  return `${terms.poNumber} line ${terms.poLine} rev ${terms.baseRevision}, ${terms.vendorItem}: ${segments}`;
}

/**
 * Questions to the supplier and proposed field corrections (ADR 0014). A
 * question's draft is shown as stored and is never sent. A correction shows
 * the terms before and after and each quote it cites, linked to the stored
 * message the quote comes from.
 */
export function ClarificationPanel({ detail }: { detail: CaseDetail }) {
  const { clarifications, corrections } = detail;
  return (
    <Panel
      id="clarifications"
      title="Questions and corrections"
      description={`Case basis ${String(detail.basisAssessment)}. Questions are local drafts that are never sent; corrections cite the supplier's own stored words.`}
    >
      {clarifications.length === 0 && corrections.length === 0 ? (
        <p className="text-sm">No question or correction is recorded for this case.</p>
      ) : null}
      {clarifications.length > 0 && (
        <ol className="space-y-3" aria-label="Questions">
          {clarifications.map((question) => (
            <li
              key={question.questionRef}
              className="space-y-2 rounded-[var(--radius-control)] border border-border p-3 text-sm"
              data-question={question.questionRef}
              data-question-status={question.status}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold">{question.questionRef}</span>
                <Badge tone={QUESTION_TONES[question.status] ?? "neutral"}>
                  {codeLabel(question.status)}
                </Badge>
                <span className="text-muted">
                  asked by {question.requestedBy} at basis {question.basisAssessment},{" "}
                  {instant(question.requestedAt)}
                </span>
              </div>
              <p>
                Fields: <span className="font-mono text-xs">{question.fields.join(", ")}</span>
              </p>
              <Notice tone="info" data-draft-not-sent>
                Local draft, not sent. To {question.draft.to ?? "unknown sender"}, subject &quot;
                {question.draft.subject}&quot;.
                <pre className="mt-2 font-mono text-xs whitespace-pre-wrap">
                  {question.draft.body}
                </pre>
              </Notice>
              {question.closedReason !== null && (
                <p className="text-xs text-muted">
                  Closed: {codeLabel(question.closedReason)}
                  {question.replyDeliveryId !== null && (
                    <>
                      {" "}
                      by{" "}
                      <a
                        href={`#${deliveryAnchor(question.replyDeliveryId)}`}
                        className="text-accent underline underline-offset-4"
                      >
                        the recorded reply
                      </a>
                    </>
                  )}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {corrections.length > 0 && (
        <ol className="mt-4 space-y-3" aria-label="Corrections">
          {corrections.map((correction) => (
            <li
              key={correction.correctionRef}
              className="space-y-2 rounded-[var(--radius-control)] border border-border p-3 text-sm"
              data-correction={correction.correctionRef}
              data-correction-status={correction.status}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold">{correction.correctionRef}</span>
                <Badge tone={CORRECTION_TONES[correction.status] ?? "neutral"}>
                  {codeLabel(correction.status)}
                </Badge>
                {correction.reason !== null && <code className="text-xs">{correction.reason}</code>}
                <span className="text-muted">
                  by {correction.actorId} at basis {correction.basisAssessment}
                  {correction.planVersion !== null &&
                    `, plan version ${String(correction.planVersion)}`}
                </span>
              </div>
              <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                <dt className="text-muted">Before</dt>
                <dd data-correction-before>{termsText(correction.before)}</dd>
                <dt className="text-muted">After</dt>
                <dd data-correction-after>{termsText(correction.after)}</dd>
              </dl>
              {correction.diagnostics.length > 0 && (
                <ul className="list-disc pl-5 text-xs">
                  {correction.diagnostics.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {correction.locators.length > 0 && (
                <Table label={`Evidence cited by ${correction.correctionRef}`}>
                  <thead>
                    <tr>
                      <Th>Field</Th>
                      <Th>Value</Th>
                      <Th>Quote and location</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {correction.locators.map((locator) => (
                      <tr key={locator.field} data-locator-field={locator.field}>
                        <Td className="font-mono text-xs">{locator.field}</Td>
                        <Td>{locator.value}</Td>
                        <Td>
                          &quot;{locator.quote}&quot;{" "}
                          <a
                            href={`#${deliveryAnchor(locator.deliveryId)}`}
                            className="font-mono text-xs text-accent underline underline-offset-4"
                          >
                            {locator.messageId} [{locator.start}, {locator.end})
                          </a>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {correction.note !== null && <p className="text-xs">Note: {correction.note}</p>}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
