"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../components/ui/button";

/**
 * The demo's stand-in for a mailbox: asks the API to ingest the stored
 * fixture message MSG-0001 (scenario C-01). Each click is a new delivery; the
 * API records a repeat as a duplicate of the existing case.
 */
const FIXTURE_MESSAGE = {
  sourceSystem: "fixture-supplier-mail",
  messageId: "MSG-0001",
  inputVersion: 1,
};

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; text: string }
  | { kind: "failed"; text: string };

export function LoadFixtureButton({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function load() {
    setStatus({ kind: "pending" });
    const response = await fetch("/api/cases/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ organizationId, deliveryId: crypto.randomUUID(), ...FIXTURE_MESSAGE }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as {
      disposition?: string;
      caseId?: string;
      caseRef?: string;
      reason?: string | null;
      error?: string;
    } | null;
    if (response === null || !response.ok || body?.caseId === undefined) {
      const code = body?.error ?? "api_unavailable";
      setStatus({
        kind: "failed",
        text: `Not loaded (HTTP ${String(response?.status ?? 0)}): ${code}`,
      });
      return;
    }
    const outcome =
      body.disposition === "duplicate"
        ? "Already loaded: recorded as a duplicate delivery, with no new case or effect."
        : `Loaded ${FIXTURE_MESSAGE.messageId}: ${body.disposition ?? "recorded"}${body.reason ? ` (${body.reason})` : ""}.`;
    setStatus({ kind: "done", text: outcome });
    router.push(`/cases/${body.caseId}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={() => void load()} disabled={status.kind === "pending"}>
        Load fixture message
      </Button>
      <span className="text-sm text-muted">
        Stored message {FIXTURE_MESSAGE.messageId} from a simulated supplier mailbox
      </span>
      <p role="status" aria-live="polite" className="w-full text-sm">
        {status.kind === "pending" && "Loading the fixture message"}
        {status.kind === "done" && status.text}
      </p>
      {status.kind === "failed" && (
        <p role="alert" className="w-full text-sm text-blocked-fg">
          {status.text}
        </p>
      )}
    </div>
  );
}
