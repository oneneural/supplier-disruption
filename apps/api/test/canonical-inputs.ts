// Independently written expectations for the canonical C-01 inputs, as raw
// database rows. Nothing here is imported from the seed manifest or seed code.
// Shared by the seed (D10), oracle trace (D11) and packaged seed (D12) gates.
// Every column is selected as text, so a pg client and psql's JSON output
// compare alike; instants are shown as Europe/Copenhagen wall time, the
// oracle's convention for unqualified instants.

export const FROZEN_ORACLE_SHA256 =
  "b90368cb66fec1b3122092153bd98337292b168b68ca5a568a46878fe189e8ea";
export const FIXTURE_VERSION = "first-slice-c01.v1";
/**
 * The manifest hash the seed marker must record, pinned as observed from the
 * packaged seed of the reviewed manifest (ADR 0004). Any manifest change, even
 * one the other checks would miss, changes it.
 */
export const CANONICAL_MANIFEST_SHA256 =
  "57547d808324fcb2c8572295048a945aed542c9bde39f8e28ed8c60bdc78c48e";

/** The supplier-stated terms of MSG-0001 as canonical JSON, written by hand. */
export const SUPPLIER_TERMS_CANONICAL_JSON =
  '{"baseRevision":"3","poLine":"10","poNumber":"PO-120","segments":[{"arrival":{"date":"2026-10-23","state":"dated"},"quantity":"40","sequence":1},{"arrival":{"date":"2026-10-26","state":"dated"},"quantity":"80","sequence":2}],"unresolvedFields":[],"uom":"EA","vendorItem":"KF-A-01"}';
/** SHA-256 of the string above, computed separately with shasum. */
export const SUPPLIER_CONTENT_SHA256 =
  "43dec39141c2d85db55a875337863ab50fbb3e5cb30a0bcc0a0040ef3478803c";

export type Row = Record<string, string | null>;

export interface CanonicalQuery {
  sql: string;
  /** Builds the key a trace entry uses to find one row. */
  key: (row: Row) => string;
  rows: Row[];
}

const cph = (column: string) =>
  `to_char(${column} AT TIME ZONE 'Europe/Copenhagen', 'YYYY-MM-DD"T"HH24:MI:SS')`;

/** Every canonical input table, with exactly the rows a fresh seed creates. */
export const CANONICAL_QUERIES = {
  organization_alias: {
    sql: `SELECT label, organization_id::text, name FROM fixture_reference.organization_alias`,
    key: (row) => row.label!,
    rows: [
      {
        label: "ORG-NDL",
        organization_id: "ed222926-927c-460e-8d28-e22ab5620819",
        name: "Nordlund Distribution (fictional)",
      },
    ],
  },
  vendor: {
    sql: `SELECT vendor_id, name FROM fixture_reference.vendor`,
    key: (row) => row.vendor_id!,
    rows: [{ vendor_id: "V-100", name: "Kestrel Fasteners ApS (fictional)" }],
  },
  vendor_contact: {
    sql: `SELECT vendor_id, address, purpose FROM fixture_reference.vendor_contact`,
    key: (row) => row.address!,
    rows: [
      {
        vendor_id: "V-100",
        address: "orders@kestrel-fasteners.test",
        purpose: "registered_sender",
      },
    ],
  },
  item: {
    sql: `SELECT sku, stock_uom, integral::text FROM fixture_reference.item`,
    key: (row) => row.sku!,
    rows: [{ sku: "PART-A", stock_uom: "EA", integral: "true" }],
  },
  item_mapping: {
    sql: `SELECT mapping_id, version::text, vendor_id, vendor_item, source_uom, sku, stock_uom,
                 ratio_numerator::text, ratio_denominator::text, effective_from::text,
                 effective_through::text, provenance
            FROM fixture_reference.item_mapping`,
    key: (row) => row.mapping_id!,
    rows: [
      {
        mapping_id: "MAP-1",
        version: "1",
        vendor_id: "V-100",
        vendor_item: "KF-A-01",
        source_uom: "EA",
        sku: "PART-A",
        stock_uom: "EA",
        ratio_numerator: "1",
        ratio_denominator: "1",
        effective_from: "2026-01-01",
        effective_through: null,
        provenance: "item_master",
      },
    ],
  },
  actor: {
    sql: `SELECT actor_id, role, vendor_id, simulated::text FROM fixture_reference.actor`,
    key: (row) => row.actor_id!,
    rows: [
      { actor_id: "buyer-1", role: "buyer", vendor_id: null, simulated: "true" },
      { actor_id: "cs-1", role: "customer_service_owner", vendor_id: null, simulated: "true" },
      { actor_id: "manager-1", role: "procurement_manager", vendor_id: null, simulated: "true" },
      { actor_id: "planner-1", role: "warehouse_planner", vendor_id: null, simulated: "true" },
      { actor_id: "supplier-1", role: "supplier_contact", vendor_id: "V-100", simulated: "true" },
    ],
  },
  policy: {
    sql: `SELECT policy_id, version::text, parameters::text FROM fixture_reference.policy`,
    key: (row) => row.policy_id!,
    rows: [
      {
        policy_id: "ALLOC-1",
        version: "1",
        parameters:
          '{"demandOrder": "priority_ascending", "supplyOrder": ["destination_eligible_stock", "on_time_inbound_by_earliest_arrival", "confirmed_on_time_transfer"]}',
      },
      {
        policy_id: "AUTH-1",
        version: "1",
        parameters:
          '{"limits": [{"role": "buyer", "maxMinorUnits": 10000}, {"role": "procurement_manager", "maxMinorUnits": 50000}], "currency": "EUR", "transferRequires": ["supplier_acknowledgement", "warehouse_planner_confirmation"]}',
      },
      {
        policy_id: "CAL-CPH-1",
        version: "1",
        parameters: '{"timezone": "Europe/Copenhagen", "granularity": "date"}',
      },
      {
        policy_id: "ELIG-1",
        version: "1",
        parameters:
          '{"subtract": ["quality_holds", "safety_stock", "unrelated_reservations"], "reservationCounting": "each_once"}',
      },
      {
        policy_id: "VERIFY-1",
        version: "1",
        parameters:
          '{"bundle": "complete_read_back", "expiry": "strictly_before", "bundleTime": "earliest_read", "validityHours": 4}',
      },
    ],
  },
  supplier_input: {
    sql: `SELECT source_system, message_id, input_version::text, content_sha256, sender, proposal_id,
                 evidence_ref, authored_at::text, received_at::text, content::text
            FROM fixture_reference.supplier_input`,
    key: (row) => row.message_id!,
    rows: [
      {
        source_system: "fixture-supplier-mail",
        message_id: "MSG-0001",
        input_version: "1",
        content_sha256: SUPPLIER_CONTENT_SHA256,
        sender: "orders@kestrel-fasteners.test",
        proposal_id: "PROP-1",
        evidence_ref: "MSG-0001@1",
        authored_at: null,
        received_at: null,
        content:
          '{"uom": "EA", "poLine": "10", "poNumber": "PO-120", "segments": [{"arrival": {"date": "2026-10-23", "state": "dated"}, "quantity": "40", "sequence": 1}, {"arrival": {"date": "2026-10-26", "state": "dated"}, "quantity": "80", "sequence": 2}], "vendorItem": "KF-A-01", "baseRevision": "3", "unresolvedFields": []}',
      },
    ],
  },
  scenario_timing: {
    sql: `SELECT scenario, name, ${cph("instant")} AS instant FROM fixture_reference.scenario_timing`,
    key: (row) => `${row.scenario!}/${row.name!}`,
    rows: [{ scenario: "C-01", name: "approval_expiry", instant: "2026-10-21T18:00:00" }],
  },
  business_clock: {
    sql: `SELECT id::text, ${cph("instant")} AS instant FROM fixture_reference.business_clock`,
    key: (row) => row.id!,
    rows: [{ id: "1", instant: "2026-10-21T09:00:00" }],
  },
  po_revision: {
    sql: `SELECT po_number, revision::text, organization, vendor_id, observed_at::text,
                 effective_date::text
            FROM fixture_purchasing.po_revision`,
    key: (row) => `${row.po_number!}@${row.revision!}`,
    rows: [
      {
        po_number: "PO-120",
        revision: "3",
        organization: "ORG-NDL",
        vendor_id: "V-100",
        observed_at: null,
        effective_date: null,
      },
    ],
  },
  po_line: {
    sql: `SELECT po_number, revision::text, line_number, sku, uom, destination, ordered::text,
                 received::text, canceled::text
            FROM fixture_purchasing.po_line`,
    key: (row) => `${row.po_number!}@${row.revision!}/${row.line_number!}`,
    rows: [
      {
        po_number: "PO-120",
        revision: "3",
        line_number: "10",
        sku: "PART-A",
        uom: "EA",
        destination: "WH-A",
        ordered: "120",
        received: "0",
        canceled: "0",
      },
    ],
  },
  po_line_segment: {
    sql: `SELECT po_number, revision::text, line_number, sequence::text, quantity::text,
                 arrival_date::text
            FROM fixture_purchasing.po_line_segment`,
    key: (row) => `${row.po_number!}@${row.revision!}/${row.line_number!}#${row.sequence!}`,
    rows: [
      {
        po_number: "PO-120",
        revision: "3",
        line_number: "10",
        sequence: "1",
        quantity: "120",
        arrival_date: "2026-10-23",
      },
    ],
  },
  stock_snapshot: {
    sql: `SELECT version, organization, sku, warehouse, uom, ${cph("observed_at")} AS observed_at,
                 physical::text, quality_hold::text, safety_stock::text
            FROM fixture_inventory.stock_snapshot`,
    key: (row) => row.version!,
    rows: [
      {
        version: "INV-A@1",
        organization: "ORG-NDL",
        sku: "PART-A",
        warehouse: "WH-A",
        uom: "EA",
        observed_at: "2026-10-21T08:55:00",
        physical: "40",
        quality_hold: "0",
        safety_stock: "0",
      },
      {
        version: "INV-B@1",
        organization: "ORG-NDL",
        sku: "PART-A",
        warehouse: "WH-B",
        uom: "EA",
        observed_at: "2026-10-21T08:55:00",
        physical: "70",
        quality_hold: "0",
        safety_stock: "0",
      },
    ],
  },
  reservation: {
    sql: `SELECT snapshot_version, reservation_id, quantity::text, plan_id
            FROM fixture_inventory.reservation`,
    key: (row) => row.reservation_id!,
    rows: [
      { snapshot_version: "INV-A@1", reservation_id: "RES-A-77", quantity: "10", plan_id: null },
      { snapshot_version: "INV-B@1", reservation_id: "RES-B-31", quantity: "20", plan_id: null },
    ],
  },
  transfer_option: {
    sql: `SELECT option_id, sku, uom, from_warehouse, to_warehouse, quantity::text,
                 dispatch_date::text, arrival_date::text, cost_minor_units::text, currency,
                 ${cph("valid_until")} AS valid_until, based_on, owner_role
            FROM fixture_inventory.transfer_option`,
    key: (row) => row.option_id!,
    rows: [
      {
        option_id: "TRO-1",
        sku: "PART-A",
        uom: "EA",
        from_warehouse: "WH-B",
        to_warehouse: "WH-A",
        quantity: "50",
        dispatch_date: "2026-10-22",
        arrival_date: "2026-10-23",
        cost_minor_units: "16000",
        currency: "EUR",
        valid_until: "2026-10-22T12:00:00",
        based_on: "INV-B@1",
        owner_role: "warehouse_planner",
      },
    ],
  },
  in_transit: {
    sql: `SELECT transit_id FROM fixture_inventory.in_transit`,
    key: (row) => row.transit_id!,
    rows: [],
  },
  demand_snapshot: {
    sql: `SELECT version, organization, observed_at::text FROM fixture_demand.demand_snapshot`,
    key: (row) => row.version!,
    rows: [{ version: "DEM@1", organization: "ORG-NDL", observed_at: null }],
  },
  demand_line: {
    sql: `SELECT version, sales_order, line, sku, uom, open_quantity::text,
                 delivered_quantity::text, destination, receipt_cutoff::text, calendar_policy_id,
                 calendar_policy_version::text, priority::text
            FROM fixture_demand.demand_line`,
    key: (row) => `${row.sales_order!}/${row.line!}`,
    rows: [
      {
        version: "DEM@1",
        sales_order: "SO-201",
        line: "10",
        sku: "PART-A",
        uom: "EA",
        open_quantity: "70",
        delivered_quantity: "0",
        destination: "WH-A",
        receipt_cutoff: "2026-10-23",
        calendar_policy_id: "CAL-CPH-1",
        calendar_policy_version: "1",
        priority: "1",
      },
      {
        version: "DEM@1",
        sales_order: "SO-202",
        line: "10",
        sku: "PART-A",
        uom: "EA",
        open_quantity: "50",
        delivered_quantity: "0",
        destination: "WH-A",
        receipt_cutoff: "2026-10-23",
        calendar_policy_id: "CAL-CPH-1",
        calendar_policy_version: "1",
        priority: "2",
      },
    ],
  },
  supply_link: {
    sql: `SELECT version, sales_order, line, po_number, po_line FROM fixture_demand.supply_link`,
    key: (row) => `${row.sales_order!}/${row.line!}`,
    rows: [
      { version: "DEM@1", sales_order: "SO-201", line: "10", po_number: "PO-120", po_line: "10" },
      { version: "DEM@1", sales_order: "SO-202", line: "10", po_number: "PO-120", po_line: "10" },
    ],
  },
} satisfies Record<string, CanonicalQuery>;

export type CanonicalTable = keyof typeof CANONICAL_QUERIES;

/** The seed marker, apart from its manifest hash and completion time. */
export const MARKER_QUERY = `SELECT fixture_version, oracle_sha256, manifest_sha256
  FROM fixture_reference.seed_marker`;

/**
 * ELIG-1 computed by the test from the raw buckets: physical minus holds,
 * safety stock and each unrelated reservation once. The seed stores no
 * eligible quantity.
 */
export const DERIVED_ELIGIBLE_QUERY = `
  SELECT s.warehouse,
         (s.physical - s.quality_hold - s.safety_stock
            - coalesce((SELECT sum(r.quantity) FROM fixture_inventory.reservation r
                         WHERE r.snapshot_version = s.version AND r.plan_id IS NULL), 0))::text AS eligible
    FROM fixture_inventory.stock_snapshot s`;
export const DERIVED_ELIGIBLE = [
  { warehouse: "WH-A", eligible: "30" },
  { warehouse: "WH-B", eligible: "50" },
];

/** Sorts rows by their JSON form, so row order never matters. */
export function sortRows<T>(rows: readonly T[]): T[] {
  return rows
    .map((row) => [JSON.stringify(row), row] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
}
