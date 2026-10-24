"use client";

import type { CaseCandidate } from "@supplier-disruption/contracts";
import { useState, type FormEvent } from "react";
import { Button } from "../../../components/ui/button";

/** An open question the reply form can answer, with the references its draft asked for. */
export interface OpenQuestion {
  questionRef: string;
  basisAssessment: number;
  to: string | null;
  subject: string;
}

/** A stored supplier message a correction may cite. */
export interface CiteableEvidence {
  deliveryId: string;
  contentSha256: string;
  label: string;
}

export interface ClarificationContext {
  caseRef: string;
  basisAssessment: number;
  candidate: CaseCandidate | null;
  openQuestions: OpenQuestion[];
  citeable: CiteableEvidence[];
}

interface Props {
  context: ClarificationContext;
  actorId: string;
  disabled: boolean;
  submit: (label: string, path: string, body: Record<string, unknown>) => void;
}

const FIELD =
  "mt-1 block w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 text-sm";

const SCALARS = [
  ["poNumber", "PO number"],
  ["poLine", "PO line"],
  ["baseRevision", "Base revision"],
  ["vendorItem", "Vendor item"],
  ["uom", "Unit"],
] as const;

interface Row {
  field: string;
  label: string;
  value: string;
  change: boolean;
  deliveryId: string;
  quote: string;
}

function initialRows(context: ClarificationContext): Row[] {
  const terms = context.candidate?.terms ?? null;
  // An unsupported or missing candidate is trusted for nothing: every row is a change.
  const change = context.candidate?.supported !== true;
  const deliveryId = context.citeable[0]?.deliveryId ?? "";
  const row = (field: string, label: string, value: string): Row => ({
    field,
    label,
    value,
    change,
    deliveryId,
    quote: "",
  });
  const segments = terms?.segments ?? [null, null];
  return [
    ...SCALARS.map(([field, label]) => row(field, label, terms?.[field] ?? "")),
    ...segments.flatMap((segment, index) => [
      row(
        `segments[${String(index)}].quantity`,
        `Segment ${String(index + 1)} quantity`,
        segment?.quantity ?? "",
      ),
      row(
        `segments[${String(index)}].arrival`,
        `Segment ${String(index + 1)} arrival`,
        segment === null
          ? ""
          : segment.arrival.state === "dated"
            ? segment.arrival.date
            : "undated",
      ),
    ]),
  ];
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/**
 * The question, reply and correction commands of ADR 0014. Each form sends
 * one command; the API checks the simulated actor's role, the case basis and
 * every citation, and the page only reports its answer. Nothing here sends a
 * message: the question is stored as a local draft.
 */
export function ClarificationForms({ context, actorId, disabled, submit }: Props) {
  const [rows, setRows] = useState<Row[]>(() => initialRows(context));
  const open = context.openQuestions[0] ?? null;

  function update(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  }

  function addSegment() {
    setRows((current) => {
      const next = current.filter((row) => row.field.startsWith("segments[")).length / 2;
      const deliveryId = context.citeable[0]?.deliveryId ?? "";
      return [
        ...current,
        ...(["quantity", "arrival"] as const).map((part) => ({
          field: `segments[${String(next)}].${part}`,
          label: `Segment ${String(next + 1)} ${part}`,
          value: "",
          change: true,
          deliveryId,
          quote: "",
        })),
      ];
    });
  }

  function onQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    submit("Question", "clarifications", {
      actorId,
      basisAssessment: context.basisAssessment,
      fields: text(form, "fields")
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field !== ""),
      question: text(form, "question"),
    });
  }

  function onReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const questionRef = text(form, "questionRef");
    const question = context.openQuestions.find((item) => item.questionRef === questionRef);
    submit("Supplier reply", "replies", {
      actorId,
      deliveryId: crypto.randomUUID(),
      caseRef: context.caseRef,
      questionRef,
      // The basis the question's draft quoted; the API compares it with its own records.
      basisAssessment: question?.basisAssessment ?? context.basisAssessment,
      sender: text(form, "sender"),
      subject: text(form, "subject"),
      text: text(form, "text"),
    });
  }

  function onCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const note = text(form, "note");
    const changes = rows
      .filter((row) => row.change)
      .map((row) => {
        const cited = context.citeable.find((item) => item.deliveryId === row.deliveryId);
        return {
          field: row.field,
          value: row.value.trim(),
          citation: {
            deliveryId: row.deliveryId,
            contentSha256: cited?.contentSha256 ?? "",
            quote: row.quote,
          },
        };
      });
    submit("Correction", "corrections", {
      actorId,
      basisAssessment: context.basisAssessment,
      changes,
      ...(note === "" ? {} : { note }),
    });
  }

  return (
    <div className="space-y-5">
      <form onSubmit={onQuestion} className="space-y-2">
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="text-sm font-semibold">Ask the supplier a question</legend>
          <p className="text-xs text-muted">
            Stored as a local draft for the buyer; it is never sent. The case waits for a recorded
            reply, and any current approval of the plan stops counting.
          </p>
          <label className="block text-sm">
            Fields in question (comma separated)
            <input
              name="fields"
              required
              className={FIELD}
              placeholder="segments[1].arrival"
              defaultValue="segments[1].arrival"
            />
          </label>
          <label className="block text-sm">
            Question
            <textarea name="question" required maxLength={1000} rows={2} className={FIELD} />
          </label>
          <Button type="submit" variant="outline">
            Save draft question
          </Button>
        </fieldset>
      </form>

      <form onSubmit={onReply} className="space-y-2">
        <fieldset disabled={disabled || open === null} className="space-y-2">
          <legend className="text-sm font-semibold">Record the supplier&apos;s reply</legend>
          <p className="text-xs text-muted">
            Enter the reply exactly as received, as the simulated supplier contact. Its bytes become
            evidence; it approves and acknowledges nothing by itself.
          </p>
          {open === null ? (
            <p className="text-sm">No question is waiting for a reply.</p>
          ) : (
            <>
              <label className="block text-sm">
                Answers question
                <select
                  name="questionRef"
                  className={`${FIELD} h-10`}
                  defaultValue={open.questionRef}
                >
                  {context.openQuestions.map((item) => (
                    <option key={item.questionRef} value={item.questionRef}>
                      {context.caseRef} {item.questionRef}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Reply sender (as received)
                <input
                  name="sender"
                  type="email"
                  required
                  className={FIELD}
                  defaultValue={open.to ?? ""}
                />
              </label>
              <label className="block text-sm">
                Reply subject
                <input name="subject" className={FIELD} defaultValue={`Re: ${open.subject}`} />
              </label>
              <label className="block text-sm">
                Reply text
                <textarea name="text" required maxLength={12_000} rows={3} className={FIELD} />
              </label>
            </>
          )}
          <Button type="submit" variant="outline">
            Record supplier reply
          </Button>
        </fieldset>
      </form>

      <form onSubmit={onCorrection} className="space-y-2">
        <fieldset disabled={disabled || context.citeable.length === 0} className="space-y-3">
          <legend className="text-sm font-semibold">Propose a field correction</legend>
          <p className="text-xs text-muted">
            Each corrected value must be stated by a quote from a stored supplier message. The API
            checks every quote, then runs intake and assessment again; the original message is never
            edited.{" "}
            {context.candidate?.supported === true
              ? "Tick only the fields you correct; the others keep their supported values."
              : "No supported proposal exists yet, so every field needs a quote."}
          </p>
          {rows.map((row, index) => (
            <div
              key={row.field}
              className="grid gap-2 rounded-[var(--radius-control)] border border-border p-2 text-sm sm:grid-cols-2"
              data-correction-field={row.field}
            >
              <label className="flex items-center gap-2 font-medium sm:col-span-2">
                <input
                  type="checkbox"
                  checked={row.change}
                  aria-label={`Correct ${row.field}`}
                  onChange={(event) => update(index, { change: event.target.checked })}
                />
                {row.label} <code className="text-xs text-muted">{row.field}</code>
              </label>
              <label className="block">
                Value
                <input
                  className={FIELD}
                  value={row.value}
                  aria-label={`Value of ${row.field}`}
                  placeholder={row.field.endsWith(".arrival") ? "YYYY-MM-DD or undated" : ""}
                  onChange={(event) => update(index, { value: event.target.value })}
                />
              </label>
              <label className="block">
                Cited message
                <select
                  className={`${FIELD} h-10`}
                  value={row.deliveryId}
                  aria-label={`Evidence for ${row.field}`}
                  onChange={(event) => update(index, { deliveryId: event.target.value })}
                >
                  {context.citeable.map((item) => (
                    <option key={item.deliveryId} value={item.deliveryId}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2">
                Quote stating the value
                <input
                  className={FIELD}
                  value={row.quote}
                  maxLength={400}
                  aria-label={`Quote for ${row.field}`}
                  onChange={(event) => update(index, { quote: event.target.value })}
                />
              </label>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={addSegment}>
              Add segment
            </Button>
          </div>
          <label className="block text-sm">
            Note (optional)
            <input name="note" maxLength={500} className={FIELD} />
          </label>
          <Button type="submit" variant="outline">
            Submit correction
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
