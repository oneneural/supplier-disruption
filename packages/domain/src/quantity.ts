// Exact integer quantities. Canonical strings cross every boundary; BigInt
// exists only inside a calculation. Number, parseInt and parseFloat never
// touch a quantity, so values above 2^53 stay exact.

const CANONICAL = /^(?:0|[1-9][0-9]*)$/;
/** The largest quantity the domain contract can carry: 18 digits. */
const MAX = 999_999_999_999_999_999n;

/** A calculation produced a value the quantity contract cannot carry. */
export class QuantityRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "QuantityRangeError";
  }
}

/** Parses a canonical nonnegative integer string; anything else is rejected. */
export function parseQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !CANONICAL.test(value)) {
    throw new TypeError(`not a canonical quantity: ${String(value)}`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX) throw new QuantityRangeError(`quantity ${value} exceeds 18 digits`);
  return parsed;
}

/** Serializes a calculated value, refusing negatives and values beyond 18 digits. */
export function formatQuantity(value: bigint): string {
  if (value < 0n) throw new QuantityRangeError(`negative quantity ${value}`);
  if (value > MAX) throw new QuantityRangeError(`quantity ${value} exceeds 18 digits`);
  return value.toString();
}

export function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
