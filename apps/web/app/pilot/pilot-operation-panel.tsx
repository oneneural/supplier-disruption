"use client";

import {
  PILOT_CONTRACT_VERSION,
  type MembershipRole,
  type PilotOperation,
  type PilotStreamEvent,
} from "@supplier-disruption/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { followPilotStream, type StreamOutcome } from "../../lib/pilot-stream";

interface Props {
  organizationId: string;
  organizationName: string;
  role: MembershipRole;
}

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "rejected"; status: number; error: string }
  | { kind: "tracking"; operation: PilotOperation };

type StreamState = "connecting" | "open" | "reconnecting" | "ended" | "refused" | "interrupted";

// After the stream ends, the receipt may still be on its way from the worker.
const RECEIPT_POLL_INTERVAL_MS = 1000;
const RECEIPT_POLL_ATTEMPTS = 10;

const STREAM_LABELS: Record<StreamState, string> = {
  connecting: "connecting",
  open: "open",
  reconnecting: "interrupted; reconnecting after the last event received",
  ended: "ended",
  refused: "stopped: the API refused to continue it (signed out or no longer permitted)",
  interrupted: "interrupted before its last event; reconnecting did not deliver it",
};

const OUTCOME_STATES: Record<Exclude<StreamOutcome["kind"], "aborted">, StreamState> = {
  ended: "ended",
  refused: "refused",
  interrupted: "interrupted",
};

async function readOperation(operationId: string): Promise<PilotOperation | null> {
  const response = await fetch(`/api/pilot/operations/${operationId}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  return response.ok ? ((await response.json()) as PilotOperation) : null;
}

export function PilotOperationPanel({ organizationId, organizationName, role }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [events, setEvents] = useState<PilotStreamEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>("connecting");

  const trackedId = status.kind === "tracking" ? status.operation.operationId : null;

  // One bounded stream per submitted operation. Each event renders as it
  // arrives; the receipt is read once the stream is over.
  useEffect(() => {
    if (trackedId === null) return;
    let cancelled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;

    const loadReceipt = async (attempt: number) => {
      const operation = await readOperation(trackedId).catch(() => null);
      if (cancelled) return;
      if (operation !== null) setStatus({ kind: "tracking", operation });
      if (operation?.receipt == null && attempt < RECEIPT_POLL_ATTEMPTS) {
        poll = setTimeout(() => void loadReceipt(attempt + 1), RECEIPT_POLL_INTERVAL_MS);
      }
    };

    // Resumes after an interruption from the last event ID received (ADR 0020).
    const controller = new AbortController();
    void followPilotStream(`/api/pilot/operations/${trackedId}/events`, {
      signal: controller.signal,
      onOpen: () => setStreamState("open"),
      onEvent: (event) => setEvents((previous) => [...previous, event]),
      onReconnecting: () => setStreamState("reconnecting"),
    }).then((outcome) => {
      if (cancelled || outcome.kind === "aborted") return;
      setStreamState(OUTCOME_STATES[outcome.kind]);
      void loadReceipt(1);
    });

    return () => {
      cancelled = true;
      clearTimeout(poll);
      controller.abort();
    };
  }, [trackedId]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const note = new FormData(event.currentTarget).get("note");
    setStatus({ kind: "submitting" });
    setEvents([]);
    setStreamState("connecting");
    const response = await fetch("/api/pilot/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        contractVersion: PILOT_CONTRACT_VERSION,
        operationId: crypto.randomUUID(),
        organizationId,
        payload: { note: typeof note === "string" ? note : "" },
      }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 200 || response.status === 202) {
      setStatus({ kind: "tracking", operation: body as PilotOperation });
    } else {
      const error = (body as { error?: string } | null)?.error ?? "unknown_error";
      setStatus({ kind: "rejected", status: response.status, error });
    }
  }

  return (
    <section
      aria-labelledby={`pilot-${organizationId}`}
      className="space-y-3 rounded-[var(--radius-panel)] border border-border bg-surface p-5"
    >
      <h2 id={`pilot-${organizationId}`} className="text-base font-semibold">
        Submit for {organizationName}
      </h2>
      <p className="text-sm text-muted">
        Manager-only placeholder command. Your role here is <strong>{role}</strong>; the API
        decides.
      </p>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-wrap items-end gap-3">
        <label className="block text-sm font-medium">
          Note
          <input
            name="note"
            defaultValue="Pilot operation"
            maxLength={200}
            required
            className="mt-1 block h-10 rounded-[var(--radius-control)] border border-border bg-surface px-3"
          />
        </label>
        <Button type="submit" disabled={status.kind === "submitting"}>
          Submit pilot operation
        </Button>
      </form>
      {status.kind === "rejected" && (
        <p role="alert" className="text-sm text-blocked-fg">
          Rejected with HTTP {status.status}: {status.error}
        </p>
      )}
      {status.kind === "tracking" && (
        <>
          <p role="status">
            Operation {status.operation.operationId}: {status.operation.state}
          </p>
          <h3 className="font-semibold">Status stream</h3>
          <p data-stream-state={streamState}>Stream {STREAM_LABELS[streamState]}</p>
          <ol className="list-decimal pl-6 tabular-nums" aria-label="Status events">
            {events.map((item) => (
              <li key={item.seq} data-event-seq={item.seq}>
                Event {item.seq}: {item.state} at {item.emittedAt}
              </li>
            ))}
          </ol>
          {status.operation.receipt !== null && (
            <p data-receipt-id={status.operation.receipt.receiptId}>
              Receipt {status.operation.receipt.receiptId} recorded at{" "}
              {status.operation.receipt.recordedAt}
            </p>
          )}
        </>
      )}
    </section>
  );
}
