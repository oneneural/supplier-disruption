"use client";

import type { CaseState, DemonstrationControl } from "@supplier-disruption/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Notice } from "../../../components/ui/panel";
import { codeLabel } from "../../../lib/format";

const CONTROLS: Record<
  DemonstrationControl,
  { button: string; explains: string; open: readonly CaseState[] | null }
> = {
  foreign_reservation: {
    button: "Simulate another order reserving 20 EA at WH-B",
    explains:
      "A source change after the plan: WH-B's stock version moves and its eligible stock falls from 50 to 30 EA. An approval binds the stock version it saw, so application must refuse to use it and reassess.",
    open: null,
  },
  uncertain_reservation_write: {
    button: "Lose the response of this case's next reservation write",
    explains:
      "The source commits the ACT-2 reservation but the API never hears back. The action becomes unknown and is reconciled by operation ID and read-back before any retry, so nothing is reserved twice.",
    open: ["awaiting_approval", "awaiting_acknowledgement"],
  },
};

type Outcome = { kind: "idle" | "pending" } | { kind: "done" | "refused"; text: string };

/**
 * Labelled demonstration controls (ADR 0012). Each one is a simulated source
 * change or fault, recorded on the case history; none decides, acknowledges
 * or applies anything.
 */
export function DemonstrationControls({ caseId, state }: { caseId: string; state: CaseState }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  async function run(control: DemonstrationControl) {
    setOutcome({ kind: "pending" });
    const response = await fetch(`/api/demonstration/cases/${caseId}/controls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ control }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as {
      error?: string;
      reason?: string;
      recorded?: boolean;
    } | null;
    if (response === null || !response.ok) {
      setOutcome({
        kind: "refused",
        text: `Refused (HTTP ${String(response?.status ?? 0)}: ${body?.error ?? "api_unavailable"}${body?.reason === undefined ? "" : `, ${body.reason}`}).`,
      });
    } else {
      setOutcome({
        kind: "done",
        text:
          body?.recorded === false
            ? `${codeLabel(control)}: already applied earlier; nothing changed.`
            : `${codeLabel(control)} recorded on the case history.`,
      });
    }
    router.refresh();
  }

  return (
    <div className="space-y-3 text-sm">
      {(Object.keys(CONTROLS) as DemonstrationControl[]).map((control) => {
        const { button, explains, open } = CONTROLS[control];
        return (
          <div key={control} className="rounded-[var(--radius-control)] border border-border p-3">
            <p>{explains}</p>
            <Button
              variant="outline"
              className="mt-2"
              disabled={outcome.kind === "pending" || (open !== null && !open.includes(state))}
              onClick={() => void run(control)}
            >
              {button}
            </Button>
          </div>
        );
      })}
      <div aria-live="polite" role="status" className="min-h-5" data-demonstration-status>
        {outcome.kind === "pending" && "Waiting for the API"}
        {outcome.kind === "done" && outcome.text}
      </div>
      {outcome.kind === "refused" && (
        <Notice tone="blocked" role="alert">
          {outcome.text}
        </Notice>
      )}
    </div>
  );
}
