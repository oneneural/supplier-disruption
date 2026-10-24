# ADR 0014: Clarification, field correction and reply resume

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-22

## Context

Before this task the workbench had one note form whose `kind` could be
`question` or `extraction_correction`. Both were history entries only: a
corrected value never reached intake, a question never paused the case for a
supplier answer and a reply had no way in. SPEC requires a buyer to correct an
extracted field from the supplier's own words, to ask the supplier a question
without sending it and to resume from an explicit recorded reply, while a note
can never change authority, a supplier proposal is never acceptance and old
approvals never authorize a replacement plan. The domain intake
(`intakeAndAssess`, ADR 0008) and the claim guards (ADR 0013) are unchanged.

## Decision

### Four separate commands

| Route                                | Actor            | Effect                                                              |
| ------------------------------------ | ---------------- | ------------------------------------------------------------------- |
| `POST /api/cases/:id/notes`          | Any case role    | History entry `note`. Changes no field, question, decision or plan. |
| `POST /api/cases/:id/clarifications` | Buyer            | Stores question `Q-n` with a local draft; pauses the case.          |
| `POST /api/cases/:id/replies`        | Supplier contact | Stores the reply bytes; answers an open question and resumes.       |
| `POST /api/cases/:id/corrections`    | Buyer            | Checks cited values, runs intake and assessment again.              |

The note command drops its `kind` field. Every command names the actor and,
except the note, the case basis: `basisAssessment`, the sequence of the latest
stored assessment (0 before any). A command prepared against an older basis
gets `409 stale_basis` and records nothing. Role checks use the simulated
actor's fixture role (ADR 0010); a wrong role gets `403 actor_not_permitted`.

### Question as an owned pause

A question is allowed in `needs_clarification`, `awaiting_approval` and
`awaiting_acknowledgement`, one open question at a time
(`409 clarification_open`). It stores the field paths in question, the text
and a draft (`to` the original sender, subject `CASE-n Q-n: clarification
requested`, a body naming the case, question and basis). `sent` is a column
with the check `NOT sent`, so no role, model or UI control can mark a draft
sent; nothing transmits it. Asking supersedes the current plan's decisions and
fails its planned or authorized actions with `clarification_requested`, then
moves the case to `needs_clarification` with reason `awaiting_supplier_reply`,
owned by the buyer. The pause is durable state, so an API restart keeps it and
`resumeInterruptedCases` queues no job for it.

### Reply ingestion

A reply carries a delivery ID, the case and question references the draft
quoted, the basis and the sender, subject and text exactly as received. In
order:

1. A repeated delivery ID with the same bytes is a replay (`200`); with other
   bytes it is `409 delivery_conflict`. A reply to a closed case
   (`plan_verified`, `escalated` or `superseded`) is then
   `409 invalid_case_state`, unrecorded.
2. A wrong `caseRef` or unknown `questionRef` is `409 reply_case_mismatch`,
   unrecorded.
3. The sender must be registered for the case's resolved vendor:
   `422 unverified_sender`, `vendor_mismatch` or `vendor_unresolved`, with a
   `reply_refused` event and no stored bytes.
4. The bytes are stored as `supplier_message` disposition `reply`, source
   system `supplier-reply`, message ID `RPL-` plus a hash prefix.
5. A question already answered by the same bytes is a duplicate (`200`); by
   other bytes a conflict (`409 reply_conflict`). A basis other than the
   question's is `409 reply_basis_mismatch`. A superseded question, one whose
   basis is no longer current, or a case no longer in the
   `awaiting_supplier_reply` pause makes the reply `409 stale_reply`. Each
   keeps the reply as evidence with that reason and has no other effect.
6. Otherwise the question is answered and the case resumes once. When the
   case has an accepted intake receipt and its current plan came from the
   latest assessment, the plan's terms are reassessed from fresh reads under
   a new plan version. Otherwise (no plan yet, or a later assessment without
   one, such as a correction that intake blocked) the case waits for a
   correction (`correction_required`) and never falls back to earlier terms.

Escalation closes an open question as `superseded` with reason
`manual_escalation`, so no reply can reopen an escalated case.

A reply's authenticity rests only on the simulated supplier-contact actor the
signed-in user may act as and the sender string matching a registered vendor
address. There is no mail transport, signature or header check behind it, so
it shows the procedure, not proof that the supplier sent the words.

A reply alone never states new terms. Its words reach the proposal only
through a correction that cites them.

### Correction

A correction lists field changes (`poNumber`, `poLine`, `baseRevision`,
`vendorItem`, `uom`, `segments[i].quantity`, `segments[i].arrival`), each with
a citation: the delivery ID and SHA-256 of a stored supplier message of this
case (an email with disposition `evidence`, or a reply with no refusal reason)
and a verbatim quote. The checks in `correction-support.ts` mirror the
extraction validator (ADR 0011): bounded identifier tokens, a whole quantity,
a stated unit word, a stated revision and an arrival date with one stated year
that is not only a shipping date. `undated` needs only a quote. No unit is
converted or implied.

The base is the current candidate: the latest accepted or blocked correction,
else the current plan's terms, both supported, else the paused agent run's
proposal, which is unsupported. With no supported base every field must be
cited (`correction_incomplete`). Invalid terms, no change and unsupported
quotes are `422`, recorded as `rejected` with diagnostics.

A supported correction builds new terms, records them as a supplier input of
source system `operator-correction` with message ID `COR-` plus a hash of the
case and terms, input version 1 and the original sender, and runs the
unchanged intake. The new message key keeps the original evidence and its
intake receipt intact. The corrected delivery's canonical bytes are stored as
a `supplier_message` (disposition `accept` or `blocked`). Prior decisions are
superseded and actions failed with `superseded_by_correction`, and an open
question is closed the same way. When intake blocks the terms the case stays
in `needs_clarification` with the intake reason and no plan. When it accepts,
the case is reassessed under the next plan version. The correction record
keeps the before and after terms and a locator per cited field (delivery,
message ID, quote, start and end offsets into the agent's evidence text and
its hash).

### Approval binding

Approvals and acknowledgements stay bound to an exact plan SHA-256 (ADR 0009,
ADR 0013). Every replacement plan has a new hash and all earlier decisions are
superseded first, so an approval of an earlier plan returns `409
plan_mismatch` and the replacement waits for its own decisions.

### Storage

Migration `0006_clarification_resume` adds `app.case_clarification` and
`app.case_correction` and allows disposition `reply`. The API role may insert
and read both and update only a question's status, reply, close time and
reason.

## Consequences

- The workbench shows questions with their unsent drafts, corrections with
  before and after terms and their linked quotes, and every stored delivery
  and reply. The forms submit the commands; the API decides.
- Repeating the original structured message after a correction is a blocked
  observation by the unchanged intake identity rules, with no effect.

## Limits

- The fixture has one vendor and one registered sender, so a wrong-vendor reply
  is exercised as an unregistered sender.
- A correction cannot remove a segment, and only supplier messages are
  citeable: PO, stock and policy records cannot support a corrected value.
- Drafts are never transmitted; there is no outbound mail integration.
