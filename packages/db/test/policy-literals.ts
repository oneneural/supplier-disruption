// Test-only expected literals for the coverage assessment P7 consumer gate, written by
// hand from the frozen oracle (docs/oracles/first-slice-oracles.md,
// "Named policies", "Canonical base fixture" and C-01). None is imported from
// the seed manifest, policy code, a plan builder or the domain package.

export const ORG = "ORG-NDL";

/** The trusted single-fixture reference binding, from test wiring, never supplier content. */
export const FIXTURE = { label: ORG, organizationId: "ed222926-927c-460e-8d28-e22ab5620819" };

/** 2026-10-21T09:00 Europe/Copenhagen, the controlled clock's start. */
export const CLOCK_START = "2026-10-21T07:00:00.000Z";
/** The setup advance: 2026-10-21T11:30 Europe/Copenhagen. */
export const CLOCK_ADVANCED = "2026-10-21T09:30:00.000Z";
/** INV-A@1 and INV-B@1 were observed 2026-10-21T08:55 Europe/Copenhagen. */
export const STOCK_OBSERVED_EPOCH_MS = Date.parse("2026-10-21T08:55:00+02:00");

export const PO_QUERY = { organization: ORG, poNumber: "PO-120" };
export const STOCK_QUERY = (warehouse: string) => ({ organization: ORG, sku: "PART-A", warehouse });
export const DEMAND_QUERY = { organization: ORG };
export const ITEM_QUERY = { organization: ORG, sku: "PART-A" };
export const MAPPING_QUERY = {
  organization: ORG,
  vendorId: "V-100",
  vendorItem: "KF-A-01",
  sourceUom: "EA",
};
export const SUPPLIER_QUERY = {
  organization: ORG,
  sourceSystem: "fixture-supplier-mail",
  messageId: "MSG-0001",
  inputVersion: 1,
};
export const OPTIONS_QUERY = {
  organization: ORG,
  sku: "PART-A",
  uom: "EA",
  fromWarehouse: "WH-B",
  toWarehouse: "WH-A",
};
export const POLICY_IDS = ["CAL-CPH-1", "ELIG-1", "ALLOC-1", "AUTH-1"] as const;

const known = (value: string) => ({ state: "known", value });

/** C-01: eligible 30 / 50; coverage 70, shortage 50, conditional TRO-1 50, remaining 0. */
export const C01_TOTALS = {
  uom: "EA",
  demandOpen: known("120"),
  preTransferCoverage: known("70"),
  preTransferShortage: known("50"),
  conditionalTransfer: known("50"),
  conditionalShortage: known("0"),
};

export const C01_ELIGIBLE = [
  ["WH-A", "INV-A@1", "40", "30"],
  ["WH-B", "INV-B@1", "70", "50"],
];

export const C01_ALLOCATIONS = [
  ["SO-201", "pre_transfer", "stock", "WH-A", "30"],
  ["SO-201", "pre_transfer", "po_segment", "PO-120@3/10#1", "40"],
  ["SO-202", "conditional_transfer", "transfer_option", "TRO-1", "50"],
];

export const C01_DECISION = {
  recommendedState: "awaiting_approval",
  reason: "policy_plan_ready_for_approval",
  owner: "procurement_manager",
};

export const C01_ACTIONS = [
  ["ACT-1", "amend_schedule"],
  ["ACT-2", "reserve"],
  ["ACT-3", "create_transfer_request"],
];

/** [kind, key, version, current version, members]: no option, transit or reference version is invented. */
export const C01_BINDINGS = [
  ["demand", "ORG-NDL", "DEM@1", "DEM@1", null],
  ["in_transit", "WH-A", null, null, []],
  ["in_transit", "WH-B", null, null, []],
  ["item", "PART-A", null, null, null],
  ["item_mappings", "V-100/KF-A-01/EA", null, null, ["MAP-1@1"]],
  ["policy", "ALLOC-1", "1", null, null],
  ["policy", "AUTH-1", "1", null, null],
  ["policy", "CAL-CPH-1", "1", null, null],
  ["policy", "ELIG-1", "1", null, null],
  ["purchase_order", "PO-120", "3", "3", null],
  ["stock", "WH-A", "INV-A@1", "INV-A@1", null],
  ["stock", "WH-B", "INV-B@1", "INV-B@1", null],
  ["supplier_input", "fixture-supplier-mail/MSG-0001", "1", null, null],
  ["transfer_options", "PART-A/EA/WH-B/WH-A", null, null, ["TRO-1"]],
];

/** Envelope observation time: reference reads state unknown; authority reads return none. */
export const C01_OBSERVED = {
  demand: "not_returned",
  in_transit: "not_returned",
  item: "unknown",
  item_mappings: "unknown",
  policy: "unknown",
  purchase_order: "not_returned",
  stock: "not_returned",
  supplier_input: "unknown",
  transfer_options: "unknown",
};

export const MSG_0001_SHA256 = "43dec39141c2d85db55a875337863ab50fbb3e5cb30a0bcc0a0040ef3478803c";

/** N-12b: WH-B unavailable; pre-transfer arithmetic known, transfer feasibility unknown. */
export const N12B_DECISION = {
  recommendedState: "needs_clarification",
  reason: "evidence_unavailable",
  owner: "warehouse_planner",
};
export const N12B_TOTALS = {
  uom: "EA",
  demandOpen: known("120"),
  preTransferCoverage: known("70"),
  preTransferShortage: known("50"),
  conditionalTransfer: { state: "unknown" },
  conditionalShortage: { state: "unknown" },
};
