// P6 immutable version and content binding. The fixed vector below was
// written by hand and hashed with `shasum -a 256` outside this code; the test
// canonicalizer and node:crypto check the plan hash without the production
// canonicalization or digest helpers.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assessCoverage, contentSha256 } from "../src/index.js";
import { c01Input, data, map1, stockRead, stockA, trr9, type C01Input } from "./literals.js";

const VECTOR = { q: "18", b: [3, "x"], a: { d: null, c: "é" } };
const VECTOR_CANONICAL = '{"a":{"c":"é","d":null},"b":[3,"x"],"q":"18"}';
const VECTOR_SHA256 = "83bcc2b9699bf2513b40ee33ca2da0d35aac2acf656f7e0657a2850a5213aa03";

/** Test-only canonical JSON: keys sorted by code unit, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function plan(input: unknown) {
  const result = assessCoverage(input);
  if (result.plan === null) throw new Error(`no plan: ${result.decision.reason}`);
  return result.plan;
}

describe("P6 immutable version and content binding", () => {
  it("matches the independently hashed fixed vector", () => {
    expect(canonical(VECTOR)).toBe(VECTOR_CANONICAL);
    expect(sha256(VECTOR_CANONICAL)).toBe(VECTOR_SHA256);
    expect(contentSha256(VECTOR)).toBe(VECTOR_SHA256);
  });

  it("hashes exactly the returned payload's canonical bytes", () => {
    const result = plan(c01Input());
    expect(result.sha256).toBe(sha256(canonical(result.payload)));
  });

  it("binds every read, policy, mapping, option set and absence by identity and version", () => {
    const { payload } = plan(c01Input());
    expect(
      payload.bindings.map((entry) => [
        entry.kind,
        entry.key,
        entry.version,
        entry.currentVersion,
        entry.members,
      ]),
    ).toEqual([
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
    ]);
    for (const entry of payload.bindings) expect(entry.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const stockBinding = payload.bindings.find(
      (entry) => entry.kind === "stock" && entry.key === "WH-A",
    );
    expect(stockBinding).toMatchObject({
      kind: "stock",
      lineage: null,
      observedAt: { state: "not_returned" },
      recordObservedAt: { state: "known", value: "2026-10-21T06:55:00.000Z" },
    });
    // Option and transit envelopes have no version or observation time; none is invented.
    expect(payload.bindings.find((entry) => entry.kind === "transfer_options")).toMatchObject({
      version: null,
      observedAt: { state: "unknown" },
      recordObservedAt: null,
    });
    expect(payload.proposal).toMatchObject({
      proposalId: "PROP-1",
      evidenceRef: "MSG-0001@1",
      contentSha256: "43dec39141c2d85db55a875337863ab50fbb3e5cb30a0bcc0a0040ef3478803c",
    });
    expect(payload.transferOptions[0]?.terms).toMatchObject({
      optionId: "TRO-1",
      quantity: "50",
      basedOn: "INV-B@1",
      validUntil: "2026-10-22T10:00:00.000Z",
    });
    expect(payload.gaps).toEqual([
      { demandLine: { salesOrder: "SO-201", line: "10" }, preTransfer: "0", conditional: "0" },
      { demandLine: { salesOrder: "SO-202", line: "10" }, preTransfer: "50", conditional: "0" },
    ]);
    expect(payload.authorization.cost).toEqual({
      minorUnits: 16000,
      currency: "EUR",
    });
  });

  const base = plan(c01Input()).sha256;
  const record = (read: unknown) => data<{ record: Record<string, unknown> }>(read).record;
  const option = (input: C01Input) =>
    data<{ records: Array<Record<string, unknown>> }>(input.reads.transferOptions).records[0]!;

  const perturbations: Array<[string, (input: C01Input) => void]> = [
    [
      "WH-A stock version",
      (input) => {
        input.reads.stock[0] = stockRead({ ...stockA(), version: "INV-A@2" });
      },
    ],
    [
      "WH-A stock lineage",
      (input) => {
        data<{ lineage: unknown }>(input.reads.stock[0]?.read).lineage = {
          parentVersion: "INV-A@0",
          receiptId: "8f9c1f0e-3d0a-4c6b-9a51-6f6d1e2b7c40",
          operationId: "OP-X",
          planId: "PLAN-0",
          actionId: "ACT-9",
          recordedAt: "2026-10-20T08:00:00.000Z",
        };
      },
    ],
    [
      "demand version",
      (input) => {
        record(input.reads.demand).version = "DEM@2";
        data<{ currentVersion: string }>(input.reads.demand).currentVersion = "DEM@2";
      },
    ],
    [
      "demand cutoff",
      (input) => {
        (record(input.reads.demand).lines as Array<Record<string, unknown>>)[0]!.receiptCutoff =
          "2026-10-24";
      },
    ],
    [
      "PO observation time",
      (input) => {
        record(input.reads.purchaseOrder).observedAt = {
          state: "known",
          value: "2026-10-21T06:00:00.000Z",
        };
      },
    ],
    [
      "ALLOC-1 read time",
      (input) => {
        (input.reads.policies.allocation as { provenance: { readAt: string } }).provenance.readAt =
          "2026-10-21T07:00:01.000Z";
      },
    ],
    [
      "AUTH-1 content",
      (input) => {
        data<{ limits: Array<{ maxMinorUnits: number }> }>(
          input.reads.policies.authorization,
        ).limits[1]!.maxMinorUnits = 50001;
      },
    ],
    [
      "mapping version",
      (input) => {
        data<{ records: unknown[] }>(input.reads.itemMappings).records = [
          { ...map1(), version: 2 },
        ];
      },
    ],
    [
      "supplier content hash",
      (input) => {
        data<{ identity: { contentSha256: string } }>(
          input.reads.supplierInput,
        ).identity.contentSha256 = "0".repeat(64);
      },
    ],
    ["quote validUntil", (input) => (option(input).validUntil = "2026-10-22T10:00:01.000Z")],
    ["quote cost", (input) => (option(input).cost = { minorUnits: 16001, currency: "EUR" })],
    [
      "proposed segment arrival (ACT-1)",
      (input) => {
        data<{ terms: { segments: Array<{ arrival: unknown }> } }>(
          input.reads.supplierInput,
        ).terms.segments[1]!.arrival = { state: "dated", date: "2026-10-27" };
      },
    ],
    [
      "transit records",
      (input) => {
        data<{ records: unknown[] }>(input.reads.inTransit[0]?.read).records = [trr9()];
      },
    ],
    ["plan version", (input) => (input.planVersion = 2)],
  ];

  it.each(perturbations)("a change of %s changes the hash", (_name, change) => {
    const input = c01Input();
    change(input);
    const changed = plan(input);
    expect(changed.sha256).not.toBe(base);
    expect(changed.sha256).toBe(sha256(canonical(changed.payload)));
  });

  it.each([
    ["AUTH-1", "authorization"],
    ["ELIG-1", "eligibility"],
  ] as const)(
    "an unsupported %s implementation version blocks instead of running v1",
    (_id, slot) => {
      const input = c01Input();
      data<{ version: number }>(input.reads.policies[slot]).version = 2;
      const result = assessCoverage(input);
      expect(result.decision).toEqual({
        recommendedState: "needs_clarification",
        reason: "policy_unsupported_policy_version",
        owner: "buyer",
      });
      expect(result.plan).toBeNull();
    },
  );

  it("a stock version the quote is not based on blocks rather than rebinding", () => {
    const input = c01Input();
    record(input.reads.stock[1]?.read).version = "INV-B@2";
    data<{ currentVersion: string }>(input.reads.stock[1]?.read).currentVersion = "INV-B@2";
    expect(assessCoverage(input).plan).toBeNull();
  });

  it("is stable under key order and unordered input order", () => {
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reorder(item)]),
        );
      }
      return value;
    };
    const input = reorder(c01Input()) as C01Input;
    input.reads.stock.reverse();
    input.reads.inTransit.reverse();
    record(input.reads.demand).lines = (record(input.reads.demand).lines as unknown[]).reverse();
    data<{ records: unknown[] }>(input.reads.itemMappings).records = [
      {
        ...map1(),
        mappingId: "MAP-0",
        effectiveThrough: "2025-12-31",
        effectiveFrom: "2025-01-01",
      },
      map1(),
    ].reverse();
    const twin = c01Input();
    data<{ records: unknown[] }>(twin.reads.itemMappings).records = [
      {
        ...map1(),
        mappingId: "MAP-0",
        effectiveThrough: "2025-12-31",
        effectiveFrom: "2025-01-01",
      },
      map1(),
    ];
    expect(plan(input).sha256).toBe(plan(twin).sha256);
    expect(plan(c01Input()).sha256).toBe(base);
  });

  it("keeps the returned payload and hash when the input changes afterwards", () => {
    const input = c01Input();
    const result = plan(input);
    const before = canonical(result.payload);
    record(input.reads.demand).version = "DEM@9";
    data<{ terms: { segments: Array<{ quantity: string }> } }>(
      input.reads.supplierInput,
    ).terms.segments[0]!.quantity = "1";
    option(input).quantity = "1";
    expect(canonical(result.payload)).toBe(before);
    expect(result.sha256).toBe(sha256(before));
  });

  it("refuses changes to a returned allocation and action precondition", () => {
    const result = plan(c01Input());
    const before = canonical(result.payload);
    const allocation = result.payload.allocations[0] as { quantity: string };
    const action = result.payload.actions[1] as { preconditions: { expectedVersion: string } };
    expect(() => {
      allocation.quantity = "999";
    }).toThrow(TypeError);
    expect(() => {
      action.preconditions.expectedVersion = "INV-B@9";
    }).toThrow(TypeError);
    expect(() => {
      (result.payload.decisions as unknown[]).pop();
    }).toThrow(TypeError);
    expect(canonical(result.payload)).toBe(before);
    expect(result.sha256).toBe(sha256(before));
  });
});
