import type { CaseActorRole } from "@supplier-disruption/contracts";
import { FIXTURE_ORGANIZATION } from "../fixtures.js";

/**
 * The single organization the case workflow serves: the synthetic pilot
 * organization, whose source records are the fixture organization `ORG-NDL`.
 * The binding comes from server configuration, never from a request or
 * supplier content. The first slice has two warehouses.
 */
export const CASE_FIXTURE = {
  label: "ORG-NDL",
  organization: FIXTURE_ORGANIZATION,
  reference: { label: "ORG-NDL", organizationId: "ed222926-927c-460e-8d28-e22ab5620819" },
  warehouses: ["WH-A", "WH-B"],
} as const;

/** Which fixture user may act as which simulated actor. Labeled simulated everywhere. */
export interface CaseActorBinding {
  actorId: string;
  role: CaseActorRole;
  vendorId: string | null;
  /** The fixture user's email. */
  user: "buyer" | "manager";
}

/**
 * The oracle's synthetic actors. The buyer account records the buyer's and
 * the customer service owner's decisions and relays the simulated supplier
 * contact; the manager account records the manager's and warehouse planner's.
 */
export const CASE_ACTORS: readonly CaseActorBinding[] = [
  { actorId: "buyer-1", role: "buyer", vendorId: null, user: "buyer" },
  { actorId: "cs-1", role: "customer_service_owner", vendorId: null, user: "buyer" },
  { actorId: "supplier-1", role: "supplier_contact", vendorId: "V-100", user: "buyer" },
  { actorId: "manager-1", role: "procurement_manager", vendorId: null, user: "manager" },
  { actorId: "planner-1", role: "warehouse_planner", vendorId: null, user: "manager" },
];
