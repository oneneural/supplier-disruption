import type { ItemMapping } from "@supplier-disruption/contracts";
import { parseQuantity } from "./quantity.js";
import { REASONS } from "./reasons.js";

export interface MappingQuery {
  vendorId: string;
  vendorItem: string;
  sourceUom: string;
  sku: string;
  stockUom: string;
  /** The business date the mapping must be effective on (ADR 0007: the assessment date). */
  onDate: string;
}

export type MappingOutcome =
  { ok: true; mapping: ItemMapping } | { ok: false; reason: string; detail: string };

/**
 * The single item-master mapping effective on the date for exactly this
 * vendor, vendor item, stated unit, SKU and stock unit. Dates are inclusive.
 * No mapping means no conversion: nothing is guessed, and an expired mapping
 * is never used. Two effective mappings are ambiguous, not a choice.
 */
export function selectMapping(
  records: readonly ItemMapping[],
  query: MappingQuery,
): MappingOutcome {
  const effective = records.filter(
    (mapping) =>
      mapping.vendorId === query.vendorId &&
      mapping.vendorItem === query.vendorItem &&
      mapping.sourceUom === query.sourceUom &&
      mapping.sku === query.sku &&
      mapping.stockUom === query.stockUom &&
      mapping.effectiveFrom <= query.onDate &&
      (mapping.effectiveThrough === null || query.onDate <= mapping.effectiveThrough),
  );
  const [only] = effective;
  if (only === undefined) {
    return {
      ok: false,
      reason: REASONS.uomConversionUnavailable,
      detail: `no ${query.vendorItem} ${query.sourceUom} to ${query.sku} ${query.stockUom} mapping is effective on ${query.onDate}`,
    };
  }
  if (effective.length > 1) {
    return {
      ok: false,
      reason: REASONS.mappingAmbiguous,
      detail: `${effective.length} mappings are effective on ${query.onDate}`,
    };
  }
  return { ok: true, mapping: only };
}

/**
 * Converts a source quantity to stock units with the mapping's exact ratio.
 * Returns null when the result is not a whole number of stock units.
 */
export function convertQuantity(quantity: string, mapping: ItemMapping): bigint | null {
  const product = parseQuantity(quantity) * BigInt(mapping.ratio.numerator);
  const denominator = BigInt(mapping.ratio.denominator);
  return product % denominator === 0n ? product / denominator : null;
}
