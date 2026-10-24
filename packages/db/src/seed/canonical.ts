import {
  DOMAIN_CONTRACT_VERSION,
  type DemandSnapshot,
  type PurchaseOrderRevision,
} from "@supplier-disruption/contracts";
import type { InventoryInputs } from "../authorities/inventory/initialize.js";
import type { ReferenceInputs } from "../authorities/reference/initialize.js";

/**
 * The canonical first-slice base fixture (frozen oracle, "Canonical base
 * fixture"), as original normalized structured inputs awaiting intake. It is
 * not accepted evidence. Values the oracle leaves unspecified are listed in
 * ADR 0004 and are explicit unknowns wherever no value was stated.
 */
export const CANONICAL_FIXTURE_VERSION = "first-slice-c01.v1";

/** SHA-256 of docs/oracles/first-slice-oracles.md, version 4, recorded in the seed marker. */
export const FROZEN_ORACLE_SHA256 =
  "b90368cb66fec1b3122092153bd98337292b168b68ca5a568a46878fe189e8ea";

export interface CanonicalManifest {
  fixtureVersion: string;
  reference: ReferenceInputs;
  purchasing: { orders: readonly PurchaseOrderRevision[] };
  inventory: InventoryInputs;
  demand: { snapshots: readonly DemandSnapshot[] };
}

const contractVersion = DOMAIN_CONTRACT_VERSION;
const unknown = { state: "unknown" } as const;

export const CANONICAL_MANIFEST: CanonicalManifest = {
  fixtureVersion: CANONICAL_FIXTURE_VERSION,
  reference: {
    organization: {
      contractVersion,
      label: "ORG-NDL",
      organizationId: "ed222926-927c-460e-8d28-e22ab5620819",
      name: "Nordlund Distribution (fictional)",
    },
    vendors: [
      {
        contractVersion,
        vendorId: "V-100",
        name: "Kestrel Fasteners ApS (fictional)",
        registeredSenders: ["orders@kestrel-fasteners.test"],
      },
    ],
    items: [{ contractVersion, sku: "PART-A", stockUom: "EA", integral: true }],
    mappings: [
      {
        contractVersion,
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
      },
    ],
    actors: [
      { contractVersion, actorId: "buyer-1", role: "buyer", vendorId: null, simulated: true },
      {
        contractVersion,
        actorId: "manager-1",
        role: "procurement_manager",
        vendorId: null,
        simulated: true,
      },
      {
        contractVersion,
        actorId: "planner-1",
        role: "warehouse_planner",
        vendorId: null,
        simulated: true,
      },
      {
        contractVersion,
        actorId: "cs-1",
        role: "customer_service_owner",
        vendorId: null,
        simulated: true,
      },
      {
        contractVersion,
        actorId: "supplier-1",
        role: "supplier_contact",
        vendorId: "V-100",
        simulated: true,
      },
    ],
    policies: [
      {
        contractVersion,
        policyId: "CAL-CPH-1",
        version: 1,
        timezone: "Europe/Copenhagen",
        granularity: "date",
      },
      {
        contractVersion,
        policyId: "ELIG-1",
        version: 1,
        subtract: ["quality_holds", "safety_stock", "unrelated_reservations"],
        reservationCounting: "each_once",
      },
      {
        contractVersion,
        policyId: "ALLOC-1",
        version: 1,
        demandOrder: "priority_ascending",
        supplyOrder: [
          "destination_eligible_stock",
          "on_time_inbound_by_earliest_arrival",
          "confirmed_on_time_transfer",
        ],
      },
      {
        contractVersion,
        policyId: "AUTH-1",
        version: 1,
        currency: "EUR",
        limits: [
          { role: "buyer", maxMinorUnits: 10_000 },
          { role: "procurement_manager", maxMinorUnits: 50_000 },
        ],
        transferRequires: ["supplier_acknowledgement", "warehouse_planner_confirmation"],
      },
      {
        contractVersion,
        policyId: "VERIFY-1",
        version: 1,
        bundle: "complete_read_back",
        bundleTime: "earliest_read",
        expiry: "strictly_before",
        validityHours: 4,
      },
    ],
    supplierInputs: [
      {
        identity: {
          contractVersion,
          sourceSystem: "fixture-supplier-mail",
          messageId: "MSG-0001",
          inputVersion: 1,
          sender: "orders@kestrel-fasteners.test",
          proposalId: "PROP-1",
          evidenceRef: "MSG-0001@1",
          authoredAt: unknown,
          receivedAt: unknown,
        },
        terms: {
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
        },
      },
    ],
    scenarioTimings: [
      {
        contractVersion,
        scenario: "C-01",
        name: "approval_expiry",
        instant: "2026-10-21T18:00:00+02:00",
      },
    ],
    clockStart: "2026-10-21T09:00:00+02:00",
  },
  purchasing: {
    orders: [
      {
        contractVersion,
        organization: "ORG-NDL",
        poNumber: "PO-120",
        revision: "3",
        vendorId: "V-100",
        observedAt: unknown,
        effectiveDate: unknown,
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
      },
    ],
  },
  inventory: {
    snapshots: [
      {
        contractVersion,
        organization: "ORG-NDL",
        version: "INV-A@1",
        sku: "PART-A",
        warehouse: "WH-A",
        uom: "EA",
        observedAt: { state: "known", value: "2026-10-21T08:55:00+02:00" },
        physical: "40",
        qualityHold: "0",
        safetyStock: "0",
        reservations: [
          { reservationId: "RES-A-77", quantity: "10", binding: { kind: "unrelated" } },
        ],
      },
      {
        contractVersion,
        organization: "ORG-NDL",
        version: "INV-B@1",
        sku: "PART-A",
        warehouse: "WH-B",
        uom: "EA",
        observedAt: { state: "known", value: "2026-10-21T08:55:00+02:00" },
        physical: "70",
        qualityHold: "0",
        safetyStock: "0",
        reservations: [
          { reservationId: "RES-B-31", quantity: "20", binding: { kind: "unrelated" } },
        ],
      },
    ],
    transferOptions: [
      {
        contractVersion,
        optionId: "TRO-1",
        sku: "PART-A",
        uom: "EA",
        from: "WH-B",
        to: "WH-A",
        quantity: "50",
        dispatchDate: "2026-10-22",
        arrivalDate: "2026-10-23",
        cost: { minorUnits: 16_000, currency: "EUR" },
        validUntil: "2026-10-22T12:00:00+02:00",
        basedOn: "INV-B@1",
        owner: "warehouse_planner",
      },
    ],
    // Canonical transit to WH-A is 0: no in-transit records exist.
    inTransit: [],
  },
  demand: {
    snapshots: [
      {
        contractVersion,
        organization: "ORG-NDL",
        version: "DEM@1",
        observedAt: unknown,
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
    ],
  },
};
