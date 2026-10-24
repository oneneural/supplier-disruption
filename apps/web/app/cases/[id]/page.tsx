import type { CaseDetail, CaseState } from "@supplier-disruption/contracts";
import { cookies } from "next/headers";
import Link from "next/link";
import { CaseStateBadge } from "../../../components/state-badge";
import { Notice, Panel } from "../../../components/ui/panel";
import { fetchActors, fetchCase, fetchDemonstration, fetchSession } from "../../../lib/api";
import { age, codeLabel, instant, money, roleLabel, shortHash } from "../../../lib/format";
import { AgentRunPanel } from "./agent-run";
import { AutoRefresh } from "./auto-refresh";
import type { ClarificationContext } from "./clarification-forms";
import { ClarificationPanel } from "./clarifications";
import { DemonstrationControls } from "./demonstration-controls";
import { EvidencePanel, FieldsPanel } from "./evidence";
import { ImpactPanel } from "./impact";
import { OptionsPanel } from "./options";
import { ReviewControls, type ReviewPlan } from "./review-controls";
import { ActionTimelinePanel, HistoryPanel } from "./timeline";
import { LineageNotice, VerificationPanel } from "./verification";

export const dynamic = "force-dynamic";

const LIVE_STATES: readonly CaseState[] = ["received", "applying", "verifying"];

/** The exact facts the review controls submit, taken from the current plan. */
function reviewPlan(detail: CaseDetail): ReviewPlan | null {
  const plan = detail.plan;
  if (plan === null) return null;
  const { payload } = plan;
  const amend = payload.actions.find((action) => action.kind === "amend_schedule");
  const transfer = payload.actions.find((action) => action.kind === "create_transfer_request");
  const currency = payload.authorization.cost.currency;
  return {
    planId: payload.planId,
    planVersion: payload.planVersion,
    sha256: plan.sha256,
    cost: money(payload.authorization.cost),
    minimumApprover: roleLabel(payload.authorization.minimumApproverRole),
    limits: payload.authorization.limits.map((limit) => ({
      role: roleLabel(limit.role),
      limit: money({ minorUnits: limit.maxMinorUnits, currency }),
    })),
    supplier:
      amend?.kind === "amend_schedule"
        ? {
            proposalId: payload.proposal.proposalId,
            poNumber: amend.poNumber,
            poLine: amend.poLine,
            uom: amend.uom,
            segments: amend.segments,
          }
        : null,
    transfer:
      transfer?.kind === "create_transfer_request"
        ? {
            optionId: transfer.optionId,
            quantity: transfer.quantity,
            uom: transfer.uom,
            arrivalDate: transfer.arrivalDate,
          }
        : null,
  };
}

/** What the question, reply and correction forms submit against, from the case read. */
function clarificationContext(detail: CaseDetail): ClarificationContext {
  return {
    caseRef: detail.case.caseRef,
    basisAssessment: detail.basisAssessment,
    candidate: detail.candidate,
    openQuestions: detail.clarifications
      .filter((question) => question.status === "awaiting_reply")
      .map((question) => ({
        questionRef: question.questionRef,
        basisAssessment: question.basisAssessment,
        to: question.draft.to,
        subject: question.draft.subject,
      })),
    // Only the supplier's own words can support a correction: emails and valid replies.
    citeable: detail.evidence
      .filter(
        (item) =>
          item.disposition === "evidence" || (item.disposition === "reply" && item.reason === null),
      )
      .map((item) => ({
        deliveryId: item.deliveryId,
        contentSha256: item.contentSha256,
        label: `${item.disposition === "reply" ? "Supplier reply" : "Supplier email"} ${item.messageId}`,
      })),
  };
}

// Typed explicitly rather than with the generated PageProps helper, so lint and
// typecheck pass in a fresh clone before `next typegen` has run.
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookieHeader = (await cookies()).toString();
  const session = await fetchSession(cookieHeader);
  if (session.kind !== "signed-in") {
    return (
      <p role="alert">
        {session.kind === "unavailable" ? "The API is unavailable." : "Sign in to view this case."}{" "}
        <Link href="/" className="underline">
          Go to the exception queue
        </Link>
      </p>
    );
  }
  const result = await fetchCase(cookieHeader, id);
  if (!result.ok) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Case unavailable</h1>
        <p role="alert">
          The API refused the case read (HTTP {result.status}: {result.error}).
        </p>
        <Link href="/" className="text-accent underline">
          Back to the exception queue
        </Link>
      </div>
    );
  }
  const detail = result.data;
  const summary = detail.case;
  const [actors, demonstration] = await Promise.all([
    fetchActors(cookieHeader, summary.organizationId),
    fetchDemonstration(),
  ]);
  const live =
    LIVE_STATES.includes(summary.state) ||
    (summary.state === "partially_applied" && summary.reason === "outcome_unknown");

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/" className="text-accent underline underline-offset-4">
          Exception queue
        </Link>{" "}
        / <span aria-current="page">{summary.caseRef}</span>
      </nav>

      <section
        aria-labelledby="case-heading"
        className="rounded-[var(--radius-panel)] border border-border bg-surface px-5 py-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="case-heading" className="font-mono text-2xl font-semibold">
            {summary.caseRef}
          </h1>
          <CaseStateBadge state={summary.state} />
          <span className="text-sm text-muted">
            {summary.messageId}
            {summary.proposalId !== null && ` / ${summary.proposalId}`}, opened{" "}
            {instant(summary.openedAt)}, age {age(summary.ageSeconds)}
          </span>
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">State</dt>
          <dd data-case-state-text={summary.state}>{codeLabel(summary.state)}</dd>
          <dt className="text-muted">Reason</dt>
          <dd>
            {codeLabel(summary.reason)}
            {summary.reason !== null && (
              <code className="ml-2 text-xs text-muted">{summary.reason}</code>
            )}
          </dd>
          <dt className="text-muted">Owner</dt>
          <dd>{roleLabel(summary.owner)}</dd>
          <dt className="text-muted">Next action</dt>
          <dd className="font-medium">{summary.nextAction}</dd>
          {detail.plan !== null && (
            <>
              <dt className="text-muted">Current plan</dt>
              <dd>
                {detail.plan.planId} version {detail.plan.planVersion},{" "}
                <span className="font-mono text-xs">{shortHash(detail.plan.sha256)}</span>
              </dd>
            </>
          )}
        </dl>
        <LineageNotice detail={detail} />
        <div className="mt-3">
          <AutoRefresh
            active={live}
            label={`Live: re-reading the case every second while it is ${codeLabel(summary.state).toLowerCase()}.`}
          />
        </div>
        <p className="mt-2 text-xs text-muted">{detail.simulated}</p>
      </section>

      <ImpactPanel detail={detail} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 space-y-6">
          {detail.agentRun !== null && <AgentRunPanel run={detail.agentRun} />}
          <ClarificationPanel detail={detail} />
          <FieldsPanel detail={detail} />
          <OptionsPanel detail={detail} />
          <EvidencePanel evidence={detail.evidence} />
        </div>
        <div className="order-first min-w-0 lg:order-none">
          <Panel
            id="review"
            title="Review and decide"
            description="Commands go to the API, which records or refuses them."
          >
            {actors.ok ? (
              <ReviewControls
                caseId={summary.caseId}
                state={summary.state}
                actors={actors.data.actors}
                plan={reviewPlan(detail)}
                clarification={clarificationContext(detail)}
              />
            ) : (
              <Notice tone="warning">
                Your simulated actors could not be read (HTTP {actors.status}: {actors.error}).
              </Notice>
            )}
          </Panel>
          {demonstration.active && (
            <Panel
              id="demonstration"
              className="mt-6"
              title="Demonstration controls (simulated)"
              description="Stand-ins for events a live demonstration cannot wait for. Each is recorded on the case history; none approves, acknowledges or applies anything."
            >
              <DemonstrationControls caseId={summary.caseId} state={summary.state} />
            </Panel>
          )}
        </div>
      </div>

      <ActionTimelinePanel detail={detail} />
      <VerificationPanel detail={detail} actors={actors.ok ? actors.data.actors : null} />
      <HistoryPanel detail={detail} />
    </div>
  );
}
