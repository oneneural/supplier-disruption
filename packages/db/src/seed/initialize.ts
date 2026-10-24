import { createHash } from "node:crypto";
import { canonicalJson } from "@supplier-disruption/contracts";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { initializeDemand, initializeDemandHeads } from "../authorities/demand/initialize.js";
import {
  initializeInventory,
  initializeInventoryHeads,
} from "../authorities/inventory/initialize.js";
import {
  initializePurchasing,
  initializePurchasingHeads,
} from "../authorities/purchasing/initialize.js";
import { initializeReference } from "../authorities/reference/initialize.js";
import { seedMarker } from "../authorities/reference/schema.js";
import { CANONICAL_MANIFEST, FROZEN_ORACLE_SHA256, type CanonicalManifest } from "./canonical.js";

/** Serializes seed runs for this database, across processes. */
export const SEED_LOCK_KEY = "supplier-disruption:seed";

/**
 * Every canonical input table, the current-version heads initialized from
 * them and the source runtime tables. With no seed marker, a row in any of
 * them is colliding partial data and stops the seed.
 */
const CANONICAL_TABLES = [
  "fixture_reference.organization_alias",
  "fixture_reference.vendor",
  "fixture_reference.vendor_contact",
  "fixture_reference.item",
  "fixture_reference.item_mapping",
  "fixture_reference.actor",
  "fixture_reference.policy",
  "fixture_reference.supplier_input",
  "fixture_reference.scenario_timing",
  "fixture_reference.business_clock",
  "fixture_purchasing.po_revision",
  "fixture_purchasing.po_line",
  "fixture_purchasing.po_line_segment",
  "fixture_purchasing.po_head",
  "fixture_purchasing.operation",
  "fixture_purchasing.operation_receipt",
  "fixture_inventory.stock_snapshot",
  "fixture_inventory.reservation",
  "fixture_inventory.transfer_option",
  "fixture_inventory.in_transit",
  "fixture_inventory.stock_head",
  "fixture_inventory.operation",
  "fixture_inventory.operation_receipt",
  "fixture_inventory.transfer_request",
  "fixture_demand.demand_snapshot",
  "fixture_demand.demand_line",
  "fixture_demand.supply_link",
  "fixture_demand.demand_head",
] as const;

/** SHA-256 of the manifest's canonical JSON, recorded in the seed marker. */
export function manifestSha256(manifest: CanonicalManifest = CANONICAL_MANIFEST): string {
  return createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
}

/** The database holds a marker or data this seed did not write; nothing was changed. */
export class CanonicalSeedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalSeedConflictError";
  }
}

export type CanonicalSeedStatus = "initialized" | "present";

/**
 * Initializes the canonical inputs and the seed marker in one transaction
 * under the seed advisory lock. A matching marker makes this a no-op, so
 * advanced clock and source state survive a rerun. A different marker, or
 * input rows without a marker, fail without repair. Any failure rolls back the
 * inputs and the marker together. Runs as the migrator role.
 */
export async function initializeCanonicalInputs(
  db: NodePgDatabase,
  manifest: CanonicalManifest = CANONICAL_MANIFEST,
): Promise<CanonicalSeedStatus> {
  const digest = manifestSha256(manifest);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SEED_LOCK_KEY}))`);
    const [marker] = await tx.select().from(seedMarker);
    if (marker !== undefined) {
      if (
        marker.fixtureVersion === manifest.fixtureVersion &&
        marker.manifestSha256 === digest &&
        marker.oracleSha256 === FROZEN_ORACLE_SHA256
      ) {
        return "present";
      }
      throw new CanonicalSeedConflictError(
        `seed marker ${marker.fixtureVersion} (manifest ${marker.manifestSha256}, oracle ${marker.oracleSha256}) ` +
          `does not match ${manifest.fixtureVersion} (manifest ${digest}, oracle ${FROZEN_ORACLE_SHA256}); ` +
          "recreate the database to change canonical inputs",
      );
    }
    const occupied: string[] = [];
    for (const table of CANONICAL_TABLES) {
      const result = await tx.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM ${table}) AS present`));
      if ((result.rows[0] as { present: boolean } | undefined)?.present === true) {
        occupied.push(table);
      }
    }
    if (occupied.length > 0) {
      throw new CanonicalSeedConflictError(
        `canonical input tables hold rows without a seed marker: ${occupied.join(", ")}; refusing to repair`,
      );
    }
    await initializeReference(tx, manifest.reference);
    await initializePurchasing(tx, manifest.purchasing.orders);
    await initializeInventory(tx, manifest.inventory);
    await initializeDemand(tx, manifest.demand.snapshots);
    await initializePurchasingHeads(tx);
    await initializeInventoryHeads(tx);
    await initializeDemandHeads(tx);
    // Last, so a marker exists only when every input above was written.
    await tx.insert(seedMarker).values({
      id: 1,
      fixtureVersion: manifest.fixtureVersion,
      manifestSha256: digest,
      oracleSha256: FROZEN_ORACLE_SHA256,
    });
    return "initialized";
  });
}
