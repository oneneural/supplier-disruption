"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../components/ui/button";

/**
 * Paste a supplier email, or load the C-01 sample, and submit it for
 * extraction. The sender is the envelope sender as received; the API opens a
 * case in `received` and the extraction agent runs as the case's job.
 */
const C01_SAMPLE = {
  sender: "orders@kestrel-fasteners.test",
  subject: "PO-120 line 10: revised delivery schedule",
  text: "Hello,\n\nRegarding your purchase order PO-120 (revision 3), line 10, our item KF-A-01: we cannot deliver the full 120 EA by October 23.\n\nWe can deliver 40 EA to your warehouse on 23 October 2026, and the remaining 80 EA will arrive on 26 October 2026.\n\nPlease confirm the revised schedule.\n\nBest regards,\nKestrel Fasteners order desk",
};

const field =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2";

export function SupplierEmailForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [sender, setSender] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [attachmentText, setAttachmentText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadSample() {
    setSender(C01_SAMPLE.sender);
    setSubject(C01_SAMPLE.subject);
    setText(C01_SAMPLE.text);
    setAttachmentText("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const response = await fetch("/api/cases/emails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        organizationId,
        deliveryId: crypto.randomUUID(),
        sender,
        subject,
        text,
        ...(attachmentText.trim() === "" ? {} : { attachmentText }),
      }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as {
      caseId?: string;
      error?: string;
    } | null;
    setPending(false);
    if (response === null || !response.ok || body?.caseId === undefined) {
      setError(
        `Not submitted (HTTP ${String(response?.status ?? 0)}): ${body?.error ?? "api_unavailable"}`,
      );
      return;
    }
    router.push(`/cases/${body.caseId}`);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Sender</span>
          <input
            className={field}
            type="email"
            required
            value={sender}
            onChange={(event) => setSender(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Subject</span>
          <input
            className={field}
            maxLength={300}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Email text</span>
        <textarea
          className={`${field} font-mono`}
          rows={8}
          required
          maxLength={12000}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Attachment text (optional)</span>
        <textarea
          className={`${field} font-mono`}
          rows={3}
          maxLength={6000}
          value={attachmentText}
          onChange={(event) => setAttachmentText(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          Submit for extraction
        </Button>
        <Button type="button" variant="outline" onClick={loadSample} disabled={pending}>
          Load C-01 sample email
        </Button>
        <span className="text-sm text-muted">
          The text is evidence only; it cannot grant permission or approve anything.
        </span>
      </div>
      <p role="status" aria-live="polite" className="text-sm">
        {pending && "Submitting the email"}
      </p>
      {error !== null && (
        <p role="alert" className="text-sm text-blocked-fg">
          {error}
        </p>
      )}
    </form>
  );
}
