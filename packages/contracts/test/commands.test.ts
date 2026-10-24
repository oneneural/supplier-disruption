// Source command and receipt contracts (ADR 0005). Every valid record below is
// an independently written literal.
import { describe, expect, it } from "vitest";
import {
  amendScheduleCommandSchema,
  amendScheduleReceiptSchema,
  createTransferRequestCommandSchema,
  inventoryReceiptSchema,
  reserveStockCommandSchema,
  sourceRejectionReasonSchema,
  transferRequestSchema,
} from "../src/index.js";

const v = "supplier-domain.v1";
const receiptId = "0b6f5b8e-7a7e-4b8e-9c55-3d7f0f2a9e11";
const digest = "a".repeat(64);

const amend = {
  contractVersion: v,
  kind: "amend_schedule",
  organization: "ORG-T1",
  operationId: "OP-9",
  poNumber: "PO-900",
  poLine: "010",
  uom: "EA",
  expectedRevision: "7",
  planId: "PLAN-9",
  actionId: "ACT-9",
  segments: [
    { sequence: 1, quantity: "5", arrival: { state: "dated", date: "2026-03-04" } },
    { sequence: 2, quantity: "6", arrival: { state: "undated" } },
  ],
};

const reserve = {
  contractVersion: v,
  kind: "reserve",
  organization: "ORG-T1",
  operationId: "0b6f5b8e-7a7e-4b8e-9c55-3d7f0f2a9e12",
  sku: "SKU-9",
  warehouse: "WH-9",
  uom: "EA",
  quantity: "999999999999999999",
  expectedVersion: "INV-9@4",
  planId: "PLAN-9",
  actionId: "ACT-8",
};

const transfer = {
  contractVersion: v,
  kind: "create_transfer_request",
  organization: "ORG-T1",
  operationId: "OP-10",
  optionId: "TRO-9",
  sku: "SKU-9",
  uom: "EA",
  from: "WH-9",
  to: "WH-8",
  quantity: "12",
  dispatchDate: "2026-03-01",
  arrivalDate: "2026-03-02",
  expectedStockVersion: "INV-9@4.ACT-8",
  reservationId: "RSV-1",
  predecessorReceiptId: receiptId,
  planId: "PLAN-9",
  actionId: "ACT-7",
};

const reservationReceipt = {
  contractVersion: v,
  kind: "reserve",
  receiptId,
  organization: "ORG-T1",
  operationId: "OP-11",
  requestDigest: digest,
  planId: "PLAN-9",
  actionId: "ACT-8",
  recordedAt: "2026-03-01T10:00:00.123456+05:30",
  sku: "SKU-9",
  warehouse: "WH-9",
  priorVersion: "INV-9@4",
  successorVersion: "INV-9@4.ACT-8",
  reservationId: "RSV-1",
  quantity: "12",
};

const request = {
  contractVersion: v,
  organization: "ORG-T1",
  requestId: "TRQ-1",
  version: 1,
  status: "requested",
  optionId: "TRO-9",
  sku: "SKU-9",
  uom: "EA",
  from: "WH-9",
  to: "WH-8",
  quantity: "12",
  dispatchDate: "2026-03-01",
  arrivalDate: "2026-03-02",
  reservation: { stockVersion: "INV-9@4.ACT-8", reservationId: "RSV-1" },
  planId: "PLAN-9",
};

describe("source command contracts", () => {
  it("round-trip exactly", () => {
    expect(amendScheduleCommandSchema.parse(amend)).toEqual(amend);
    expect(reserveStockCommandSchema.parse(reserve)).toEqual(reserve);
    expect(createTransferRequestCommandSchema.parse(transfer)).toEqual(transfer);
    expect(inventoryReceiptSchema.parse(reservationReceipt)).toEqual(reservationReceipt);
    expect(transferRequestSchema.parse(request)).toEqual(request);
    expect(
      amendScheduleReceiptSchema.parse({
        contractVersion: v,
        kind: "amend_schedule",
        receiptId,
        organization: "ORG-T1",
        operationId: "OP-9",
        requestDigest: digest,
        planId: "PLAN-9",
        actionId: "ACT-9",
        recordedAt: "2026-03-01T09:00:00Z",
        poNumber: "PO-900",
        poLine: "010",
        priorRevision: "7",
        successorRevision: "8",
      }).successorRevision,
    ).toBe("8");
  });

  it.each([
    ["an unknown field", amendScheduleCommandSchema, { ...amend, approved: true }],
    ["a missing operation ID", amendScheduleCommandSchema, { ...amend, operationId: undefined }],
    ["another kind", amendScheduleCommandSchema, { ...amend, kind: "reserve" }],
    ["a numeric revision", amendScheduleCommandSchema, { ...amend, expectedRevision: 7 }],
    ["no segments", amendScheduleCommandSchema, { ...amend, segments: [] }],
    [
      "duplicate sequences",
      amendScheduleCommandSchema,
      { ...amend, segments: [amend.segments[0], amend.segments[0]] },
    ],
    ["a numeric quantity", reserveStockCommandSchema, { ...reserve, quantity: 50 }],
    ["a zero quantity", reserveStockCommandSchema, { ...reserve, quantity: "0" }],
    ["a fractional quantity", reserveStockCommandSchema, { ...reserve, quantity: "1.5" }],
    ["a 19-digit quantity", reserveStockCommandSchema, { ...reserve, quantity: "1".repeat(19) }],
    [
      "an oracle '+' version label",
      reserveStockCommandSchema,
      { ...reserve, expectedVersion: "INV-B@1+ACT-2" },
    ],
    ["a missing plan", reserveStockCommandSchema, { ...reserve, planId: undefined }],
    ["the same warehouses", createTransferRequestCommandSchema, { ...transfer, to: "WH-9" }],
    [
      "a non-UUID predecessor receipt",
      createTransferRequestCommandSchema,
      { ...transfer, predecessorReceiptId: "RCPT-1" },
    ],
    [
      "an offset-free receipt time",
      inventoryReceiptSchema,
      { ...reservationReceipt, recordedAt: "2026-03-01T10:00:00" },
    ],
    ["a short digest", inventoryReceiptSchema, { ...reservationReceipt, requestDigest: "abc" }],
    ["a dispatched request", transferRequestSchema, { ...request, status: "dispatched" }],
  ] as const)("reject %s", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("names the oracle's conflict reasons unqualified and other source errors by namespace", () => {
    for (const reason of sourceRejectionReasonSchema.options) {
      expect(
        ["stale_base_revision", "stale_source_stock"].includes(reason) ||
          /^(source|purchasing|inventory)\.[a-z_]+$/.test(reason),
        reason,
      ).toBe(true);
    }
    expect(sourceRejectionReasonSchema.options).toContain("stale_base_revision");
    expect(sourceRejectionReasonSchema.options).toContain("stale_source_stock");
  });
});
