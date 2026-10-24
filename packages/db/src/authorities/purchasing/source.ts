import { randomUUID } from "node:crypto";
import {
  DOMAIN_CONTRACT_VERSION,
  amendScheduleCommandSchema,
  amendScheduleReceiptSchema,
  purchaseOrderRevisionSchema,
  revisionSchema,
  type AmendScheduleCommand,
  type AmendScheduleReceipt,
  type Instant,
  type PurchaseOrderRevision,
} from "@supplier-disruption/contracts";
import type pg from "pg";
import {
  SourceRejectedError,
  claimOperation,
  readTransaction,
  requestDigest,
  writeTransaction,
  type SourceOptions,
  type SourceWriteResult,
} from "../runtime.js";
import { instantFromPostgres, knownFromColumn } from "../values.js";

/** A PO revision as read, with the current revision and the business time of the read. */
export interface PurchaseOrderRead {
  readAt: Instant;
  currentRevision: string;
  record: PurchaseOrderRevision;
}

/**
 * An operation's native receipt and the records it affected as they are now:
 * the successor revision's current rows and the PO's current revision. A
 * receipt is not a business acknowledgement or proof that records still match.
 */
export interface PurchasingOperationLookup {
  readAt: Instant;
  receipt: AmendScheduleReceipt;
  currentRevision: string;
  effect: PurchaseOrderRevision;
}

export interface PurchasingSource {
  /** The current revision, or a specific retained one. */
  readPurchaseOrder(query: {
    organization: string;
    poNumber: string;
    revision?: string;
  }): Promise<PurchaseOrderRead>;
  /** Conditional amendment of one line's outstanding schedule; see ADR 0005. */
  amendSchedule(command: AmendScheduleCommand): Promise<SourceWriteResult<AmendScheduleReceipt>>;
  /** Null when no committed operation has this ID. Absence alone never proves no effect. */
  lookupOperation(query: {
    organization: string;
    operationId: string;
  }): Promise<PurchasingOperationLookup | null>;
}

const reject = (reason: ConstructorParameters<typeof SourceRejectedError>[1], message: string) =>
  new SourceRejectedError("purchasing", reason, message);

async function currentRevision(
  client: pg.PoolClient,
  organization: string,
  poNumber: string,
  lock: boolean,
): Promise<number> {
  const { rows } = await client.query<{ revision: number }>(
    `SELECT revision FROM fixture_purchasing.po_head
      WHERE po_number = $1 AND organization = $2${lock ? " FOR UPDATE" : ""}`,
    [poNumber, organization],
  );
  const [head] = rows;
  if (head === undefined) {
    throw reject("source.not_found", `${organization} has no purchase order ${poNumber}`);
  }
  return head.revision;
}

async function loadRevision(
  client: pg.PoolClient,
  organization: string,
  poNumber: string,
  revision: number,
): Promise<PurchaseOrderRevision | null> {
  const { rows: headers } = await client.query<{
    vendor_id: string;
    observed_at: string | null;
    effective_date: string | null;
  }>(
    `SELECT vendor_id, observed_at::text AS observed_at, effective_date::text AS effective_date
       FROM fixture_purchasing.po_revision
      WHERE po_number = $1 AND revision = $2 AND organization = $3`,
    [poNumber, revision, organization],
  );
  const [header] = headers;
  if (header === undefined) return null;
  const { rows: lines } = await client.query<{
    line_number: string;
    sku: string;
    uom: string;
    destination: string;
    ordered: string;
    received: string;
    canceled: string;
  }>(
    `SELECT line_number, sku, uom, destination, ordered::text AS ordered,
            received::text AS received, canceled::text AS canceled
       FROM fixture_purchasing.po_line
      WHERE po_number = $1 AND revision = $2 ORDER BY line_number`,
    [poNumber, revision],
  );
  const { rows: segments } = await client.query<{
    line_number: string;
    sequence: number;
    quantity: string;
    arrival_date: string | null;
  }>(
    `SELECT line_number, sequence, quantity::text AS quantity, arrival_date::text AS arrival_date
       FROM fixture_purchasing.po_line_segment
      WHERE po_number = $1 AND revision = $2 ORDER BY line_number, sequence`,
    [poNumber, revision],
  );
  return purchaseOrderRevisionSchema.parse({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    organization,
    poNumber,
    revision: String(revision),
    vendorId: header.vendor_id,
    observedAt: knownFromColumn(
      header.observed_at === null ? null : instantFromPostgres(header.observed_at),
    ),
    effectiveDate: knownFromColumn(header.effective_date),
    lines: lines.map((line) => ({
      lineNumber: line.line_number,
      sku: line.sku,
      uom: line.uom,
      destination: line.destination,
      ordered: line.ordered,
      received: line.received,
      canceled: line.canceled,
      acceptedSegments: segments
        .filter((segment) => segment.line_number === line.line_number)
        .map((segment) => ({
          sequence: segment.sequence,
          quantity: segment.quantity,
          arrival:
            segment.arrival_date === null
              ? { state: "undated" as const }
              : { state: "dated" as const, date: segment.arrival_date },
        })),
    })),
  });
}

async function loadReceipt(
  client: pg.PoolClient,
  organization: string,
  operationId: string,
): Promise<AmendScheduleReceipt | null> {
  const { rows } = await client.query<{
    receipt_id: string;
    request_digest: string;
    plan_id: string;
    action_id: string;
    po_number: string;
    line_number: string;
    prior_revision: number;
    successor_revision: number;
    recorded_at: string;
  }>(
    `SELECT r.receipt_id, o.request_digest, r.plan_id, r.action_id, r.po_number, r.line_number,
            r.prior_revision, r.successor_revision, r.recorded_at::text AS recorded_at
       FROM fixture_purchasing.operation_receipt r
       JOIN fixture_purchasing.operation o USING (organization, operation_id)
      WHERE r.organization = $1 AND r.operation_id = $2`,
    [organization, operationId],
  );
  const [row] = rows;
  if (row === undefined) return null;
  return amendScheduleReceiptSchema.parse({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    kind: "amend_schedule",
    receiptId: row.receipt_id,
    organization,
    operationId,
    requestDigest: row.request_digest,
    planId: row.plan_id,
    actionId: row.action_id,
    poNumber: row.po_number,
    poLine: row.line_number,
    priorRevision: String(row.prior_revision),
    successorRevision: String(row.successor_revision),
    recordedAt: instantFromPostgres(row.recorded_at),
  });
}

/**
 * The fixture purchasing authority's runtime module. Each method runs in its
 * own transaction on its own pooled connection; see ADR 0005.
 */
export function createPurchasingSource(options: SourceOptions): PurchasingSource {
  return {
    async readPurchaseOrder(query) {
      const readAt = await options.clock.now();
      return readTransaction(options, async (client) => {
        const current = await currentRevision(client, query.organization, query.poNumber, false);
        const revision =
          query.revision === undefined ? current : Number(revisionSchema.parse(query.revision));
        const record = await loadRevision(client, query.organization, query.poNumber, revision);
        if (record === null) {
          throw reject(
            "source.not_found",
            `${query.poNumber} has no revision ${String(query.revision)}`,
          );
        }
        return { readAt, currentRevision: String(current), record };
      });
    },

    async amendSchedule(input) {
      const command = amendScheduleCommandSchema.parse(input);
      const digest = requestDigest(command);
      return writeTransaction(options, async (client) => {
        const claim = await claimOperation(client, "purchasing", "fixture_purchasing.operation", {
          organization: command.organization,
          operationId: command.operationId,
          kind: command.kind,
          digest,
        });
        if (claim === "replay") {
          const receipt = await loadReceipt(client, command.organization, command.operationId);
          if (receipt === null) throw new Error(`operation ${command.operationId} has no receipt`);
          return { replayed: true, receipt };
        }

        // Lock order: operation identity (above), then the PO head.
        const base = await currentRevision(client, command.organization, command.poNumber, true);
        if (String(base) !== command.expectedRevision) {
          throw reject(
            "stale_base_revision",
            `${command.poNumber} is at revision ${base}, not ${command.expectedRevision}`,
          );
        }
        // Business time of the accepted change, sampled while the head is held.
        const recordedAt = await options.clock.now();
        const { rows: lines } = await client.query<{
          uom: string;
          ordered: string;
          received: string;
          canceled: string;
        }>(
          `SELECT uom, ordered::text AS ordered, received::text AS received, canceled::text AS canceled
             FROM fixture_purchasing.po_line
            WHERE po_number = $1 AND revision = $2 AND line_number = $3`,
          [command.poNumber, base, command.poLine],
        );
        const [line] = lines;
        if (line === undefined) {
          throw reject(
            "purchasing.unknown_po_line",
            `${command.poNumber}@${base} has no line ${command.poLine}`,
          );
        }
        if (line.uom !== command.uom) {
          throw reject("source.uom_mismatch", `line is in ${line.uom}, not ${command.uom}`);
        }
        const outstanding = BigInt(line.ordered) - BigInt(line.received) - BigInt(line.canceled);
        const scheduled = command.segments.reduce(
          (total, segment) => total + BigInt(segment.quantity),
          0n,
        );
        if (scheduled !== outstanding) {
          throw reject(
            "purchasing.schedule_quantity_mismatch",
            `segments total ${scheduled}, outstanding is ${outstanding}`,
          );
        }

        // Append the successor revision; the base revision stays as history.
        const successor = base + 1;
        const keys = [command.poNumber, base, successor];
        await client.query(
          `INSERT INTO fixture_purchasing.po_revision
             (po_number, revision, organization, vendor_id, observed_at, effective_date)
           SELECT po_number, $3, organization, vendor_id, observed_at, effective_date
             FROM fixture_purchasing.po_revision WHERE po_number = $1 AND revision = $2`,
          keys,
        );
        await client.query(
          `INSERT INTO fixture_purchasing.po_line
             (po_number, revision, line_number, sku, uom, destination, ordered, received, canceled)
           SELECT po_number, $3, line_number, sku, uom, destination, ordered, received, canceled
             FROM fixture_purchasing.po_line WHERE po_number = $1 AND revision = $2`,
          keys,
        );
        await client.query(
          `INSERT INTO fixture_purchasing.po_line_segment
             (po_number, revision, line_number, sequence, quantity, arrival_date)
           SELECT po_number, $3, line_number, sequence, quantity, arrival_date
             FROM fixture_purchasing.po_line_segment
            WHERE po_number = $1 AND revision = $2 AND line_number <> $4`,
          [...keys, command.poLine],
        );
        for (const segment of command.segments) {
          await client.query(
            `INSERT INTO fixture_purchasing.po_line_segment
               (po_number, revision, line_number, sequence, quantity, arrival_date)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              command.poNumber,
              successor,
              command.poLine,
              segment.sequence,
              segment.quantity,
              segment.arrival.state === "dated" ? segment.arrival.date : null,
            ],
          );
        }
        // Compare-and-set: the head moves only from the base this transaction checked.
        const moved = await client.query(
          `UPDATE fixture_purchasing.po_head SET revision = $4
            WHERE po_number = $1 AND organization = $2 AND revision = $3`,
          [command.poNumber, command.organization, base, successor],
        );
        if (moved.rowCount !== 1) {
          throw new Error(
            `${command.poNumber} head moved from revision ${base} during the amendment`,
          );
        }
        await client.query(
          `INSERT INTO fixture_purchasing.operation_receipt
             (receipt_id, organization, operation_id, plan_id, action_id, po_number, line_number,
              prior_revision, successor_revision, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            command.organization,
            command.operationId,
            command.planId,
            command.actionId,
            command.poNumber,
            command.poLine,
            base,
            successor,
            recordedAt,
          ],
        );
        const receipt = await loadReceipt(client, command.organization, command.operationId);
        if (receipt === null) throw new Error(`operation ${command.operationId} has no receipt`);
        return { replayed: false, receipt };
      });
    },

    async lookupOperation(query) {
      const readAt = await options.clock.now();
      return readTransaction(options, async (client) => {
        const receipt = await loadReceipt(client, query.organization, query.operationId);
        if (receipt === null) return null;
        const current = await currentRevision(client, query.organization, receipt.poNumber, false);
        const effect = await loadRevision(
          client,
          query.organization,
          receipt.poNumber,
          Number(receipt.successorRevision),
        );
        if (effect === null) {
          throw new Error(`receipt ${receipt.receiptId} names a missing revision`);
        }
        return { readAt, receipt, currentRevision: String(current), effect };
      });
    },
  };
}
