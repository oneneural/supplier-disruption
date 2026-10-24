import { describe, expect, it } from "vitest";
import {
  PILOT_CONTRACT_VERSION,
  PILOT_MAX_HOLD_MS,
  PILOT_STREAM_EVENT_COUNT,
  PILOT_STREAM_INTERVAL_MS,
  PILOT_STREAM_MAX_MS,
  canonicalJson,
  pilotDigestInput,
  pilotOperationCommandSchema,
  pilotOperationSchema,
  pilotStreamEventSchema,
  type PilotOperationCommand,
} from "../src/index.js";

const command: PilotOperationCommand = {
  contractVersion: PILOT_CONTRACT_VERSION,
  operationId: "0b6f3c1e-9a43-4a5e-8d6b-2f1e7c4a9d10",
  organizationId: "5d2c8a7e-1f34-4b6a-9c8d-7e6f5a4b3c21",
  payload: { note: "pilot" },
};

describe("pilot operation command", () => {
  it("accepts a valid command", () => {
    expect(pilotOperationCommandSchema.parse(command)).toEqual(command);
  });

  it("bounds holdMs at 8000 ms", () => {
    expect(PILOT_MAX_HOLD_MS).toBe(8_000);
  });

  it.each([0, 5000, 8000])("accepts holdMs %i", (holdMs) => {
    const withHold = { ...command, payload: { note: "pilot", holdMs } };
    expect(pilotOperationCommandSchema.parse(withHold)).toEqual(withHold);
  });

  it("leaves holdMs absent rather than defaulting it, so existing digests are unchanged", () => {
    const parsed = pilotOperationCommandSchema.parse(command);
    expect(parsed.payload).toEqual({ note: "pilot" });
    expect(pilotDigestInput(parsed)).toBe(pilotDigestInput(command));
  });

  it.each([
    ["wrong contract version", { ...command, contractVersion: "pilot-operation.v0" }],
    ["non-UUID operation ID", { ...command, operationId: "op-1" }],
    ["non-UUID organization ID", { ...command, organizationId: "org-1" }],
    ["missing payload", { ...command, payload: undefined }],
    ["empty note", { ...command, payload: { note: "" } }],
    ["oversized note", { ...command, payload: { note: "x".repeat(201) } }],
    ["unknown payload field", { ...command, payload: { note: "a", quantity: 5 } }],
    ["negative holdMs", { ...command, payload: { note: "a", holdMs: -1 } }],
    ["fractional holdMs", { ...command, payload: { note: "a", holdMs: 1.5 } }],
    ["holdMs above 8000", { ...command, payload: { note: "a", holdMs: 8_001 } }],
    ["string holdMs", { ...command, payload: { note: "a", holdMs: "100" } }],
    ["unknown top-level field", { ...command, actorId: "user-1" }],
  ])("rejects %s", (_label, input) => {
    expect(pilotOperationCommandSchema.safeParse(input).success).toBe(false);
  });

  it("describes an operation response with an optional receipt", () => {
    const response = {
      ...command,
      state: "completed",
      receipt: {
        receiptId: "9e1d2c3b-4a5f-4e6d-8c7b-6a5f4e3d2c1b",
        recordedAt: "2026-10-18T10:00:00.000Z",
      },
      createdAt: "2026-10-18T09:59:59.000Z",
    };
    expect(pilotOperationSchema.parse(response)).toEqual(response);
    expect(pilotOperationSchema.safeParse({ ...response, state: "applied" }).success).toBe(false);
  });
});

describe("canonical JSON digest input", () => {
  it("sorts keys at every depth and omits whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[true,null]},"b":1}',
    );
  });

  it("is independent of key insertion order", () => {
    const reordered = {
      payload: { note: "pilot" },
      organizationId: command.organizationId,
      operationId: command.operationId,
      contractVersion: command.contractVersion,
    };
    expect(pilotDigestInput(reordered)).toBe(pilotDigestInput(command));
  });

  it("covers version, organization and payload but not the operation ID", () => {
    const input = pilotDigestInput(command);
    expect(JSON.parse(input)).toEqual({
      contractVersion: PILOT_CONTRACT_VERSION,
      organizationId: command.organizationId,
      payload: { note: "pilot" },
    });
    expect(pilotDigestInput({ ...command, payload: { note: "other" } })).not.toBe(input);
    expect(
      pilotDigestInput({ ...command, organizationId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }),
    ).not.toBe(input);
  });

  it("rejects values JSON cannot represent exactly", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe("pilot stream event", () => {
  const event = {
    seq: 1,
    operationId: command.operationId,
    state: "queued",
    emittedAt: "2026-10-19T08:00:00.000Z",
    final: false,
  };

  it("bounds the stream: five events a second apart, well inside 10 s", () => {
    expect(PILOT_STREAM_EVENT_COUNT).toBe(5);
    expect(PILOT_STREAM_INTERVAL_MS).toBe(1_000);
    expect((PILOT_STREAM_EVENT_COUNT - 1) * PILOT_STREAM_INTERVAL_MS).toBeLessThan(
      PILOT_STREAM_MAX_MS,
    );
    expect(PILOT_STREAM_MAX_MS).toBeLessThanOrEqual(10_000);
  });

  it("accepts an event with the operation ID and state only", () => {
    expect(pilotStreamEventSchema.parse(event)).toEqual(event);
  });

  it.each([0, 6, 1.5])("rejects sequence number %s", (seq) => {
    expect(pilotStreamEventSchema.safeParse({ ...event, seq }).success).toBe(false);
  });

  it("rejects any extra identifier", () => {
    for (const extra of [{ jobId: command.operationId }, { receiptId: command.operationId }]) {
      expect(pilotStreamEventSchema.safeParse({ ...event, ...extra }).success).toBe(false);
    }
  });
});
