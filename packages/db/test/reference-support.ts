// Shared setup for the reference read gates (R1 to R5). Expected
// records are independently written literals from the frozen oracle
// (docs/oracles/first-slice-oracles.md, "Named policies" and "Canonical
// base fixture"); none is imported from the seed manifest, its hash helpers
// or the source modules' decoders. Supplemental rows are written with raw SQL
// on a separate migrator connection and labeled as such in each test.
import { createHash } from "node:crypto";
import type { Clock } from "@supplier-disruption/contracts";
import type pg from "pg";
import { expect } from "vitest";
import { createInventorySource } from "../src/authorities/inventory/index.js";
import {
  createReferenceSource,
  type FixtureOrganization,
  type SourceTimeouts,
} from "../src/authorities/reference/index.js";
import { createControlledClock } from "../src/clock.js";
import type { DisposableDatabase } from "./disposable.js";

const v = "supplier-domain.v1";

export const ORG = "ORG-NDL";
export const ORG_ID = "ed222926-927c-460e-8d28-e22ab5620819";
export const FIXTURE: FixtureOrganization = { label: ORG, organizationId: ORG_ID };
export const VALIDATED = { state: "validated", label: ORG, organizationId: ORG_ID } as const;
export const ATTEMPTED = { state: "attempted", label: ORG, organizationId: ORG_ID } as const;

/** The controlled clock's start, 2026-10-21T09:00 Europe/Copenhagen, as the clock reports it. */
export const CLOCK_START = "2026-10-21T07:00:00.000Z";

export const PART_A = { contractVersion: v, sku: "PART-A", stockUom: "EA", integral: true };

export const MAP_1 = {
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

export const POLICIES = {
  "CAL-CPH-1": {
    contractVersion: v,
    policyId: "CAL-CPH-1",
    version: 1,
    timezone: "Europe/Copenhagen",
    granularity: "date",
  },
  "ELIG-1": {
    contractVersion: v,
    policyId: "ELIG-1",
    version: 1,
    subtract: ["quality_holds", "safety_stock", "unrelated_reservations"],
    reservationCounting: "each_once",
  },
  "ALLOC-1": {
    contractVersion: v,
    policyId: "ALLOC-1",
    version: 1,
    demandOrder: "priority_ascending",
    supplyOrder: [
      "destination_eligible_stock",
      "on_time_inbound_by_earliest_arrival",
      "confirmed_on_time_transfer",
    ],
  },
  // EUR 100.00 and EUR 500.00 in minor units.
  "AUTH-1": {
    contractVersion: v,
    policyId: "AUTH-1",
    version: 1,
    currency: "EUR",
    limits: [
      { role: "buyer", maxMinorUnits: 10000 },
      { role: "procurement_manager", maxMinorUnits: 50000 },
    ],
    transferRequires: ["supplier_acknowledgement", "warehouse_planner_confirmation"],
  },
} as const;

export const SENDER = "orders@kestrel-fasteners.test";

export const V_100 = {
  contractVersion: v,
  vendorId: "V-100",
  name: "Kestrel Fasteners ApS (fictional)",
  registeredSenders: [SENDER],
};

export const MSG_0001_TERMS = {
  poNumber: "PO-120",
  poLine: "10",
  baseRevision: "3",
  vendorItem: "KF-A-01",
  uom: "EA",
  segments: [
    { sequence: 1, quantity: "40", arrival: { state: "dated", date: "2026-10-23" } },
    { sequence: 2, quantity: "80", arrival: { state: "dated", date: "2026-10-26" } },
  ],
  unresolvedFields: [],
};

/**
 * The canonical JSON of MSG-0001's terms, written out by hand with sorted
 * keys, and its SHA-256. The seed computes the stored hash with its own
 * helper; this is the independent expectation.
 */
export const MSG_0001_CANONICAL =
  '{"baseRevision":"3","poLine":"10","poNumber":"PO-120","segments":[' +
  '{"arrival":{"date":"2026-10-23","state":"dated"},"quantity":"40","sequence":1},' +
  '{"arrival":{"date":"2026-10-26","state":"dated"},"quantity":"80","sequence":2}],' +
  '"unresolvedFields":[],"uom":"EA","vendorItem":"KF-A-01"}';
export const MSG_0001_SHA256 = "43dec39141c2d85db55a875337863ab50fbb3e5cb30a0bcc0a0040ef3478803c";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const MSG_0001 = {
  identity: {
    contractVersion: v,
    sourceSystem: "fixture-supplier-mail",
    messageId: "MSG-0001",
    inputVersion: 1,
    contentSha256: MSG_0001_SHA256,
    sender: SENDER,
    proposalId: "PROP-1",
    evidenceRef: "MSG-0001@1",
    authoredAt: { state: "unknown" },
    receivedAt: { state: "unknown" },
  },
  terms: MSG_0001_TERMS,
};

/** TRO-1 as read on a UTC session: valid until 2026-10-22T12:00 Copenhagen. */
export const TRO_1 = {
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
  validUntil: "2026-10-22T10:00:00+00:00",
  basedOn: "INV-B@1",
  owner: "warehouse_planner",
};

/** The canonical transfer scope: PART-A in EA from WH-B to WH-A. */
export const TRANSFER_QUERY = {
  organization: ORG,
  sku: "PART-A",
  uom: "EA",
  fromWarehouse: "WH-B",
  toWarehouse: "WH-A",
};

export function referenceScope(
  resource: string,
  selectors: Record<string, unknown>,
  binding: unknown = VALIDATED,
  organization = ORG,
) {
  return { owner: "reference", resource, organization, selectors, binding };
}

export function transferScope(query: Record<string, unknown> = TRANSFER_QUERY) {
  const { organization, ...selectors } = query;
  return { owner: "inventory", resource: "transfer_options", organization, selectors, bound: 100 };
}

export interface ReaderOptions {
  pool?: pg.Pool;
  max?: number;
  sessionOptions?: string;
  clock?: Clock;
  fixture?: FixtureOrganization;
  timeouts?: Partial<SourceTimeouts>;
}

/**
 * The reference and inventory sources on an API-role pool, as the API would
 * compose them. The controlled clock always has its own pool, separate from
 * the source pool, whatever the source pool's size (ADR 0005).
 */
export function readers(db: DisposableDatabase, name: string, options: ReaderOptions = {}) {
  const pool = options.pool ?? db.pool("api", name, options.max ?? 4, options.sessionOptions);
  const clockPool = db.pool("api", `${name}-clock`, 2);
  const clock = options.clock ?? createControlledClock(clockPool);
  const source = { pool, clock, timeouts: options.timeouts };
  return {
    pool,
    clockPool,
    clock,
    reference: createReferenceSource({
      ...source,
      fixtureOrganization: options.fixture ?? FIXTURE,
    }),
    inventory: createInventorySource(source),
  };
}

/** Every pooled client is back and idle, and nothing waits for one. */
export function expectPoolSettled(pool: pg.Pool): void {
  expect({ idle: pool.idleCount, waiting: pool.waitingCount }).toEqual({
    idle: pool.totalCount,
    waiting: 0,
  });
}

/**
 * Every fixture source and reference table, the clock and seed marker, and the
 * application's pilot, organization and identity records. Fingerprinted with
 * xmin, a read that rewrote a row with equal values is still visible.
 * worker.heartbeat is excluded: the worker owns it and no source reads it.
 */
export const ALL_RECORDS = [
  "fixture_purchasing.po_revision",
  "fixture_purchasing.po_line",
  "fixture_purchasing.po_line_segment",
  "fixture_purchasing.po_head",
  "fixture_purchasing.operation",
  "fixture_purchasing.operation_receipt",
  "fixture_inventory.stock_snapshot",
  "fixture_inventory.reservation",
  "fixture_inventory.stock_head",
  "fixture_inventory.transfer_option",
  "fixture_inventory.in_transit",
  "fixture_inventory.transfer_request",
  "fixture_inventory.transfer_observation",
  "fixture_inventory.operation",
  "fixture_inventory.operation_receipt",
  "fixture_demand.demand_snapshot",
  "fixture_demand.demand_line",
  "fixture_demand.supply_link",
  "fixture_demand.demand_head",
  "fixture_reference.organization_alias",
  "fixture_reference.vendor",
  "fixture_reference.vendor_contact",
  "fixture_reference.item",
  "fixture_reference.item_mapping",
  "fixture_reference.actor",
  "fixture_reference.policy",
  "fixture_reference.supplier_input",
  "fixture_reference.scenario_timing",
  "fixture_reference.business_clock",
  "fixture_reference.seed_marker",
  "app.organization",
  "app.membership",
  "app.pilot_operation",
  "app.pilot_handler_attempt",
  "app.pilot_receipt_attempt",
  "app.schema_tag",
  "auth.user",
  "auth.account",
  "auth.session",
  "auth.verification",
] as const;

/** Row counts of every recorded table, read by a second observer. */
export async function recordCounts(observer: pg.Client): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ALL_RECORDS) {
    const { rows } = await observer.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = Number(rows[0]?.n);
  }
  return counts;
}

/** The fields an unavailable read must never carry. */
export function expectNoEvidence(result: object): void {
  for (const field of ["data", "readAt", "observedAt"]) {
    expect(result, field).not.toHaveProperty(field);
  }
}
