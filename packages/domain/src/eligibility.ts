import type { StockSnapshot } from "@supplier-disruption/contracts";
import { formatQuantity, parseQuantity, sum } from "./quantity.js";
import { REASONS } from "./reasons.js";

export interface Eligibility {
  warehouse: string;
  stockVersion: string;
  uom: string;
  physical: string;
  qualityHold: string;
  safetyStock: string;
  unrelatedReservations: Array<{ reservationId: string; quantity: string }>;
  /** Present only when a predecessor plan's commitments hold stock here. */
  commitmentReservations?: Array<{ reservationId: string; planId: string; quantity: string }>;
  eligible: string;
}

/** A reservation a named predecessor plan made for one of its transfer commitments. */
export interface CommitmentReservation {
  reservationId: string;
  planId: string;
  quantity: string;
}

export type EligibilityOutcome =
  { ok: true; value: Eligibility } | { ok: false; reason: string; detail: string };

/**
 * ELIG-1@1: physical minus quality holds, safety stock and each unrelated
 * reservation once. Inbound and in-transit quantities are not inputs, so they
 * can neither add to nor be subtracted from a snapshot. Reservations are read,
 * never changed. A plan-bound reservation, a repeated reservation ID or
 * deductions beyond physical stock are inconsistent input: the snapshot is
 * refused rather than clamped to zero.
 *
 * The one exception (ADR 0015): a reservation of a named predecessor plan
 * that backs one of its listed transfer commitments is deducted once, as
 * committed stock, and reported apart from unrelated reservations. Its
 * quantity must match the commitment. Any other plan-bound reservation is
 * still refused.
 */
export function deriveEligibility(
  snapshot: StockSnapshot,
  commitments: readonly CommitmentReservation[] = [],
): EligibilityOutcome {
  const seen = new Set<string>();
  const committed: Array<{ reservationId: string; planId: string; quantity: bigint }> = [];
  for (const reservation of snapshot.reservations) {
    if (seen.has(reservation.reservationId)) {
      return refuse(REASONS.inconsistentStock, `${reservation.reservationId} appears twice`);
    }
    seen.add(reservation.reservationId);
    if (reservation.binding.kind !== "unrelated") {
      const { planId } = reservation.binding;
      const commitment = commitments.find(
        (entry) => entry.reservationId === reservation.reservationId && entry.planId === planId,
      );
      if (commitment === undefined) {
        return refuse(
          REASONS.planReservationUnsupported,
          `${reservation.reservationId} is bound to plan ${planId}`,
        );
      }
      if (parseQuantity(commitment.quantity) !== parseQuantity(reservation.quantity)) {
        return refuse(
          REASONS.inconsistentStock,
          `${reservation.reservationId} holds ${reservation.quantity}, its commitment ${commitment.quantity}`,
        );
      }
      committed.push({
        reservationId: reservation.reservationId,
        planId,
        quantity: parseQuantity(reservation.quantity),
      });
    }
  }
  const physical = parseQuantity(snapshot.physical);
  const qualityHold = parseQuantity(snapshot.qualityHold);
  const safetyStock = parseQuantity(snapshot.safetyStock);
  const reservations = snapshot.reservations
    .filter((reservation) => reservation.binding.kind === "unrelated")
    .sort((a, b) => compareText(a.reservationId, b.reservationId))
    .map((reservation) => ({
      reservationId: reservation.reservationId,
      quantity: parseQuantity(reservation.quantity),
    }));
  committed.sort((a, b) => compareText(a.reservationId, b.reservationId));
  const deductions =
    qualityHold +
    safetyStock +
    sum(reservations.map((r) => r.quantity)) +
    sum(committed.map((r) => r.quantity));
  if (deductions > physical) {
    return refuse(
      REASONS.inconsistentStock,
      `${snapshot.version}: deductions ${deductions} exceed physical ${physical}`,
    );
  }
  return {
    ok: true,
    value: {
      warehouse: snapshot.warehouse,
      stockVersion: snapshot.version,
      uom: snapshot.uom,
      physical: formatQuantity(physical),
      qualityHold: formatQuantity(qualityHold),
      safetyStock: formatQuantity(safetyStock),
      unrelatedReservations: reservations.map((r) => ({
        reservationId: r.reservationId,
        quantity: formatQuantity(r.quantity),
      })),
      ...(committed.length === 0
        ? {}
        : {
            commitmentReservations: committed.map((r) => ({
              reservationId: r.reservationId,
              planId: r.planId,
              quantity: formatQuantity(r.quantity),
            })),
          }),
      eligible: formatQuantity(physical - deductions),
    },
  };
}

function refuse(reason: string, detail: string): EligibilityOutcome {
  return { ok: false, reason, detail };
}

/** Byte-order comparison for documented identity sorts. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
