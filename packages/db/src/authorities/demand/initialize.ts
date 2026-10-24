import { demandSnapshotSchema, type DemandSnapshot } from "@supplier-disruption/contracts";
import { sql } from "drizzle-orm";
import type { InitTransaction } from "../columns.js";
import { AmbiguousCurrentVersionError, knownOrNull } from "../values.js";
import { demandLine, demandSnapshot, supplyLink } from "./schema.js";

/** Initialization only: inserts demand snapshots, lines and supply links. */
export async function initializeDemand(
  tx: InitTransaction,
  snapshots: readonly DemandSnapshot[],
): Promise<void> {
  for (const input of snapshots) {
    const snapshot = demandSnapshotSchema.parse(input);
    await tx.insert(demandSnapshot).values({
      version: snapshot.version,
      organization: snapshot.organization,
      observedAt: knownOrNull(snapshot.observedAt, (value) => value),
    });
    for (const line of snapshot.lines) {
      await tx.insert(demandLine).values({
        version: snapshot.version,
        salesOrder: line.salesOrder,
        line: line.line,
        sku: line.sku,
        uom: line.uom,
        open: line.open,
        delivered: knownOrNull(line.delivered, (value) => value),
        destination: line.destination,
        receiptCutoff: line.receiptCutoff,
        calendarPolicyId: line.calendar.policyId,
        calendarPolicyVersion: line.calendar.version,
        priority: line.priority,
      });
      for (const link of line.supplyLinks) {
        await tx.insert(supplyLink).values({
          version: snapshot.version,
          salesOrder: line.salesOrder,
          line: line.line,
          poNumber: link.poNumber,
          poLine: link.poLine,
        });
      }
    }
  }
}

/**
 * Initialization only: makes each organization's single demand snapshot
 * current. Several snapshots have no stated current version and fail; the
 * order system names a later current version explicitly. Migration 0003
 * applies the same rule.
 */
export async function initializeDemandHeads(tx: InitTransaction): Promise<void> {
  const ambiguous = await tx.execute(sql`
    SELECT organization FROM fixture_demand.demand_snapshot
     GROUP BY organization HAVING count(*) > 1`);
  if (ambiguous.rows.length > 0) {
    throw new AmbiguousCurrentVersionError(
      `several demand snapshots without a stated current version: ${JSON.stringify(ambiguous.rows)}`,
    );
  }
  await tx.execute(sql`
    INSERT INTO fixture_demand.demand_head (organization, version)
    SELECT organization, version FROM fixture_demand.demand_snapshot`);
}
