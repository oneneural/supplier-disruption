// D11 oracle trace. Each specified canonical input is an independently
// written literal, tied to an exact phrase of the frozen oracle, to its path
// in the seed manifest and to a raw database row read on a separate
// connection. Unspecified metadata is listed separately; an input path that
// is neither traced nor listed fails the gate.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CANONICAL_MANIFEST } from "@supplier-disruption/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CANONICAL_QUERIES,
  DERIVED_ELIGIBLE,
  DERIVED_ELIGIBLE_QUERY,
  FROZEN_ORACLE_SHA256,
  SUPPLIER_CONTENT_SHA256,
  SUPPLIER_TERMS_CANONICAL_JSON,
  sortRows,
  type CanonicalTable,
  type Row,
} from "./canonical-inputs.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  NODE_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import { REPO_ROOT } from "./support.js";

type Value = string | number | boolean | null | readonly never[];

interface Trace {
  path: string;
  value: Value;
  /** The unique oracle line starting with `line`, a phrase in it and, for semantic tokens only, the words shown. */
  oracle: readonly [line: string, phrase: string, shown?: string];
  /**
   * For a number in a phrase with other numbers: the text immediately before
   * and after it, so the phrase must hold exactly `before + form + after`.
   */
  context?: readonly [before: string, after: string];
  /**
   * A database cell: table, row key and column (a dotted path after a JSON
   * column descends into it). `rows` compares the row count instead. The
   * expected text defaults to the value as text.
   */
  db: readonly [table: CanonicalTable, key: string, column: string, expected?: string | null];
}

const ORG = "| Organization |";
const CLOCK = "| Clock |";
const VENDOR = "| Vendor |";
const ITEM = "| Item and UOM |";
const PO = "| PO |";
const STOCK_A = "| Stock `WH-A` |";
const STOCK_B = "| Stock `WH-B` |";
const DEMAND = "| Demand |";
const QUOTE = "| Transfer option |";
const EVENT = "| Supplier event |";
const ACTORS = "| Actors (synthetic, labeled simulated) |";
const ON_TIME = "| On-time inbound |";
const CAL = "| `CAL-CPH-1` |";
const ELIG = "| `ELIG-1` |";
const ALLOC = "| `ALLOC-1` |";
const AUTH = "| `AUTH-1` |";
const VERIFY = "| `VERIFY-1` |";
const SO201 =
  "`SO-201` line `10`: open 70 EA at `WH-A`, cutoff 2026-10-23, priority 1, supply link `PO-120/10`";
const SO202 =
  "`SO-202` line `10`: open 50 EA at `WH-A`, cutoff 2026-10-23, priority 2, supply link `PO-120/10`";

// One trace per line, so the table reads as a table.
// prettier-ignore
const actor = (index: number, id: string, role: string, phrase: string, vendor: string | null) => [
  { path: `reference.actors.${index}.actorId`, value: id, oracle: [ACTORS, phrase], db: ["actor", id, "actor_id"] },
  { path: `reference.actors.${index}.role`, value: role, oracle: [ACTORS, phrase], db: ["actor", id, "role"] },
  { path: `reference.actors.${index}.vendorId`, value: vendor, oracle: vendor === null ? [ACTORS, phrase, id] : [ACTORS, phrase], db: ["actor", id, "vendor_id"] },
  { path: `reference.actors.${index}.simulated`, value: true, oracle: [ACTORS, "Actors (synthetic, labeled simulated)", "simulated"], db: ["actor", id, "simulated"] },
] satisfies Trace[];

// One trace per line, so the table reads as a table.
// prettier-ignore
const stock = (index: number, line: string, version: string, warehouse: string, physical: string, reservation: string, reserved: string) => {
  const base = `inventory.snapshots.${index}`;
  return [
    { path: `${base}.version`, value: version, oracle: [line, `version \`${version}\``], db: ["stock_snapshot", version, "version"] },
    { path: `${base}.sku`, value: "PART-A", oracle: [ITEM, "`PART-A`, stock UOM `EA`"], db: ["stock_snapshot", version, "sku"] },
    { path: `${base}.warehouse`, value: warehouse, oracle: [line, `Stock \`${warehouse}\``], db: ["stock_snapshot", version, "warehouse"] },
    { path: `${base}.uom`, value: "EA", oracle: [line, `${reserved} EA`], db: ["stock_snapshot", version, "uom"] },
    { path: `${base}.observedAt.state`, value: "known", oracle: [line, "observed 2026-10-21T08:55", "observed"], db: ["stock_snapshot", version, "observed_at", "2026-10-21T08:55:00"] },
    { path: `${base}.observedAt.value`, value: "2026-10-21T08:55:00+02:00", oracle: [line, "observed 2026-10-21T08:55"], db: ["stock_snapshot", version, "observed_at", "2026-10-21T08:55:00"] },
    { path: `${base}.physical`, value: physical, oracle: [line, `physical ${physical}`], db: ["stock_snapshot", version, "physical"] },
    { path: `${base}.qualityHold`, value: "0", oracle: [line, "no holds", "no holds"], db: ["stock_snapshot", version, "quality_hold"] },
    { path: `${base}.safetyStock`, value: "0", oracle: [line, "no safety stock", "no safety stock"], db: ["stock_snapshot", version, "safety_stock"] },
    { path: `${base}.reservations.0.reservationId`, value: reservation, oracle: [line, `unrelated reservation \`${reservation}\` ${reserved} EA`], db: ["reservation", reservation, "reservation_id"] },
    { path: `${base}.reservations.0.quantity`, value: reserved, oracle: [line, `unrelated reservation \`${reservation}\` ${reserved} EA`], db: ["reservation", reservation, "quantity"] },
    { path: `${base}.reservations.0.binding.kind`, value: "unrelated", oracle: [line, `unrelated reservation \`${reservation}\``], db: ["reservation", reservation, "plan_id", null] },
  ] satisfies Trace[];
};

// One trace per line, so the table reads as a table.
// prettier-ignore
const demandLine = (index: number, so: string, phrase: string, open: string, priority: number) => {
  const base = `demand.snapshots.0.lines.${index}`;
  const key = `${so}/10`;
  return [
    { path: `${base}.salesOrder`, value: so, oracle: [DEMAND, phrase], db: ["demand_line", key, "sales_order"] },
    { path: `${base}.line`, value: "10", oracle: [DEMAND, phrase], context: ["line `", "`"], db: ["demand_line", key, "line"] },
    { path: `${base}.sku`, value: "PART-A", oracle: [ITEM, "`PART-A`, stock UOM `EA`"], db: ["demand_line", key, "sku"] },
    { path: `${base}.uom`, value: "EA", oracle: [DEMAND, phrase], db: ["demand_line", key, "uom"] },
    { path: `${base}.open`, value: open, oracle: [DEMAND, phrase], context: ["open ", " EA"], db: ["demand_line", key, "open_quantity"] },
    { path: `${base}.delivered.state`, value: "known", oracle: [DEMAND, "Delivered 0 on both", "Delivered 0"], db: ["demand_line", key, "delivered_quantity", "0"] },
    { path: `${base}.delivered.value`, value: "0", oracle: [DEMAND, "Delivered 0 on both"], db: ["demand_line", key, "delivered_quantity"] },
    { path: `${base}.destination`, value: "WH-A", oracle: [DEMAND, phrase], db: ["demand_line", key, "destination"] },
    { path: `${base}.receiptCutoff`, value: "2026-10-23", oracle: [DEMAND, phrase], db: ["demand_line", key, "receipt_cutoff"] },
    { path: `${base}.calendar.policyId`, value: "CAL-CPH-1", oracle: [CAL, "`CAL-CPH-1`"], db: ["demand_line", key, "calendar_policy_id"] },
    { path: `${base}.calendar.version`, value: 1, oracle: [CAL, "`CAL-CPH-1` | 1 |"], db: ["demand_line", key, "calendar_policy_version"] },
    { path: `${base}.priority`, value: priority, oracle: [DEMAND, phrase], context: ["priority ", ","], db: ["demand_line", key, "priority"] },
    { path: `${base}.supplyLinks.0.poNumber`, value: "PO-120", oracle: [DEMAND, phrase], db: ["supply_link", key, "po_number"] },
    { path: `${base}.supplyLinks.0.poLine`, value: "10", oracle: [DEMAND, phrase], context: ["`PO-120/", "`"], db: ["supply_link", key, "po_line"] },
  ] satisfies Trace[];
};

const TERMS = "reference.supplierInputs.0.terms";
const PROPOSES = "proposes 40 EA arriving 2026-10-23 and 80 EA arriving 2026-10-26";
const MAP = "reference.mappings.0";
const OPTION = "inventory.transferOptions.0";
const ORDER = "purchasing.orders.0";
const LINE = `${ORDER}.lines.0`;

// One trace per line, so the table reads as a table.
// prettier-ignore
const TRACE: Trace[] = [
  // Organization, vendor, item and item master.
  { path: "reference.organization.label", value: "ORG-NDL", oracle: [ORG, "`ORG-NDL`"], db: ["organization_alias", "ORG-NDL", "label"] },
  { path: "reference.organization.name", value: "Nordlund Distribution (fictional)", oracle: [ORG, '"Nordlund Distribution" (fictional)'], db: ["organization_alias", "ORG-NDL", "name"] },
  { path: "reference.vendors.0.vendorId", value: "V-100", oracle: [VENDOR, "`V-100`"], db: ["vendor", "V-100", "vendor_id"] },
  { path: "reference.vendors.0.name", value: "Kestrel Fasteners ApS (fictional)", oracle: [VENDOR, '"Kestrel Fasteners ApS" (fictional)'], db: ["vendor", "V-100", "name"] },
  { path: "reference.vendors.0.registeredSenders.0", value: "orders@kestrel-fasteners.test", oracle: [VENDOR, "registered sender `orders@kestrel-fasteners.test`"], db: ["vendor_contact", "orders@kestrel-fasteners.test", "address"] },
  { path: "reference.items.0.sku", value: "PART-A", oracle: [ITEM, "`PART-A`, stock UOM `EA`"], db: ["item", "PART-A", "sku"] },
  { path: "reference.items.0.stockUom", value: "EA", oracle: [ITEM, "stock UOM `EA`"], db: ["item", "PART-A", "stock_uom"] },
  { path: "reference.items.0.integral", value: true, oracle: [ITEM, "integral quantities", "integral"], db: ["item", "PART-A", "integral"] },
  { path: `${MAP}.mappingId`, value: "MAP-1", oracle: [ITEM, "Item master `MAP-1`"], db: ["item_mapping", "MAP-1", "mapping_id"] },
  { path: `${MAP}.vendorItem`, value: "KF-A-01", oracle: [ITEM, "vendor item `KF-A-01` in `EA`"], db: ["item_mapping", "MAP-1", "vendor_item"] },
  { path: `${MAP}.sourceUom`, value: "EA", oracle: [ITEM, "vendor item `KF-A-01` in `EA`"], db: ["item_mapping", "MAP-1", "source_uom"] },
  { path: `${MAP}.sku`, value: "PART-A", oracle: [ITEM, "maps 1:1 to `PART-A` `EA`"], db: ["item_mapping", "MAP-1", "sku"] },
  { path: `${MAP}.stockUom`, value: "EA", oracle: [ITEM, "maps 1:1 to `PART-A` `EA`"], db: ["item_mapping", "MAP-1", "stock_uom"] },
  { path: `${MAP}.ratio.numerator`, value: "1", oracle: [ITEM, "maps 1:1 to `PART-A`"], context: ["maps ", ":"], db: ["item_mapping", "MAP-1", "ratio_numerator"] },
  { path: `${MAP}.ratio.denominator`, value: "1", oracle: [ITEM, "maps 1:1 to `PART-A`"], context: ["1:", " to"], db: ["item_mapping", "MAP-1", "ratio_denominator"] },
  { path: `${MAP}.effectiveFrom`, value: "2026-01-01", oracle: [ITEM, "effective from 2026-01-01"], db: ["item_mapping", "MAP-1", "effective_from"] },
  { path: `${MAP}.effectiveThrough`, value: null, oracle: [ITEM, "no end date", "no end date"], db: ["item_mapping", "MAP-1", "effective_through"] },
  { path: `${MAP}.provenance`, value: "item_master", oracle: [ITEM, "provenance item master"], db: ["item_mapping", "MAP-1", "provenance"] },

  // Simulated actors and their roles.
  ...actor(0, "buyer-1", "buyer", "`buyer-1` (buyer)", null),
  ...actor(1, "manager-1", "procurement_manager", "`manager-1` (procurement manager)", null),
  ...actor(2, "planner-1", "warehouse_planner", "`planner-1` (warehouse planner)", null),
  ...actor(3, "cs-1", "customer_service_owner", "`cs-1` (customer service owner)", null),
  ...actor(4, "supplier-1", "supplier_contact", "`supplier-1` (supplier contact for `V-100`)", "V-100"),

  // Named policies and the values the fixture binds.
  { path: "reference.policies.0.policyId", value: "CAL-CPH-1", oracle: [CAL, "`CAL-CPH-1`"], db: ["policy", "CAL-CPH-1", "policy_id"] },
  { path: "reference.policies.0.version", value: 1, oracle: [CAL, "`CAL-CPH-1` | 1 |"], db: ["policy", "CAL-CPH-1", "version"] },
  { path: "reference.policies.0.timezone", value: "Europe/Copenhagen", oracle: [CAL, "Case calendar Europe/Copenhagen"], db: ["policy", "CAL-CPH-1", "parameters.timezone"] },
  { path: "reference.policies.0.granularity", value: "date", oracle: [CAL, "date-granularity Decision"], db: ["policy", "CAL-CPH-1", "parameters.granularity"] },
  { path: "reference.policies.1.policyId", value: "ELIG-1", oracle: [ELIG, "`ELIG-1`"], db: ["policy", "ELIG-1", "policy_id"] },
  { path: "reference.policies.1.version", value: 1, oracle: [ELIG, "`ELIG-1` | 1 |"], db: ["policy", "ELIG-1", "version"] },
  { path: "reference.policies.1.subtract.0", value: "quality_holds", oracle: [ELIG, "physical - quality holds - safety stock - unrelated reservations"], db: ["policy", "ELIG-1", "parameters.subtract.0"] },
  { path: "reference.policies.1.subtract.1", value: "safety_stock", oracle: [ELIG, "physical - quality holds - safety stock - unrelated reservations"], db: ["policy", "ELIG-1", "parameters.subtract.1"] },
  { path: "reference.policies.1.subtract.2", value: "unrelated_reservations", oracle: [ELIG, "physical - quality holds - safety stock - unrelated reservations"], db: ["policy", "ELIG-1", "parameters.subtract.2"] },
  { path: "reference.policies.1.reservationCounting", value: "each_once", oracle: [ELIG, "each reservation subtracted once", "subtracted once"], db: ["policy", "ELIG-1", "parameters.reservationCounting"] },
  { path: "reference.policies.2.policyId", value: "ALLOC-1", oracle: [ALLOC, "`ALLOC-1`"], db: ["policy", "ALLOC-1", "policy_id"] },
  { path: "reference.policies.2.version", value: 1, oracle: [ALLOC, "`ALLOC-1` | 1 |"], db: ["policy", "ALLOC-1", "version"] },
  { path: "reference.policies.2.demandOrder", value: "priority_ascending", oracle: [ALLOC, "allocated in ascending numeric priority (1 first)", "ascending numeric priority"], db: ["policy", "ALLOC-1", "parameters.demandOrder"] },
  { path: "reference.policies.2.supplyOrder.0", value: "destination_eligible_stock", oracle: [ALLOC, "present eligible stock at the destination, then", "eligible stock at the destination"], db: ["policy", "ALLOC-1", "parameters.supplyOrder.0"] },
  { path: "reference.policies.2.supplyOrder.1", value: "on_time_inbound_by_earliest_arrival", oracle: [ALLOC, "then on-time inbound segments by earliest arrival, then", "on-time inbound segments by earliest arrival"], db: ["policy", "ALLOC-1", "parameters.supplyOrder.1"] },
  { path: "reference.policies.2.supplyOrder.2", value: "confirmed_on_time_transfer", oracle: [ALLOC, "then confirmed on-time transfers.", "confirmed on-time transfers"], db: ["policy", "ALLOC-1", "parameters.supplyOrder.2"] },
  { path: "reference.policies.3.policyId", value: "AUTH-1", oracle: [AUTH, "`AUTH-1`"], db: ["policy", "AUTH-1", "policy_id"] },
  { path: "reference.policies.3.version", value: 1, oracle: [AUTH, "`AUTH-1` | 1 |"], db: ["policy", "AUTH-1", "version"] },
  { path: "reference.policies.3.currency", value: "EUR", oracle: [AUTH, "currency EUR only"], db: ["policy", "AUTH-1", "parameters.currency"] },
  { path: "reference.policies.3.limits.0.role", value: "buyer", oracle: [AUTH, "Buyer limit EUR 100.00 (10 000 minor units)", "Buyer limit"], db: ["policy", "AUTH-1", "parameters.limits.0.role"] },
  { path: "reference.policies.3.limits.0.maxMinorUnits", value: 10000, oracle: [AUTH, "Buyer limit EUR 100.00 (10 000 minor units)"], context: ["(", " minor units)"], db: ["policy", "AUTH-1", "parameters.limits.0.maxMinorUnits"] },
  { path: "reference.policies.3.limits.1.role", value: "procurement_manager", oracle: [AUTH, "procurement manager limit EUR 500.00 (50 000 minor units)"], db: ["policy", "AUTH-1", "parameters.limits.1.role"] },
  { path: "reference.policies.3.limits.1.maxMinorUnits", value: 50000, oracle: [AUTH, "procurement manager limit EUR 500.00 (50 000 minor units)"], context: ["(", " minor units)"], db: ["policy", "AUTH-1", "parameters.limits.1.maxMinorUnits"] },
  { path: "reference.policies.3.transferRequires.0", value: "supplier_acknowledgement", oracle: [AUTH, "the supplier's acknowledgement of the revised schedule", "supplier's acknowledgement"], db: ["policy", "AUTH-1", "parameters.transferRequires.0"] },
  { path: "reference.policies.3.transferRequires.1", value: "warehouse_planner_confirmation", oracle: [AUTH, "the warehouse planner's confirmation", "warehouse planner's confirmation"], db: ["policy", "AUTH-1", "parameters.transferRequires.1"] },
  { path: "reference.policies.4.policyId", value: "VERIFY-1", oracle: [VERIFY, "`VERIFY-1`"], db: ["policy", "VERIFY-1", "policy_id"] },
  { path: "reference.policies.4.version", value: 1, oracle: [VERIFY, "`VERIFY-1` | 1 |"], db: ["policy", "VERIFY-1", "version"] },
  { path: "reference.policies.4.bundle", value: "complete_read_back", oracle: [VERIFY, "one read-back of every required source record and planning reference", "one read-back of every required source record"], db: ["policy", "VERIFY-1", "parameters.bundle"] },
  { path: "reference.policies.4.bundleTime", value: "earliest_read", oracle: [VERIFY, "Its time is the earliest read time in the bundle"], db: ["policy", "VERIFY-1", "parameters.bundleTime"] },
  { path: "reference.policies.4.expiry", value: "strictly_before", oracle: [VERIFY, "strictly earlier than bundle time plus 4 hours", "strictly earlier"], db: ["policy", "VERIFY-1", "parameters.expiry"] },
  { path: "reference.policies.4.validityHours", value: 4, oracle: [VERIFY, "strictly earlier than bundle time plus 4 hours"], db: ["policy", "VERIFY-1", "parameters.validityHours"] },

  // Supplier event MSG-0001 and proposal PROP-1.
  { path: "reference.supplierInputs.0.identity.messageId", value: "MSG-0001", oracle: [EVENT, "`MSG-0001`, from the registered sender"], db: ["supplier_input", "MSG-0001", "message_id"] },
  { path: "reference.supplierInputs.0.identity.sender", value: "orders@kestrel-fasteners.test", oracle: [VENDOR, "registered sender `orders@kestrel-fasteners.test`"], db: ["supplier_input", "MSG-0001", "sender"] },
  { path: "reference.supplierInputs.0.identity.proposalId", value: "PROP-1", oracle: [EVENT, "Its proposal identity is `PROP-1`"], db: ["supplier_input", "MSG-0001", "proposal_id"] },
  { path: `${TERMS}.poNumber`, value: "PO-120", oracle: [EVENT, "references `PO-120` line `10` revision `3`"], db: ["supplier_input", "MSG-0001", "content.poNumber"] },
  { path: `${TERMS}.poLine`, value: "10", oracle: [EVENT, "references `PO-120` line `10` revision `3`"], context: ["line `", "`"], db: ["supplier_input", "MSG-0001", "content.poLine"] },
  { path: `${TERMS}.baseRevision`, value: "3", oracle: [EVENT, "references `PO-120` line `10` revision `3`"], context: ["revision `", "`"], db: ["supplier_input", "MSG-0001", "content.baseRevision"] },
  { path: `${TERMS}.vendorItem`, value: "KF-A-01", oracle: [EVENT, "vendor item `KF-A-01`"], db: ["supplier_input", "MSG-0001", "content.vendorItem"] },
  { path: `${TERMS}.uom`, value: "EA", oracle: [EVENT, "UOM `EA`"], db: ["supplier_input", "MSG-0001", "content.uom"] },
  { path: `${TERMS}.segments.0.sequence`, value: 1, oracle: [ON_TIME, "40 (segment 1, arriving 2026-10-23)"], context: ["segment ", ","], db: ["supplier_input", "MSG-0001", "content.segments.0.sequence"] },
  { path: `${TERMS}.segments.0.quantity`, value: "40", oracle: [EVENT, PROPOSES], context: ["proposes ", " EA arriving 2026-10-23"], db: ["supplier_input", "MSG-0001", "content.segments.0.quantity"] },
  { path: `${TERMS}.segments.0.arrival.state`, value: "dated", oracle: [EVENT, PROPOSES, "40 EA arriving"], db: ["supplier_input", "MSG-0001", "content.segments.0.arrival.state"] },
  { path: `${TERMS}.segments.0.arrival.date`, value: "2026-10-23", oracle: [EVENT, "40 EA arriving 2026-10-23"], db: ["supplier_input", "MSG-0001", "content.segments.0.arrival.date"] },
  { path: `${TERMS}.segments.1.sequence`, value: 2, oracle: [ON_TIME, "Segment 2 (80, arriving 2026-10-26)"], context: ["Segment ", " ("], db: ["supplier_input", "MSG-0001", "content.segments.1.sequence"] },
  { path: `${TERMS}.segments.1.quantity`, value: "80", oracle: [EVENT, PROPOSES], context: ["and ", " EA arriving 2026-10-26"], db: ["supplier_input", "MSG-0001", "content.segments.1.quantity"] },
  { path: `${TERMS}.segments.1.arrival.state`, value: "dated", oracle: [EVENT, PROPOSES, "80 EA arriving"], db: ["supplier_input", "MSG-0001", "content.segments.1.arrival.state"] },
  { path: `${TERMS}.segments.1.arrival.date`, value: "2026-10-26", oracle: [EVENT, "80 EA arriving 2026-10-26"], db: ["supplier_input", "MSG-0001", "content.segments.1.arrival.date"] },

  // Clock, calendar and scenario timing.
  { path: "reference.clockStart", value: "2026-10-21T09:00:00+02:00", oracle: [CLOCK, "Controlled; starts 2026-10-21T09:00 Europe/Copenhagen"], db: ["business_clock", "1", "instant", "2026-10-21T09:00:00"] },
  { path: "reference.scenarioTimings.0.scenario", value: "C-01", oracle: ["## C-01 canonical split", "## C-01 canonical split"], db: ["scenario_timing", "C-01/approval_expiry", "scenario"] },
  { path: "reference.scenarioTimings.0.name", value: "approval_expiry", oracle: ["**Approval and acknowledgement", "(expiry 2026-10-21T18:00 for approvals)", "expiry"], db: ["scenario_timing", "C-01/approval_expiry", "name"] },
  { path: "reference.scenarioTimings.0.instant", value: "2026-10-21T18:00:00+02:00", oracle: ["**Approval and acknowledgement", "(expiry 2026-10-21T18:00 for approvals)"], db: ["scenario_timing", "C-01/approval_expiry", "instant", "2026-10-21T18:00:00"] },

  // Purchasing: PO-120 revision 3.
  { path: `${ORDER}.poNumber`, value: "PO-120", oracle: [PO, "`PO-120`, revision `3`"], db: ["po_revision", "PO-120@3", "po_number"] },
  { path: `${ORDER}.revision`, value: "3", oracle: [PO, "`PO-120`, revision `3`"], context: ["revision `", "`"], db: ["po_revision", "PO-120@3", "revision"] },
  { path: `${ORDER}.vendorId`, value: "V-100", oracle: [PO, "vendor `V-100`"], db: ["po_revision", "PO-120@3", "vendor_id"] },
  { path: `${LINE}.lineNumber`, value: "10", oracle: [PO, "line `10`: 120 EA `PART-A` to `WH-A`"], context: ["line `", "`"], db: ["po_line", "PO-120@3/10", "line_number"] },
  { path: `${LINE}.sku`, value: "PART-A", oracle: [PO, "line `10`: 120 EA `PART-A` to `WH-A`"], db: ["po_line", "PO-120@3/10", "sku"] },
  { path: `${LINE}.uom`, value: "EA", oracle: [PO, "line `10`: 120 EA `PART-A` to `WH-A`"], db: ["po_line", "PO-120@3/10", "uom"] },
  { path: `${LINE}.destination`, value: "WH-A", oracle: [PO, "line `10`: 120 EA `PART-A` to `WH-A`"], db: ["po_line", "PO-120@3/10", "destination"] },
  { path: `${LINE}.ordered`, value: "120", oracle: [PO, "line `10`: 120 EA `PART-A` to `WH-A`"], db: ["po_line", "PO-120@3/10", "ordered"] },
  { path: `${LINE}.received`, value: "0", oracle: [PO, "received 0, canceled 0"], context: ["received ", ","], db: ["po_line", "PO-120@3/10", "received"] },
  { path: `${LINE}.canceled`, value: "0", oracle: [PO, "canceled 0"], db: ["po_line", "PO-120@3/10", "canceled"] },
  { path: `${LINE}.acceptedSegments.0.quantity`, value: "120", oracle: [PO, "one segment 120 EA arriving 2026-10-23"], db: ["po_line_segment", "PO-120@3/10#1", "quantity"] },
  { path: `${LINE}.acceptedSegments.0.arrival.state`, value: "dated", oracle: [PO, "one segment 120 EA arriving 2026-10-23", "arriving"], db: ["po_line_segment", "PO-120@3/10#1", "arrival_date", "2026-10-23"] },
  { path: `${LINE}.acceptedSegments.0.arrival.date`, value: "2026-10-23", oracle: [PO, "one segment 120 EA arriving 2026-10-23"], db: ["po_line_segment", "PO-120@3/10#1", "arrival_date"] },

  // Inventory: stock snapshots, the only transfer option and no transit.
  ...stock(0, STOCK_A, "INV-A@1", "WH-A", "40", "RES-A-77", "10"),
  ...stock(1, STOCK_B, "INV-B@1", "WH-B", "70", "RES-B-31", "20"),
  { path: "inventory.inTransit", value: [], oracle: [STOCK_A, "in transit to `WH-A` 0", "in transit to `WH-A` 0"], db: ["in_transit", "", "rows", "0"] },
  { path: `${OPTION}.optionId`, value: "TRO-1", oracle: [QUOTE, "`TRO-1`: `PART-A`, `WH-B` to `WH-A`"], db: ["transfer_option", "TRO-1", "option_id"] },
  { path: `${OPTION}.sku`, value: "PART-A", oracle: [QUOTE, "`TRO-1`: `PART-A`, `WH-B` to `WH-A`"], db: ["transfer_option", "TRO-1", "sku"] },
  { path: `${OPTION}.uom`, value: "EA", oracle: [QUOTE, "exactly 50 EA"], db: ["transfer_option", "TRO-1", "uom"] },
  { path: `${OPTION}.from`, value: "WH-B", oracle: [QUOTE, "`WH-B` to `WH-A`"], db: ["transfer_option", "TRO-1", "from_warehouse"] },
  { path: `${OPTION}.to`, value: "WH-A", oracle: [QUOTE, "`WH-B` to `WH-A`"], db: ["transfer_option", "TRO-1", "to_warehouse"] },
  { path: `${OPTION}.quantity`, value: "50", oracle: [QUOTE, "exactly 50 EA"], db: ["transfer_option", "TRO-1", "quantity"] },
  { path: `${OPTION}.dispatchDate`, value: "2026-10-22", oracle: [QUOTE, "dispatch 2026-10-22"], db: ["transfer_option", "TRO-1", "dispatch_date"] },
  { path: `${OPTION}.arrivalDate`, value: "2026-10-23", oracle: [QUOTE, "arrival 2026-10-23"], db: ["transfer_option", "TRO-1", "arrival_date"] },
  { path: `${OPTION}.cost.minorUnits`, value: 16000, oracle: [QUOTE, "cost EUR 160.00 (16 000 minor units)"], context: ["(", " minor units)"], db: ["transfer_option", "TRO-1", "cost_minor_units"] },
  { path: `${OPTION}.cost.currency`, value: "EUR", oracle: [QUOTE, "cost EUR 160.00"], db: ["transfer_option", "TRO-1", "currency"] },
  { path: `${OPTION}.validUntil`, value: "2026-10-22T12:00:00+02:00", oracle: [QUOTE, "valid until 2026-10-22T12:00"], db: ["transfer_option", "TRO-1", "valid_until", "2026-10-22T12:00:00"] },
  { path: `${OPTION}.basedOn`, value: "INV-B@1", oracle: [QUOTE, "based on `INV-B@1`"], db: ["transfer_option", "TRO-1", "based_on"] },
  { path: `${OPTION}.owner`, value: "warehouse_planner", oracle: [QUOTE, "owner warehouse planner"], db: ["transfer_option", "TRO-1", "owner_role"] },

  // Demand DEM@1.
  { path: "demand.snapshots.0.version", value: "DEM@1", oracle: [DEMAND, "version `DEM@1`"], db: ["demand_snapshot", "DEM@1", "version"] },
  ...demandLine(0, "SO-201", SO201, "70", 1),
  ...demandLine(1, "SO-202", SO202, "50", 2),
];

/**
 * Manifest paths the oracle leaves unspecified (ADR 0004), each with the
 * reason it holds the value it does. `*` matches one path segment.
 */
const UNSPECIFIED: ReadonlyArray<readonly [pattern: string, reason: string]> = [
  ["fixtureVersion", "fixture metadata recorded in the seed marker"],
  ["*.*.contractVersion", "contract literal supplier-domain.v1"],
  ["*.*.*.contractVersion", "contract literal supplier-domain.v1"],
  ["*.*.*.*.contractVersion", "contract literal supplier-domain.v1"],
  ["reference.organization.organizationId", "stable synthetic application UUID"],
  ["reference.mappings.0.version", "first and only mapping version"],
  [
    "reference.mappings.0.vendorId",
    "the vendor whose item KF-A-01 is; MSG-0001 comes from its sender",
  ],
  ["reference.supplierInputs.0.identity.sourceSystem", "synthetic source-system name"],
  ["reference.supplierInputs.0.identity.inputVersion", "first and only input version"],
  ["reference.supplierInputs.0.identity.evidenceRef", "message ID and input version"],
  [
    "reference.supplierInputs.0.identity.authoredAt.state",
    "unknown: the oracle states no authored time",
  ],
  [
    "reference.supplierInputs.0.identity.receivedAt.state",
    "unknown: the oracle states no received time",
  ],
  ["reference.supplierInputs.0.terms.unresolvedFields", "none: every proposal field is stated"],
  ["purchasing.orders.0.organization", "the fixture's single organization"],
  [
    "purchasing.orders.0.lines.0.acceptedSegments.0.sequence",
    "the only accepted segment, numbered 1",
  ],
  ["purchasing.orders.0.observedAt.state", "unknown: the oracle states no PO observation time"],
  ["purchasing.orders.0.effectiveDate.state", "unknown: the oracle states no PO effective date"],
  ["inventory.snapshots.*.organization", "the fixture's single organization"],
  ["demand.snapshots.0.organization", "the fixture's single organization"],
  ["demand.snapshots.0.observedAt.state", "unknown: the oracle states no demand observation time"],
];

const ORACLE_PATH = `${REPO_ROOT}docs/oracles/first-slice-oracles.md`;
const oracleBytes = readFileSync(ORACLE_PATH);
const oracleLines = oracleBytes.toString("utf8").split("\n");

const SEMANTIC = /^[a-z_]+$/;
/** A form that is a number, such as 1, 120 or 10 000. */
const NUMBER = /^\d+(?: \d{3})*$/;
/** Zero quantities the oracle states in words: "no holds" and "no safety stock". */
const ZERO_STATED_AS_NONE = ["qualityHold", "safetyStock"];

/**
 * How a literal appears in the oracle: quantities, labels and dates as they
 * are; minor units of 10 000 or more grouped with spaces; Copenhagen
 * October instants (+02:00) without seconds and offset; fictional names
 * quoted; snake-case tokens as words.
 */
function oracleForm(value: Value): string | undefined {
  if (typeof value === "number") {
    return value >= 10_000 ? value.toLocaleString("en-US").replaceAll(",", " ") : String(value);
  }
  if (typeof value !== "string") return undefined;
  const instant = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):00\+02:00$/.exec(value);
  if (instant !== null) return instant[1];
  const fictional = /^(.*) \(fictional\)$/.exec(value);
  if (fictional !== null) return `"${fictional[1]}" (fictional)`;
  if (SEMANTIC.test(value)) return value.replaceAll("_", " ");
  return value;
}

/**
 * The standalone numbers in an oracle phrase. Labels in backticks, dates and
 * instants are not numbers; "10 000" and "100.00" are one number each.
 */
function standaloneNumbers(phrase: string): string[] {
  const text = phrase.replace(/`[^`]*`/g, " ").replace(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/g, " ");
  return text.match(/(?<![\w.])\d+(?: \d{3})*(?:\.\d+)?(?![\w.])/g) ?? [];
}

function oracleLine(prefix: string): string {
  const matches = oracleLines.filter((line) => line.startsWith(prefix));
  expect(matches, `oracle lines starting with ${prefix}`).toHaveLength(1);
  return matches[0]!;
}

function at(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, root);
}

/** Leaf paths of the manifest: scalars, null and empty arrays. */
function leaves(node: unknown, prefix = ""): string[] {
  if (node !== null && typeof node === "object" && !(Array.isArray(node) && node.length === 0)) {
    return Object.entries(node).flatMap(([key, child]) =>
      leaves(child, prefix === "" ? key : `${prefix}.${key}`),
    );
  }
  return [prefix];
}

function matches(pattern: string, path: string): boolean {
  const a = pattern.split(".");
  const b = path.split(".");
  return a.length === b.length && a.every((part, index) => part === "*" || part === b[index]);
}

const db = new DisposableDatabase("trace");
const tables = new Map<string, Row[]>();

beforeAll(
  async () => {
    await db.start();
    expect((await db.migrate()).code).toBe(0);
    expect((await db.seed()).code).toBe(0);
    const observer = await db.client("migrator", "d11-observer");
    for (const [name, query] of Object.entries(CANONICAL_QUERIES)) {
      tables.set(name, (await observer.query<Row>(query.sql)).rows);
    }
    tables.set("derived_eligible", (await observer.query<Row>(DERIVED_ELIGIBLE_QUERY)).rows);
    tables.set(
      "eligible_columns",
      (
        await observer.query<Row>(
          `SELECT table_schema || '.' || table_name || '.' || column_name AS name
             FROM information_schema.columns
            WHERE table_schema LIKE 'fixture\\_%' AND column_name LIKE '%eligib%'`,
        )
      ).rows,
    );
    tables.set(
      "output_tables",
      (
        await observer.query<Row>(
          `SELECT schemaname || '.' || tablename AS name FROM pg_tables
            WHERE schemaname LIKE 'fixture\\_%'
              AND tablename ~ '(plan|approval|acknowledg|confirmation|journal|case|allocation|action)'`,
        )
      ).rows,
    );
  },
  START_TIMEOUT_MS + 2 * NODE_TIMEOUT_MS,
);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

function dbCell(trace: Trace): unknown {
  const [table, key, column] = trace.db;
  const rows = tables.get(table) ?? [];
  if (column === "rows") return String(rows.length);
  const query = CANONICAL_QUERIES[table] as { key: (row: Row) => string };
  const found = rows.filter((row) => query.key(row) === key);
  expect(found, `${table} row ${key}`).toHaveLength(1);
  const [name, ...json] = column.split(".");
  const cell = found[0]![name!];
  if (json.length === 0) return cell;
  return at(JSON.parse(String(cell)) as unknown, json.join("."));
}

describe("D11 oracle trace", () => {
  it("reads the exact frozen oracle bytes", () => {
    expect(createHash("sha256").update(oracleBytes).digest("hex")).toBe(FROZEN_ORACLE_SHA256);
  });

  it.each(TRACE.map((trace) => [trace.path, trace] as const))(
    "%s matches its oracle phrase, the manifest and the database",
    (_path, trace) => {
      const [prefix, phrase, shown] = trace.oracle;
      expect(oracleLine(prefix)).toContain(phrase);
      if (shown === undefined) {
        const form = oracleForm(trace.value);
        expect(form, "a literal without a fixed oracle form needs shown words").toBeDefined();
        expect(phrase).toContain(form);
        if (trace.context !== undefined) {
          const [before, after] = trace.context;
          expect(phrase).toContain(`${before}${form}${after}`);
        } else if (NUMBER.test(form!)) {
          // A digit is in almost every phrase, so a number must be the only one.
          expect(
            standaloneNumbers(phrase),
            "a number needs a phrase of its own or a context",
          ).toEqual([form]);
        }
      } else {
        // Only semantic tokens may name the words that show them; quantities,
        // labels, dates and instants must appear in their own form.
        const semantic =
          typeof trace.value === "boolean" ||
          trace.value === null ||
          Array.isArray(trace.value) ||
          (typeof trace.value === "string" && SEMANTIC.test(trace.value)) ||
          ZERO_STATED_AS_NONE.includes(trace.path.split(".").at(-1)!);
        expect(semantic, "shown words are only for semantic tokens").toBe(true);
        expect(phrase).toContain(shown);
      }

      expect(at(CANONICAL_MANIFEST, trace.path)).toEqual(trace.value);

      const [, , column, expected] = trace.db;
      const json = column.includes(".");
      const want =
        expected !== undefined
          ? expected
          : json || trace.value === null
            ? trace.value
            : String(trace.value);
      expect(dbCell(trace)).toEqual(want);
    },
  );

  it("traces or lists every manifest input path, and nothing else", () => {
    const paths = leaves(CANONICAL_MANIFEST);
    const traced = new Set(TRACE.map((trace) => trace.path));
    expect(traced.size, "duplicate trace paths").toBe(TRACE.length);
    for (const path of traced) expect(paths, `stale trace ${path}`).toContain(path);
    for (const [pattern] of UNSPECIFIED) {
      expect(
        paths.some((path) => matches(pattern, path)),
        `stale pattern ${pattern}`,
      ).toBe(true);
    }
    const unspecified = paths.filter((path) =>
      UNSPECIFIED.some(([pattern]) => matches(pattern, path)),
    );
    for (const path of unspecified) expect(traced.has(path), `${path} is both`).toBe(false);
    const untraced = paths.filter((path) => !traced.has(path) && !unspecified.includes(path));
    expect(untraced).toEqual([]);
  });

  it("derives eligible 30 and 50 from the raw stock buckets and reservations", () => {
    expect(oracleLine(STOCK_A)).toContain("eligible 30");
    expect(oracleLine(STOCK_B)).toContain("eligible 50");
    expect(oracleLine("| Eligible at `WH-A` / `WH-B` |")).toContain("30 / 50");
    expect(sortRows(tables.get("derived_eligible") ?? [])).toEqual(DERIVED_ELIGIBLE);
  });

  it("seeds inputs only: no eligible counter, plan, approval or other expected output", () => {
    expect(tables.get("eligible_columns")).toEqual([]);
    expect(tables.get("output_tables")).toEqual([]);
    const manifest = JSON.stringify(CANONICAL_MANIFEST);
    // ALLOC-1 names "destination_eligible_stock" as a supply source; no field holds an eligible quantity.
    expect(manifest).not.toMatch(/"eligible[A-Za-z]*":/);
    for (const output of ["PLAN-1", '"H1"', "ACT-1", "shortage", "coverage", "allocation"]) {
      expect(manifest, output).not.toContain(output);
    }
  });

  it("hashes the supplier terms independently of the message ID", () => {
    expect(createHash("sha256").update(SUPPLIER_TERMS_CANONICAL_JSON, "utf8").digest("hex")).toBe(
      SUPPLIER_CONTENT_SHA256,
    );
    const [row] = tables.get("supplier_input") ?? [];
    expect(row?.content_sha256).toBe(SUPPLIER_CONTENT_SHA256);
    expect(JSON.parse(String(row?.content))).toEqual(JSON.parse(SUPPLIER_TERMS_CANONICAL_JSON));
    expect(SUPPLIER_TERMS_CANONICAL_JSON).not.toContain("MSG-0001");
  });

  it("matches every canonical table exactly", () => {
    for (const [name, query] of Object.entries(CANONICAL_QUERIES)) {
      expect(sortRows<Row>(tables.get(name) ?? []), name).toEqual(sortRows<Row>(query.rows));
    }
  });
});
