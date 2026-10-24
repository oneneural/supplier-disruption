import { z } from "zod";

/**
 * Domain input contracts for the first policy slice. Every top-level record
 * carries this literal; any other value is an unsupported version.
 */
export const DOMAIN_CONTRACT_VERSION = "supplier-domain.v1";
export const domainContractVersionSchema = z.literal(DOMAIN_CONTRACT_VERSION);

/**
 * A business label scoped by its owning record, such as `PO-120`, line `10`
 * or version `INV-A@1`. Labels are text identities, never numbers; internal
 * application UUIDs map to them explicitly.
 */
export const labelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/);

/**
 * Quantities are canonical nonnegative integer decimal strings: zero, or an
 * unsigned value without leading zeros, at most 18 digits. Numbers, signs,
 * fractions and exponents are rejected, so a quantity never passes through
 * binary floating point. Fractional units of measure wait for a reviewed case.
 */
export const quantitySchema = z.string().regex(/^(?:0|[1-9][0-9]{0,17})$/);
/** A quantity that must be positive, such as a segment, reservation or transfer. */
export const positiveQuantitySchema = z.string().regex(/^[1-9][0-9]{0,17}$/);

/**
 * A stated unit-of-measure label (`EA`, `CTN`, `BOX`). Stating a unit says
 * nothing about converting it; conversions exist only as item-master mappings.
 */
export const uomSchema = z.string().regex(/^[A-Z][A-Z0-9]{0,15}$/);

/** A calendar date, `YYYY-MM-DD`. Arrival cutoffs are date-granular. */
export const businessDateSchema = z.iso.date();
/** An instant. An offset (or `Z`) is required; local date-times are rejected. */
export const instantSchema = z.iso.datetime({ offset: true });

/** A PO revision: a positive integer string, ordered independently of observation. */
export const revisionSchema = z.string().regex(/^[1-9][0-9]{0,8}$/);
/** A positive integer version of a named policy or mapping. */
export const versionNumberSchema = z.int().min(1);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** ISO 4217 code and a safe nonnegative integer amount in that currency's minor units. */
export const moneySchema = z.strictObject({
  minorUnits: z.int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

/**
 * A value whose absence is a recorded fact. Unknown is never zero, an empty
 * string or a fabricated timestamp.
 */
export function knowable<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("known"), value }),
    z.strictObject({ state: z.literal("unknown") }),
  ]);
}

/** An arrival that is either dated or explicitly undated. An undated arrival is never on time. */
export const arrivalSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("dated"), date: businessDateSchema }),
  z.strictObject({ state: z.literal("undated") }),
]);

export const actorRoleSchema = z.enum([
  "buyer",
  "procurement_manager",
  "warehouse_planner",
  "customer_service_owner",
  "supplier_contact",
]);

export type Quantity = z.infer<typeof quantitySchema>;
export type Instant = z.infer<typeof instantSchema>;
export type Arrival = z.infer<typeof arrivalSchema>;
export type ActorRole = z.infer<typeof actorRoleSchema>;
export type Money = z.infer<typeof moneySchema>;
