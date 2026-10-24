import type { CaseActor, CaseDetail, VerificationEntry } from "@supplier-disruption/contracts";
import Link from "next/link";
import { Notice, Panel } from "../../../components/ui/panel";
import { Table, Td, Th } from "../../../components/ui/table";
import { codeLabel, instant, shortHash } from "../../../lib/format";
import { VerificationRecheck } from "./verification-recheck";

const VERIFIER_ROLES = ["buyer", "procurement_manager", "warehouse_planner"];

/** What the current status means for someone relying on the plan now. */
function currentText(detail: CaseDetail): {
  tone: "verified" | "warning" | "blocked" | "info";
  title: string;
} {
  const { status, currentUntil, lastVerified } = detail.verificationStatus;
  const last =
    lastVerified === null
      ? ""
      : ` The last matching read-back was at ${instant(lastVerified.bundleTime)}.`;
  switch (status) {
    case "current":
      return {
        tone: "verified",
        title: `Currently verified: the source records matched, valid until ${instant(currentUntil)}.`,
      };
    case "expired":
      return {
        tone: "warning",
        title: `Not currently verified: the read-back expired at ${instant(lastVerified?.validUntil)}.${last} Recheck before relying on it.`,
      };
    case "mismatch":
      return {
        tone: "blocked",
        title: `Not currently verified: the latest read-back no longer matches the source records.${last}`,
      };
    case "unavailable":
      return {
        tone: "warning",
        title: `Not currently verified: the latest recheck could not read the source records. This is unavailable evidence, not a mismatch.${last}`,
      };
    case "superseded":
      return {
        tone: "info",
        title: `Not current: a later supplier revision superseded this case.${last}`,
      };
    case "none":
      return { tone: "info", title: "Not verified: the plan has not been read back." };
  }
}

function outcomeText(entry: VerificationEntry): string {
  return entry.outcome === "verified" ? "Matched" : codeLabel(entry.outcome);
}

/**
 * Current verification versus every earlier read-back (ADR 0015). A
 * read-back supports the plan for four hours; past that, after a mismatch, or
 * once a later revision supersedes the case, the last matching evidence stays
 * listed but is no longer shown as current.
 */
export function VerificationPanel({
  detail,
  actors,
}: {
  detail: CaseDetail;
  actors: CaseActor[] | null;
}) {
  const verification = detail.verificationStatus;
  if (verification.history.length === 0) return null;
  const current = currentText(detail);
  return (
    <Panel
      id="verification"
      title="Verification"
      description="Whether the plan's source records match now, beside every earlier read-back. A verified plan is not evidence of physical delivery."
    >
      <Notice tone={current.tone} data-verification-current={verification.status}>
        <p className="font-semibold">{current.title}</p>
      </Notice>
      <div className="mt-4">
        <Table label="Verification history">
          <thead>
            <tr>
              <Th>Recorded</Th>
              <Th>Kind</Th>
              <Th>Outcome</Th>
              <Th>Read-back bundle</Th>
              <Th>Valid until</Th>
              <Th>Plan</Th>
            </tr>
          </thead>
          <tbody>
            {verification.history.map((entry) => (
              <tr
                key={entry.sequence}
                data-verification-entry={entry.outcome}
                data-verification-latest={
                  entry.sequence === verification.lastAttempt?.sequence ? "" : undefined
                }
              >
                <Td>{instant(entry.occurredAt)}</Td>
                <Td>
                  {entry.recheck ? "Recheck" : "After application"}
                  {entry.actorId !== null && (
                    <span className="block font-mono text-xs">{entry.actorId}</span>
                  )}
                </Td>
                <Td>
                  {outcomeText(entry)}
                  {entry.failedChecks.length + entry.missing.length > 0 && (
                    <span className="block font-mono text-xs">
                      {[...entry.missing.map((id) => `${id} missing`), ...entry.failedChecks].join(
                        ", ",
                      )}
                    </span>
                  )}
                </Td>
                <Td>{entry.bundleTime === null ? "none" : instant(entry.bundleTime)}</Td>
                <Td>{entry.validUntil === null ? "none" : instant(entry.validUntil)}</Td>
                <Td className="font-mono text-xs">{shortHash(entry.planSha256)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      {verification.recheckable && actors !== null && (
        <div className="mt-4">
          <VerificationRecheck
            caseId={detail.case.caseId}
            actors={actors.filter((actor) => VERIFIER_ROLES.includes(actor.role))}
          />
        </div>
      )}
    </Panel>
  );
}

/** The predecessor or successor of a later supplier revision, as links. */
export function LineageNotice({ detail }: { detail: CaseDetail }) {
  const { predecessor, successor } = detail.lineage;
  if (predecessor === null && successor === null) return null;
  return (
    <div className="mt-3 space-y-2" data-lineage>
      {successor !== null && (
        <Notice tone="info" data-lineage-successor={successor.caseRef}>
          Superseded by a later supplier revision:{" "}
          <Link href={`/cases/${successor.caseId}`} className="font-mono font-semibold underline">
            {successor.caseRef}
          </Link>{" "}
          ({successor.messageId}, {codeLabel(successor.state).toLowerCase()}). This case keeps its
          plan, decisions, actions and effects; none of its approvals apply to the successor.
        </Notice>
      )}
      {predecessor !== null && (
        <Notice tone="info" data-lineage-predecessor={predecessor.caseRef}>
          Later revision of{" "}
          <Link href={`/cases/${predecessor.caseId}`} className="font-mono font-semibold underline">
            {predecessor.caseRef}
          </Link>{" "}
          ({predecessor.messageId}, {predecessor.planId ?? "no plan"}). Its committed transfers are
          counted before any new allocation and never reserved again.
        </Notice>
      )}
    </div>
  );
}
