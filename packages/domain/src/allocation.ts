import type { SupplyRef } from "@supplier-disruption/contracts";
import { arrivesBy } from "./calendar.js";
import { compareText } from "./eligibility.js";
import { min } from "./quantity.js";

export interface DemandInput {
  salesOrder: string;
  line: string;
  priority: number;
  open: bigint;
  destination: string;
  receiptCutoff: string;
}

export interface SupplyInput {
  /** Stable identity used for tie detection and bookkeeping. */
  key: string;
  supply: SupplyRef;
  destination: string;
  quantity: bigint;
  /** Null for present stock, which is available now. */
  arrival: { state: "dated"; date: string } | { state: "undated" } | null;
}

export interface AllocationEntry {
  salesOrder: string;
  line: string;
  supplyKey: string;
  supply: SupplyRef;
  quantity: bigint;
}

export interface AllocationRun {
  allocations: AllocationEntry[];
  /** Covered quantity per demand line key. */
  covered: Map<string, bigint>;
  /** Allocated quantity per supply key. */
  used: Map<string, bigint>;
}

/** Which identity orders to reverse inside ties. */
export interface TieOrder {
  lines: boolean;
  supply: boolean;
}

/** The identity order and every combination of reversed line and supply ties. */
export const TIE_ORDERS: readonly TieOrder[] = [
  { lines: false, supply: false },
  { lines: true, supply: false },
  { lines: false, supply: true },
  { lines: true, supply: true },
];

export const lineKey = (line: { salesOrder: string; line: string }) =>
  `${line.salesOrder}/${line.line}`;

/**
 * ALLOC-1@1. Demand lines in ascending numeric priority; for each line,
 * present eligible stock at its destination, then on-time inbound by earliest
 * arrival. Every supply unit covers at most one demand unit across the whole
 * run. `ties` reverses the identity order inside equal priorities (`lines`)
 * and inside equal arrivals (`supply`) independently, so a caller can detect
 * when either tie, or both together, change the outcome.
 * Confirmed transfers are the third stage; a quote is not one, so none enter here.
 */
export function allocate(
  demand: readonly DemandInput[],
  supply: readonly SupplyInput[],
  ties: TieOrder,
): AllocationRun {
  const lineTie = (comparison: number) => (ties.lines ? -comparison : comparison);
  const supplyTie = (comparison: number) => (ties.supply ? -comparison : comparison);
  const lines = [...demand].sort(
    (a, b) => a.priority - b.priority || lineTie(compareText(lineKey(a), lineKey(b))),
  );
  const stock = supply.filter((item) => item.arrival === null);
  const inbound = supply
    .filter((item) => item.arrival !== null)
    .sort((a, b) => {
      const dateA = a.arrival?.state === "dated" ? a.arrival.date : "";
      const dateB = b.arrival?.state === "dated" ? b.arrival.date : "";
      return compareText(dateA, dateB) || supplyTie(compareText(a.key, b.key));
    });
  const used = new Map<string, bigint>(supply.map((item) => [item.key, 0n]));
  const covered = new Map<string, bigint>();
  const allocations: AllocationEntry[] = [];

  for (const line of lines) {
    let remaining = line.open;
    const candidates = [
      ...stock.filter((item) => item.destination === line.destination),
      ...inbound.filter(
        (item) =>
          item.destination === line.destination &&
          item.arrival !== null &&
          arrivesBy(item.arrival, line.receiptCutoff),
      ),
    ];
    for (const item of candidates) {
      if (remaining === 0n) break;
      const free = item.quantity - (used.get(item.key) ?? 0n);
      const take = min(free, remaining);
      if (take === 0n) continue;
      used.set(item.key, (used.get(item.key) ?? 0n) + take);
      remaining -= take;
      allocations.push({
        salesOrder: line.salesOrder,
        line: line.line,
        supplyKey: item.key,
        supply: item.supply,
        quantity: take,
      });
    }
    covered.set(lineKey(line), line.open - remaining);
  }
  return { allocations, covered, used };
}

/** Whether two runs assign the same supply to the same lines in the same quantities. */
export function sameOutcome(a: AllocationRun, b: AllocationRun): boolean {
  const normal = (run: AllocationRun) =>
    run.allocations
      .map((entry) => `${entry.salesOrder}/${entry.line}|${entry.supplyKey}|${entry.quantity}`)
      .sort()
      .join("\n");
  return normal(a) === normal(b);
}
