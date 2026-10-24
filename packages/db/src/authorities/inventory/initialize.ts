import {
  inTransitRecordSchema,
  stockSnapshotSchema,
  transferOptionSchema,
  type InTransitRecord,
  type StockSnapshot,
  type TransferOption,
} from "@supplier-disruption/contracts";
import { sql } from "drizzle-orm";
import type { InitTransaction } from "../columns.js";
import { AmbiguousCurrentVersionError, knownOrNull } from "../values.js";
import { inTransit, reservation, stockSnapshot, transferOption } from "./schema.js";

export interface InventoryInputs {
  snapshots: readonly StockSnapshot[];
  transferOptions: readonly TransferOption[];
  inTransit: readonly InTransitRecord[];
}

/** Initialization only: inserts stock snapshots, options and transit records. */
export async function initializeInventory(
  tx: InitTransaction,
  inputs: InventoryInputs,
): Promise<void> {
  for (const input of inputs.snapshots) {
    const snapshot = stockSnapshotSchema.parse(input);
    await tx.insert(stockSnapshot).values({
      version: snapshot.version,
      organization: snapshot.organization,
      sku: snapshot.sku,
      warehouse: snapshot.warehouse,
      uom: snapshot.uom,
      observedAt: knownOrNull(snapshot.observedAt, (value) => value),
      physical: snapshot.physical,
      qualityHold: snapshot.qualityHold,
      safetyStock: snapshot.safetyStock,
    });
    for (const held of snapshot.reservations) {
      await tx.insert(reservation).values({
        snapshotVersion: snapshot.version,
        reservationId: held.reservationId,
        quantity: held.quantity,
        planId: held.binding.kind === "plan" ? held.binding.planId : null,
      });
    }
  }
  for (const input of inputs.transferOptions) {
    const option = transferOptionSchema.parse(input);
    await tx.insert(transferOption).values({
      optionId: option.optionId,
      sku: option.sku,
      uom: option.uom,
      fromWarehouse: option.from,
      toWarehouse: option.to,
      quantity: option.quantity,
      dispatchDate: option.dispatchDate,
      arrivalDate: option.arrivalDate,
      costMinorUnits: option.cost.minorUnits,
      currency: option.cost.currency,
      validUntil: option.validUntil,
      basedOn: option.basedOn,
      ownerRole: option.owner,
    });
  }
  for (const input of inputs.inTransit) {
    const record = inTransitRecordSchema.parse(input);
    await tx.insert(inTransit).values({
      transitId: record.transitId,
      sku: record.sku,
      uom: record.uom,
      fromWarehouse: record.from,
      toWarehouse: record.to,
      quantity: record.quantity,
      dispatchedOn: knownOrNull(record.dispatchedOn, (value) => value),
      arrivalDate: record.arrival.state === "dated" ? record.arrival.date : null,
    });
  }
}

/**
 * Initialization only: makes the single stock snapshot of each SKU at each
 * warehouse current. Several snapshots for one SKU and warehouse have no
 * stated current version and fail. Migration 0003 applies the same rule.
 */
export async function initializeInventoryHeads(tx: InitTransaction): Promise<void> {
  const ambiguous = await tx.execute(sql`
    SELECT organization, sku, warehouse FROM fixture_inventory.stock_snapshot
     GROUP BY organization, sku, warehouse HAVING count(*) > 1`);
  if (ambiguous.rows.length > 0) {
    throw new AmbiguousCurrentVersionError(
      `several stock snapshots without a stated current version: ${JSON.stringify(ambiguous.rows)}`,
    );
  }
  await tx.execute(sql`
    INSERT INTO fixture_inventory.stock_head (organization, sku, warehouse, version)
    SELECT organization, sku, warehouse, version FROM fixture_inventory.stock_snapshot`);
}
