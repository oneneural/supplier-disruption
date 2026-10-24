// P7 public-source consumption and purity (ADR 0007). The merged
// public authority and reference reads are composed here, in the test, into the
// assessment contract and passed to the pure domain policy. Expected values
// are the hand-written literals in policy-literals.ts; a separate migrator
// connection observes every source and reference row through raw SQL. The
// clock has its own pool, separate from the source pool (ADR 0005).
import { createServer } from "node:net";
import { assessCoverage } from "@supplier-disruption/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemandSource } from "../src/authorities/demand/index.js";
import {
  SourceRejectedError,
  createInventorySource,
  type InventorySource,
} from "../src/authorities/inventory/index.js";
import { createPurchasingSource } from "../src/authorities/purchasing/index.js";
import { createReferenceSource } from "../src/authorities/reference/index.js";
import { BusinessClockError, createControlledClock } from "../src/clock.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import * as L from "./policy-literals.js";
import { ALL_RECORDS } from "./reference-support.js";
import { fingerprint, rows, setClock } from "./source-support.js";

const db = new DisposableDatabase("p7");
let observer: pg.Client;

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "p7-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

const UNKNOWN = { state: "unknown" } as const;
type Scope = { owner: string; resource: string; organization: string; selectors: object };

/** The merged public sources on one API-role pool and a controlled clock on its own pool. */
function sources(name: string) {
  const pool = db.pool("api", name);
  const clock = createControlledClock(db.pool("api", `${name}-clock`, 2));
  const options = { pool, clock };
  return {
    clock,
    purchasing: createPurchasingSource(options),
    inventory: createInventorySource(options),
    demand: createDemandSource(options),
    reference: createReferenceSource({ ...options, fixtureOrganization: L.FIXTURE }),
  };
}
type Sources = ReturnType<typeof sources>;

/**
 * Classifies a thrown fixture-source read failure into typed evidence. A missing
 * record is attributable absence, everything else is unavailable; neither
 * carries a read time the source never returned.
 */
function classify(scope: Scope, error: unknown) {
  if (error instanceof SourceRejectedError && error.reason === "source.not_found") {
    return { status: "not_found", scope, readAt: UNKNOWN, reason: error.reason };
  }
  const code = (error as { code?: unknown }).code;
  const reason =
    error instanceof SourceRejectedError
      ? error.reason
      : error instanceof BusinessClockError
        ? "clock_unavailable"
        : code === "ECONNREFUSED"
          ? "connection_unavailable"
          : "read_failed";
  return { status: "unavailable", scope, reason, attemptedAt: UNKNOWN };
}

/** A fixture authority read: its envelope returns no observation time, so none is stated. */
async function sourceRead<R extends { readAt: string }>(
  scope: Scope,
  read: () => Promise<R>,
  toData: (result: R) => unknown,
) {
  try {
    const result = await read();
    return {
      status: "ok",
      provenance: { scope, readAt: result.readAt, observedAt: { state: "not_returned" } },
      data: toData(result),
    };
  } catch (error) {
    return classify(scope, error);
  }
}

type PublicRead =
  | { status: "ok"; scope: object; readAt: string; observedAt: { state: "unknown" }; data: unknown }
  | { status: "not_found" | "ambiguous"; scope: object; readAt: string; reason: string }
  | { status: "unavailable"; scope: object; reason: string; attemptedAt?: string };

/**
 * A reference read outcome, unchanged except for shape. An invalid query
 * echoes unvalidated selectors, so the intended scope stands in for it; the
 * reason is narrowed before the optional attempted time is read.
 */
function publicRead(result: PublicRead, intended: Scope) {
  switch (result.status) {
    case "ok":
      return {
        status: "ok",
        provenance: { scope: result.scope, readAt: result.readAt, observedAt: result.observedAt },
        data: result.data,
      };
    case "not_found":
      return {
        status: result.status,
        scope: result.scope,
        readAt: { state: "known", value: result.readAt },
        reason: result.reason,
      };
    case "ambiguous":
      return {
        status: result.status,
        scope: result.scope,
        readAt: result.readAt,
        reason: result.reason,
      };
    case "unavailable":
      return {
        status: "unavailable",
        scope: result.reason === "invalid_query" ? intended : result.scope,
        reason: result.reason,
        attemptedAt:
          result.reason !== "invalid_query" && result.attemptedAt !== undefined
            ? { state: "known", value: result.attemptedAt }
            : UNKNOWN,
      };
  }
}

const stockScope = (warehouse: string) => ({
  owner: "inventory",
  resource: "stock",
  organization: L.ORG,
  selectors: { sku: "PART-A", warehouse },
});
const transitScope = (warehouse: string) => ({ ...stockScope(warehouse), resource: "in_transit" });
const referenceScope = (resource: string, selectors: object) => ({
  owner: "reference",
  resource,
  organization: L.ORG,
  selectors,
  binding: { state: "attempted", ...L.FIXTURE },
});

/** A query's selectors: every field but the organization. */
function withoutOrganization(query: { organization: string }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([key]) => key !== "organization"));
}

interface Overrides {
  /** Reads WH-B stock through this inventory source instead. */
  stockB?: InventorySource;
  authorizationVersion?: number;
}

/** Composes C-01's assessment input from actual public reads, each in its own transaction. */
async function compose(src: Sources, assessedAt: string, overrides: Overrides = {}) {
  const stock = (warehouse: string, inventory: InventorySource) =>
    sourceRead(
      stockScope(warehouse),
      () => inventory.readStock(L.STOCK_QUERY(warehouse)),
      ({ currentVersion, record, lineage }) => ({ currentVersion, record, lineage }),
    );
  const transit = (warehouse: string) =>
    sourceRead(
      transitScope(warehouse),
      () => src.inventory.readInTransit(L.STOCK_QUERY(warehouse)),
      ({ records }) => ({ records }),
    );
  const policy = async (policyId: (typeof L.POLICY_IDS)[number], version = 1) => {
    const query = { organization: L.ORG, policyId, version };
    return publicRead(
      await src.reference.readPolicy(query),
      referenceScope("policy", { policyId, version }),
    );
  };
  const mappingSelectors = withoutOrganization(L.MAPPING_QUERY);
  const supplierSelectors = withoutOrganization(L.SUPPLIER_QUERY);
  const optionSelectors = withoutOrganization(L.OPTIONS_QUERY);
  return {
    contractVersion: "coverage-assessment.v1",
    organization: L.ORG,
    assessedAt,
    planId: "PLAN-1",
    planVersion: 1,
    vendorId: "V-100",
    poLine: { poNumber: "PO-120", poLine: "10" },
    proposalId: "PROP-1",
    reads: {
      supplierInput: publicRead(
        await src.reference.readSupplierInput(L.SUPPLIER_QUERY),
        referenceScope("supplier_input", supplierSelectors),
      ),
      purchaseOrder: await sourceRead(
        {
          owner: "purchasing",
          resource: "purchase_order",
          organization: L.ORG,
          selectors: { poNumber: "PO-120" },
        },
        () => src.purchasing.readPurchaseOrder(L.PO_QUERY),
        ({ currentRevision, record }) => ({ currentRevision, record }),
      ),
      demand: await sourceRead(
        { owner: "demand", resource: "demand", organization: L.ORG, selectors: {} },
        () => src.demand.readDemand(L.DEMAND_QUERY),
        ({ currentVersion, record }) => ({ currentVersion, record }),
      ),
      stock: [
        { warehouse: "WH-A", read: await stock("WH-A", src.inventory) },
        { warehouse: "WH-B", read: await stock("WH-B", overrides.stockB ?? src.inventory) },
      ],
      inTransit: [
        { warehouse: "WH-A", read: await transit("WH-A") },
        { warehouse: "WH-B", read: await transit("WH-B") },
      ],
      transferOptions: publicRead(await src.inventory.readTransferOptions(L.OPTIONS_QUERY), {
        owner: "inventory",
        resource: "transfer_options",
        organization: L.ORG,
        selectors: optionSelectors,
      }),
      item: publicRead(
        await src.reference.readItem(L.ITEM_QUERY),
        referenceScope("item", { sku: "PART-A" }),
      ),
      itemMappings: publicRead(
        await src.reference.readItemMappings(L.MAPPING_QUERY),
        referenceScope("item_mappings", mappingSelectors),
      ),
      policies: {
        calendar: await policy("CAL-CPH-1"),
        eligibility: await policy("ELIG-1"),
        allocation: await policy("ALLOC-1"),
        authorization: await policy("AUTH-1", overrides.authorizationVersion),
      },
    },
    candidateOffers: [],
  };
}

type Input = Awaited<ReturnType<typeof compose>>;

/** Every read's read time and envelope observation time, in input order. */
function readTimes(input: Input) {
  const reads = [
    input.reads.supplierInput,
    input.reads.purchaseOrder,
    input.reads.demand,
    ...input.reads.stock.map((entry) => entry.read),
    ...input.reads.inTransit.map((entry) => entry.read),
    input.reads.transferOptions,
    input.reads.item,
    input.reads.itemMappings,
    ...Object.values(input.reads.policies),
  ];
  return reads.map((read) =>
    "provenance" in read && read.provenance !== undefined ? read.provenance.readAt : read.status,
  );
}

const SOURCE_TABLES = ALL_RECORDS.filter((table) => table !== "fixture_reference.business_clock");

function summary(result: ReturnType<typeof assessCoverage>) {
  return {
    decision: result.decision,
    totals: result.totals,
    eligible: result.eligibility.map((entry) =>
      entry.state === "known"
        ? [entry.warehouse, entry.stockVersion, entry.physical, entry.eligible]
        : [entry.warehouse, entry.reason],
    ),
    allocations: result.allocations.map((entry) => [
      entry.demandLine.salesOrder,
      entry.stage,
      entry.supply.kind,
      entry.supply.kind === "stock"
        ? entry.supply.warehouse
        : entry.supply.kind === "po_segment"
          ? `${entry.supply.poNumber}@${entry.supply.revision}/${entry.supply.poLine}#${entry.supply.sequence}`
          : entry.supply.kind === "transfer_option"
            ? entry.supply.optionId
            : entry.supply.kind === "prior_commitment"
              ? entry.supply.commitmentId
              : entry.supply.transitId,
      entry.quantity,
    ]),
  };
}

describe("P7 public-source consumption and purity", () => {
  it("assesses C-01 from the merged public reads and binds their actual provenance, writing nothing", async () => {
    const src = sources("p7-c01");
    const before = await fingerprint(observer, SOURCE_TABLES);
    const input = await compose(src, L.CLOCK_START);
    const result = assessCoverage(input);
    expect(await fingerprint(observer, SOURCE_TABLES)).toBe(before);

    expect(summary(result)).toEqual({
      decision: L.C01_DECISION,
      totals: L.C01_TOTALS,
      eligible: L.C01_ELIGIBLE,
      allocations: L.C01_ALLOCATIONS,
    });
    const plan = result.plan;
    if (plan === null) throw new Error("C-01 must propose a plan");
    expect(plan.payload.actions.map((action) => [action.actionId, action.kind])).toEqual(
      L.C01_ACTIONS,
    );
    expect(plan.payload.authorization.cost).toEqual({ minorUnits: 16000, currency: "EUR" });
    expect(plan.payload.proposal.contentSha256).toBe(L.MSG_0001_SHA256);
    expect(
      plan.payload.bindings.map((entry) => [
        entry.kind,
        entry.key,
        entry.version,
        entry.currentVersion,
        entry.members,
      ]),
    ).toEqual(L.C01_BINDINGS);
    for (const entry of plan.payload.bindings) {
      expect(entry.readAt).toBe(L.CLOCK_START);
      expect([entry.kind, entry.observedAt.state]).toEqual([
        entry.kind,
        (L.C01_OBSERVED as Record<string, string>)[entry.kind],
      ]);
    }
    const stockBinding = plan.payload.bindings.find((entry) => entry.kind === "stock");
    const observed = stockBinding?.recordObservedAt;
    expect(observed?.state === "known" && Date.parse(observed.value)).toBe(
      L.STOCK_OBSERVED_EPOCH_MS,
    );
    expect(stockBinding?.lineage).toBeNull();
    // Reference and option scopes are bound as the sources returned them, with the validated binding.
    expect(plan.payload.bindings.find((entry) => entry.kind === "item")?.scope).toEqual({
      owner: "reference",
      resource: "item",
      organization: L.ORG,
      selectors: { sku: "PART-A" },
      binding: { state: "validated", ...L.FIXTURE },
    });
    expect(
      plan.payload.bindings.find((entry) => entry.kind === "transfer_options")?.scope,
    ).toMatchObject({
      bound: 100,
    });

    // Raw SQL: no source effect, unrelated reservations and received/canceled as seeded.
    expect(
      await rows(observer, "SELECT count(*)::int AS n FROM fixture_inventory.transfer_request"),
    ).toEqual([{ n: 0 }]);
    expect(
      await rows(
        observer,
        `SELECT (SELECT count(*) FROM fixture_purchasing.operation)
              + (SELECT count(*) FROM fixture_inventory.operation)
              + (SELECT count(*) FROM fixture_purchasing.operation_receipt)
              + (SELECT count(*) FROM fixture_inventory.operation_receipt) AS n`,
      ),
    ).toEqual([{ n: "0" }]);
    expect(
      await rows(
        observer,
        `SELECT reservation_id, quantity::text AS quantity FROM fixture_inventory.reservation
          ORDER BY reservation_id`,
      ),
    ).toEqual([
      { reservation_id: "RES-A-77", quantity: "10" },
      { reservation_id: "RES-B-31", quantity: "20" },
    ]);
    expect(
      await rows(
        observer,
        `SELECT received::text AS received, canceled::text AS canceled FROM fixture_purchasing.po_line
          WHERE po_number = 'PO-120' AND line_number = '10'`,
      ),
    ).toEqual([{ received: "0", canceled: "0" }]);
  });

  it("an advanced injected clock changes read times only, never versions or observation times", async () => {
    const src = sources("p7-clock");
    const first = await compose(src, L.CLOCK_START);
    // Explicit setup mutation, outside the before/after fingerprint comparison.
    await setClock(observer, "2026-10-21T11:30:00+02:00");
    try {
      const assessedAt = await src.clock.now();
      expect(assessedAt).toBe(L.CLOCK_ADVANCED);
      const before = await fingerprint(observer, SOURCE_TABLES);
      const second = await compose(src, assessedAt);
      expect(readTimes(first)).toEqual(Array.from({ length: 14 }, () => L.CLOCK_START));
      expect(readTimes(second)).toEqual(Array.from({ length: 14 }, () => L.CLOCK_ADVANCED));

      const a = assessCoverage(first).plan;
      const b = assessCoverage(second).plan;
      expect(await fingerprint(observer, SOURCE_TABLES)).toBe(before);
      if (a === null || b === null) throw new Error("both reads must propose a plan");
      const identity = (plan: typeof a) =>
        plan.payload.bindings.map((entry) => [
          entry.kind,
          entry.key,
          entry.version,
          entry.currentVersion,
          entry.members,
          entry.observedAt,
          entry.recordObservedAt,
          entry.contentSha256,
        ]);
      expect(identity(b)).toEqual(identity(a));
      expect(b.payload.bindings.map((entry) => entry.readAt)).toEqual(
        Array.from({ length: 14 }, () => L.CLOCK_ADVANCED),
      );
      // The earlier plan is not edited by the newer reads; the newer one has its own hash.
      expect(a.payload.bindings.map((entry) => entry.readAt)).toEqual(
        Array.from({ length: 14 }, () => L.CLOCK_START),
      );
      expect(b.sha256).not.toBe(a.sha256);
    } finally {
      await setClock(observer, "2026-10-21T09:00:00+02:00");
    }
  });

  it("an unavailable WH-B read stays typed unavailable evidence, never zero or a remembered snapshot", async () => {
    const src = sources("p7-unavailable");
    // A pool on a loopback port nothing listens on: the WH-B read itself fails.
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          resolve(typeof address === "object" && address !== null ? address.port : 0),
        );
      });
    });
    const dead = new pg.Pool({
      connectionString: db.url("api").replace(/@127\.0\.0\.1:\d+\//, `@127.0.0.1:${port}/`),
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    dead.on("error", () => undefined);
    try {
      const stockB = createInventorySource({ pool: dead, clock: src.clock });
      const before = await fingerprint(observer, SOURCE_TABLES);
      const input = await compose(src, L.CLOCK_START, { stockB });
      expect(input.reads.stock[1]).toEqual({
        warehouse: "WH-B",
        read: {
          status: "unavailable",
          scope: stockScope("WH-B"),
          reason: "connection_unavailable",
          attemptedAt: UNKNOWN,
        },
      });
      const result = assessCoverage(input);
      expect(await fingerprint(observer, SOURCE_TABLES)).toBe(before);
      expect(result.decision).toEqual(L.N12B_DECISION);
      expect(result.totals).toEqual(L.N12B_TOTALS);
      expect(summary(result).eligible).toEqual([
        ["WH-A", "INV-A@1", "40", "30"],
        ["WH-B", "evidence_unavailable"],
      ]);
      expect(result.plan).toBeNull();
    } finally {
      await dead.end();
    }
  });

  it("a missing exact policy version is attributable absence that blocks, never a fallback to another version", async () => {
    const src = sources("p7-policy");
    const input = await compose(src, L.CLOCK_START, { authorizationVersion: 2 });
    expect(input.reads.policies.authorization).toMatchObject({
      status: "not_found",
      reason: "record_not_found",
      readAt: { state: "known", value: L.CLOCK_START },
    });
    const result = assessCoverage(input);
    expect(result.decision).toEqual({
      recommendedState: "needs_clarification",
      reason: "policy_evidence_not_found",
      owner: "buyer",
    });
    expect(result.plan).toBeNull();
  });
});
