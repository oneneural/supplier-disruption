// I6 actual-source intake composition and authority isolation
// (ADR 0008). The public authority and reference reads are composed here,
// in the test, into the intake contract and passed to the production intake
// and assessment composition. Expected values are the hand-written
// literals in intake-literals.ts; a separate migrator connection makes the
// labeled supplemental setup and observes every source and reference row
// through raw SQL. The clock has its own pool (ADR 0005).
import { createHash } from "node:crypto";
import { intakeAndAssess } from "@supplier-disruption/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemandSource } from "../src/authorities/demand/index.js";
import {
  SourceRejectedError,
  createInventorySource,
  type TransferOptionsRead,
} from "../src/authorities/inventory/index.js";
import { createPurchasingSource } from "../src/authorities/purchasing/index.js";
import {
  createReferenceSource,
  type ItemMappingsRead,
  type ItemRead,
  type PolicyRead,
  type RegisteredVendorRead,
  type SupplierInputRead,
  type VendorRead,
} from "../src/authorities/reference/index.js";
import { BusinessClockError, createControlledClock } from "../src/clock.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import * as L from "./intake-literals.js";
import { ALL_RECORDS } from "./reference-support.js";
import { fingerprint, rows } from "./source-support.js";

const db = new DisposableDatabase("i6");
let observer: pg.Client;

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "i6-observer");
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

/** Every reference read outcome this consumer composes, as the public entries export them. */
type PublicRead =
  | ItemRead
  | ItemMappingsRead
  | PolicyRead
  | VendorRead
  | RegisteredVendorRead
  | SupplierInputRead
  | TransferOptionsRead;

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
      // ReadInvalidQuery has no attempted time and an unvalidated scope echo.
      if (result.reason === "invalid_query") {
        return {
          status: "unavailable",
          scope: intended,
          reason: result.reason,
          attemptedAt: UNKNOWN,
        };
      }
      return {
        status: "unavailable",
        scope: result.scope,
        reason: result.reason,
        attemptedAt:
          result.attemptedAt === undefined
            ? UNKNOWN
            : { state: "known", value: result.attemptedAt },
      };
  }
}

const attempted = (resource: string, selectors: object) => ({
  ...L.referenceScope(resource, selectors),
  binding: { state: "attempted", ...L.FIXTURE },
});
const stockScope = (warehouse: string) => ({
  owner: "inventory",
  resource: "stock",
  organization: L.ORG,
  selectors: { sku: "PART-A", warehouse },
});
const transitScope = (warehouse: string) => ({ ...stockScope(warehouse), resource: "in_transit" });

interface Compose {
  message: { messageId: string; inputVersion: number };
  /** The trusted prior-acceptance state: none, or a retained receipt for this message. */
  receipt?: unknown;
  supplierText?: string;
  receiptId?: string;
}

/**
 * Composes one intake from actual public reads, each in its own transaction.
 * The delivery is the stored structured input; the vendor is read by the
 * registered-sender vendor's ID, never a supplier-provided one; the PO is a
 * current-head read of the structured PO number.
 */
async function compose(src: Sources, options: Compose) {
  const organization = L.ORG;
  const key = { sourceSystem: L.SOURCE_SYSTEM, ...options.message };
  const stored = await src.reference.readSupplierInput({ organization, ...key });
  if (stored.status !== "ok") throw new Error(`${key.messageId} must be stored`);
  const { identity, terms } = stored.data;
  const registered = await src.reference.readRegisteredVendor({
    organization,
    sender: identity.sender,
  });
  const vendor =
    registered.status === "ok"
      ? publicRead(
          await src.reference.readVendor({ organization, vendorId: registered.data.vendorId }),
          attempted("vendor", { vendorId: registered.data.vendorId }),
        )
      : null;
  const purchaseOrder = await sourceRead(
    {
      owner: "purchasing",
      resource: "purchase_order",
      organization,
      selectors: { poNumber: terms.poNumber },
    },
    () => src.purchasing.readPurchaseOrder({ organization, poNumber: terms.poNumber }),
    ({ currentRevision, record }) => ({ currentRevision, record }),
  );
  const query = {
    organization,
    sourceSystem: key.sourceSystem,
    messageId: key.messageId,
    contentSha256: identity.contentSha256,
  };
  const priorAcceptance =
    options.receipt === undefined
      ? { status: "none", query }
      : { status: "receipt", query, receipt: options.receipt };
  return {
    contractVersion: "supplier-intake.v1",
    organization,
    assessedAt: L.CLOCK_START,
    receiptId: options.receiptId ?? "RCPT-1",
    caseId: "CASE-1",
    planId: "PLAN-1",
    planVersion: 1,
    delivery: {
      identity,
      proposal: {
        contractVersion: identity.contractVersion,
        proposalId: identity.proposalId,
        terms,
        evidence: {
          sourceSystem: identity.sourceSystem,
          messageId: identity.messageId,
          inputVersion: identity.inputVersion,
        },
      },
      ...(options.supplierText === undefined ? {} : { supplierText: options.supplierText }),
    } as Record<string, unknown>,
    priorAcceptance,
    reads: {
      supplierInput: publicRead(stored, attempted("supplier_input", key)),
      registeredVendor: publicRead(
        registered,
        attempted("registered_vendor", { sender: identity.sender }),
      ),
      vendor,
      purchaseOrder,
      assessment: await assessmentReads(src),
    },
    candidateOffers: [],
  };
}

type Intake = Awaited<ReturnType<typeof compose>>;

/** The C-01 assessment reads other than supplier input and PO. */
async function assessmentReads(src: Sources) {
  const organization = L.ORG;
  const stock = (warehouse: string) =>
    sourceRead(
      stockScope(warehouse),
      () => src.inventory.readStock({ organization, sku: "PART-A", warehouse }),
      ({ currentVersion, record, lineage }) => ({ currentVersion, record, lineage }),
    );
  const transit = (warehouse: string) =>
    sourceRead(
      transitScope(warehouse),
      () => src.inventory.readInTransit({ organization, sku: "PART-A", warehouse }),
      ({ records }) => ({ records }),
    );
  const policy = async (policyId: "CAL-CPH-1" | "ELIG-1" | "ALLOC-1" | "AUTH-1") =>
    publicRead(
      await src.reference.readPolicy({ organization, policyId, version: 1 }),
      attempted("policy", { policyId, version: 1 }),
    );
  const options = { sku: "PART-A", uom: "EA", fromWarehouse: "WH-B", toWarehouse: "WH-A" };
  const mapping = { vendorId: "V-100", vendorItem: "KF-A-01", sourceUom: "EA" };
  return {
    demand: await sourceRead(
      { owner: "demand", resource: "demand", organization, selectors: {} },
      () => src.demand.readDemand({ organization }),
      ({ currentVersion, record }) => ({ currentVersion, record }),
    ),
    stock: [
      { warehouse: "WH-A", read: await stock("WH-A") },
      { warehouse: "WH-B", read: await stock("WH-B") },
    ],
    inTransit: [
      { warehouse: "WH-A", read: await transit("WH-A") },
      { warehouse: "WH-B", read: await transit("WH-B") },
    ],
    transferOptions: publicRead(
      await src.inventory.readTransferOptions({ organization, ...options }),
      { owner: "inventory", resource: "transfer_options", organization, selectors: options },
    ),
    item: publicRead(
      await src.reference.readItem({ organization, sku: "PART-A" }),
      attempted("item", { sku: "PART-A" }),
    ),
    itemMappings: publicRead(
      await src.reference.readItemMappings({ organization, ...mapping }),
      attempted("item_mappings", mapping),
    ),
    policies: {
      calendar: await policy("CAL-CPH-1"),
      eligibility: await policy("ELIG-1"),
      allocation: await policy("ALLOC-1"),
      authorization: await policy("AUTH-1"),
    },
  };
}

/**
 * Composes one intake from the public reads and runs it inside a single
 * before/after fingerprint of every source, reference, clock and alias row
 * (row content and xmin), so a read that writes fails the test as surely as
 * the pure composition would.
 */
async function observed(prepare: () => Promise<Intake>) {
  const before = await fingerprint(observer, ALL_RECORDS);
  const input = await prepare();
  const outcome = intakeAndAssess(input);
  expect(await fingerprint(observer, ALL_RECORDS)).toBe(before);
  return { input, outcome };
}

async function unchanged(prepare: () => Promise<Intake>) {
  return (await observed(prepare)).outcome;
}

function accepted(outcome: ReturnType<typeof intakeAndAssess>) {
  expect(outcome.intake.disposition).toBe("accept");
  if (outcome.intake.disposition !== "accept" || outcome.assessment === null) {
    throw new Error("the input must be accepted and assessed");
  }
  return { intake: outcome.intake, assessment: outcome.assessment };
}

/** Every property name anywhere in a JSON value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]);
}

/** Independent raw-SQL observations of the records no intake may change. */
async function sourceState() {
  return {
    effects: await rows(
      observer,
      `SELECT (SELECT count(*) FROM fixture_inventory.transfer_request)
            + (SELECT count(*) FROM fixture_purchasing.operation)
            + (SELECT count(*) FROM fixture_inventory.operation)
            + (SELECT count(*) FROM fixture_purchasing.operation_receipt)
            + (SELECT count(*) FROM fixture_inventory.operation_receipt) AS n`,
    ),
    reservations: await rows(
      observer,
      `SELECT reservation_id, quantity::text AS quantity FROM fixture_inventory.reservation
        ORDER BY reservation_id`,
    ),
    physical: await rows(
      observer,
      `SELECT warehouse, physical::text AS physical FROM fixture_inventory.stock_snapshot
        ORDER BY warehouse`,
    ),
    receivedCanceled: await rows(
      observer,
      `SELECT revision, received::text AS received, canceled::text AS canceled
         FROM fixture_purchasing.po_line WHERE po_number = 'PO-120' AND line_number = '10'
        ORDER BY revision`,
    ),
    auth: await rows(
      observer,
      "SELECT parameters FROM fixture_reference.policy WHERE policy_id = 'AUTH-1' AND version = 1",
    ),
  };
}

const CANONICAL_STATE = {
  effects: [{ n: "0" }],
  reservations: [
    { reservation_id: "RES-A-77", quantity: "10" },
    { reservation_id: "RES-B-31", quantity: "20" },
  ],
  physical: [
    { warehouse: "WH-A", physical: "40" },
    { warehouse: "WH-B", physical: "70" },
  ],
  receivedCanceled: [{ revision: 3, received: "0", canceled: "0" }],
  auth: [{ parameters: L.AUTH_1_PARAMETERS }],
};

describe("I6 actual-source intake composition and authority isolation", () => {
  it("accepts MSG-0001 from the public reads once, assesses C-01 and suppresses the replay, writing nothing", async () => {
    const src = sources("i6-canonical");
    const { intake, assessment } = accepted(
      await unchanged(() => compose(src, { message: L.MSG_0001 })),
    );

    expect(intake.vendorId).toBe("V-100");
    expect(intake.contentSha256).toBe(L.MSG_0001_SHA256);
    expect(intake.association).toEqual({
      poNumber: "PO-120",
      poLine: "10",
      baseRevision: "3",
      currentRevision: "3",
    });
    expect(intake.provenance).toEqual(L.MSG_0001_PROVENANCE);
    expect(intake.identity.authoredAt).toEqual(UNKNOWN);
    expect(intake.identity.receivedAt).toEqual(UNKNOWN);

    expect(assessment.decision).toEqual(L.C01_DECISION);
    expect(assessment.totals).toEqual(L.C01_TOTALS);
    const plan = assessment.plan;
    if (plan === null) throw new Error("C-01 must propose a plan");
    expect(plan.payload.proposal).toMatchObject({
      proposalId: "PROP-1",
      vendorId: "V-100",
      messageId: "MSG-0001",
      sender: L.SENDER,
      contentSha256: L.MSG_0001_SHA256,
    });
    // The assessment binds the same supplier input and current PO reads intake checked.
    const binding = (kind: string) => plan.payload.bindings.find((entry) => entry.kind === kind);
    expect(binding("supplier_input")).toMatchObject({
      scope: L.MSG_0001_PROVENANCE.supplierInput.scope,
      readAt: L.CLOCK_START,
      observedAt: UNKNOWN,
    });
    expect(binding("purchase_order")).toMatchObject({
      version: "3",
      currentVersion: "3",
      scope: L.PO_SCOPE,
      readAt: L.CLOCK_START,
      observedAt: { state: "not_returned" },
    });

    // The caller retains the receipt; the exact replay is a duplicate with no assessment.
    const replay = await unchanged(() =>
      compose(src, { message: L.MSG_0001, receipt: intake.proposedReceipt, receiptId: "RCPT-2" }),
    );
    expect(replay.intake).toMatchObject({
      disposition: "duplicate",
      priorReceipt: { receiptId: "RCPT-1", proposalId: "PROP-1", caseId: "CASE-1" },
    });
    expect(replay.assessment).toBeNull();
    expect(JSON.stringify(replay)).not.toContain("RCPT-2");

    expect(await sourceState()).toEqual(CANONICAL_STATE);
  });

  it("N-13 supplier text changes no authority, recipient or approval, and the assessment is identical", async () => {
    const src = sources("i6-n13");
    const plain = accepted(await unchanged(() => compose(src, { message: L.MSG_0001 })));
    const attack = accepted(
      await unchanged(() => compose(src, { message: L.MSG_0001, supplierText: L.N13_TEXT })),
    );

    expect(attack.intake.proposal.terms).toEqual(plain.intake.proposal.terms);
    expect(attack.intake.contentSha256).toBe(L.MSG_0001_SHA256);
    expect(attack.assessment.totals).toEqual(L.C01_TOTALS);
    expect(attack.assessment).toEqual(plain.assessment);
    const plan = attack.assessment.plan;
    if (plan === null) throw new Error("C-01 must propose a plan");
    expect(plan.sha256).toBe(plain.assessment.plan?.sha256);
    expect(plan.payload.authorization).toMatchObject({
      policy: { policyId: "AUTH-1", version: 1 },
      cost: { minorUnits: 16000, currency: "EUR" },
      limits: L.AUTH_1_LIMITS,
      minimumApproverRole: "procurement_manager",
    });
    // The text is evidence only: it reaches no output, recipient or approval field.
    const text = JSON.stringify(attack);
    for (const fragment of ["attacker", "10 000", "System note", "automatically"]) {
      expect(text).not.toContain(fragment);
    }
    // No field appears that the same input without the text lacks.
    expect(keysOf(attack)).toEqual(keysOf(plain));
    expect(await sourceState()).toEqual(CANONICAL_STATE);
  });

  it("authority properties injected into the structured input are rejected before assessment", async () => {
    const src = sources("i6-authority");
    const injections: Array<(input: Intake) => void> = [
      (input) => {
        const proposal = input.delivery.proposal as { terms: Record<string, unknown> };
        proposal.terms.approvalLimit = { minorUnits: 1000000, currency: "EUR" };
      },
      (input) => {
        input.delivery.recipients = ["ops@attacker.example"];
      },
      (input) => {
        (input.delivery.identity as Record<string, unknown>).role = "procurement_manager";
      },
    ];
    for (const inject of injections) {
      const outcome = await unchanged(async () => {
        const input = await compose(src, { message: L.MSG_0001 });
        inject(input);
        return input;
      });
      expect(outcome.intake).toMatchObject({
        disposition: "blocked",
        decision: L.clarification("intake_invalid_input"),
        subject: "delivery",
      });
      expect(outcome.assessment).toBeNull();
    }
    expect(await sourceState()).toEqual(CANONICAL_STATE);
  });

  it("after PO-120 advances to @4 the current head decides: replay stays a duplicate, a new base-3 message is stale", async () => {
    const src = sources("i6-head");
    const first = accepted(await unchanged(() => compose(src, { message: L.MSG_0001 })));
    // The supplemental MSG-0002 literals agree: its bytes are its terms and hash to its digest.
    expect(JSON.parse(L.MSG_0002_TERMS_BYTES)).toEqual(L.MSG_0002_TERMS);
    expect(createHash("sha256").update(L.MSG_0002_TERMS_BYTES, "utf8").digest("hex")).toBe(
      L.MSG_0002_SHA256,
    );

    // Supplemental setup, outside the before/after comparisons: PO-120@4 is
    // appended and made the head, retained @3 is observed later than @4, and
    // a new MSG-0002 based on revision 3 is stored.
    await observer.query("BEGIN");
    await observer.query(
      `INSERT INTO fixture_purchasing.po_revision (po_number, revision, organization, vendor_id, observed_at)
       VALUES ('PO-120', 4, 'ORG-NDL', 'V-100', $1)`,
      [L.PO_4_OBSERVED],
    );
    await observer.query(`
      INSERT INTO fixture_purchasing.po_line
          (po_number, revision, line_number, sku, uom, destination, ordered, received, canceled)
        VALUES ('PO-120', 4, '10', 'PART-A', 'EA', 'WH-A', 120, 0, 0);
      INSERT INTO fixture_purchasing.po_line_segment
          (po_number, revision, line_number, sequence, quantity, arrival_date)
        VALUES ('PO-120', 4, '10', 1, 40, '2026-10-23'), ('PO-120', 4, '10', 2, 80, '2026-10-26');
      UPDATE fixture_purchasing.po_head SET revision = 4 WHERE po_number = 'PO-120'`);
    await observer.query(
      "UPDATE fixture_purchasing.po_revision SET observed_at = $1 WHERE po_number = 'PO-120' AND revision = 3",
      [L.PO_3_OBSERVED],
    );
    await observer.query(
      `INSERT INTO fixture_reference.supplier_input
          (source_system, message_id, input_version, content_sha256, sender, proposal_id,
           evidence_ref, authored_at, received_at, content)
        VALUES ($1, 'MSG-0002', 1, $2, $3, 'PROP-2', 'MSG-0002@1', NULL, $4, $5)`,
      [L.SOURCE_SYSTEM, L.MSG_0002_SHA256, L.SENDER, L.MSG_0002_RECEIVED, L.MSG_0002_TERMS],
    );
    await observer.query("COMMIT");

    // Independent raw SQL: the explicit head is 4, both revisions are retained,
    // and the retained @3 carries the later observation time.
    expect(
      await rows(
        observer,
        "SELECT revision FROM fixture_purchasing.po_head WHERE po_number = 'PO-120'",
      ),
    ).toEqual([{ revision: 4 }]);
    expect(
      await rows(
        observer,
        `SELECT revision, (observed_at = $1::timestamptz) AS later
           FROM fixture_purchasing.po_revision WHERE po_number = 'PO-120' ORDER BY revision`,
        [L.PO_3_OBSERVED],
      ),
    ).toEqual([
      { revision: 3, later: true },
      { revision: 4, later: false },
    ]);
    expect(
      await rows(
        observer,
        `SELECT (SELECT observed_at FROM fixture_purchasing.po_revision
                  WHERE po_number = 'PO-120' AND revision = 3)
              > (SELECT observed_at FROM fixture_purchasing.po_revision
                  WHERE po_number = 'PO-120' AND revision = 4) AS retained_is_later`,
      ),
    ).toEqual([{ retained_is_later: true }]);

    // The exact replay is decided before any PO check: a duplicate, no reassessment.
    const replay = await unchanged(() =>
      compose(src, { message: L.MSG_0001, receipt: first.intake.proposedReceipt }),
    );
    expect(replay.intake.disposition).toBe("duplicate");
    expect(replay.assessment).toBeNull();

    // A new message based on revision 3 against the current @4.
    const { input: fresh, outcome: stale } = await observed(() =>
      compose(src, { message: L.MSG_0002 }),
    );
    expect(fresh.reads.purchaseOrder).toMatchObject({
      status: "ok",
      data: { currentRevision: "4", record: { revision: "4" } },
    });
    expect(stale.intake).toMatchObject({
      disposition: "blocked",
      decision: L.clarification("stale_base_revision"),
      subject: "reads.purchaseOrder",
      diagnostics: ["the proposal is based on revision 3, PO-120 is at 4"],
      identity: { messageId: "MSG-0002", receivedAt: { state: "known" } },
    });
    expect(stale.assessment).toBeNull();

    // The public historical read of @3 never satisfies the current-read requirement.
    const { input: historical, outcome: retained } = await observed(async () => {
      const input = await compose(src, { message: L.MSG_0002 });
      input.reads.purchaseOrder = await sourceRead(
        L.PO_SCOPE,
        () =>
          src.purchasing.readPurchaseOrder({
            organization: L.ORG,
            poNumber: "PO-120",
            revision: "3",
          }),
        ({ currentRevision, record }) => ({ currentRevision, record }),
      );
      return input;
    });
    expect(historical.reads.purchaseOrder).toMatchObject({
      status: "ok",
      data: { currentRevision: "4", record: { revision: "3" } },
    });
    expect(retained.intake).toMatchObject({
      disposition: "blocked",
      decision: L.clarification("intake_source_unavailable"),
      diagnostics: ["retained revision 3 is not the current head 4; a current read is required"],
    });
    expect(retained.assessment).toBeNull();

    expect(await sourceState()).toEqual({
      ...CANONICAL_STATE,
      receivedCanceled: [
        { revision: 3, received: "0", canceled: "0" },
        { revision: 4, received: "0", canceled: "0" },
      ],
    });
  });
});
