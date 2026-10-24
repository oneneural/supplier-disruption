// R1 exact reference records: after the normal migrate and seed, the public
// reference reads return the oracle's item, mapping, four policies, vendor
// and supplier input unchanged, every mapping version of an exact tuple, and
// stored ratios and hashes byte-exact. Also R5's mapping bound and purity.
// Expectations are literals; stored rows are confirmed through raw SQL on a
// separate migrator connection.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ItemMappingsRead, ItemRead } from "../src/authorities/reference/index.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import {
  ATTEMPTED,
  ALL_RECORDS,
  CLOCK_START,
  MAP_1,
  MSG_0001,
  MSG_0001_CANONICAL,
  MSG_0001_SHA256,
  MSG_0001_TERMS,
  ORG,
  PART_A,
  POLICIES,
  SENDER,
  V_100,
  expectNoEvidence,
  readers,
  recordCounts,
  referenceScope,
  sha256,
} from "./reference-support.js";
import { fingerprint, rows } from "./source-support.js";

const db = new DisposableDatabase("r1");
let observer: pg.Client;

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "r1-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

const ok = (resource: string, selectors: Record<string, unknown>, data: unknown) => ({
  status: "ok",
  scope: referenceScope(resource, selectors),
  readAt: CLOCK_START,
  observedAt: { state: "unknown" },
  data,
});

describe("R1 exact reference records", () => {
  it("stores the oracle's canonical reference rows", async () => {
    expect(
      await rows(
        observer,
        "SELECT label, organization_id::text FROM fixture_reference.organization_alias",
      ),
    ).toEqual([{ label: "ORG-NDL", organization_id: "ed222926-927c-460e-8d28-e22ab5620819" }]);
    expect(
      await rows(observer, "SELECT sku, stock_uom, integral FROM fixture_reference.item"),
    ).toEqual([{ sku: "PART-A", stock_uom: "EA", integral: true }]);
    expect(
      await rows(
        observer,
        `SELECT mapping_id, version, vendor_id, vendor_item, source_uom, sku, stock_uom,
                ratio_numerator::text, ratio_denominator::text, effective_from::text,
                effective_through::text, provenance FROM fixture_reference.item_mapping`,
      ),
    ).toEqual([
      {
        mapping_id: "MAP-1",
        version: 1,
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
    ]);
    expect(
      await rows(
        observer,
        `SELECT policy_id, version, parameters->'limits' AS limits FROM fixture_reference.policy
          WHERE policy_id = 'AUTH-1'`,
      ),
    ).toEqual([
      {
        policy_id: "AUTH-1",
        version: 1,
        limits: [
          { role: "buyer", maxMinorUnits: 10000 },
          { role: "procurement_manager", maxMinorUnits: 50000 },
        ],
      },
    ]);
    expect(
      await rows(
        observer,
        "SELECT vendor_id, address, purpose FROM fixture_reference.vendor_contact",
      ),
    ).toEqual([{ vendor_id: "V-100", address: SENDER, purpose: "registered_sender" }]);
    expect(
      await rows(
        observer,
        `SELECT message_id, input_version, content_sha256, sender, proposal_id, evidence_ref,
                authored_at, received_at FROM fixture_reference.supplier_input`,
      ),
    ).toEqual([
      {
        message_id: "MSG-0001",
        input_version: 1,
        content_sha256: MSG_0001_SHA256,
        sender: SENDER,
        proposal_id: "PROP-1",
        evidence_ref: "MSG-0001@1",
        authored_at: null,
        received_at: null,
      },
    ]);
    // The independent hash expectation is the SHA-256 of the hand-written canonical JSON.
    expect(sha256(MSG_0001_CANONICAL)).toBe(MSG_0001_SHA256);
  });

  it("reads PART-A, MAP-1, the four policies, V-100 and MSG-0001 exactly", async () => {
    const { reference } = readers(db, "r1-canonical");
    expect(await reference.readItem({ organization: ORG, sku: "PART-A" })).toEqual(
      ok("item", { sku: "PART-A" }, PART_A),
    );
    const tuple = { vendorId: "V-100", vendorItem: "KF-A-01", sourceUom: "EA" };
    expect(await reference.readItemMappings({ organization: ORG, ...tuple })).toEqual(
      ok("item_mappings", tuple, { records: [MAP_1], complete: true }),
    );
    for (const policy of Object.values(POLICIES)) {
      const selectors = { policyId: policy.policyId, version: 1 };
      expect(
        await reference.readPolicy({ organization: ORG, ...selectors }),
        policy.policyId,
      ).toEqual(ok("policy", selectors, policy));
    }
    expect(await reference.readVendor({ organization: ORG, vendorId: "V-100" })).toEqual(
      ok("vendor", { vendorId: "V-100" }, V_100),
    );
    expect(await reference.readRegisteredVendor({ organization: ORG, sender: SENDER })).toEqual(
      ok("registered_vendor", { sender: SENDER }, V_100),
    );
    const key = { sourceSystem: "fixture-supplier-mail", messageId: "MSG-0001", inputVersion: 1 };
    expect(await reference.readSupplierInput({ organization: ORG, ...key })).toEqual(
      ok("supplier_input", key, MSG_0001),
    );
  });

  it("returns every mapping version of the exact tuple, expired ones unchanged, and nothing of another tuple", async () => {
    // Supplemental item-master rows: an expired CTN mapping, two later CTN
    // versions (numeric order 2 before 10), another vendor item and a large ratio.
    await observer.query(`
      INSERT INTO fixture_reference.item_mapping
        (mapping_id, version, vendor_id, vendor_item, source_uom, sku, stock_uom,
         ratio_numerator, ratio_denominator, effective_from, effective_through, provenance)
      VALUES ('MAP-2', 10, 'V-100', 'KF-A-01', 'CTN', 'PART-A', 'EA', 12, 1, '2027-01-01', NULL, 'item_master'),
             ('MAP-2', 1, 'V-100', 'KF-A-01', 'CTN', 'PART-A', 'EA', 10, 1, '2026-01-01', '2026-09-30', 'item_master'),
             ('MAP-2', 2, 'V-100', 'KF-A-01', 'CTN', 'PART-A', 'EA', 12, 1, '2026-10-01', NULL, 'item_master'),
             ('MAP-3', 1, 'V-100', 'KF-A-02', 'CTN', 'PART-A', 'EA', 6, 1, '2026-01-01', NULL, 'item_master'),
             ('MAP-4', 1, 'V-100', 'KF-A-09', 'EA', 'PART-A', 'EA', 9007199254740993, 7, '2026-01-01', NULL, 'item_master')`);
    const { reference } = readers(db, "r1-mappings");
    const mapping = (version: number, numerator: string, from: string, through: string | null) => ({
      ...MAP_1,
      mappingId: "MAP-2",
      version,
      sourceUom: "CTN",
      ratio: { numerator, denominator: "1" },
      effectiveFrom: from,
      effectiveThrough: through,
    });
    const ctn = { vendorId: "V-100", vendorItem: "KF-A-01", sourceUom: "CTN" };
    expect(await reference.readItemMappings({ organization: ORG, ...ctn })).toEqual(
      ok("item_mappings", ctn, {
        records: [
          mapping(1, "10", "2026-01-01", "2026-09-30"),
          mapping(2, "12", "2026-10-01", null),
          mapping(10, "12", "2027-01-01", null),
        ],
        complete: true,
      }),
    );
    // At compile time: a mapping read has no absent or sender-ambiguous member,
    // and an invalid query's echoed selectors are unvalidated unknown values.
    // @ts-expect-error ItemMappingsRead has no not_found member
    const absent: Extract<ItemMappingsRead, { status: "not_found" }>["status"] = "not_found";
    const echoed: Extract<ItemRead, { reason: "invalid_query" }>["scope"]["selectors"] = 42;
    expect([absent, echoed]).toEqual(["not_found", 42]);
    // A unit without a mapping is a complete, successful empty set.
    const box = { vendorId: "V-100", vendorItem: "KF-A-01", sourceUom: "BOX" };
    expect(await reference.readItemMappings({ organization: ORG, ...box })).toEqual(
      ok("item_mappings", box, { records: [], complete: true }),
    );
    // The original EA tuple is unchanged by the other rows.
    const ea = { vendorId: "V-100", vendorItem: "KF-A-01", sourceUom: "EA" };
    expect(await reference.readItemMappings({ organization: ORG, ...ea })).toEqual(
      ok("item_mappings", ea, { records: [MAP_1], complete: true }),
    );
    // 9007199254740993 is not representable as a double; it must survive as text.
    const large = { vendorId: "V-100", vendorItem: "KF-A-09", sourceUom: "EA" };
    const read = await reference.readItemMappings({ organization: ORG, ...large });
    expect(read).toMatchObject({ status: "ok", data: { complete: true } });
    expect(read.status === "ok" && read.data.records.map((record) => record.ratio)).toEqual([
      { numerator: "9007199254740993", denominator: "7" },
    ]);
    expect(
      await rows(
        observer,
        `SELECT ratio_numerator::text FROM fixture_reference.item_mapping WHERE mapping_id = 'MAP-4'`,
      ),
    ).toEqual([{ ratio_numerator: "9007199254740993" }]);
  });

  it("an exactly requested absent policy or input version is not found, even with another version present", async () => {
    // Supplemental versions: AUTH-1@2 with a lower manager limit, MSG-0001@2.
    await observer.query(`
      INSERT INTO fixture_reference.policy (policy_id, version, parameters)
      VALUES ('AUTH-1', 2, '{"currency": "EUR", "limits": [{"role": "buyer", "maxMinorUnits": 10000},
              {"role": "procurement_manager", "maxMinorUnits": 15000}],
              "transferRequires": ["supplier_acknowledgement", "warehouse_planner_confirmation"]}');
      INSERT INTO fixture_reference.supplier_input
        (source_system, message_id, input_version, content_sha256, sender, proposal_id,
         evidence_ref, authored_at, received_at, content)
      SELECT source_system, message_id, 2, content_sha256, sender, 'PROP-1-V2', 'MSG-0001@2',
             NULL, NULL, content
        FROM fixture_reference.supplier_input WHERE message_id = 'MSG-0001'`);
    const { reference } = readers(db, "r1-versions");
    for (const [policyId, version] of [
      ["AUTH-1", 3],
      ["CAL-CPH-1", 2],
      ["ELIG-1", 2],
    ] as const) {
      expect(await reference.readPolicy({ organization: ORG, policyId, version })).toEqual({
        status: "not_found",
        scope: referenceScope("policy", { policyId, version }),
        readAt: CLOCK_START,
        reason: "record_not_found",
      });
    }
    const auth2 = await reference.readPolicy({ organization: ORG, policyId: "AUTH-1", version: 2 });
    expect(auth2).toMatchObject({
      status: "ok",
      data: {
        policyId: "AUTH-1",
        version: 2,
        limits: [
          { role: "buyer", maxMinorUnits: 10000 },
          { role: "procurement_manager", maxMinorUnits: 15000 },
        ],
      },
    });
    // AUTH-1@1 is still read as version 1, not the higher version.
    expect(
      await reference.readPolicy({ organization: ORG, policyId: "AUTH-1", version: 1 }),
    ).toEqual(ok("policy", { policyId: "AUTH-1", version: 1 }, POLICIES["AUTH-1"]));
    const key = { sourceSystem: "fixture-supplier-mail", messageId: "MSG-0001", inputVersion: 3 };
    expect(await reference.readSupplierInput({ organization: ORG, ...key })).toEqual({
      status: "not_found",
      scope: referenceScope("supplier_input", key),
      readAt: CLOCK_START,
      reason: "record_not_found",
    });
    // VERIFY-1 has no public read: an unsupported query, never absence.
    const verify = await reference.readPolicy({
      organization: ORG,
      policyId: "VERIFY-1" as "AUTH-1",
      version: 1,
    });
    expect(verify).toEqual({
      status: "unavailable",
      scope: referenceScope("policy", { policyId: "VERIFY-1", version: 1 }, ATTEMPTED),
      reason: "invalid_query",
    });
  });

  it("returns a valid stored hash that differs from the terms unchanged, never recomputed", async () => {
    // Supplemental input: MSG-0001's terms with a different, well-formed stored hash.
    const stored = "f".repeat(64);
    await observer.query(
      `INSERT INTO fixture_reference.supplier_input
         (source_system, message_id, input_version, content_sha256, sender, proposal_id,
          evidence_ref, authored_at, received_at, content)
       SELECT source_system, 'MSG-0002', 1, $1, sender, 'PROP-2', 'MSG-0002@1', NULL, NULL, content
         FROM fixture_reference.supplier_input WHERE message_id = 'MSG-0001' AND input_version = 1`,
      [stored],
    );
    const { reference } = readers(db, "r1-hash");
    const key = { sourceSystem: "fixture-supplier-mail", messageId: "MSG-0002", inputVersion: 1 };
    expect(await reference.readSupplierInput({ organization: ORG, ...key })).toEqual(
      ok("supplier_input", key, {
        identity: {
          ...MSG_0001.identity,
          messageId: "MSG-0002",
          contentSha256: stored,
          proposalId: "PROP-2",
          evidenceRef: "MSG-0002@1",
        },
        terms: MSG_0001_TERMS,
      }),
    );
    expect(
      await rows(
        observer,
        "SELECT content_sha256 FROM fixture_reference.supplier_input WHERE message_id = 'MSG-0002'",
      ),
    ).toEqual([{ content_sha256: stored }]);
  });

  it("R5: a tuple of exactly 100 mappings is complete; 101 is unavailable with no prefix", async () => {
    // Supplemental MAP-1 versions 2 to 100; the seed supplies version 1.
    await observer.query(`
      INSERT INTO fixture_reference.item_mapping
        (mapping_id, version, vendor_id, vendor_item, source_uom, sku, stock_uom,
         ratio_numerator, ratio_denominator, effective_from, effective_through, provenance)
      SELECT 'MAP-1', n, 'V-100', 'KF-A-01', 'EA', 'PART-A', 'EA', 1, 1, '2026-01-01', NULL, 'item_master'
        FROM generate_series(2, 100) AS n`);
    const matching = `SELECT count(*)::int AS n FROM fixture_reference.item_mapping
                       WHERE vendor_id = 'V-100' AND vendor_item = 'KF-A-01' AND source_uom = 'EA'`;
    expect(await rows(observer, matching)).toEqual([{ n: 100 }]);
    const { reference } = readers(db, "r1-bound");
    const ea = { vendorId: "V-100", vendorItem: "KF-A-01", sourceUom: "EA" };
    const full = await reference.readItemMappings({ organization: ORG, ...ea });
    expect(full).toMatchObject({ status: "ok", data: { complete: true } });
    const versions = full.status === "ok" ? full.data.records.map((record) => record.version) : [];
    expect(versions).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));

    await observer.query(`
      INSERT INTO fixture_reference.item_mapping
        (mapping_id, version, vendor_id, vendor_item, source_uom, sku, stock_uom,
         ratio_numerator, ratio_denominator, effective_from, effective_through, provenance)
      VALUES ('MAP-1', 101, 'V-100', 'KF-A-01', 'EA', 'PART-A', 'EA', 1, 1, '2026-01-01', NULL, 'item_master')`);
    expect(await rows(observer, matching)).toEqual([{ n: 101 }]);
    const over = await reference.readItemMappings({ organization: ORG, ...ea });
    expect(over).toEqual({
      status: "unavailable",
      scope: referenceScope("item_mappings", ea, ATTEMPTED),
      reason: "collection_bound_exceeded",
      attemptedAt: CLOCK_START,
    });
    expectNoEvidence(over);
  });

  it("R5: reference reads change no source, reference or application record", async () => {
    // All setup above is complete; nothing else writes during the measured interval.
    const second = await db.client("migrator", "r1-second-observer");
    const before = await fingerprint(observer, ALL_RECORDS);
    const counts = await recordCounts(second);
    const { reference } = readers(db, "r1-purity");
    const results = await Promise.all([
      reference.readItem({ organization: ORG, sku: "PART-A" }),
      reference.readItem({ organization: ORG, sku: "PART-Z" }),
      reference.readItemMappings({
        organization: ORG,
        vendorId: "V-100",
        vendorItem: "KF-A-01",
        sourceUom: "CTN",
      }),
      reference.readItemMappings({
        organization: ORG,
        vendorId: "V-100",
        vendorItem: "KF-A-01",
        sourceUom: "EA",
      }),
      ...Object.values(POLICIES).map((policy) =>
        reference.readPolicy({ organization: ORG, policyId: policy.policyId, version: 1 }),
      ),
      reference.readVendor({ organization: ORG, vendorId: "V-100" }),
      reference.readRegisteredVendor({ organization: ORG, sender: SENDER }),
      reference.readSupplierInput({
        organization: ORG,
        sourceSystem: "fixture-supplier-mail",
        messageId: "MSG-0001",
        inputVersion: 1,
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "ok",
      "not_found",
      "ok",
      "unavailable",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(await fingerprint(observer, ALL_RECORDS)).toBe(before);
    expect(await recordCounts(second)).toEqual(counts);
  });
});
