// CAL-CPH-1@1: business dates in Europe/Copenhagen, date granularity.

const COPENHAGEN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Copenhagen",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Copenhagen business date of an offset-qualified instant, as `YYYY-MM-DD`. */
export function copenhagenDate(instant: string): string {
  const epoch = Date.parse(instant);
  if (Number.isNaN(epoch)) throw new TypeError(`not an instant: ${instant}`);
  return COPENHAGEN.format(epoch);
}

/**
 * Whether `instant` is strictly before `limit`. Instants compare at
 * millisecond precision; truncating finer digits can only make an endpoint
 * comparison stricter, never extend a validity.
 */
export function strictlyBefore(instant: string, limit: string): boolean {
  const a = Date.parse(instant);
  const b = Date.parse(limit);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new TypeError("not an instant");
  return a < b;
}

/**
 * An arrival counts for a cutoff only when it is dated on or before the
 * cutoff date. Date-only values compare as dates, never as instants, so a
 * DST change cannot move them. An undated arrival is never on time.
 */
export function arrivesBy(
  arrival: { state: "dated"; date: string } | { state: "undated" },
  cutoff: string,
): boolean {
  return arrival.state === "dated" && arrival.date <= cutoff;
}
