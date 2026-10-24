import type { ActionState, Arrival, CaseState, Money } from "@supplier-disruption/contracts";
import type { Tone } from "../components/ui/badge";

/** Presentation labels only. The API's codes stay visible next to them. */

export const ROLE_LABELS: Record<string, string> = {
  buyer: "Buyer",
  procurement_manager: "Procurement manager",
  warehouse_planner: "Warehouse planner",
  customer_service_owner: "Customer service owner",
  supplier_contact: "Supplier contact",
};

export function roleLabel(role: string | null): string {
  return role === null ? "Unassigned" : (ROLE_LABELS[role] ?? role);
}

export const CASE_STATE_LABELS: Record<CaseState, { label: string; tone: Tone }> = {
  received: { label: "Received", tone: "neutral" },
  needs_clarification: { label: "Needs clarification", tone: "warning" },
  assessing: { label: "Assessing", tone: "info" },
  awaiting_approval: { label: "Awaiting approval", tone: "suggested" },
  awaiting_acknowledgement: { label: "Awaiting acknowledgement", tone: "suggested" },
  applying: { label: "Applying", tone: "info" },
  partially_applied: { label: "Partially applied", tone: "blocked" },
  verifying: { label: "Verifying", tone: "info" },
  plan_verified: { label: "Plan verified", tone: "verified" },
  escalated: { label: "Escalated", tone: "warning" },
  superseded: { label: "Superseded", tone: "neutral" },
};

export const ACTION_STATE_LABELS: Record<ActionState, { label: string; tone: Tone }> = {
  planned: { label: "Planned, no effect", tone: "neutral" },
  authorized: { label: "Authorized, not started", tone: "suggested" },
  pending: { label: "Pending, result not yet known", tone: "info" },
  confirmed: { label: "Confirmed by source receipt", tone: "verified" },
  failed: { label: "Failed, no effect", tone: "blocked" },
  unknown: { label: "Unknown, reconcile before retry", tone: "warning" },
};

/** `policy_arrival_after_cutoff` becomes "Arrival after cutoff". */
export function codeLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code === "") return "None";
  const words = code
    .replace(/^policy_/, "")
    .replace(/[._]/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function money(value: Money | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  const major = (value.minorUnits / 100).toFixed(2);
  return `${value.currency} ${major}`;
}

export function knowable(value: { state: string; value?: string } | null | undefined): string {
  return value?.state === "known" && value.value !== undefined ? value.value : "unknown";
}

export function arrival(value: Arrival | null | undefined): string {
  if (value === null || value === undefined) return "on hand";
  return value.state === "dated" ? value.date : "undated";
}

export function age(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} h ${String(minutes % 60)} min`;
  return `${String(Math.floor(hours / 24))} d ${String(hours % 24)} h`;
}

/** An instant as UTC text, so every viewer reads the same business time. */
export function instant(value: string | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function shortHash(value: string | null | undefined): string {
  return value === null || value === undefined ? "none" : value.slice(0, 12);
}

/** A JSON path such as `proposal.terms.segments[0].quantity` as an element ID. */
export function locatorId(path: string): string {
  return `loc-${path.replace(/[^A-Za-z0-9]+/g, "-").replace(/-$/, "")}`;
}
