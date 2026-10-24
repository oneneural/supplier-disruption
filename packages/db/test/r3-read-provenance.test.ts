// R3 real provenance and connection ownership: read time comes from the
// injected controlled clock and nothing else, unknown times stay unknown,
// PostgreSQL text is normalized under any session DateStyle and zone, clock
// failure invents no time, and each call owns its connection and snapshot.
// The clock always has its own pool (ADR 0005). Observed through raw
// SQL on a separate migrator connection.
import {
  itemMappingSchema,
  supplierInputIdentitySchema,
  transferOptionSchema,
} from "@supplier-disruption/contracts";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInventorySource } from "../src/authorities/inventory/index.js";
import { createReferenceSource } from "../src/authorities/reference/index.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import {
  ATTEMPTED,
  CLOCK_START,
  FIXTURE,
  MAP_1,
  MSG_0001,
  ORG,
  PART_A,
  POLICIES,
  TRANSFER_QUERY,
  TRO_1,
  expectNoEvidence,
  expectPoolSettled,
  readers,
  referenceScope,
  transferScope,
} from "./reference-support.js";
import { clockEpochMs, holdHead, lockWaiters, rows, setClock } from "./source-support.js";

const db = new DisposableDatabase("r3");
let observer: pg.Client;

beforeAll(async () => {
  await db.start();
  await db.prepare();
  observer = await db.client("migrator", "r3-observer");
}, START_TIMEOUT_MS + RESET_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

const MSG_KEY = { sourceSystem: "fixture-supplier-mail", messageId: "MSG-0001", inputVersion: 1 };
const MAP_TUPLE = { vendorId: "V-100", vendorItem: "KF-A-01", sourceUom: "EA" };

describe("R3 real provenance and connection ownership", () => {
  it("read time follows only the injected clock; versions, content and source times do not move", async () => {
    expect(await clockEpochMs(observer)).toBe(Date.parse("2026-10-21T09:00:00+02:00"));
    const { reference, inventory } = readers(db, "r3-clock");
    const readAll = () =>
      Promise.all([
        reference.readItem({ organization: ORG, sku: "PART-A" }),
        reference.readItemMappings({ organization: ORG, ...MAP_TUPLE }),
        reference.readPolicy({ organization: ORG, policyId: "AUTH-1", version: 1 }),
        reference.readSupplierInput({ organization: ORG, ...MSG_KEY }),
        inventory.readTransferOptions(TRANSFER_QUERY),
      ]);
    const first = await readAll();
    await setClock(observer, "2026-10-21T11:30:00+02:00");
    expect(await clockEpochMs(observer)).toBe(Date.parse("2026-10-21T11:30:00+02:00"));
    const second = await readAll();

    const data = [
      PART_A,
      { records: [MAP_1], complete: true },
      POLICIES["AUTH-1"],
      MSG_0001,
      { records: [TRO_1], complete: true },
    ];
    for (const [results, readAt] of [
      [first, CLOCK_START],
      [second, "2026-10-21T09:30:00.000Z"],
    ] as const) {
      expect(results.map((result) => result.status === "ok" && result.readAt)).toEqual(
        Array.from({ length: 5 }, () => readAt),
      );
      expect(results.map((result) => result.status === "ok" && result.observedAt)).toEqual(
        Array.from({ length: 5 }, () => ({ state: "unknown" })),
      );
      expect(results.map((result) => result.status === "ok" && result.data)).toEqual(data);
    }
    // MSG-0001's unknown authored and received times stay unknown, not the read time.
    expect(second[3]).toMatchObject({
      data: { identity: { authoredAt: { state: "unknown" }, receivedAt: { state: "unknown" } } },
    });
    await setClock(observer, "2026-10-21T09:00:00+02:00");
  });

  it("normalizes known six-digit times under a non-ISO DateStyle and a non-UTC zone, keeping dates", async () => {
    // Supplemental input with known authored and received instants, fractions to the microsecond.
    await observer.query(`
      INSERT INTO fixture_reference.supplier_input
        (source_system, message_id, input_version, content_sha256, sender, proposal_id,
         evidence_ref, authored_at, received_at, content)
      SELECT source_system, 'MSG-0004', 1, content_sha256, sender, 'PROP-4', 'MSG-0004@1',
             '2026-10-20 06:15:30.123456+00', '2026-10-20 06:16:01.000001+00', content
        FROM fixture_reference.supplier_input WHERE message_id = 'MSG-0001'`);
    const sessionOptions = "-c DateStyle=SQL,DMY -c TimeZone=Asia/Kolkata";
    const { pool, reference, inventory } = readers(db, "r3-datestyle", { sessionOptions });
    // The session really is non-ISO and offset +05:30 outside the source transaction.
    const session = await pool.query<{ style: string; zone: string; text: string }>(
      `SELECT current_setting('DateStyle') AS style, current_setting('TimeZone') AS zone,
              '2026-10-20 06:15:30.123456+00'::timestamptz::text AS text`,
    );
    expect(session.rows).toEqual([
      { style: "SQL, DMY", zone: "Asia/Kolkata", text: "20/10/2026 11:45:30.123456 IST" },
    ]);

    const input = await reference.readSupplierInput({
      organization: ORG,
      ...MSG_KEY,
      messageId: "MSG-0004",
    });
    expect(input).toMatchObject({ status: "ok" });
    const identity = input.status === "ok" ? input.data.identity : undefined;
    expect(identity).toMatchObject({
      authoredAt: { state: "known", value: "2026-10-20T11:45:30.123456+05:30" },
      receivedAt: { state: "known", value: "2026-10-20T11:46:01.000001+05:30" },
    });
    expect(supplierInputIdentitySchema.parse(identity)).toEqual(identity);
    expect(
      await rows(
        observer,
        `SELECT (extract(epoch FROM authored_at) * 1000000)::bigint::text AS micros
           FROM fixture_reference.supplier_input WHERE message_id = 'MSG-0004'`,
      ),
    ).toEqual([{ micros: "1792476930123456" }]);

    const mappings = await reference.readItemMappings({ organization: ORG, ...MAP_TUPLE });
    expect(mappings.status === "ok" && mappings.data.records).toEqual([MAP_1]);
    expect(itemMappingSchema.parse(MAP_1)).toEqual(MAP_1);
    const options = await inventory.readTransferOptions(TRANSFER_QUERY);
    const tro1 = { ...TRO_1, validUntil: "2026-10-22T15:30:00+05:30" };
    expect(options.status === "ok" && options.data.records).toEqual([tro1]);
    expect(transferOptionSchema.parse(tro1)).toEqual(tro1);
    expect(Date.parse(tro1.validUntil)).toBe(Date.parse(TRO_1.validUntil));
  });

  it("a failing or unusable clock is unavailable with no invented attempted or read time", async () => {
    const down = readers(db, "r3-clock-down", {
      clock: { now: () => Promise.reject(new Error("clock down")) },
    });
    const garbage = readers(db, "r3-clock-garbage", {
      clock: { now: () => Promise.resolve("2026-10-21 09:00") },
    });
    for (const { reference, inventory } of [down, garbage]) {
      const item = await reference.readItem({ organization: ORG, sku: "PART-A" });
      expect(item).toEqual({
        status: "unavailable",
        scope: referenceScope("item", { sku: "PART-A" }, ATTEMPTED),
        reason: "clock_unavailable",
      });
      const options = await inventory.readTransferOptions(TRANSFER_QUERY);
      expect(options).toEqual({
        status: "unavailable",
        scope: transferScope(),
        reason: "clock_unavailable",
      });
      for (const result of [item, options]) {
        expectNoEvidence(result);
        expect(result).not.toHaveProperty("attemptedAt");
      }
    }
    // The database-backed controlled clock without its row fails the same way, never wall time.
    await observer.query("DELETE FROM fixture_reference.business_clock");
    const { reference } = readers(db, "r3-clock-missing");
    expect(await reference.readItem({ organization: ORG, sku: "PART-A" })).toEqual({
      status: "unavailable",
      scope: referenceScope("item", { sku: "PART-A" }, ATTEMPTED),
      reason: "clock_unavailable",
    });
    await observer.query(
      "INSERT INTO fixture_reference.business_clock (id, instant) VALUES (1, '2026-10-21T09:00:00+02:00')",
    );
  });

  it("a one-connection source pool with its own clock pool completes concurrent calls and recovers after failures", async () => {
    const name = "r3-single";
    const { pool, clockPool, clock, reference, inventory } = readers(db, name, {
      max: 1,
      timeouts: { lockTimeoutMs: 1_000 },
    });
    // The wiring under test: the clock never draws from the source pool.
    expect(clockPool).not.toBe(pool);
    expect(pool.options.max).toBe(1);

    const concurrent = await Promise.all([
      ...Array.from({ length: 4 }, () => reference.readItem({ organization: ORG, sku: "PART-A" })),
      ...Array.from({ length: 4 }, () => inventory.readTransferOptions(TRANSFER_QUERY)),
      reference.readSupplierInput({ organization: ORG, ...MSG_KEY }),
    ]);
    expect(concurrent.map((result) => result.status)).toEqual(
      Array.from({ length: 9 }, () => "ok"),
    );
    expect(pool.totalCount).toBe(1);
    expectPoolSettled(pool);

    // While the source pool's only connection waits on a lock, the clock still answers.
    const blocker = await holdHead(
      db,
      "LOCK TABLE fixture_reference.item IN ACCESS EXCLUSIVE MODE",
    );
    let failed: Array<{ status: string; reason?: string }>;
    try {
      const pending = Promise.all(
        Array.from({ length: 3 }, () => reference.readItem({ organization: ORG, sku: "PART-A" })),
      );
      await lockWaiters(observer, name, 1);
      expect(await clock.now()).toBe(CLOCK_START);
      failed = await pending;
    } finally {
      await blocker.release();
    }
    expect(failed.map((result) => `${result.status}:${result.reason}`)).toEqual(
      Array.from({ length: 3 }, () => "unavailable:read_timeout"),
    );
    expectPoolSettled(pool);
    expect(await reference.readItem({ organization: ORG, sku: "PART-A" })).toMatchObject({
      status: "ok",
    });
    expectPoolSettled(pool);
  });

  it("each call reads its own committed snapshot: a caller's open change is invisible until committed", async () => {
    const { reference } = readers(db, "r3-snapshot");
    const caller = await db.client("migrator", "r3-caller");
    await caller.query("BEGIN");
    try {
      await caller.query(
        "UPDATE fixture_reference.vendor SET name = 'Renamed (uncommitted)' WHERE vendor_id = 'V-100'",
      );
      await caller.query(
        "UPDATE fixture_reference.item_mapping SET ratio_numerator = 2 WHERE mapping_id = 'MAP-1'",
      );
      const vendor = await reference.readVendor({ organization: ORG, vendorId: "V-100" });
      expect(vendor.status === "ok" && vendor.data.name).toBe("Kestrel Fasteners ApS (fictional)");
      const mapping = await reference.readItemMappings({ organization: ORG, ...MAP_TUPLE });
      expect(mapping.status === "ok" && mapping.data.records).toEqual([MAP_1]);
      await caller.query("COMMIT");
    } catch (error) {
      await caller.query("ROLLBACK");
      throw error;
    }
    expect(
      await rows(observer, "SELECT name FROM fixture_reference.vendor WHERE vendor_id = 'V-100'"),
    ).toEqual([{ name: "Renamed (uncommitted)" }]);
    const vendor = await reference.readVendor({ organization: ORG, vendorId: "V-100" });
    expect(vendor.status === "ok" && vendor.data.name).toBe("Renamed (uncommitted)");
    const mapping = await reference.readItemMappings({ organization: ORG, ...MAP_TUPLE });
    expect(mapping.status === "ok" && mapping.data.records).toEqual([
      { ...MAP_1, ratio: { numerator: "2", denominator: "1" } },
    ]);
    await observer.query(`
      UPDATE fixture_reference.vendor SET name = 'Kestrel Fasteners ApS (fictional)' WHERE vendor_id = 'V-100';
      UPDATE fixture_reference.item_mapping SET ratio_numerator = 1 WHERE mapping_id = 'MAP-1'`);
  });

  it("no caller transaction or client can be passed to a source", () => {
    const { pool, clock } = readers(db, "r3-options");
    const reference = createReferenceSource({
      pool,
      clock,
      fixtureOrganization: FIXTURE,
      // @ts-expect-error a source takes a pool, never a client or transaction
      client: {},
    });
    const inventory = createInventorySource({
      pool,
      clock,
      // @ts-expect-error a source takes a pool, never a client or transaction
      transaction: {},
    });
    // Every read takes exactly one query argument.
    for (const method of Object.values(reference)) expect(method).toHaveLength(1);
    expect(Object.getOwnPropertyDescriptor(inventory, "readTransferOptions")?.value).toHaveLength(
      1,
    );
    expect(() =>
      createReferenceSource({
        pool,
        clock,
        fixtureOrganization: { label: ORG, organizationId: "x" },
      }),
    ).toThrow(TypeError);
  });
});
