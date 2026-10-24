// D1 input contracts. Every valid record below is an independently written
// literal; none is imported from the seed manifest.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  DOMAIN_CONTRACT_VERSION,
  actorSchema,
  canonicalJson,
  demandSnapshotSchema,
  expectedInboundRefSchema,
  inTransitRecordSchema,
  itemMappingSchema,
  policySchema,
  purchaseOrderRevisionSchema,
  sourceIdentitySchema,
  stockSnapshotSchema,
  supplierInputIdentitySchema,
  supplierProposalSchema,
  transferOptionSchema,
} from "../src/index.js";

const v = "supplier-domain.v1";

const purchaseOrder = {
  contractVersion: v,
  organization: "ORG-T1",
  poNumber: "PO-900",
  revision: "7",
  vendorId: "V-900",
  observedAt: { state: "unknown" },
  effectiveDate: { state: "known", value: "2026-03-01" },
  lines: [
    {
      lineNumber: "010",
      sku: "SKU-9",
      uom: "EA",
      destination: "WH-9",
      ordered: "999999999999999999",
      received: "0",
      canceled: "3",
      acceptedSegments: [
        { sequence: 1, quantity: "5", arrival: { state: "dated", date: "2026-03-04" } },
        { sequence: 2, quantity: "6", arrival: { state: "undated" } },
      ],
    },
  ],
};

const proposal = {
  contractVersion: v,
  proposalId: "PROP-77",
  terms: {
    poNumber: "PO-900",
    poLine: "010",
    baseRevision: "7",
    vendorItem: "VX-1",
    uom: "CTN",
    segments: [
      { sequence: 1, quantity: "12", arrival: { state: "dated", date: "2028-02-29" } },
      { sequence: 2, quantity: "8", arrival: { state: "undated" } },
    ],
    unresolvedFields: ["segments.2.arrival"],
  },
  evidence: { sourceSystem: "mail-test", messageId: "M-1", inputVersion: 2 },
};

const supplierInput = {
  contractVersion: v,
  sourceSystem: "mail-test",
  messageId: "M-1",
  inputVersion: 2,
  contentSha256: "a".repeat(64),
  sender: "desk@vendor-nine.test",
  proposalId: "PROP-77",
  evidenceRef: "M-1@2",
  authoredAt: { state: "unknown" },
  receivedAt: { state: "known", value: "2026-03-02T10:15:00+01:00" },
};

const mapping = {
  contractVersion: v,
  mappingId: "MAP-9",
  version: 3,
  vendorId: "V-900",
  vendorItem: "VX-1",
  sourceUom: "CTN",
  sku: "SKU-9",
  stockUom: "EA",
  ratio: { numerator: "12", denominator: "1" },
  effectiveFrom: "2026-01-01",
  effectiveThrough: "2026-09-30",
  provenance: "item_master",
};

const stock = {
  contractVersion: v,
  organization: "ORG-T1",
  version: "INV-9@4",
  sku: "SKU-9",
  warehouse: "WH-9",
  uom: "EA",
  observedAt: { state: "known", value: "2026-03-02T06:00:00Z" },
  physical: "100",
  qualityHold: "4",
  safetyStock: "6",
  reservations: [
    { reservationId: "R-1", quantity: "10", binding: { kind: "unrelated" } },
    { reservationId: "R-2", quantity: "7", binding: { kind: "plan", planId: "PLAN-9" } },
  ],
};

const inbound = {
  contractVersion: v,
  sku: "SKU-9",
  destination: "WH-9",
  purchasing: { poNumber: "PO-900", revision: "7", poLine: "010", segment: 1 },
};

const transit = {
  contractVersion: v,
  transitId: "TRR-90",
  sku: "SKU-9",
  uom: "EA",
  from: "WH-8",
  to: "WH-9",
  quantity: "20",
  dispatchedOn: { state: "unknown" },
  arrival: { state: "dated", date: "2026-03-05" },
};

const demand = {
  contractVersion: v,
  organization: "ORG-T1",
  version: "DEM@9",
  observedAt: { state: "unknown" },
  lines: [
    {
      salesOrder: "SO-9",
      line: "10",
      sku: "SKU-9",
      uom: "EA",
      open: "15",
      delivered: { state: "unknown" },
      destination: "WH-9",
      receiptCutoff: "2026-03-05",
      calendar: { policyId: "CAL-T", version: 2 },
      priority: 3,
      supplyLinks: [
        { poNumber: "PO-900", poLine: "010" },
        { poNumber: "PO-901", poLine: "20" },
      ],
    },
  ],
};

const quote = {
  contractVersion: v,
  optionId: "TRO-9",
  sku: "SKU-9",
  uom: "EA",
  from: "WH-8",
  to: "WH-9",
  quantity: "9",
  dispatchDate: "2026-03-03",
  arrivalDate: "2026-03-04",
  cost: { minorUnits: Number.MAX_SAFE_INTEGER, currency: "DKK" },
  validUntil: "2026-03-03T11:00:00+01:00",
  basedOn: "INV-8@2",
  owner: "warehouse_planner",
};

const identity = {
  organization: "ORG-T1",
  authority: "purchasing",
  document: "PO-900",
  line: "010",
  segment: "2",
  version: "7",
  observedAt: { state: "known", value: "2026-03-02T06:00:00.250-05:00" },
  effectiveDate: { state: "unknown" },
};

const ROUND_TRIPS: Array<[string, z.ZodType, unknown]> = [
  ["purchase order revision", purchaseOrderRevisionSchema, purchaseOrder],
  ["supplier proposal", supplierProposalSchema, proposal],
  ["supplier input identity", supplierInputIdentitySchema, supplierInput],
  ["item mapping", itemMappingSchema, mapping],
  ["stock snapshot", stockSnapshotSchema, stock],
  ["expected inbound reference", expectedInboundRefSchema, inbound],
  ["in-transit record", inTransitRecordSchema, transit],
  ["demand snapshot", demandSnapshotSchema, demand],
  ["transfer option", transferOptionSchema, quote],
  ["source identity", sourceIdentitySchema, identity],
];

/** Deep copy with one change at a path; `undefined` removes the key. */
function variant(value: unknown, path: Array<string | number>, replacement: unknown): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
  const last = path.at(-1)!;
  if (replacement === undefined) delete target[last];
  else target[last] = replacement;
  return copy;
}

describe("D1 input contracts round-trip exactly", () => {
  it("uses the contract literal supplier-domain.v1", () => {
    expect(DOMAIN_CONTRACT_VERSION).toBe("supplier-domain.v1");
  });

  it.each(ROUND_TRIPS)("%s", (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
    const wire = JSON.parse(JSON.stringify(value)) as unknown;
    expect(canonicalJson(schema.parse(wire))).toBe(canonicalJson(value));
  });

  it("keeps labels as text: line 010 is not line 10", () => {
    const parsed = purchaseOrderRevisionSchema.parse(purchaseOrder);
    expect(parsed.lines[0]?.lineNumber).toBe("010");
    expect(parsed.lines[0]?.ordered).toBe("999999999999999999");
    expect(parsed.revision).toBe("7");
  });

  it("keeps an unknown authored time and an undated remainder explicit", () => {
    expect(supplierInputIdentitySchema.parse(supplierInput).authoredAt).toEqual({
      state: "unknown",
    });
    expect(supplierProposalSchema.parse(proposal).terms.segments[1]).toEqual({
      sequence: 2,
      quantity: "8",
      arrival: { state: "undated" },
    });
  });

  it.each([
    ["CAL-CPH-1", { timezone: "Europe/Copenhagen", granularity: "date" }],
    [
      "AUTH-1",
      {
        currency: "EUR",
        limits: [{ role: "buyer", maxMinorUnits: 1 }],
        transferRequires: ["supplier_acknowledgement", "warehouse_planner_confirmation"],
      },
    ],
    [
      "VERIFY-1",
      {
        bundle: "complete_read_back",
        bundleTime: "earliest_read",
        expiry: "strictly_before",
        validityHours: 2,
      },
    ],
  ])("round-trips policy %s", (policyId, parameters) => {
    const policy = { contractVersion: v, policyId, version: 5, ...parameters };
    expect(policySchema.parse(policy)).toEqual(policy);
  });
});

describe("D1 input contracts reject", () => {
  it.each([
    ["missing PO document", purchaseOrderRevisionSchema, purchaseOrder, ["poNumber"], undefined],
    [
      "missing PO line number",
      purchaseOrderRevisionSchema,
      purchaseOrder,
      ["lines", 0, "lineNumber"],
      undefined,
    ],
    ["a PO without lines", purchaseOrderRevisionSchema, purchaseOrder, ["lines"], []],
    ["missing source document", sourceIdentitySchema, identity, ["document"], undefined],
    ["missing proposal PO line", supplierProposalSchema, proposal, ["terms", "poLine"], undefined],
    [
      "missing demand supply links",
      demandSnapshotSchema,
      demand,
      ["lines", 0, "supplyLinks"],
      undefined,
    ],
    [
      "a supply link without its PO line",
      demandSnapshotSchema,
      demand,
      ["lines", 0, "supplyLinks", 0],
      { poNumber: "PO-900" },
    ],
    ["missing message ID", supplierInputIdentitySchema, supplierInput, ["messageId"], undefined],
  ])("%s", (_name, schema, value, path, replacement) => {
    expect(schema.safeParse(variant(value, path, replacement)).success).toBe(false);
  });

  it.each(ROUND_TRIPS.filter(([name]) => name !== "source identity"))(
    "an unsupported contract version: %s",
    (_name, schema, value) => {
      for (const version of ["supplier-domain.v2", "pilot-operation.v1", undefined]) {
        expect(schema.safeParse(variant(value, ["contractVersion"], version)).success).toBe(false);
      }
    },
  );

  it.each([
    [purchaseOrderRevisionSchema, purchaseOrder, ["extra"]],
    [purchaseOrderRevisionSchema, purchaseOrder, ["lines", 0, "extra"]],
    [purchaseOrderRevisionSchema, purchaseOrder, ["lines", 0, "acceptedSegments", 0, "extra"]],
    [supplierProposalSchema, proposal, ["terms", "vendorId"]],
    [supplierInputIdentitySchema, supplierInput, ["authoredAt", "value"]],
    // Eligible stock is derived by policy, never an accepted counter.
    [stockSnapshotSchema, stock, ["eligible"]],
    [stockSnapshotSchema, stock, ["expectedInbound"]],
    [stockSnapshotSchema, stock, ["reservations", 0, "extra"]],
    // An option is not a confirmation.
    [transferOptionSchema, quote, ["confirmed"]],
    [demandSnapshotSchema, demand, ["lines", 0, "allocations"]],
    [itemMappingSchema, mapping, ["substituteFor"]],
  ])("unknown field %#", (schema, value, path) => {
    expect(schema.safeParse(variant(value, path, "x")).success).toBe(false);
  });

  it.each([
    120,
    1.5,
    "1.5",
    "40.0",
    "1e2",
    "-1",
    "+1",
    "01",
    " 1",
    "",
    "1000000000000000000",
    null,
  ])("quantity %j (numeric, fractional EA, non-canonical or over 18 digits)", (quantity) => {
    expect(
      purchaseOrderRevisionSchema.safeParse(
        variant(purchaseOrder, ["lines", 0, "ordered"], quantity),
      ).success,
    ).toBe(false);
    expect(stockSnapshotSchema.safeParse(variant(stock, ["physical"], quantity)).success).toBe(
      false,
    );
    expect(
      demandSnapshotSchema.safeParse(variant(demand, ["lines", 0, "open"], quantity)).success,
    ).toBe(false);
  });

  it.each([
    [purchaseOrderRevisionSchema, purchaseOrder, ["lines", 0, "acceptedSegments", 0, "quantity"]],
    [supplierProposalSchema, proposal, ["terms", "segments", 0, "quantity"]],
    [stockSnapshotSchema, stock, ["reservations", 0, "quantity"]],
    [transferOptionSchema, quote, ["quantity"]],
    [inTransitRecordSchema, transit, ["quantity"]],
  ])("a zero quantity where it must be positive %#", (schema, value, path) => {
    expect(schema.safeParse(variant(value, path, "0")).success).toBe(false);
  });

  it.each(["2026-02-30", "2026-13-01", "2026-3-4", "2026-03-04T00:00:00Z", "", 20260304])(
    "invalid date %j",
    (date) => {
      expect(transferOptionSchema.safeParse(variant(quote, ["arrivalDate"], date)).success).toBe(
        false,
      );
      expect(
        demandSnapshotSchema.safeParse(variant(demand, ["lines", 0, "receiptCutoff"], date))
          .success,
      ).toBe(false);
      expect(
        supplierProposalSchema.safeParse(
          variant(proposal, ["terms", "segments", 0, "arrival", "date"], date),
        ).success,
      ).toBe(false);
    },
  );

  it.each([
    "2026-03-03T11:00:00",
    "2026-03-03T11:00",
    "2026-03-03",
    "2026-03-03T25:00:00Z",
    1772532000000,
  ])("instant %j without an offset or otherwise invalid", (instant) => {
    expect(transferOptionSchema.safeParse(variant(quote, ["validUntil"], instant)).success).toBe(
      false,
    );
    expect(
      stockSnapshotSchema.safeParse(
        variant(stock, ["observedAt"], { state: "known", value: instant }),
      ).success,
    ).toBe(false);
  });

  it.each([2 ** 53, Number.MAX_SAFE_INTEGER + 2, 1.5, -1, "16000", Number.NaN])(
    "unsafe or non-integer minor units %j",
    (minorUnits) => {
      expect(
        transferOptionSchema.safeParse(variant(quote, ["cost"], { minorUnits, currency: "EUR" }))
          .success,
      ).toBe(false);
    },
  );

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a bare instant", "2026-03-02T10:15:00+01:00"],
    ["unknown with a value", { state: "unknown", value: "2026-03-02T10:15:00+01:00" }],
    ["known without a value", { state: "known" }],
  ])("an authored time that is %s", (_name, authoredAt) => {
    expect(
      supplierInputIdentitySchema.safeParse(variant(supplierInput, ["authoredAt"], authoredAt))
        .success,
    ).toBe(false);
  });

  it.each([
    ["omitted", undefined],
    ["dated without a date", { state: "dated" }],
    ["a bare date", "2026-03-05"],
    ["undated with a date", { state: "undated", date: "2026-03-05" }],
  ])("a segment arrival that is %s", (_name, arrival) => {
    expect(
      supplierProposalSchema.safeParse(
        variant(proposal, ["terms", "segments", 1, "arrival"], arrival),
      ).success,
    ).toBe(false);
  });

  it("duplicate segment sequences and reservation IDs", () => {
    expect(
      supplierProposalSchema.safeParse(variant(proposal, ["terms", "segments", 1, "sequence"], 1))
        .success,
    ).toBe(false);
    expect(
      stockSnapshotSchema.safeParse(variant(stock, ["reservations", 1, "reservationId"], "R-1"))
        .success,
    ).toBe(false);
  });

  it.each([
    [["ratio", "numerator"], "0"],
    [["ratio", "denominator"], "1.5"],
    [["ratio", "numerator"], 12],
    [["effectiveThrough"], "2025-12-31"],
    [["effectiveThrough"], undefined],
    [["provenance"], "model_suggestion"],
  ])("an item mapping with %j = %j", (path, replacement) => {
    expect(itemMappingSchema.safeParse(variant(mapping, path, replacement)).success).toBe(false);
  });

  it("a transfer option from and to the same warehouse", () => {
    expect(transferOptionSchema.safeParse(variant(quote, ["to"], "WH-8")).success).toBe(false);
  });

  it("a transfer option that arrives before its dispatch", () => {
    expect(
      transferOptionSchema.safeParse(variant(quote, ["arrivalDate"], "2026-03-02")).success,
    ).toBe(false);
    // Same-day arrival is a valid option.
    expect(
      transferOptionSchema.safeParse(variant(quote, ["arrivalDate"], "2026-03-03")).success,
    ).toBe(true);
  });

  it("an AUTH-1 policy without limits or with a role limited twice", () => {
    const auth = {
      contractVersion: v,
      policyId: "AUTH-1",
      version: 1,
      currency: "EUR",
      limits: [
        { role: "buyer", maxMinorUnits: 1 },
        { role: "procurement_manager", maxMinorUnits: 2 },
      ],
      transferRequires: ["supplier_acknowledgement", "warehouse_planner_confirmation"],
    };
    expect(policySchema.safeParse(auth).success).toBe(true);
    expect(policySchema.safeParse({ ...auth, limits: [] }).success).toBe(false);
    expect(
      policySchema.safeParse({
        ...auth,
        limits: [
          { role: "buyer", maxMinorUnits: 1 },
          { role: "buyer", maxMinorUnits: 2 },
        ],
      }).success,
    ).toBe(false);
  });

  it("actors whose vendor does not match their role", () => {
    const base = { contractVersion: v, actorId: "a-1", simulated: true };
    expect(actorSchema.safeParse({ ...base, role: "buyer", vendorId: null }).success).toBe(true);
    expect(actorSchema.safeParse({ ...base, role: "buyer", vendorId: "V-1" }).success).toBe(false);
    expect(
      actorSchema.safeParse({ ...base, role: "supplier_contact", vendorId: null }).success,
    ).toBe(false);
    expect(
      actorSchema.safeParse({ ...base, role: "buyer", vendorId: null, simulated: false }).success,
    ).toBe(false);
  });

  it("an unknown policy or a policy with another currency", () => {
    expect(
      policySchema.safeParse({ contractVersion: v, policyId: "X-1", version: 1 }).success,
    ).toBe(false);
    expect(
      policySchema.safeParse({
        contractVersion: v,
        policyId: "AUTH-1",
        version: 1,
        currency: "DKK",
        limits: [{ role: "buyer", maxMinorUnits: 1 }],
        transferRequires: ["supplier_acknowledgement", "warehouse_planner_confirmation"],
      }).success,
    ).toBe(false);
  });
});
