import type { PurchaseOrderRevision } from "@supplier-disruption/contracts";
import { evidenceText, sha256Hex, type SupplierEmail, type ToolHost } from "../src/index.js";

/** The C-01 supplier email in plain language (fictional, as the SPEC demonstration case). */
export const C01_EMAIL: SupplierEmail = {
  sender: "orders@kestrel-fasteners.test",
  subject: "PO-120 line 10: revised delivery schedule",
  text: [
    "Hello,",
    "",
    "Regarding your purchase order PO-120 (revision 3), line 10, our item KF-A-01: we cannot deliver the full 120 EA by October 23.",
    "",
    "We can deliver 40 EA to your warehouse on 23 October 2026, and the remaining 80 EA will arrive on 26 October 2026.",
    "",
    "Please confirm the revised schedule.",
    "",
    "Best regards,",
    "Kestrel Fasteners order desk",
  ].join("\n"),
};

export const PO_120: PurchaseOrderRevision = {
  contractVersion: "supplier-domain.v1",
  organization: "ORG-NDL",
  poNumber: "PO-120",
  revision: "3",
  vendorId: "V-100",
  observedAt: { state: "unknown" },
  effectiveDate: { state: "unknown" },
  lines: [
    {
      lineNumber: "10",
      sku: "PART-A",
      uom: "EA",
      destination: "WH-A",
      ordered: "120",
      received: "0",
      canceled: "0",
      acceptedSegments: [
        { sequence: 1, quantity: "120", arrival: { state: "dated", date: "2026-10-23" } },
      ],
    },
  ],
};

export function evidenceOf(email: SupplierEmail) {
  const text = evidenceText(email);
  return { text, sha256: sha256Hex(text) };
}

export const host: ToolHost = {
  readPurchaseOrder: (poNumber) =>
    Promise.resolve(
      poNumber === "PO-120"
        ? { status: "ok", data: PO_120 }
        : { status: "not_found", detail: "no such purchase order" },
    ),
  inspectDemandAndStock: () => Promise.resolve({ status: "ok", data: { demand: [], stock: [] } }),
};

let ids = 0;
export function toolUse(name: string, input: unknown) {
  ids += 1;
  return {
    content: [
      { type: "tool_use", id: `toolu_${String(ids)}`, name, input, caller: { type: "direct" } },
    ],
    stopReason: "tool_use",
  } as never;
}

const q = (value: string, quote: string) => ({ value, quote, confidence: "high" });

export const C01_PROPOSAL = {
  poNumber: q("PO-120", "purchase order PO-120 (revision 3), line 10"),
  poLine: {
    value: "10",
    cite: { source: "email", quote: "PO-120 (revision 3), line 10" },
    confidence: "high",
  },
  baseRevision: {
    value: "3",
    cite: { source: "email", quote: "PO-120 (revision 3)" },
    confidence: "high",
  },
  vendorItem: q("KF-A-01", "our item KF-A-01"),
  uom: q("EA", "40 EA"),
  segments: [
    {
      quantity: q("40", "We can deliver 40 EA"),
      arrival: {
        state: "dated",
        date: "2026-10-23",
        quote: "We can deliver 40 EA to your warehouse on 23 October 2026",
        confidence: "high",
      },
    },
    {
      quantity: q("80", "the remaining 80 EA"),
      arrival: {
        state: "dated",
        date: "2026-10-26",
        quote: "the remaining 80 EA will arrive on 26 October 2026",
        confidence: "high",
      },
    },
  ],
  rationale: "The email splits line 10 into 40 EA on 23 October and 80 EA on 26 October.",
};
