import { z } from "zod";
import {
  actorRoleSchema,
  domainContractVersionSchema,
  instantSchema,
  labelSchema,
  uomSchema,
  versionNumberSchema,
  type Instant,
} from "./primitives.js";

/**
 * Business time. `now()` returns an offset-qualified instant. Implementations
 * are the server's system clock and, in tests only, a controlled clock read
 * from the database on every call. Operational timers (sessions, queue,
 * heartbeat, timeouts) keep using real time and never take a Clock.
 */
export interface Clock {
  now(): Promise<Instant>;
}

/** Maps an organization's business label to its application UUID. */
export const organizationAliasSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  label: labelSchema,
  organizationId: z.uuid(),
  name: z.string().min(1).max(200),
});

export const vendorSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  vendorId: labelSchema,
  name: z.string().min(1).max(200),
  registeredSenders: z.array(z.email()).min(1),
});

export const itemSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  sku: labelSchema,
  stockUom: uomSchema,
  /** Integral items accept whole quantities only. */
  integral: z.literal(true),
});

/**
 * A simulated fixture actor. Actors are registry inputs: they are not sign-in
 * accounts and carry no authority grant. A supplier contact names its vendor.
 */
export const actorSchema = z
  .strictObject({
    contractVersion: domainContractVersionSchema,
    actorId: labelSchema,
    role: actorRoleSchema,
    vendorId: labelSchema.nullable(),
    simulated: z.literal(true),
  })
  .refine((actor) => (actor.role === "supplier_contact") === (actor.vendorId !== null), {
    message: "only a supplier contact names a vendor, and it must",
    path: ["vendorId"],
  });

export const policyRefSchema = z.strictObject({
  policyId: labelSchema,
  version: versionNumberSchema,
});

const policyBase = {
  contractVersion: domainContractVersionSchema,
  version: versionNumberSchema,
};

/**
 * The named policies of the first slice and only the parameters the canonical
 * fixture uses. The rules themselves belong to the policy task; these records
 * bind the versions and values a plan will reference.
 */
export const policySchema = z.discriminatedUnion("policyId", [
  z.strictObject({
    ...policyBase,
    policyId: z.literal("CAL-CPH-1"),
    timezone: z.literal("Europe/Copenhagen"),
    granularity: z.literal("date"),
  }),
  z.strictObject({
    ...policyBase,
    policyId: z.literal("ELIG-1"),
    subtract: z.tuple([
      z.literal("quality_holds"),
      z.literal("safety_stock"),
      z.literal("unrelated_reservations"),
    ]),
    reservationCounting: z.literal("each_once"),
  }),
  z.strictObject({
    ...policyBase,
    policyId: z.literal("ALLOC-1"),
    demandOrder: z.literal("priority_ascending"),
    supplyOrder: z.tuple([
      z.literal("destination_eligible_stock"),
      z.literal("on_time_inbound_by_earliest_arrival"),
      z.literal("confirmed_on_time_transfer"),
    ]),
  }),
  z.strictObject({
    ...policyBase,
    policyId: z.literal("AUTH-1"),
    currency: z.literal("EUR"),
    limits: z
      .array(z.strictObject({ role: actorRoleSchema, maxMinorUnits: z.int().min(0) }))
      .min(1)
      .refine(
        (limits) => new Set(limits.map((limit) => limit.role)).size === limits.length,
        "duplicate role",
      ),
    transferRequires: z.tuple([
      z.literal("supplier_acknowledgement"),
      z.literal("warehouse_planner_confirmation"),
    ]),
  }),
  z.strictObject({
    ...policyBase,
    policyId: z.literal("VERIFY-1"),
    bundle: z.literal("complete_read_back"),
    bundleTime: z.literal("earliest_read"),
    expiry: z.literal("strictly_before"),
    validityHours: z.int().min(1),
  }),
]);

/** Timing metadata a scenario declares for later tests, such as an approval expiry. */
export const scenarioTimingSchema = z.strictObject({
  contractVersion: domainContractVersionSchema,
  scenario: labelSchema,
  name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  instant: instantSchema,
});

export type OrganizationAlias = z.infer<typeof organizationAliasSchema>;
export type Vendor = z.infer<typeof vendorSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type PolicyRef = z.infer<typeof policyRefSchema>;
export type Policy = z.infer<typeof policySchema>;
export type ScenarioTiming = z.infer<typeof scenarioTimingSchema>;
