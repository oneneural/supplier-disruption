// R2 identity, scope and failure distinctions: exact registered-sender
// lookup and ambiguity, the trusted single-fixture binding checked on every
// call, absence versus invalid data, and permission, connection and lock
// failures that are unavailable, never absence. Also R5's contact bound and
// purity. Setup and observation use raw SQL on separate migrator connections.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  NODE_TIMEOUT_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import {
  ALL_RECORDS,
  ATTEMPTED,
  CLOCK_START,
  FIXTURE,
  ORG,
  ORG_ID,
  SENDER,
  V_100,
  expectNoEvidence,
  expectPoolSettled,
  readers,
  recordCounts,
  referenceScope,
} from "./reference-support.js";
import { fingerprint, holdHead, lockWaiters, rows } from "./source-support.js";

const db = new DisposableDatabase("r2");
let observer: pg.Client;

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "r2-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

const OTHER_ID = "0b8f1c4e-2d3a-4e5f-8a9b-1c2d3e4f5a6b";
const MSG_KEY = { sourceSystem: "fixture-supplier-mail", messageId: "MSG-0001", inputVersion: 1 };

type Reference = ReturnType<typeof readers>["reference"];

/** One call of every reference method for the given organization. */
function everyRead(reference: Reference, organization = ORG) {
  return Promise.all([
    reference.readItem({ organization, sku: "PART-A" }),
    reference.readItemMappings({
      organization,
      vendorId: "V-100",
      vendorItem: "KF-A-01",
      sourceUom: "EA",
    }),
    reference.readPolicy({ organization, policyId: "AUTH-1", version: 1 }),
    reference.readVendor({ organization, vendorId: "V-100" }),
    reference.readRegisteredVendor({ organization, sender: SENDER }),
    reference.readSupplierInput({ organization, ...MSG_KEY }),
  ]);
}

/** Status and reason of each result, and that no unavailable one carries evidence. */
function outcomes(results: Array<{ status: string; reason?: string }>) {
  for (const result of results) if (result.status === "unavailable") expectNoEvidence(result);
  return results.map((result) => `${result.status}:${result.reason ?? ""}`);
}

const all = (outcome: string) => Array.from({ length: 6 }, () => outcome);

describe("R2 identity, scope and failure distinctions", () => {
  it("resolves only the exact registered address, with the vendor's complete contacts", async () => {
    // Supplemental contact for V-100, which sorts before the canonical one.
    await observer.query(
      `INSERT INTO fixture_reference.vendor_contact (vendor_id, address, purpose)
       VALUES ('V-100', 'ap@kestrel-fasteners.test', 'registered_sender')`,
    );
    const { reference } = readers(db, "r2-sender");
    const contacts = { ...V_100, registeredSenders: ["ap@kestrel-fasteners.test", SENDER] };
    expect(await reference.readRegisteredVendor({ organization: ORG, sender: SENDER })).toEqual({
      status: "ok",
      scope: referenceScope("registered_vendor", { sender: SENDER }),
      readAt: CLOCK_START,
      observedAt: { state: "unknown" },
      data: contacts,
    });
    for (const sender of [
      "unknown@example.test",
      "Orders@kestrel-fasteners.test",
      "ORDERS@KESTREL-FASTENERS.TEST",
      "orders+po120@kestrel-fasteners.test",
      "sales@kestrel-fasteners.test",
    ]) {
      expect(await reference.readRegisteredVendor({ organization: ORG, sender }), sender).toEqual({
        status: "not_found",
        scope: referenceScope("registered_vendor", { sender }),
        readAt: CLOCK_START,
        reason: "record_not_found",
      });
    }
    // A bare domain or display-name form is not a sender address at all.
    for (const sender of ["kestrel-fasteners.test", "Kestrel <orders@kestrel-fasteners.test>"]) {
      expect(await reference.readRegisteredVendor({ organization: ORG, sender }), sender).toEqual({
        status: "unavailable",
        scope: referenceScope("registered_vendor", { sender }, ATTEMPTED),
        reason: "invalid_query",
      });
    }
    await observer.query(
      "DELETE FROM fixture_reference.vendor_contact WHERE address = 'ap@kestrel-fasteners.test'",
    );
  });

  it("an address registered to two vendors is ambiguous and chooses neither", async () => {
    // Supplemental V-200, registered with the same exact address.
    await observer.query(`
      INSERT INTO fixture_reference.vendor (vendor_id, name) VALUES ('V-200', 'Second vendor (synthetic)');
      INSERT INTO fixture_reference.vendor_contact (vendor_id, address, purpose)
        VALUES ('V-200', 'orders@kestrel-fasteners.test', 'registered_sender')`);
    expect(
      await rows(
        observer,
        `SELECT vendor_id FROM fixture_reference.vendor_contact WHERE address = $1 ORDER BY 1`,
        [SENDER],
      ),
    ).toEqual([{ vendor_id: "V-100" }, { vendor_id: "V-200" }]);
    const { reference } = readers(db, "r2-ambiguous-sender");
    const result = await reference.readRegisteredVendor({ organization: ORG, sender: SENDER });
    expect(result).toEqual({
      status: "ambiguous",
      scope: referenceScope("registered_vendor", { sender: SENDER }),
      readAt: CLOCK_START,
      reason: "registered_sender_ambiguous",
    });
    expect(result).not.toHaveProperty("data");
    // Each vendor is still readable on its own.
    expect(await reference.readVendor({ organization: ORG, vendorId: "V-200" })).toMatchObject({
      status: "ok",
      data: { vendorId: "V-200", registeredSenders: [SENDER] },
    });
    await observer.query(`
      DELETE FROM fixture_reference.vendor_contact WHERE vendor_id = 'V-200';
      DELETE FROM fixture_reference.vendor WHERE vendor_id = 'V-200'`);
  });

  it("a different organization or trusted binding is a scope mismatch that reads nothing", async () => {
    const wrongQuery = await everyRead(readers(db, "r2-wrong-query").reference, "ORG-OTHER");
    expect(outcomes(wrongQuery)).toEqual(all("unavailable:scope_mismatch"));
    expect(wrongQuery[0]).toEqual({
      status: "unavailable",
      scope: referenceScope("item", { sku: "PART-A" }, ATTEMPTED, "ORG-OTHER"),
      reason: "scope_mismatch",
      attemptedAt: CLOCK_START,
    });

    const wrongId = readers(db, "r2-wrong-id", {
      fixture: { label: ORG, organizationId: OTHER_ID },
    });
    const byId = await everyRead(wrongId.reference);
    expect(outcomes(byId)).toEqual(all("unavailable:scope_mismatch"));
    expect(byId[0]).toMatchObject({
      scope: { binding: { state: "attempted", label: ORG, organizationId: OTHER_ID } },
    });

    // A trusted label with no alias row is a missing binding, even when queried consistently.
    const wrongLabel = readers(db, "r2-wrong-label", {
      fixture: { label: "ORG-ELSE", organizationId: ORG_ID },
    });
    expect(outcomes(await everyRead(wrongLabel.reference, "ORG-ELSE"))).toEqual(
      all("unavailable:binding_missing"),
    );
  });

  it("checks the binding on every call: a missing, changed or second alias is never adopted", async () => {
    const { reference } = readers(db, "r2-binding");
    expect(outcomes(await everyRead(reference))).toEqual(all("ok:"));

    await observer.query("DELETE FROM fixture_reference.organization_alias");
    expect(outcomes(await everyRead(reference))).toEqual(all("unavailable:binding_missing"));

    await observer.query(
      `INSERT INTO fixture_reference.organization_alias (label, organization_id, name)
       VALUES ('ORG-NDL', $1, 'Nordlund Distribution (fictional)')`,
      [ORG_ID],
    );
    expect(outcomes(await everyRead(reference))).toEqual(all("ok:"));

    // The same source object sees a changed UUID on its next call.
    await observer.query("UPDATE fixture_reference.organization_alias SET organization_id = $1", [
      OTHER_ID,
    ]);
    expect(outcomes(await everyRead(reference))).toEqual(all("unavailable:scope_mismatch"));
    await observer.query("UPDATE fixture_reference.organization_alias SET organization_id = $1", [
      ORG_ID,
    ]);
    expect(outcomes(await everyRead(reference))).toEqual(all("ok:"));

    // A second alias makes the binding ambiguous whichever label sorts first.
    for (const label of ["ORG-ZZZ", "ORG-AAA"]) {
      await observer.query(
        `INSERT INTO fixture_reference.organization_alias (label, organization_id, name)
         VALUES ($1, $2, 'Second organization (synthetic)')`,
        [label, OTHER_ID],
      );
      const results = await everyRead(reference);
      expect(outcomes(results), label).toEqual(all("ambiguous:fixture_binding_ambiguous"));
      expect(results[0]).toEqual({
        status: "ambiguous",
        scope: referenceScope("item", { sku: "PART-A" }, ATTEMPTED),
        readAt: CLOCK_START,
        reason: "fixture_binding_ambiguous",
      });
      for (const result of results) expect(result).not.toHaveProperty("data");
      await observer.query("DELETE FROM fixture_reference.organization_alias WHERE label = $1", [
        label,
      ]);
    }
    expect(outcomes(await everyRead(reference))).toEqual(all("ok:"));
  });

  it("a missing item, vendor or exact supplier key is not found; a malformed query is invalid", async () => {
    const { reference } = readers(db, "r2-absent");
    const absent = await Promise.all([
      reference.readItem({ organization: ORG, sku: "PART-Z" }),
      reference.readVendor({ organization: ORG, vendorId: "V-999" }),
      reference.readSupplierInput({ organization: ORG, ...MSG_KEY, messageId: "MSG-9999" }),
      reference.readSupplierInput({ organization: ORG, ...MSG_KEY, sourceSystem: "other-mail" }),
    ]);
    expect(outcomes(absent)).toEqual(Array.from({ length: 4 }, () => "not_found:record_not_found"));
    expect(absent[1]).toEqual({
      status: "not_found",
      scope: referenceScope("vendor", { vendorId: "V-999" }),
      readAt: CLOCK_START,
      reason: "record_not_found",
    });
    const invalid = await Promise.all([
      reference.readItem({ organization: ORG, sku: "" }),
      reference.readItem({ organization: ORG, sku: "PART-A", version: "1" } as {
        organization: string;
        sku: string;
      }),
      reference.readPolicy({ organization: ORG, policyId: "AUTH-1", version: 0 }),
      reference.readPolicy({
        organization: ORG,
        policyId: "AUTH-1",
        version: "1" as unknown as number,
      }),
      reference.readItemMappings({
        organization: ORG,
        vendorId: "V-100",
        vendorItem: "KF-A-01",
        sourceUom: "ea",
      }),
      reference.readSupplierInput({ organization: "", ...MSG_KEY }),
    ]);
    expect(outcomes(invalid)).toEqual(all("unavailable:invalid_query"));
    for (const result of invalid) expect(result).not.toHaveProperty("attemptedAt");
  });

  it("invalid policy parameters, injected identity keys, strict supplier terms and contactless vendors are invalid data", async () => {
    // Supplemental invalid rows, each under a version or key of its own.
    await observer.query(`
      INSERT INTO fixture_reference.policy (policy_id, version, parameters) VALUES
        ('ELIG-1', 2, '{"subtract": "everything", "reservationCounting": "each_once"}'),
        ('CAL-CPH-1', 2, '{"policyId": "AUTH-1", "timezone": "Europe/Copenhagen", "granularity": "date"}'),
        ('CAL-CPH-1', 3, '{"version": 1, "timezone": "Europe/Copenhagen", "granularity": "date"}'),
        ('ALLOC-1', 2, '[1, 2, 3]'),
        ('AUTH-1', 2, '{"currency": "EUR", "limits": [{"role": "buyer", "maxMinorUnits": 10000}],
                        "transferRequires": ["supplier_acknowledgement", "warehouse_planner_confirmation"],
                        "approvalOverride": true}');
      INSERT INTO fixture_reference.supplier_input
        (source_system, message_id, input_version, content_sha256, sender, proposal_id,
         evidence_ref, authored_at, received_at, content)
      SELECT source_system, 'MSG-0003', 1, content_sha256, sender, 'PROP-3', 'MSG-0003@1', NULL, NULL,
             content || '{"buyerApprovalLimit": 100000}'
        FROM fixture_reference.supplier_input WHERE message_id = 'MSG-0001';
      INSERT INTO fixture_reference.vendor (vendor_id, name) VALUES ('V-300', 'Contactless (synthetic)')`);
    const { reference } = readers(db, "r2-invalid");
    const results = await Promise.all([
      reference.readPolicy({ organization: ORG, policyId: "ELIG-1", version: 2 }),
      reference.readPolicy({ organization: ORG, policyId: "CAL-CPH-1", version: 2 }),
      reference.readPolicy({ organization: ORG, policyId: "CAL-CPH-1", version: 3 }),
      reference.readPolicy({ organization: ORG, policyId: "ALLOC-1", version: 2 }),
      reference.readPolicy({ organization: ORG, policyId: "AUTH-1", version: 2 }),
      reference.readSupplierInput({ organization: ORG, ...MSG_KEY, messageId: "MSG-0003" }),
      reference.readVendor({ organization: ORG, vendorId: "V-300" }),
    ]);
    expect(outcomes(results)).toEqual(Array.from({ length: 7 }, () => "unavailable:invalid_data"));
    expect(results[1]).toEqual({
      status: "unavailable",
      scope: referenceScope("policy", { policyId: "CAL-CPH-1", version: 2 }, ATTEMPTED),
      reason: "invalid_data",
      attemptedAt: CLOCK_START,
    });
    await observer.query(`
      DELETE FROM fixture_reference.policy WHERE version > 1;
      DELETE FROM fixture_reference.supplier_input WHERE message_id = 'MSG-0003';
      DELETE FROM fixture_reference.vendor WHERE vendor_id = 'V-300'`);
  });

  it(
    "a revoked grant or an ended pool is unavailable, never absence or an empty set",
    async () => {
      await observer.query(`
        REVOKE SELECT ON fixture_reference.item, fixture_reference.item_mapping,
          fixture_reference.policy, fixture_reference.vendor, fixture_reference.supplier_input
          FROM sd_api`);
      const { reference } = readers(db, "r2-revoked");
      // The registered-sender lookup fails on its vendor read after the contact lookup.
      expect(outcomes(await everyRead(reference))).toEqual(all("unavailable:permission_denied"));
      // The normal migration command reapplies the grants.
      expect((await db.migrate()).code).toBe(0);
      expect(outcomes(await everyRead(reference))).toEqual(all("ok:"));

      const ended = readers(db, "r2-ended");
      await ended.pool.end();
      const results = await everyRead(ended.reference);
      expect(outcomes(results)).toEqual(all("unavailable:connection_unavailable"));
      expect(results[0]).toMatchObject({ attemptedAt: CLOCK_START });
    },
    NODE_TIMEOUT_MS + MARGIN_MS,
  );

  it("a read blocked past its lock timeout is unavailable and its connection returns to the pool", async () => {
    const name = "r2-lock";
    const { reference, pool } = readers(db, name, { max: 1, timeouts: { lockTimeoutMs: 3_000 } });
    const blocker = await holdHead(
      db,
      "LOCK TABLE fixture_reference.vendor IN ACCESS EXCLUSIVE MODE",
    );
    let result: Awaited<ReturnType<Reference["readVendor"]>>;
    try {
      const pending = reference.readVendor({ organization: ORG, vendorId: "V-100" });
      // PostgreSQL itself reports the read waiting on the lock.
      await lockWaiters(observer, name, 1);
      result = await pending;
    } finally {
      await blocker.release();
    }
    expect(result).toEqual({
      status: "unavailable",
      scope: referenceScope("vendor", { vendorId: "V-100" }, ATTEMPTED),
      reason: "read_timeout",
      attemptedAt: CLOCK_START,
    });
    expectNoEvidence(result);
    expectPoolSettled(pool);
    expect(
      await rows(
        observer,
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name = $1 AND state <> 'idle'`,
        [name],
      ),
    ).toEqual([{ n: 0 }]);
    expect(await reference.readVendor({ organization: ORG, vendorId: "V-100" })).toMatchObject({
      status: "ok",
    });
  });

  it("R5: a vendor with exactly 100 contacts is complete; 101 is unavailable with no prefix", async () => {
    const counted = `SELECT count(*)::int AS n FROM fixture_reference.vendor_contact
                      WHERE vendor_id = 'V-100' AND purpose = 'registered_sender'`;
    expect(await rows(observer, counted)).toEqual([{ n: 1 }]);
    // Supplemental contacts 2 to 100; the seed supplies the first.
    await observer.query(`
      INSERT INTO fixture_reference.vendor_contact (vendor_id, address, purpose)
      SELECT 'V-100', 'contact-' || lpad(n::text, 3, '0') || '@kestrel-fasteners.test', 'registered_sender'
        FROM generate_series(2, 100) AS n`);
    expect(await rows(observer, counted)).toEqual([{ n: 100 }]);
    const { reference } = readers(db, "r2-bound");
    const expected = [
      ...Array.from(
        { length: 99 },
        (_, index) => `contact-${String(index + 2).padStart(3, "0")}@kestrel-fasteners.test`,
      ),
      SENDER,
    ];
    for (const result of [
      await reference.readVendor({ organization: ORG, vendorId: "V-100" }),
      await reference.readRegisteredVendor({ organization: ORG, sender: SENDER }),
    ]) {
      expect(result).toMatchObject({ status: "ok" });
      expect(result.status === "ok" && result.data.registeredSenders).toEqual(expected);
    }

    await observer.query(
      `INSERT INTO fixture_reference.vendor_contact (vendor_id, address, purpose)
       VALUES ('V-100', 'contact-101@kestrel-fasteners.test', 'registered_sender')`,
    );
    expect(await rows(observer, counted)).toEqual([{ n: 101 }]);
    const over = [
      await reference.readVendor({ organization: ORG, vendorId: "V-100" }),
      await reference.readRegisteredVendor({ organization: ORG, sender: SENDER }),
    ];
    expect(outcomes(over)).toEqual([
      "unavailable:collection_bound_exceeded",
      "unavailable:collection_bound_exceeded",
    ]);
  });

  it("R5: identity reads change no source, reference or application record", async () => {
    // Failing and changing setup is above; nothing else writes in this interval.
    const second = await db.client("migrator", "r2-second-observer");
    const before = await fingerprint(observer, ALL_RECORDS);
    const counts = await recordCounts(second);
    const { reference } = readers(db, "r2-purity");
    const wrong = readers(db, "r2-purity-wrong", {
      fixture: { ...FIXTURE, organizationId: OTHER_ID },
    });
    const results = [
      ...(await everyRead(reference)),
      ...(await everyRead(reference, "ORG-OTHER")),
      ...(await everyRead(wrong.reference)),
      await reference.readRegisteredVendor({ organization: ORG, sender: "nobody@example.test" }),
      await reference.readItem({ organization: ORG, sku: "PART-Z" }),
    ];
    expect(results).toHaveLength(20);
    expect(await fingerprint(observer, ALL_RECORDS)).toBe(before);
    expect(await recordCounts(second)).toEqual(counts);
  });
});
