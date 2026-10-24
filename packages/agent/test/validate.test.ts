import { describe, expect, it } from "vitest";
import { dateSupport, validateProposal } from "../src/index.js";
import { C01_EMAIL, C01_PROPOSAL, evidenceOf, PO_120 } from "./support.js";

const evidence = evidenceOf(C01_EMAIL);
const context = {
  evidenceText: evidence.text,
  evidenceSha256: evidence.sha256,
  purchaseOrders: { "PO-120": PO_120 },
};

function variant(change: (proposal: typeof C01_PROPOSAL) => void) {
  const proposal = structuredClone(C01_PROPOSAL);
  change(proposal);
  return validateProposal(proposal, context);
}

describe("proposal validation", () => {
  it("accepts the supported C-01 proposal", () => {
    expect(validateProposal(C01_PROPOSAL, context).ok).toBe(true);
  });

  it("rejects a quote that is not in the stored email", () => {
    const result = variant((p) => {
      p.segments[0]!.quantity.quote = "We can deliver 45 EA";
    });
    expect(result).toMatchObject({ ok: false, kind: "evidence" });
  });

  it("rejects a value the quote does not contain, such as a converted quantity", () => {
    const result = variant((p) => {
      p.segments[0]!.quantity.value = "400";
    });
    expect(result).toMatchObject({ ok: false, kind: "evidence" });
    if (!result.ok) expect(result.diagnostics[0]).toContain("segments[0].quantity");
  });

  it("rejects a unit the quote does not state", () => {
    const result = variant((p) => {
      p.uom.value = "CTN";
    });
    expect(result).toMatchObject({ ok: false, kind: "evidence" });
  });

  it("rejects a shipping date as an arrival date", () => {
    const email = {
      ...C01_EMAIL,
      text: "PO-120 rev 3 line 10, item KF-A-01: 40 EA will ship on 22 October.",
    };
    const shipped = evidenceOf(email);
    const proposal = structuredClone(C01_PROPOSAL);
    proposal.segments = [
      {
        quantity: { value: "40", quote: "40 EA will ship", confidence: "high" },
        arrival: {
          state: "dated",
          date: "2026-10-22",
          quote: "40 EA will ship on 22 October",
          confidence: "high",
        },
      },
    ];
    const result = validateProposal(proposal, {
      ...context,
      evidenceText: shipped.text,
      evidenceSha256: shipped.sha256,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.join(" ")).toContain("shipping or dispatch date");
  });

  it("allows a record citation only for a PO the run read, and a line only for a one-line order", () => {
    const fromRecord = (p: typeof C01_PROPOSAL) => {
      p.poLine = {
        value: "10",
        cite: { source: "purchase_order", field: "lineNumber" } as never,
        confidence: "high",
      };
      p.baseRevision = {
        value: "3",
        cite: { source: "purchase_order", field: "revision" } as never,
        confidence: "high",
      };
    };
    expect(variant(fromRecord).ok).toBe(true);
    const unread = structuredClone(C01_PROPOSAL);
    fromRecord(unread);
    expect(validateProposal(unread, { ...context, purchaseOrders: {} }).ok).toBe(false);
    const twoLines = structuredClone(PO_120);
    twoLines.lines.push({ ...twoLines.lines[0]!, lineNumber: "20" });
    expect(
      validateProposal(unread, { ...context, purchaseOrders: { "PO-120": twoLines } }).ok,
    ).toBe(false);
  });

  it("accepts a revision stated in a compound word, and nothing that only ends in a number", () => {
    const text = `${C01_EMAIL.text}\nZu PO-120, Basisrevision 3. Vedrørende linje 10, basisrevision 3. Position 3.`;
    const compound = evidenceOf({ ...C01_EMAIL, text });
    const check = (quote: string) => {
      const proposal = structuredClone(C01_PROPOSAL);
      proposal.baseRevision.cite = { source: "email", quote };
      return validateProposal(proposal, {
        ...context,
        evidenceText: compound.text,
        evidenceSha256: compound.sha256,
      }).ok;
    };
    expect(check("Basisrevision 3")).toBe(true);
    expect(check("basisrevision 3")).toBe(true);
    expect(check("Position 3")).toBe(false);
  });

  it("reports schema failures as malformed", () => {
    expect(validateProposal({ poNumber: "PO-120" }, context)).toMatchObject({
      ok: false,
      kind: "schema",
    });
  });

  it("recognizes explicit date forms only, with the stated year", () => {
    const evidence = "From: x\n\nOrder of 2026-09-01.";
    const support = (quote: string, date = "2026-10-23") => dateSupport(quote, date, evidence);
    expect(support("arrive on 23 October 2026")).toBe("stated");
    expect(support("arrive on October 23, 2026")).toBe("stated");
    expect(support("delivery 2026-10-23")).toBe("stated");
    expect(support("delivery 23.10.2026")).toBe("stated");
    expect(support("delivery Oct 23rd")).toBe("inferred");
    expect(support("delivery 23.10.")).toBe("inferred");
    expect(support("delivery on Friday")).toBe("unsupported");
    expect(support("delivery 10/23")).toBe("unsupported");
    expect(support("delivery October 2")).toBe("unsupported");
    expect(support("delivery 23.10.26")).toBe("unsupported");
  });

  // R1 B1.1: an ISO date is never read as day and month digits.
  it("does not read 2026-11-10 as 11 October", () => {
    const evidence = "40 EA will arrive 2026-11-10";
    expect(dateSupport("40 EA will arrive 2026-11-10", "2026-10-11", evidence)).toBe("unsupported");
    expect(dateSupport("40 EA will arrive 2026-11-10", "2026-11-10", evidence)).toBe("stated");
  });

  // R1 B1.2: a stated year must match; a missing year is inferred only from one stated year.
  it("checks the year", () => {
    const evidence = "deliver on 23 October 2026";
    expect(dateSupport("deliver on 23 October 2026", "2027-10-23", evidence)).toBe("unsupported");
    expect(dateSupport("deliver on 23 October 2026", "2025-10-23", evidence)).toBe("unsupported");
    const oneYear = "Order placed 2026-09-01. We deliver on 23 October.";
    expect(dateSupport("deliver on 23 October", "2026-10-23", oneYear)).toBe("inferred");
    expect(dateSupport("deliver on 23 October", "2027-10-23", oneYear)).toBe("unsupported");
    const noYear = "We deliver on 23 October.";
    expect(dateSupport("deliver on 23 October", "2026-10-23", noYear)).toBe("ambiguous_year");
    const twoYears = "Order of 2025-12-20. We deliver on 23 October, before 1 January 2027.";
    expect(dateSupport("deliver on 23 October", "2026-10-23", twoYears)).toBe("ambiguous_year");
  });

  /** Validates C-01 with one field's value and quote replaced, against an email holding the quote. */
  function withQuote(
    quote: string,
    change: (proposal: typeof C01_PROPOSAL, quote: string) => void,
  ) {
    const email = evidenceOf({ ...C01_EMAIL, text: `${C01_EMAIL.text}\n${quote}` });
    const proposal = structuredClone(C01_PROPOSAL);
    change(proposal, quote);
    return validateProposal(proposal, {
      ...context,
      evidenceText: email.text,
      evidenceSha256: email.sha256,
    });
  }

  it("rejects an ISO date read as day and month, and a different stated year", () => {
    const iso = withQuote("40 EA will arrive 2026-11-10", (p, quote) => {
      p.segments[0]!.arrival = { state: "dated", date: "2026-10-11", quote, confidence: "high" };
    });
    expect(iso).toMatchObject({ ok: false, kind: "evidence" });
    const year = withQuote("40 EA will arrive on 23 October 2026", (p, quote) => {
      p.segments[0]!.arrival = { state: "dated", date: "2027-10-23", quote, confidence: "high" };
    });
    expect(year).toMatchObject({ ok: false, kind: "evidence" });
  });

  it("marks a yearless date low confidence when the email states no single year", () => {
    const yearless = (text: string) => text.replaceAll(" 2026", "");
    const email = evidenceOf({ ...C01_EMAIL, text: yearless(C01_EMAIL.text) });
    const proposal = JSON.parse(yearless(JSON.stringify(C01_PROPOSAL))) as typeof C01_PROPOSAL;
    const result = validateProposal(proposal, {
      ...context,
      evidenceText: email.text,
      evidenceSha256: email.sha256,
    });
    expect(result).toMatchObject({
      ok: true,
      lowConfidence: ["segments[0].arrival", "segments[1].arrival"],
    });
  });

  // R1 B1.3: a quantity is a whole number, never part of 1,200 or 1.200.
  it("rejects a quantity inside a grouped number", () => {
    for (const quote of ["we ship 1,200 pieces", "we ship 1.200 pieces"]) {
      for (const value of ["200", "1"]) {
        const result = withQuote(quote, (p, q) => {
          p.segments[0]!.quantity = { value, quote: q, confidence: "high" };
        });
        expect(result, `${value} in ${quote}`).toMatchObject({ ok: false, kind: "evidence" });
      }
    }
  });

  // A quantity glued to letters or inside space-grouped thousands is not standalone.
  it("rejects a quantity glued to letters or inside a space-grouped number", () => {
    const cases: [string, string][] = [
      ["reference AB200 ships later", "200"],
      ["we deliver 1 200 pieces", "200"],
      ["we deliver 1 200 pieces", "1"],
      ["we deliver 1\u00a0200 pieces", "200"],
    ];
    for (const [quote, value] of cases) {
      const result = withQuote(quote, (p, q) => {
        p.segments[0]!.quantity = { value, quote: q, confidence: "high" };
      });
      expect(result, `${value} in ${quote}`).toMatchObject({ ok: false, kind: "evidence" });
    }
    for (const [quote, value] of [
      ["we deliver 200pcs", "200"],
      ["line 10: 40 EA on 23 October", "40"],
    ] as const) {
      const result = withQuote(quote, (p, q) => {
        p.segments[0]!.quantity = { value, quote: q, confidence: "high" };
      });
      expect(result.ok, `${value} in ${quote}`).toBe(true);
    }
  });

  // R1 B1.4: PO number and vendor item are bounded tokens, not substrings.
  it("rejects a PO number or item code that is only part of a longer one", () => {
    const po = withQuote("our order PO-1201", (p, quote) => {
      p.poNumber = { value: "PO-120", quote, confidence: "high" };
    });
    expect(po).toMatchObject({ ok: false, kind: "evidence" });
    const item = withQuote("item KF-A-01", (p, quote) => {
      p.vendorItem = { value: "KF-A-0", quote, confidence: "high" };
    });
    expect(item).toMatchObject({ ok: false, kind: "evidence" });
    const spaced = withQuote("order PO 120 item KF A 01", (p, quote) => {
      p.poNumber = { value: "PO-120", quote, confidence: "high" };
      p.vendorItem = { value: "KF-A-01", quote, confidence: "high" };
    });
    expect(spaced.ok).toBe(true);
  });
});
