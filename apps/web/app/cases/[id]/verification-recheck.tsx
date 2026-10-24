"use client";

import type { CaseActor } from "@supplier-disruption/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Notice } from "../../../components/ui/panel";
import { codeLabel, instant, roleLabel } from "../../../lib/format";

type Outcome = { kind: "idle" | "pending" } | { kind: "done" | "refused"; text: string };

/**
 * Asks the API to read the plan's source records back again (ADR 0015). It
 * writes no source; the API records whether the records still match, no
 * longer match, or could not be read.
 */
export function VerificationRecheck({ caseId, actors }: { caseId: string; actors: CaseActor[] }) {
  const router = useRouter();
  const [actorId, setActorId] = useState(actors[0]?.actorId ?? "");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  async function recheck() {
    setOutcome({ kind: "pending" });
    const response = await fetch(`/api/cases/${caseId}/verifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ actorId }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as {
      error?: string;
      outcome?: string;
      validUntil?: string | null;
    } | null;
    if (response === null || !response.ok) {
      setOutcome({
        kind: "refused",
        text: `Recheck refused (HTTP ${String(response?.status ?? 0)}: ${body?.error ?? "api_unavailable"}).`,
      });
    } else if (body?.outcome === "verified") {
      setOutcome({
        kind: "done",
        text: `The records still match. Verified until ${instant(body.validUntil)}.`,
      });
    } else if (body?.outcome === "unavailable") {
      setOutcome({
        kind: "done",
        text: "The source records could not be read. Recorded as unavailable, not as a mismatch.",
      });
    } else {
      setOutcome({
        kind: "done",
        text: `The records no longer match (${codeLabel(body?.outcome)}). The plan is no longer verified.`,
      });
    }
    router.refresh();
  }

  if (actors.length === 0) {
    return (
      <p className="text-sm text-muted">
        None of your simulated actors may ask for a recheck: it needs a buyer, procurement manager
        or warehouse planner.
      </p>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-muted">Recheck as simulated actor</span>
          <select
            className="mt-1 block rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2"
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
          >
            {actors.map((actor) => (
              <option key={actor.actorId} value={actor.actorId}>
                {actor.actorId} ({roleLabel(actor.role)})
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          disabled={outcome.kind === "pending"}
          onClick={() => void recheck()}
          data-verification-recheck
        >
          Recheck the source records
        </Button>
      </div>
      <div aria-live="polite" role="status" className="min-h-5" data-verification-recheck-status>
        {outcome.kind === "pending" && "Reading the source records back"}
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
