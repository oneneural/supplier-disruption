import { dateSupport } from "@supplier-disruption/agent";
import {
  supplierProposalTermsSchema,
  type CandidateField,
  type SupplierProposalTerms,
} from "@supplier-disruption/contracts";

/**
 * Deterministic checks for a human field correction (ADR 0014). A corrected
 * value must be stated by the quoted span of the supplier's own stored words,
 * by the same rules the extraction validator applies to a model proposal
 * (`packages/agent/src/validate.ts`, ADR 0011): bounded identifier tokens,
 * whole quantities, a stated unit, a stated base revision and an arrival
 * date with a single stated year that is not only a shipping date. Nothing
 * here infers, converts or repairs a value.
 */

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const token = (value: string) =>
  new RegExp(`(^|[^0-9A-Za-z])${escape(value)}($|[^0-9A-Za-z])`, "i");

/** An identifier such as `PO-120` as a bounded token, as in the extraction validator. */
function identifierToken(value: string): RegExp {
  const runs = value.match(/[0-9A-Za-z]+/g) ?? [];
  const body = runs.map(escape).join("[-_./ ]?");
  return new RegExp(`(?<![0-9A-Za-z])(?<![0-9A-Za-z][-_./])${body}(?![-_./]?[0-9A-Za-z])`, "i");
}

const GROUP_SPACE = "[ \\u00a0\\u202f]";

/** A whole number not joined to a digit group (`200` is not in `1,200` or `1 200`). */
const wholeNumber = (value: string) =>
  new RegExp(
    `(?<![0-9A-Za-z])(?<![0-9][.,'])${value.length === 3 ? `(?<![0-9]${GROUP_SPACE})` : ""}` +
      `${escape(value)}(?![0-9])(?![.,'][0-9])(?!${GROUP_SPACE}[0-9]{3}(?![0-9]))`,
  );

/** Stated unit words for each unit label. No unit implies another. */
const UNIT_WORDS: Record<string, readonly string[]> = {
  EA: ["ea", "each", "pc", "pcs", "piece", "pieces", "unit", "units", "stk"],
  CTN: ["ctn", "ctns", "carton", "cartons"],
  BOX: ["box", "boxes"],
  PK: ["pk", "pack", "packs"],
};

const SHIPPING =
  /\b(ship|ships|shipped|shipping|shipment|dispatch|dispatched|dispatches|leaves?|depart(s|ure)?|collection|pick-?up)\b/i;
const ARRIVAL =
  /\b(deliver|delivers|delivered|delivery|arrive|arrives|arrival|on site|at your|in your warehouse|receive|received|receipt|land|lands)\b/i;

/**
 * Why a quote does not support a corrected value, or null when it does. The
 * evidence text is the whole cited message, used only for the single-year rule.
 */
export function unsupportedReason(
  field: CandidateField,
  value: string,
  quote: string,
  evidenceText: string,
): string | null {
  const states = (ok: boolean, what: string) => (ok ? null : `the quote does not state ${what}`);
  if (field === "poNumber" || field === "vendorItem") {
    return states(identifierToken(value).test(quote), value);
  }
  if (field === "poLine") return states(token(value).test(quote), `line ${value}`);
  if (field === "baseRevision") {
    const stated = new RegExp(
      `(\\b(rev|version|v)|revision)\\.?\\s*(no\\.?|#)?\\s*${escape(value)}\\b`,
      "i",
    ).test(quote);
    return states(stated, `revision ${value}`);
  }
  if (field === "uom") {
    const words = UNIT_WORDS[value] ?? [value.toLowerCase()];
    return states(
      words.some((word) => token(word).test(quote)),
      `unit ${value}`,
    );
  }
  if (field.endsWith(".quantity")) return states(wholeNumber(value).test(quote), value);
  // An arrival: `undated` needs only the quote; a date must be stated with one year.
  if (value === "undated") return null;
  const support = dateSupport(quote, value, evidenceText);
  if (support === "ambiguous_year") {
    return "the quote states no year and the message does not state exactly one year";
  }
  if (support === "unsupported") return `the quote does not state ${value}`;
  if (SHIPPING.test(quote) && !ARRIVAL.test(quote)) {
    return "a shipping or dispatch date is not an arrival date";
  }
  return null;
}

const SEGMENT = /^segments\[(\d)\]\.(quantity|arrival)$/;
const SCALARS = ["poNumber", "poLine", "baseRevision", "vendorItem", "uom"] as const;

/** Every field a complete candidate states, in a stable order. */
export function candidateFields(terms: SupplierProposalTerms): CandidateField[] {
  return [
    ...SCALARS,
    ...terms.segments.flatMap((_, index) => [
      `segments[${String(index)}].quantity`,
      `segments[${String(index)}].arrival`,
    ]),
  ];
}

/** The value a candidate states for one field, as correction text. */
export function fieldValue(terms: SupplierProposalTerms, field: CandidateField): string | null {
  const segment = SEGMENT.exec(field);
  if (segment === null) return terms[field as (typeof SCALARS)[number]];
  const entry = terms.segments[Number(segment[1])];
  if (entry === undefined) return null;
  if (segment[2] === "quantity") return entry.quantity;
  return entry.arrival.state === "dated" ? entry.arrival.date : "undated";
}

/**
 * Applies field changes to the base terms. Segments are renumbered in order
 * and an undated arrival is listed as unresolved, as the extraction does. A
 * new segment must follow the last one and state both its fields.
 */
export function applyChanges(
  base: SupplierProposalTerms | null,
  changes: readonly { field: CandidateField; value: string }[],
): { ok: true; terms: SupplierProposalTerms } | { ok: false; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const scalars: Record<string, string> = {};
  for (const name of SCALARS) {
    if (base !== null) scalars[name] = base[name];
  }
  const segments: { quantity?: string; arrival?: string }[] = (base?.segments ?? []).map(
    (segment) => ({
      quantity: segment.quantity,
      arrival: segment.arrival.state === "dated" ? segment.arrival.date : "undated",
    }),
  );
  for (const change of changes) {
    if (seen.has(change.field)) diagnostics.push(`${change.field}: changed more than once`);
    seen.add(change.field);
    const segment = SEGMENT.exec(change.field);
    if (segment === null) {
      scalars[change.field] = change.value;
      continue;
    }
    const index = Number(segment[1]);
    if (index > segments.length) {
      diagnostics.push(`${change.field}: segments must follow one another`);
      continue;
    }
    const entry = segments[index] ?? {};
    segments[index] = entry;
    if (segment[2] === "quantity") entry.quantity = change.value;
    else entry.arrival = change.value;
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const parsed = supplierProposalTermsSchema.safeParse({
    ...scalars,
    segments: segments.map((segment, index) => ({
      sequence: index + 1,
      quantity: segment.quantity,
      arrival:
        segment.arrival === "undated"
          ? { state: "undated" }
          : { state: "dated", date: segment.arrival },
    })),
    unresolvedFields: segments.flatMap((segment, index) =>
      segment.arrival === "undated" ? [`segments[${String(index)}].arrival`] : [],
    ),
  });
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues
        .slice(0, 12)
        .map((issue) => `${issue.path.map(String).join(".") || "(terms)"}: ${issue.message}`),
    };
  }
  return { ok: true, terms: parsed.data };
}
