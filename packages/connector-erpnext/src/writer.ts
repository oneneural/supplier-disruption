import { createHash } from "node:crypto";
import {
  CONNECTOR_CONTRACT_VERSION,
  type ConnectorOperationEvent,
  type ConnectorOperationIntent,
  type ConnectorOperationKind,
  type ConnectorOperationRecord,
  type ConnectorOperationState,
  type ConnectorRefusalReason,
} from "@supplier-disruption/contracts";
import { classify, type Classified } from "./classify.js";
import type { ApiPrincipal } from "./config.js";
import type { OperationJournal } from "./journal.js";
import { wholeQuantity } from "./native.js";
import { hasMarker, resourcePath, type ErpnextReader, type PurchaseOrderRead } from "./reader.js";
import { stable } from "./stable.js";
import type { Transport } from "./transport.js";

/**
 * `recorded` means this call created the operation record and decided its
 * state. A repeated operation ID never sends a request: with the same intent
 * it returns the stored record as `duplicate_operation`, with another intent
 * as `operation_conflict`.
 */
export interface WriteResult {
  readonly outcome: "recorded" | "duplicate_operation" | "operation_conflict";
  readonly record: ConnectorOperationRecord;
}

type UnsupportedKind = Exclude<
  ConnectorOperationKind,
  "update_schedule_date" | "create_transfer_request_draft"
>;

/**
 * Operations with no safe native precondition in ERPNext v16.52.0, from the
 * sandbox probes (ADR 0018). They are recorded and never sent; an operator
 * performs and verifies them, or they stay unresolved.
 */
export const UNSUPPORTED_OPERATIONS: Record<
  UnsupportedKind,
  { readonly disposition: "manual" | "unresolved"; readonly reason: string }
> = {
  update_items_quantity: {
    disposition: "manual",
    reason:
      "Update Items accepts no caller source token; a request built from an old snapshot silently reverted a second actor's change (probe P05b)",
  },
  split_line: {
    disposition: "manual",
    reason:
      "a row has one schedule date and an Update Items split dropped the new row's demand link (probe P06a)",
  },
  cancel_and_amend: {
    disposition: "manual",
    reason:
      "cancel, create and submit are three separate requests; in the first sandbox run a refused create left the original cancelled with no successor (probe P06b)",
  },

  plan_bound_reservation: {
    disposition: "unresolved",
    reason:
      "a reservation submit checks native capacity and its own token only, never the approved stock version, and two identical requests created two entries (probes P07, P09)",
  },
  transfer_submission: {
    disposition: "unresolved",
    reason:
      "submitting a Material Transfer posts stock at once, and the connector principal has no stock movement authority (probe P11)",
  },
};

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

/** The marker a created record carries so that a read-back can find it. */
export function operationMarker(operationId: string): string {
  return `sd-op:${operationId}`;
}

/**
 * Conditional and marked writes for one principal. Every operation is
 * journalled before its single request, a refusal or an uncertain result is
 * recorded as such, and success requires a read-back that matches the
 * recorded intent. The writer never retries a request.
 */
export class ErpnextWriter {
  constructor(
    readonly transport: Transport,
    readonly principal: ApiPrincipal,
    readonly journal: OperationJournal,
    /** Reads back with the writer's own principal. */
    private readonly readBack: ErpnextReader,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private event(
    state: ConnectorOperationState,
    note: string,
    response?: { status: number | null; sourceError: string | null },
  ): ConnectorOperationEvent {
    return {
      at: this.clock().toISOString(),
      state,
      ...(response?.status ? { status: response.status } : {}),
      ...(response?.sourceError ? { sourceError: response.sourceError } : {}),
      note: note.slice(0, 500),
    };
  }

  private transition(
    record: ConnectorOperationRecord,
    state: ConnectorOperationState,
    note: string,
    changes: Partial<ConnectorOperationRecord> = {},
    response?: { status: number | null; sourceError: string | null },
  ): ConnectorOperationRecord {
    const next = {
      ...record,
      ...changes,
      state,
      history: [...record.history, this.event(state, note, response)],
    };
    this.journal.put(next);
    return next;
  }

  /** Returns a stored record for a repeated operation ID, or a new one not yet journalled. */
  private open(input: {
    operationId: string;
    kind: ConnectorOperationKind;
    target: ConnectorOperationRecord["target"];
    intent: ConnectorOperationIntent;
    expectedModified: string | null;
    marker: string | null;
  }): WriteResult | ConnectorOperationRecord {
    const requestSha256 = digest({
      kind: input.kind,
      target: input.target,
      intent: input.intent,
      expectedModified: input.expectedModified,
    });
    const existing = this.journal.get(input.operationId);
    if (existing) {
      return {
        outcome:
          existing.requestSha256 === requestSha256 ? "duplicate_operation" : "operation_conflict",
        record: existing,
      };
    }
    return {
      contractVersion: CONNECTOR_CONTRACT_VERSION,
      ...input,
      requestSha256,
      state: "dispatching",
      reason: null,
      nativeName: null,
      observedModified: null,
      requestsSent: 0,
      history: [this.event("dispatching", "operation recorded")],
    };
  }

  private refuseLocally(
    record: ConnectorOperationRecord,
    reason: ConnectorRefusalReason,
    note: string,
  ): WriteResult {
    const refused = {
      ...record,
      state: "refused" as const,
      reason,
      history: [this.event("refused", note)],
    };
    this.journal.put(refused);
    return { outcome: "recorded", record: refused };
  }

  /** Journals the request as sent, sends it once and records a refusal or an unknown result. */
  private async dispatch(
    record: ConnectorOperationRecord,
    request: Parameters<Transport["send"]>[1],
  ): Promise<{ record: ConnectorOperationRecord; outcome: Classified }> {
    const sent = { ...record, requestsSent: 1 };
    this.journal.put(sent);
    const outcome = classify(await this.transport.send(this.principal, request));
    if (outcome.kind === "refused") {
      return {
        outcome,
        record: this.transition(
          sent,
          "refused",
          "the source refused the request",
          { reason: outcome.reason },
          outcome,
        ),
      };
    }
    if (outcome.kind === "unknown") {
      return {
        outcome,
        record: this.transition(sent, "unknown", `outcome unknown: ${outcome.detail}`, {}, outcome),
      };
    }
    return { outcome, record: sent };
  }

  /**
   * Changes one submitted PO row's schedule date with the read's `modified`
   * as the precondition. The request sends every row exactly as read, so the
   * source refuses it (HTTP 417 `TimestampMismatchError`) if anything changed
   * since. A missing token is refused here: the sandbox accepted a tokenless
   * update built from an old snapshot and overwrote a newer date (probe P04).
   */
  async updateScheduleDate(command: {
    readonly operationId: string;
    readonly purchaseOrder: PurchaseOrderRead;
    readonly rowId: string;
    readonly scheduleDate: string;
  }): Promise<WriteResult> {
    const { record: po, native } = command.purchaseOrder;
    const token = native.modified === "" ? null : native.modified;
    const opened = this.open({
      operationId: command.operationId,
      kind: "update_schedule_date",
      target: { doctype: "Purchase Order", name: po.ref.name },
      intent: {
        kind: "update_schedule_date",
        rowId: command.rowId,
        scheduleDate: command.scheduleDate,
        rowsAfter: po.lines.map((line) => ({
          rowId: line.rowId,
          sku: line.sku,
          ordered: line.ordered,
          received: line.received,
          scheduleDate: line.rowId === command.rowId ? command.scheduleDate : line.scheduleDate,
        })),
      },
      expectedModified: token,
      marker: null,
    });
    if ("outcome" in opened) return opened;
    if (token === null) {
      return this.refuseLocally(opened, "missing_source_token", "no source token; nothing sent");
    }
    if (po.ref.docstatus !== 1 || !po.lines.some((line) => line.rowId === command.rowId)) {
      return this.refuseLocally(
        opened,
        "business_validation",
        "the row is not on a submitted purchase order; nothing sent",
      );
    }
    // A request for the date the row already has would change nothing the
    // read-back could tell apart from another actor's save, so it is refused.
    const current = po.lines.find((line) => line.rowId === command.rowId);
    if (current?.scheduleDate === command.scheduleDate) {
      return this.refuseLocally(
        opened,
        "business_validation",
        "the row already has the requested date; nothing sent",
      );
    }
    const items = native.items.map((row) =>
      row.name === command.rowId ? { ...row, schedule_date: command.scheduleDate } : row,
    );
    const { record, outcome } = await this.dispatch(opened, {
      method: "PUT",
      path: resourcePath("Purchase Order", po.ref.name),
      body: { modified: token, items },
    });
    if (outcome.kind === "refused") return { outcome: "recorded", record };
    return { outcome: "recorded", record: await this.verify(record) };
  }

  /**
   * Creates a draft Material Transfer as the transfer request. A draft moves
   * no stock (probe P11). Creation has no native precondition or idempotency,
   * so the remarks carry a unique marker and a lost response is resolved only
   * by finding exactly one matching record.
   */
  async createTransferRequestDraft(command: {
    readonly operationId: string;
    readonly company: string;
    readonly sku: string;
    readonly stockUom: string;
    readonly quantity: string;
    readonly from: string;
    readonly to: string;
  }): Promise<WriteResult> {
    const marker = operationMarker(command.operationId);
    const { operationId, ...intent } = command;
    const opened = this.open({
      operationId,
      kind: "create_transfer_request_draft",
      target: { doctype: "Stock Entry", name: null },
      intent: { kind: "create_transfer_request_draft", ...intent },
      expectedModified: null,
      marker,
    });
    if ("outcome" in opened) return opened;
    const quantity = Number(command.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || command.from === command.to) {
      return this.refuseLocally(
        opened,
        "business_validation",
        "invalid transfer request; nothing sent",
      );
    }
    const { record, outcome } = await this.dispatch(opened, {
      method: "POST",
      path: resourcePath("Stock Entry"),
      body: {
        docstatus: 0,
        stock_entry_type: "Material Transfer",
        company: command.company,
        remarks: `${marker} transfer request draft; not a dispatch or receipt`,
        items: [
          {
            item_code: command.sku,
            qty: quantity,
            uom: command.stockUom,
            stock_uom: command.stockUom,
            conversion_factor: 1,
            s_warehouse: command.from,
            t_warehouse: command.to,
          },
        ],
      },
    });
    if (outcome.kind === "refused") return { outcome: "recorded", record };
    const created =
      outcome.kind === "ok"
        ? (outcome.body as { data?: { name?: unknown } } | null)?.data?.name
        : undefined;
    return {
      outcome: "recorded",
      record: await this.verify(record, typeof created === "string" ? created : undefined),
    };
  }

  /** Records an operation that has no safe native path; no request is sent. */
  unsupported(command: {
    readonly operationId: string;
    readonly kind: UnsupportedKind;
    readonly target: ConnectorOperationRecord["target"];
  }): WriteResult {
    const opened = this.open({
      operationId: command.operationId,
      kind: command.kind,
      target: command.target,
      intent: { kind: "not_sent" },
      expectedModified: null,
      marker: null,
    });
    if ("outcome" in opened) return opened;
    const { disposition, reason } = UNSUPPORTED_OPERATIONS[command.kind];
    const record = {
      ...opened,
      state: "unsupported" as const,
      history: [this.event("unsupported", `${disposition}: ${reason}`)],
    };
    this.journal.put(record);
    return { outcome: "recorded", record };
  }

  /**
   * Reads the source again for an operation whose outcome is unknown, for
   * example after a lost response or a restart. It never sends a write.
   */
  async reconcile(operationId: string): Promise<ConnectorOperationRecord | undefined> {
    const record = this.journal.get(operationId);
    // A `dispatching` record was journalled as sent before its request, so a
    // process stop leaves it as uncertain as an unknown one.
    if (!record || (record.state !== "unknown" && record.state !== "dispatching")) return record;
    return this.verify(record, record.nativeName ?? undefined);
  }

  private async verify(
    record: ConnectorOperationRecord,
    createdName?: string,
  ): Promise<ConnectorOperationRecord> {
    const intent = record.intent;
    if (intent.kind === "update_schedule_date") return this.verifySchedule(record, intent);
    if (intent.kind === "create_transfer_request_draft") {
      return this.verifyTransfer(record, intent, createdName);
    }
    return record;
  }

  private unverified(record: ConnectorOperationRecord, note: string): ConnectorOperationRecord {
    return this.transition(record, "unknown", note);
  }

  private async verifySchedule(
    record: ConnectorOperationRecord,
    intent: Extract<ConnectorOperationIntent, { kind: "update_schedule_date" }>,
  ): Promise<ConnectorOperationRecord> {
    const read = await this.readBack.purchaseOrder(record.target.name ?? "");
    if (read.kind !== "ok") return this.unverified(record, `read-back unavailable: ${read.kind}`);
    const po = read.value.record;
    const rows = new Map(po.lines.map((line) => [line.rowId, line]));
    const matches =
      po.ref.docstatus === 1 &&
      rows.size === intent.rowsAfter.length &&
      intent.rowsAfter.every((expected) => {
        const actual = rows.get(expected.rowId);
        return (
          actual !== undefined &&
          actual.sku === expected.sku &&
          actual.ordered === expected.ordered &&
          actual.received === expected.received &&
          actual.scheduleDate === expected.scheduleDate
        );
      });
    const observed = { observedModified: po.ref.modified, nativeName: po.ref.name };
    if (po.ref.modified === record.expectedModified) {
      // An untouched token after an uncertain request is not proof that no
      // effect will follow, so the operation stays unknown.
      return this.unverified(record, "read-back: source token unchanged, effect not observed");
    }
    if (matches) {
      return this.transition(record, "applied", "read-back matches the intended rows", observed);
    }
    return this.transition(
      record,
      "manual_reconciliation",
      "read-back: the purchase order changed but does not match the intended rows",
      observed,
    );
  }

  private async verifyTransfer(
    record: ConnectorOperationRecord,
    intent: Extract<ConnectorOperationIntent, { kind: "create_transfer_request_draft" }>,
    createdName?: string,
  ): Promise<ConnectorOperationRecord> {
    const marker = record.marker ?? "";
    let name = createdName;
    if (name === undefined) {
      const found = await this.readBack.stockEntriesByMarker(marker);
      if (found.kind !== "ok")
        return this.unverified(record, `marker search unavailable: ${found.kind}`);
      const candidates = found.value.filter((entry) => hasMarker(entry.remarks, marker));
      if (candidates.length === 0) {
        return this.unverified(
          record,
          "no record carries the marker; absence after an uncertain request is not proof of no effect",
        );
      }
      if (candidates.length > 1) {
        return this.transition(
          record,
          "manual_reconciliation",
          `${candidates.length} records carry the marker: ${candidates.map((entry) => entry.name).join(", ")}`,
        );
      }
      name = candidates[0]!.name;
    }
    const read = await this.readBack.stockEntry(name);
    if (read.kind !== "ok") return this.unverified(record, `read-back unavailable: ${read.kind}`);
    const doc = read.value;
    const row = doc.items.length === 1 ? doc.items[0] : undefined;
    const matches =
      row !== undefined &&
      doc.docstatus === 0 &&
      doc.stock_entry_type === "Material Transfer" &&
      doc.company === intent.company &&
      hasMarker(doc.remarks ?? "", marker) &&
      row.item_code === intent.sku &&
      row.uom === intent.stockUom &&
      wholeQuantity(row.qty) === intent.quantity &&
      row.conversion_factor === 1 &&
      row.s_warehouse === intent.from &&
      row.t_warehouse === intent.to;
    const observed = { observedModified: doc.modified, nativeName: doc.name };
    return matches
      ? this.transition(record, "applied", "read-back matches the intended draft", observed)
      : this.transition(
          record,
          "manual_reconciliation",
          "read-back: the marked record does not match the intended draft",
          observed,
        );
  }
}
