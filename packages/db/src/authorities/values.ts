import { instantSchema, type Instant } from "@supplier-disruption/contracts";

/** Maps an explicit known/unknown value to a column value; unknown is stored as null. */
export function knownOrNull<T, R>(
  value: { state: "known"; value: T } | { state: "unknown" },
  map: (known: T) => R,
): R | null {
  return value.state === "known" ? map(value.value) : null;
}

/**
 * Several source versions exist and none is stated current. Opaque version
 * labels have no order, so initialization never guesses one.
 */
export class AmbiguousCurrentVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousCurrentVersionError";
  }
}

/** A source read returned a value the contracts cannot represent; nothing is substituted. */
export class SourceDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceDataError";
  }
}

// PostgreSQL's ISO DateStyle text for timestamptz: date, time with optional
// fraction, and an hour offset with optional minutes. Second offsets and BC
// dates are not instants the contracts accept.
const POSTGRES_INSTANT =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)([+-]\d{2})(?::(\d{2}))?$/;

/**
 * Converts PostgreSQL timestamptz text such as `2026-10-21 07:00:00+00` into
 * an offset-qualified ISO instant, keeping the instant and its precision.
 */
export function instantFromPostgres(text: string): Instant {
  const match = POSTGRES_INSTANT.exec(text);
  if (match === null) {
    throw new SourceDataError(`unrecognized PostgreSQL timestamp text: ${text}`);
  }
  const [, date, time, hours, minutes = "00"] = match;
  const parsed = instantSchema.safeParse(`${date}T${time}${hours}:${minutes}`);
  if (!parsed.success) {
    throw new SourceDataError(`PostgreSQL timestamp is not a valid instant: ${text}`);
  }
  return parsed.data;
}

/** Maps a nullable column to the explicit known/unknown shape; null stays unknown. */
export function knownFromColumn<T>(
  value: T | null,
): { state: "known"; value: T } | { state: "unknown" } {
  return value === null ? { state: "unknown" } : { state: "known", value };
}
