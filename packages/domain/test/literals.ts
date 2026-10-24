// Test-only literal inputs for the coverage assessment unit gates (P1 to P6), written by
// hand from the frozen oracle (docs/oracles/first-slice-oracles.md,
// "Named policies", "Canonical base fixture", C-01, N-12, N-14 and N-15).
// Nothing here is imported from the seed manifest, policy code or a plan
// builder. Every call returns a fresh object, so a test may change it freely.

const v = "supplier-domain.v1";
export const ORG = "ORG-NDL";
export const ORG_ID = "ed222926-927c-460e-8d28-e22ab5620819";
/** 2026-10-21T09:00 Europe/Copenhagen, the controlled clock's start. */
export const ASSESSED_AT = "2026-10-21T07:00:00.000Z";
const READ_AT = "2026-10-21T07:00:00.000Z";
const BINDING = { state: "validated", label: ORG, organizationId: ORG_ID } as const;

const reference = (resource: string, selectors: Record<string, unknown>) => ({
  owner: "reference",
  resource,
  organization: ORG,
  selectors,
  binding: BINDING,
});

const ok = (scope: unknown, data: unknown, observedAt: unknown = { state: "not_returned" }) => ({
  status: "ok",
  provenance: { scope, readAt: READ_AT, observedAt },
  data,
});

export const CAL = {
  contractVersion: v,
  policyId: "CAL-CPH-1",
  version: 1,
  timezone: "Europe/Copenhagen",
  granularity: "date",
};
export const ELIG = {
  contractVersion: v,
  policyId: "ELIG-1",
  version: 1,
  subtract: ["quality_holds", "safety_stock", "unrelated_reservations"],
  reservationCounting: "each_once",
};
export const ALLOC = {
  contractVersion: v,
  policyId: "ALLOC-1",
  version: 1,
  demandOrder: "priority_ascending",
  supplyOrder: [
    "destination_eligible_stock",
    "on_time_inbound_by_earliest_arrival",
    "confirmed_on_time_transfer",
  ],
};
/** EUR 100.00 buyer and EUR 500.00 procurement manager, in minor units. */
export const AUTH = {
  contractVersion: v,
  policyId: "AUTH-1",
  version: 1,
  currency: "EUR",
  limits: [
    { role: "buyer", maxMinorUnits: 10000 },
    { role: "procurement_manager", maxMinorUnits: 50000 },
  ],
  transferRequires: ["supplier_acknowledgement", "warehouse_planner_confirmation"],
};

export function stockA() {
  return {
    contractVersion: v,
    organization: ORG,
    version: "INV-A@1",
    sku: "PART-A",
    warehouse: "WH-A",
    uom: "EA",
    observedAt: { state: "known", value: "2026-10-21T06:55:00.000Z" },
    physical: "40",
    qualityHold: "0",
    safetyStock: "0",
    reservations: [{ reservationId: "RES-A-77", quantity: "10", binding: { kind: "unrelated" } }],
  };
}

export function stockB() {
  return {
    contractVersion: v,
    organization: ORG,
    version: "INV-B@1",
    sku: "PART-A",
    warehouse: "WH-B",
    uom: "EA",
    observedAt: { state: "known", value: "2026-10-21T06:55:00.000Z" },
    physical: "70",
    qualityHold: "0",
    safetyStock: "0",
    reservations: [{ reservationId: "RES-B-31", quantity: "20", binding: { kind: "unrelated" } }],
  };
}

export const stockScope = (warehouse: string) => ({
  owner: "inventory",
  resource: "stock",
  organization: ORG,
  selectors: { sku: "PART-A", warehouse },
});

export function stockRead(record: ReturnType<typeof stockA>) {
  return {
    warehouse: record.warehouse,
    read: ok(stockScope(record.warehouse), {
      currentVersion: record.version,
      record,
      lineage: null,
    }),
  };
}

export function tro1() {
  return {
    contractVersion: v,
    optionId: "TRO-1",
    sku: "PART-A",
    uom: "EA",
    from: "WH-B",
    to: "WH-A",
    quantity: "50",
    dispatchDate: "2026-10-22",
    arrivalDate: "2026-10-23",
    cost: { minorUnits: 16000, currency: "EUR" },
    // 2026-10-22T12:00 Europe/Copenhagen.
    validUntil: "2026-10-22T10:00:00.000Z",
    basedOn: "INV-B@1",
    owner: "warehouse_planner",
  };
}

export const optionsScope = {
  owner: "inventory",
  resource: "transfer_options",
  organization: ORG,
  selectors: { sku: "PART-A", uom: "EA", fromWarehouse: "WH-B", toWarehouse: "WH-A" },
  bound: 100,
};

export function transitScope(warehouse: string) {
  return {
    owner: "inventory",
    resource: "in_transit",
    organization: ORG,
    selectors: { sku: "PART-A", warehouse },
  };
}

/** N-15: TRR-9, 20 EA WH-B to WH-A, dispatched before the snapshots, arriving 2026-10-24. */
export function trr9() {
  return {
    contractVersion: v,
    transitId: "TRR-9",
    sku: "PART-A",
    uom: "EA",
    from: "WH-B",
    to: "WH-A",
    quantity: "20",
    dispatchedOn: { state: "known", value: "2026-10-20" },
    arrival: { state: "dated", date: "2026-10-24" },
  };
}

export const MSG_0001_SHA256 = "43dec39141c2d85db55a875337863ab50fbb3e5cb30a0bcc0a0040ef3478803c";

export function map1() {
  return {
    contractVersion: v,
    mappingId: "MAP-1",
    version: 1,
    vendorId: "V-100",
    vendorItem: "KF-A-01",
    sourceUom: "EA",
    sku: "PART-A",
    stockUom: "EA",
    ratio: { numerator: "1", denominator: "1" },
    effectiveFrom: "2026-01-01",
    effectiveThrough: null,
    provenance: "item_master",
  };
}

const segment = (sequence: number, quantity: string, date: string) => ({
  sequence,
  quantity,
  arrival: { state: "dated", date },
});

/** The canonical C-01 assessment input: PROP-1 against the base fixture. */
export function c01Input() {
  return structuredClone(c01Literal());
}

function c01Literal() {
  return {
    contractVersion: "coverage-assessment.v1",
    organization: ORG,
    assessedAt: ASSESSED_AT,
    planId: "PLAN-1",
    planVersion: 1,
    vendorId: "V-100",
    poLine: { poNumber: "PO-120", poLine: "10" },
    proposalId: "PROP-1",
    reads: {
      supplierInput: ok(
        reference("supplier_input", {
          sourceSystem: "fixture-supplier-mail",
          messageId: "MSG-0001",
          inputVersion: 1,
        }),
        {
          identity: {
            contractVersion: v,
            sourceSystem: "fixture-supplier-mail",
            messageId: "MSG-0001",
            inputVersion: 1,
            contentSha256: MSG_0001_SHA256,
            sender: "orders@kestrel-fasteners.test",
            proposalId: "PROP-1",
            evidenceRef: "MSG-0001@1",
            authoredAt: { state: "unknown" },
            receivedAt: { state: "unknown" },
          },
          terms: {
            poNumber: "PO-120",
            poLine: "10",
            baseRevision: "3",
            vendorItem: "KF-A-01",
            uom: "EA",
            segments: [segment(1, "40", "2026-10-23"), segment(2, "80", "2026-10-26")],
            unresolvedFields: [],
          },
        },
        { state: "unknown" },
      ),
      purchaseOrder: ok(
        {
          owner: "purchasing",
          resource: "purchase_order",
          organization: ORG,
          selectors: { poNumber: "PO-120" },
        },
        {
          currentRevision: "3",
          record: {
            contractVersion: v,
            organization: ORG,
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
                acceptedSegments: [segment(1, "120", "2026-10-23")],
              },
            ],
          },
        },
      ),
      demand: ok(
        { owner: "demand", resource: "demand", organization: ORG, selectors: {} },
        {
          currentVersion: "DEM@1",
          record: {
            contractVersion: v,
            organization: ORG,
            version: "DEM@1",
            observedAt: { state: "unknown" },
            lines: [
              {
                salesOrder: "SO-201",
                line: "10",
                sku: "PART-A",
                uom: "EA",
                open: "70",
                delivered: { state: "known", value: "0" },
                destination: "WH-A",
                receiptCutoff: "2026-10-23",
                calendar: { policyId: "CAL-CPH-1", version: 1 },
                priority: 1,
                supplyLinks: [{ poNumber: "PO-120", poLine: "10" }],
              },
              {
                salesOrder: "SO-202",
                line: "10",
                sku: "PART-A",
                uom: "EA",
                open: "50",
                delivered: { state: "known", value: "0" },
                destination: "WH-A",
                receiptCutoff: "2026-10-23",
                calendar: { policyId: "CAL-CPH-1", version: 1 },
                priority: 2,
                supplyLinks: [{ poNumber: "PO-120", poLine: "10" }],
              },
            ],
          },
        },
      ),
      stock: [stockRead(stockA()), stockRead(stockB())],
      inTransit: [
        { warehouse: "WH-A", read: ok(transitScope("WH-A"), { records: [] }) },
        { warehouse: "WH-B", read: ok(transitScope("WH-B"), { records: [] }) },
      ],
      transferOptions: ok(
        optionsScope,
        { records: [tro1()], complete: true },
        { state: "unknown" },
      ),
      item: ok(
        reference("item", { sku: "PART-A" }),
        { contractVersion: v, sku: "PART-A", stockUom: "EA", integral: true },
        { state: "unknown" },
      ),
      itemMappings: ok(
        reference("item_mappings", { vendorId: "V-100", vendorItem: "KF-A-01", sourceUom: "EA" }),
        { records: [map1()], complete: true },
        { state: "unknown" },
      ),
      policies: {
        calendar: ok(reference("policy", { policyId: "CAL-CPH-1", version: 1 }), CAL, {
          state: "unknown",
        }),
        eligibility: ok(reference("policy", { policyId: "ELIG-1", version: 1 }), ELIG, {
          state: "unknown",
        }),
        allocation: ok(reference("policy", { policyId: "ALLOC-1", version: 1 }), ALLOC, {
          state: "unknown",
        }),
        authorization: ok(reference("policy", { policyId: "AUTH-1", version: 1 }), AUTH, {
          state: "unknown",
        }),
      },
    },
    candidateOffers: [] as unknown[],
  };
}

export type C01Input = ReturnType<typeof c01Input>;

/** A typed unavailable read of a scope; never zero, empty or remembered data. */
export function unavailable(scope: unknown, reason = "connection_unavailable") {
  return { status: "unavailable", scope, reason, attemptedAt: { state: "unknown" } };
}

/** Reads the data of an ok literal read for in-place test changes. */
export function data<T = Record<string, unknown>>(read: unknown): T {
  return (read as { data: T }).data;
}
