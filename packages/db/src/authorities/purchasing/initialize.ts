import {
  purchaseOrderRevisionSchema,
  type PurchaseOrderRevision,
} from "@supplier-disruption/contracts";
import { sql } from "drizzle-orm";
import type { InitTransaction } from "../columns.js";
import { knownOrNull } from "../values.js";
import { poLine, poLineSegment, poRevision } from "./schema.js";

/** Initialization only: inserts accepted PO revisions. Fails on any existing row. */
export async function initializePurchasing(
  tx: InitTransaction,
  orders: readonly PurchaseOrderRevision[],
): Promise<void> {
  for (const input of orders) {
    const order = purchaseOrderRevisionSchema.parse(input);
    const revision = Number(order.revision);
    await tx.insert(poRevision).values({
      poNumber: order.poNumber,
      revision,
      organization: order.organization,
      vendorId: order.vendorId,
      observedAt: knownOrNull(order.observedAt, (value) => value),
      effectiveDate: knownOrNull(order.effectiveDate, (value) => value),
    });
    for (const line of order.lines) {
      await tx.insert(poLine).values({
        poNumber: order.poNumber,
        revision,
        lineNumber: line.lineNumber,
        sku: line.sku,
        uom: line.uom,
        destination: line.destination,
        ordered: line.ordered,
        received: line.received,
        canceled: line.canceled,
      });
      for (const segment of line.acceptedSegments) {
        await tx.insert(poLineSegment).values({
          poNumber: order.poNumber,
          revision,
          lineNumber: line.lineNumber,
          sequence: segment.sequence,
          quantity: segment.quantity,
          arrivalDate: segment.arrival.state === "dated" ? segment.arrival.date : null,
        });
      }
    }
  }
}

/**
 * Initialization only: makes each PO's highest revision current. Revisions
 * are the source's own integer order, so the choice is unambiguous. Migration
 * 0003 applies the same rule to databases seeded before heads existed.
 */
export async function initializePurchasingHeads(tx: InitTransaction): Promise<void> {
  await tx.execute(sql`
    INSERT INTO fixture_purchasing.po_head (po_number, organization, revision)
    SELECT DISTINCT ON (po_number) po_number, organization, revision
      FROM fixture_purchasing.po_revision
     ORDER BY po_number, revision DESC`);
}
