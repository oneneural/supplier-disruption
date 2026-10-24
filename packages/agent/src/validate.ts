import {
  agentProposalInputSchema,
  type AgentProposalInput,
  type EvidenceLocator,
  type PurchaseOrderRevision,
  type SupplierProposalTerms,
} from "@supplier-disruption/contracts";

/**
 * Deterministic validation of a model proposal (SD-02, SD-16). Schema first,
 * then semantic support: every email quote must occur in the stored evidence
 * text and contain the proposed value, and a record citation must name a
 * purchase order this run actually read. Nothing here infers, converts or
 * repairs a value; a failure is reported back, never patched.
 */
export type ProposalValidation =
  | {
      ok: true;
      terms: SupplierProposalTerms;
      locators: EvidenceLocator[];
      lowConfidence: string[];
      rationale: string;
    }
  | { ok: false; kind: "schema" | "evidence"; diagnostics: string[] };

export interface ValidationContext {
  evidenceText: string;
  evidenceSha256: string;
  /** Purchase orders read by this run, by PO number, exactly as the tool returned them. */
  purchaseOrders: Readonly<Record<string, PurchaseOrderRevision>>;
}

const MONTHS = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may", "may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sep", "sept"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
] as const;

/** Stated unit words a quote may use for each unit label. No unit implies another. */
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

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const token = (value: string) =>
  new RegExp(`(^|[^0-9A-Za-z])${escape(value)}($|[^0-9A-Za-z])`, "i");

/** Spaces a supplier may use to group thousands, as in `1 200`. */
const GROUP_SPACE = "[ \\u00a0\\u202f]";

/**
 * A whole number: no letter or digit before it (`200` is not found in
 * `AB200`), no digit-group separator joined to a digit on either side
 * (`1,200`, `1.200`) and no space-grouped thousands (`1 200`). A unit may
 * follow directly, as in `200pcs`.
 */
const wholeNumber = (value: string) =>
  new RegExp(
    `(?<![0-9A-Za-z])(?<![0-9][.,'])${value.length === 3 ? `(?<![0-9]${GROUP_SPACE})` : ""}` +
      `${escape(value)}(?![0-9])(?![.,'][0-9])(?!${GROUP_SPACE}[0-9]{3}(?![0-9]))`,
  );

/**
 * An identifier such as `PO-120` or `KF-A-01` as a bounded token. Its letter
 * and digit runs must appear in order, joined by nothing or by one of
 * `- _ . /` or a space, and the token may not continue into another letter or
 * digit run (so `PO-120` is not found in `PO-1201` and `KF-A-0` not in `KF-A-01`).
 */
function identifierToken(value: string): RegExp {
  const runs = value.match(/[0-9A-Za-z]+/g) ?? [];
  const body = runs.map(escape).join("[-_./ ]?");
  return new RegExp(`(?<![0-9A-Za-z])(?<![0-9A-Za-z][-_./])${body}(?![-_./]?[0-9A-Za-z])`, "i");
}

interface DateMention {
  day: number;
  month: number;
  year: number | null;
}

const MONTH_NAME = MONTHS.flat()
  .sort((a, b) => b.length - a.length)
  .join("|");

/**
 * Every explicit calendar date in a text: ISO `yyyy-mm-dd`, a day and an
 * English month name (either order, optional year), or European day/month
 * digits with an optional four-digit year (`23.10.`, `23/10`, `23-10-2026`).
 * Digits inside an ISO date or a longer digit run are never read as day and
 * month, digits are never read month first, and a two-digit year is no date.
 */
export function dateMentions(text: string): DateMention[] {
  const lower = text.toLowerCase();
  const mentions: DateMention[] = [];
  const add = (day: number, month: number, year: number | null) => {
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) mentions.push({ day, month, year });
  };
  const monthOf = (name: string) =>
    MONTHS.findIndex((names) => (names as readonly string[]).includes(name)) + 1;
  for (const m of lower.matchAll(/(?<![0-9])(\d{4})-(\d{1,2})-(\d{1,2})(?![0-9])/g)) {
    add(Number(m[3]), Number(m[2]), Number(m[1]));
  }
  const ordinal = "(?:st|nd|rd|th)?\\.?";
  const year = "(?:,?\\s+(\\d{4})(?![0-9]))?";
  const dayFirst = new RegExp(
    `(?<![0-9])(\\d{1,2})${ordinal}\\s*(?:of\\s+)?(${MONTH_NAME})\\b\\.?${year}`,
    "g",
  );
  for (const m of lower.matchAll(dayFirst)) {
    add(Number(m[1]), monthOf(m[2]!), m[3] === undefined ? null : Number(m[3]));
  }
  const monthFirst = new RegExp(
    `\\b(${MONTH_NAME})\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?(?![0-9])${year}`,
    "g",
  );
  for (const m of lower.matchAll(monthFirst)) {
    add(Number(m[2]), monthOf(m[1]!), m[3] === undefined ? null : Number(m[3]));
  }
  const digits =
    /(?<![0-9])(?<![0-9][./-])(\d{1,2})([./-])(\d{1,2})(?:\2(\d{4}))?(?![0-9])(?![./-][0-9])/g;
  for (const m of lower.matchAll(digits)) {
    add(Number(m[1]), Number(m[3]), m[4] === undefined ? null : Number(m[4]));
  }
  return mentions;
}

/**
 * How a quote supports a proposed date (ADR 0011, "Dates and years"):
 * - `stated`: the quote states this day, month and year;
 * - `inferred`: the quote states the day and month without a year, and the
 *   whole email states exactly one year in its explicit dates, which equals
 *   the proposed year;
 * - `ambiguous_year`: the day and month match, no year is stated in the
 *   quote, and the email states no year or more than one;
 * - `unsupported`: anything else, including a different stated year.
 */
export function dateSupport(
  quote: string,
  date: string,
  evidenceText: string,
): "stated" | "inferred" | "ambiguous_year" | "unsupported" {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const matching = dateMentions(quote).filter(
    (mention) => mention.day === day && mention.month === month,
  );
  if (matching.some((mention) => mention.year === year)) return "stated";
  if (!matching.some((mention) => mention.year === null)) return "unsupported";
  const years = new Set(
    dateMentions(evidenceText)
      .map((mention) => mention.year)
      .filter((stated): stated is number => stated !== null),
  );
  if (years.size !== 1) return "ambiguous_year";
  return years.has(year) ? "inferred" : "unsupported";
}

function quoteStatesUnit(quote: string, uom: string): boolean {
  const words = UNIT_WORDS[uom] ?? [uom.toLowerCase()];
  return words.some((word) => token(word).test(quote));
}

function issuesOf(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues
    .slice(0, 12)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
}

export function validateProposal(raw: unknown, context: ValidationContext): ProposalValidation {
  const parsed = agentProposalInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, kind: "schema", diagnostics: issuesOf(parsed.error) };
  const proposal: AgentProposalInput = parsed.data;
  const diagnostics: string[] = [];
  const locators: EvidenceLocator[] = [];
  const lowConfidence: string[] = [];
  const { evidenceText } = context;

  const emailLocator = (field: string, value: string, quote: string): boolean => {
    const start = evidenceText.indexOf(quote);
    if (start < 0) {
      diagnostics.push(`${field}: the quote does not occur verbatim in the email`);
      return false;
    }
    locators.push({
      source: "email",
      field,
      value,
      quote,
      start,
      end: start + quote.length,
      evidenceSha256: context.evidenceSha256,
    });
    return true;
  };
  const requireIn = (field: string, ok: boolean, what: string) => {
    if (!ok) diagnostics.push(`${field}: the quote does not state ${what}`);
  };
  const confidence = (field: string, level: "high" | "low") => {
    if (level === "low") lowConfidence.push(field);
  };

  const po = proposal.poNumber;
  confidence("poNumber", po.confidence);
  if (emailLocator("poNumber", po.value, po.quote)) {
    requireIn("poNumber", identifierToken(po.value).test(po.quote), po.value);
  }
  const record = context.purchaseOrders[po.value];

  for (const [field, entry, recordField] of [
    ["poLine", proposal.poLine, "lineNumber"],
    ["baseRevision", proposal.baseRevision, "revision"],
  ] as const) {
    confidence(field, entry.confidence);
    if (entry.cite.source === "email") {
      if (emailLocator(field, entry.value, entry.cite.quote)) {
        const stated =
          field === "baseRevision"
            ? new RegExp(
                // "revision" may end a compound word, as in German and Danish "Basisrevision".
                `(\\b(rev|version|v)|revision)\\.?\\s*(no\\.?|#)?\\s*${escape(entry.value)}\\b`,
                "i",
              ).test(entry.cite.quote)
            : token(entry.value).test(entry.cite.quote);
        requireIn(field, stated, `${field} ${entry.value}`);
      }
      continue;
    }
    if (entry.cite.field !== recordField) {
      diagnostics.push(`${field}: a record citation must name the record's ${recordField}`);
      continue;
    }
    if (record === undefined) {
      diagnostics.push(`${field}: purchase order ${po.value} was not read in this run`);
      continue;
    }
    if (field === "baseRevision") {
      if (record.revision !== entry.value) {
        diagnostics.push(`baseRevision: the record's revision is ${record.revision}`);
        continue;
      }
    } else {
      // A line may come from the record only when the order has exactly one line.
      if (record.lines.length !== 1 || record.lines[0]?.lineNumber !== entry.value) {
        diagnostics.push(
          "poLine: the email states no line and the order does not have exactly one line",
        );
        continue;
      }
    }
    locators.push({
      source: "purchase_order",
      field,
      value: entry.value,
      poNumber: record.poNumber,
      revision: record.revision,
      recordField,
    });
  }

  const item = proposal.vendorItem;
  confidence("vendorItem", item.confidence);
  if (emailLocator("vendorItem", item.value, item.quote)) {
    requireIn("vendorItem", identifierToken(item.value).test(item.quote), item.value);
  }
  const uom = proposal.uom;
  confidence("uom", uom.confidence);
  if (emailLocator("uom", uom.value, uom.quote)) {
    requireIn("uom", quoteStatesUnit(uom.quote, uom.value), `unit ${uom.value}`);
  }

  proposal.segments.forEach((segment, index) => {
    const base = `segments[${String(index)}]`;
    const quantity = segment.quantity;
    confidence(`${base}.quantity`, quantity.confidence);
    if (emailLocator(`${base}.quantity`, quantity.value, quantity.quote)) {
      requireIn(
        `${base}.quantity`,
        wholeNumber(quantity.value).test(quantity.quote),
        quantity.value,
      );
    }
    const arrival = segment.arrival;
    confidence(`${base}.arrival`, arrival.confidence);
    const value = arrival.state === "dated" ? arrival.date : "undated";
    if (!emailLocator(`${base}.arrival`, value, arrival.quote) || arrival.state === "undated")
      return;
    const support = dateSupport(arrival.quote, arrival.date, evidenceText);
    requireIn(`${base}.arrival`, support !== "unsupported", arrival.date);
    // A day and month with no single stated year is kept for the buyer, never trusted.
    if (support === "ambiguous_year" && !lowConfidence.includes(`${base}.arrival`)) {
      lowConfidence.push(`${base}.arrival`);
    }
    if (SHIPPING.test(arrival.quote) && !ARRIVAL.test(arrival.quote)) {
      diagnostics.push(`${base}.arrival: a shipping or dispatch date is not an arrival date`);
    }
  });

  if (diagnostics.length > 0) return { ok: false, kind: "evidence", diagnostics };
  const undated = proposal.segments
    .map((segment, index) =>
      segment.arrival.state === "undated" ? `segments[${String(index)}].arrival` : null,
    )
    .filter((path): path is string => path !== null);
  return {
    ok: true,
    terms: {
      poNumber: po.value,
      poLine: proposal.poLine.value,
      baseRevision: proposal.baseRevision.value,
      vendorItem: item.value,
      uom: uom.value,
      segments: proposal.segments.map((segment, index) => ({
        sequence: index + 1,
        quantity: segment.quantity.value,
        arrival:
          segment.arrival.state === "dated"
            ? { state: "dated" as const, date: segment.arrival.date }
            : { state: "undated" as const },
      })),
      unresolvedFields: undated,
    },
    locators,
    lowConfidence,
    rationale: proposal.rationale,
  };
}
