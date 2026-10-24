"use client";

import type {
  AcknowledgementCommand,
  CaseActor,
  CaseState,
  ScheduleSegment,
} from "@supplier-disruption/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "../../../components/ui/button";
import { Notice } from "../../../components/ui/panel";
import { arrival, codeLabel, roleLabel } from "../../../lib/format";
import { ClarificationForms, type ClarificationContext } from "./clarification-forms";

/** The exact plan facts the controls submit, chosen by the server page from the current plan. */
export interface ReviewPlan {
  planId: string;
  planVersion: number;
  sha256: string;
  cost: string;
  minimumApprover: string;
  limits: { role: string; limit: string }[];
  supplier: {
    proposalId: string;
    poNumber: string;
    poLine: string;
    uom: string;
    segments: ScheduleSegment[];
  } | null;
  transfer: { optionId: string; quantity: string; uom: string; arrivalDate: string } | null;
}

interface Props {
  caseId: string;
  state: CaseState;
  actors: CaseActor[];
  plan: ReviewPlan | null;
  clarification: ClarificationContext;
}

type Outcome =
  | { kind: "idle" }
  | { kind: "pending"; label: string }
  | { kind: "accepted"; text: string }
  | { kind: "refused"; text: string };

const ERROR_TEXT: Record<string, string> = {
  over_approval_limit:
    "The simulated role's approval limit is below the plan cost. Nothing was authorized.",
  role_not_permitted: "The policy gives this role no approval limit. Nothing was authorized.",
  currency_not_permitted: "The policy does not permit the plan currency. Nothing was authorized.",
  actor_not_permitted:
    "This fixture identity cannot act as that simulated actor, or the actor's role cannot record this.",
  plan_mismatch: "The plan changed since this page loaded. Review the current plan first.",
  invalid_case_state: "The case is no longer in a state that accepts this.",
  case_not_found: "The case is not visible to this identity.",
  origin_rejected: "The request did not come from the application origin.",
  invalid_request: "The API rejected the request as malformed.",
  clarification_open: "A question is already waiting for the supplier's reply.",
  stale_basis: "The case was reassessed since this page loaded. Review the current facts first.",
  reply_case_mismatch: "The reply names another case or a question this case does not have.",
  unverified_sender:
    "The reply's sender is not registered for this case's vendor. Nothing changed.",
  vendor_mismatch: "The reply is not from this case's vendor. Nothing changed.",
  vendor_unresolved: "The case's vendor is not resolved, so no reply can be attributed.",
  reply_basis_mismatch: "The reply answers a different basis than its question. Kept, no effect.",
  stale_reply: "The question was superseded by newer facts. The reply is kept with no effect.",
  reply_conflict: "The question already has a different reply. This one is kept with no effect.",
  correction_invalid: "The corrected fields do not form valid proposal terms.",
  correction_incomplete: "No supported proposal exists yet, so every field needs a quote.",
  correction_unsupported: "A quote does not state its corrected value. Nothing changed.",
  correction_no_change: "The correction states the current terms; nothing would change.",
  delivery_conflict: "That delivery ID was already used for something else.",
};

const FIELD =
  "mt-1 block w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 text-sm";

const OPEN_FOR_DECISIONS: readonly CaseState[] = ["awaiting_approval"];
const OPEN_FOR_ACKNOWLEDGEMENT: readonly CaseState[] = [
  "awaiting_approval",
  "awaiting_acknowledgement",
];
const TERMINAL: readonly CaseState[] = ["plan_verified", "escalated", "superseded"];

/** A form field's trimmed text; a file or missing field is empty. */
function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function segmentsText(segments: ScheduleSegment[], uom: string): string {
  return segments
    .map((segment) => `${segment.quantity} ${uom} arriving ${arrival(segment.arrival)}`)
    .join("; ");
}

/**
 * Review controls. Every button sends one command to the API, which checks
 * the simulated actor against its own records; the page only reports the
 * API's answer and re-reads the case.
 */
export function ReviewControls({ caseId, state, actors, plan, clarification }: Props) {
  const router = useRouter();
  const [actorId, setActorId] = useState(actors[0]?.actorId ?? "");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const actor = actors.find((item) => item.actorId === actorId) ?? null;
  const pending = outcome.kind === "pending";

  async function submit(label: string, path: string, body: Record<string, unknown>) {
    setOutcome({ kind: "pending", label });
    const response = await fetch(`/api/cases/${caseId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    }).catch(() => null);
    const result = (await response?.json().catch(() => null)) as {
      error?: string;
      outcome?: string;
      disposition?: string;
      reason?: string | null;
      state?: string;
      recorded?: string;
      diagnostics?: string[];
    } | null;
    if (response === null) {
      setOutcome({
        kind: "refused",
        text: `${label}: no answer from the API. The result is unknown; reload before retrying.`,
      });
      return;
    }
    if (!response.ok) {
      const code = result?.error ?? "unknown_error";
      setOutcome({
        kind: "refused",
        text: `${label} refused (HTTP ${String(response.status)}: ${code}). ${ERROR_TEXT[code] ?? codeLabel(code)}${
          result?.diagnostics === undefined ? "" : ` ${result.diagnostics.join("; ")}`
        }`,
      });
    } else if (result?.outcome === "blocked") {
      setOutcome({
        kind: "refused",
        text: `${label} recorded, but intake blocked the corrected terms (${codeLabel(result.reason)}). No plan.`,
      });
    } else if (result?.disposition === "duplicate") {
      setOutcome({
        kind: "accepted",
        text: `${label} recorded as a duplicate of the earlier reply. It changes nothing.`,
      });
    } else if (result?.outcome === "non_matching") {
      setOutcome({
        kind: "refused",
        text: `${label} recorded as not matching (${codeLabel(result.reason)}). It changes nothing.`,
      });
    } else {
      setOutcome({
        kind: "accepted",
        text: `${label} recorded by the API. Case state after it: ${codeLabel(result?.state ?? state)}.`,
      });
    }
    router.refresh();
  }

  function decide(decision: "approve" | "reject") {
    if (plan === null) return;
    void submit(decision === "approve" ? "Approval" : "Rejection", "decisions", {
      actorId,
      decision,
      planSha256: plan.sha256,
    });
  }

  function acknowledge(command: AcknowledgementCommand, label: string) {
    void submit(label, "acknowledgements", command);
  }

  function onEscalate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const note = text(new FormData(event.currentTarget), "note");
    void submit("Escalation", "escalations", { actorId, note });
  }

  function onNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = text(form, "field");
    void submit("Note", "notes", {
      actorId,
      note: text(form, "note"),
      ...(field === "" ? {} : { field }),
    });
  }

  if (actors.length === 0) {
    return (
      <Notice tone="warning">
        This fixture identity has no simulated actor in this organization, so it can only read the
        case.
      </Notice>
    );
  }

  const decisionsOpen = OPEN_FOR_DECISIONS.includes(state) && plan !== null;
  const acknowledgementsOpen = OPEN_FOR_ACKNOWLEDGEMENT.includes(state) && plan !== null;

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium">
          Act as (simulated role)
          <select
            className={`${FIELD} h-10`}
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
          >
            {actors.map((item) => (
              <option key={item.actorId} value={item.actorId}>
                {item.actorId}: {roleLabel(item.role)}
                {item.vendorId === null ? "" : ` for ${item.vendorId}`}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-xs text-muted">
          Simulated actors bound to your fixture identity. Choosing one here never grants authority:
          the API checks every command against its own records. Sign out to switch identity.
        </p>
      </div>

      <div aria-live="polite" role="status" className="min-h-5 text-sm" data-review-status>
        {outcome.kind === "pending" && `${outcome.label}: waiting for the API`}
        {outcome.kind === "accepted" && outcome.text}
      </div>
      {outcome.kind === "refused" && (
        <Notice tone="blocked" role="alert" data-review-refusal>
          {outcome.text}
        </Notice>
      )}

      <fieldset className="space-y-2" disabled={pending || !decisionsOpen}>
        <legend className="text-sm font-semibold">Plan decision</legend>
        {plan === null ? (
          <p className="text-sm">No plan to decide on.</p>
        ) : (
          <>
            <p className="text-sm">
              {plan.planId} version {plan.planVersion}, cost {plan.cost}. Minimum approver:{" "}
              {plan.minimumApprover}. Limits:{" "}
              {plan.limits.map((item) => `${item.role} ${item.limit}`).join(", ")}. The decision
              binds plan SHA-256 <span className="font-mono text-xs">{plan.sha256}</span>.
            </p>
            {!decisionsOpen && (
              <p className="text-xs text-muted">Decisions are closed in this case state.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => decide("approve")}>Approve plan</Button>
              <Button variant="outline" onClick={() => decide("reject")}>
                Reject plan
              </Button>
            </div>
          </>
        )}
      </fieldset>

      <fieldset className="space-y-3" disabled={pending || !acknowledgementsOpen}>
        <legend className="text-sm font-semibold">Simulated acknowledgements</legend>
        <p className="text-xs text-muted">
          These stand in for a supplier reply and a warehouse confirmation. Each records exactly the
          references shown; a reply without them never completes the case.
        </p>
        {plan?.supplier != null && (
          <div className="rounded-[var(--radius-control)] border border-border p-3 text-sm">
            <p>
              Supplier acknowledgement of {plan.supplier.proposalId}: {plan.supplier.poNumber} line{" "}
              {plan.supplier.poLine}, {segmentsText(plan.supplier.segments, plan.supplier.uom)}.
            </p>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => {
                const supplier = plan.supplier;
                if (supplier === null) return;
                acknowledge(
                  {
                    kind: "supplier_acknowledgement",
                    actorId,
                    proposalId: supplier.proposalId,
                    poNumber: supplier.poNumber,
                    poLine: supplier.poLine,
                    segments: supplier.segments,
                  },
                  "Supplier acknowledgement",
                );
              }}
            >
              Record supplier acknowledgement
            </Button>
          </div>
        )}
        {plan?.transfer != null && (
          <div className="rounded-[var(--radius-control)] border border-border p-3 text-sm">
            <p>
              Warehouse planner confirmation of {plan.transfer.optionId}: {plan.transfer.quantity}{" "}
              {plan.transfer.uom} arriving {plan.transfer.arrivalDate}.
            </p>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => {
                const transfer = plan.transfer;
                if (transfer === null) return;
                acknowledge(
                  {
                    kind: "warehouse_planner_confirmation",
                    actorId,
                    planSha256: plan.sha256,
                    optionId: transfer.optionId,
                    quantity: transfer.quantity,
                    arrivalDate: transfer.arrivalDate,
                  },
                  "Warehouse planner confirmation",
                );
              }}
            >
              Record warehouse planner confirmation
            </Button>
          </div>
        )}
        {actor !== null && (
          <p className="text-xs text-muted">
            Recorded as {actor.actorId} ({roleLabel(actor.role)}).
          </p>
        )}
      </fieldset>

      <ClarificationForms
        // A new basis remounts the forms with the current candidate terms.
        key={clarification.basisAssessment}
        context={clarification}
        actorId={actorId}
        disabled={pending || TERMINAL.includes(state)}
        submit={(label, path, body) => void submit(label, path, body)}
      />

      <form onSubmit={onNote} className="space-y-2">
        <fieldset disabled={pending} className="space-y-2">
          <legend className="text-sm font-semibold">Note</legend>
          <p className="text-xs text-muted">
            Recorded on the case history only. A note is not evidence: it changes no field,
            question, decision or plan.
          </p>
          <label className="block text-sm">
            Field (optional)
            <input
              name="field"
              maxLength={120}
              className={FIELD}
              placeholder="segments[2].arrival"
            />
          </label>
          <label className="block text-sm">
            Note
            <textarea name="note" required maxLength={500} rows={2} className={FIELD} />
          </label>
          <Button type="submit" variant="outline">
            Record note
          </Button>
        </fieldset>
      </form>

      <form onSubmit={onEscalate} className="space-y-2">
        <fieldset disabled={pending || TERMINAL.includes(state)} className="space-y-2">
          <legend className="text-sm font-semibold">Escalate</legend>
          <p className="text-xs text-muted">
            Stops the case for a buyer decision. Effects already applied stay recorded and are not
            reversed.
          </p>
          <label className="block text-sm">
            Reason for escalation
            <textarea name="note" required maxLength={500} rows={2} className={FIELD} />
          </label>
          <Button type="submit" variant="destructive">
            Escalate case
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
