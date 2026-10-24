// Conditional writes, uncertain outcomes and the operation journal over
// recorded, redacted sandbox responses. No network.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApiPrincipal,
  ErpnextReader,
  ErpnextWriter,
  FileJournal,
  FileRecorder,
  MemoryJournal,
  loadErpnextConfig,
  readPrincipal,
  redactText,
  resourcePath,
  type OperationJournal,
  type PurchaseOrderRead,
  type Transport,
} from "../src/index.js";
import { SITE, lost, on, replay, response, sequence } from "./helpers.js";

const PO = "PUR-ORD-2026-00002";
const PO_PATH = resourcePath("Purchase Order", PO);
const LIST_PO = resourcePath("Purchase Order");
const ROW = "rvevbfr0jl";
const principal = new ApiPrincipal(
  "sd35-prober@example.invalid",
  "test-key-0001",
  "test-secret-0001",
);

async function readBefore(): Promise<PurchaseOrderRead> {
  const transport = replay(
    on("GET", PO_PATH, response("po-stale-before")),
    on("GET", LIST_PO, response("po-no-successors")),
  );
  const read = await new ErpnextReader(transport, null).purchaseOrder(PO);
  if (read.kind !== "ok") throw new Error(JSON.stringify(read));
  return read.value;
}

function writer(transport: Transport, journal: OperationJournal = new MemoryJournal()) {
  return new ErpnextWriter(transport, principal, journal, new ErpnextReader(transport, principal));
}

/** The recorded update moved the PROBE-A row from 2026-10-29 to 2026-11-02. */
const update = (
  purchaseOrder: PurchaseOrderRead,
  operationId = "OP-1",
  scheduleDate = "2026-11-02",
) => ({
  operationId,
  purchaseOrder,
  rowId: ROW,
  scheduleDate,
});

describe("conditional schedule update", () => {
  it("sends every row with the read token and applies only after a matching read-back", async () => {
    const before = await readBefore();
    const transport = replay(
      on("PUT", PO_PATH, { kind: "response", status: 200, body: {}, elapsedMs: 1 }),
      on("GET", PO_PATH, response("po-stale-after-update")),
      on("GET", LIST_PO, response("po-no-successors")),
    );
    const { outcome, record } = await writer(transport).updateScheduleDate(update(before));
    expect(outcome).toBe("recorded");
    expect(record).toMatchObject({
      state: "applied",
      expectedModified: "2026-10-22 13:21:04.242706",
      observedModified: "2026-10-22 13:22:15.379126",
      requestsSent: 1,
    });
    const put = transport.sent[0]!;
    const body = put.body as { modified: string; items: { name: string; schedule_date: string }[] };
    expect(body.modified).toBe("2026-10-22 13:21:04.242706");
    expect(body.items.map((row) => [row.name, row.schedule_date])).toEqual([
      [ROW, "2026-11-02"],
      ["rveuu8hn7k", "2026-10-30"],
    ]);
  });

  it("records a stale token as refused without reading back", async () => {
    const transport = replay(on("PUT", PO_PATH, response("put-stale-417")));
    const { record } = await writer(transport).updateScheduleDate(update(await readBefore()));
    expect(record).toMatchObject({ state: "refused", reason: "stale_source_token" });
    expect(record.history.at(-1)).toMatchObject({
      status: 417,
      sourceError: "TimestampMismatchError",
    });
    expect(transport.sent).toHaveLength(1);
  });

  it("refuses to send an update without a source token", async () => {
    const before = await readBefore();
    const transport = replay();
    const { record } = await writer(transport).updateScheduleDate(
      update({ ...before, native: { ...before.native, modified: "" } }),
    );
    expect(record).toMatchObject({
      state: "refused",
      reason: "missing_source_token",
      requestsSent: 0,
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("never sends a repeated operation, and flags a changed intent", async () => {
    const before = await readBefore();
    const transport = replay(on("PUT", PO_PATH, response("put-stale-417")));
    const connector = writer(transport);
    await connector.updateScheduleDate(update(before));
    const repeated = await connector.updateScheduleDate(update(before));
    expect(repeated.outcome).toBe("duplicate_operation");
    const changed = await connector.updateScheduleDate(update(before, "OP-1", "2026-11-05"));
    expect(changed.outcome).toBe("operation_conflict");
    expect(transport.sent).toHaveLength(1);
  });

  it("refuses a request for the date the row already has, sending nothing", async () => {
    const transport = replay();
    const { record } = await writer(transport).updateScheduleDate(
      update(await readBefore(), "OP-3", "2026-10-29"),
    );
    expect(record).toMatchObject({
      state: "refused",
      reason: "business_validation",
      requestsSent: 0,
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("resolves a lost response by read-back with no second request", async () => {
    const transport = replay(
      on("PUT", PO_PATH, lost),
      on("GET", PO_PATH, response("po-stale-after-update")),
      on("GET", LIST_PO, response("po-no-successors")),
    );
    const { record } = await writer(transport).updateScheduleDate(update(await readBefore()));
    expect(record.history.map((event) => event.state)).toEqual([
      "dispatching",
      "unknown",
      "applied",
    ]);
    expect(transport.sent.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it("keeps a lost update unknown while the token is unchanged, and reconciles later", async () => {
    const before = await readBefore();
    const transport = replay(
      on("PUT", PO_PATH, lost),
      on("GET", PO_PATH, sequence(response("po-stale-before"), response("po-stale-after-update"))),
      on("GET", LIST_PO, response("po-no-successors")),
    );
    const connector = writer(transport);
    const { record } = await connector.updateScheduleDate(update(before));
    expect(record.state).toBe("unknown");
    const later = await connector.reconcile("OP-1");
    expect(later?.state).toBe("applied");
    expect(transport.sent.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it("hands a 500 whose read-back shows another change to an operator", async () => {
    const transport = replay(
      on("PUT", PO_PATH, response("put-concurrent-500")),
      on("GET", PO_PATH, response("po-stale-after-update")),
      on("GET", LIST_PO, response("po-no-successors")),
    );
    const { record } = await writer(transport).updateScheduleDate(
      update(await readBefore(), "OP-2", "2026-11-05"),
    );
    expect(record.history.map((event) => event.state)).toEqual([
      "dispatching",
      "unknown",
      "manual_reconciliation",
    ]);
  });
});

describe("transfer request draft", () => {
  const STOCK_ENTRY = resourcePath("Stock Entry");
  // The recorded draft carries the marker of operation L08-09c498e2.
  const command = {
    operationId: "L08-09c498e2",
    company: "Nordlund Distribution (fictional)",
    sku: "PROBE-A",
    stockUom: "EA",
    quantity: "7",
    from: "WH-B - NDL",
    to: "WH-A - NDL",
  };

  it("finds a lost create by its marker and confirms the draft", async () => {
    const transport = replay(
      on("POST", STOCK_ENTRY, lost),
      on("GET", STOCK_ENTRY, response("stock-entry-marker-one")),
      on("GET", resourcePath("Stock Entry", "MAT-STE-2026-00005"), response("stock-entry-draft")),
    );
    const { record } = await writer(transport).createTransferRequestDraft(command);
    expect(record).toMatchObject({
      state: "applied",
      nativeName: "MAT-STE-2026-00005",
      requestsSent: 1,
    });
    const post = transport.sent[0]!.body as { docstatus: number; remarks: string };
    expect(post.docstatus).toBe(0);
    expect(post.remarks).toContain("sd-op:L08-09c498e2");
  });

  it("keeps a lost create unknown when no record carries the marker", async () => {
    const transport = replay(
      on("POST", STOCK_ENTRY, lost),
      on("GET", STOCK_ENTRY, response("stock-entry-marker-none")),
    );
    const { record } = await writer(transport).createTransferRequestDraft(command);
    expect(record.state).toBe("unknown");
    expect(transport.sent.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("never binds an operation to a record marked with a longer operation ID", async () => {
    // OP-1's create was lost; only OP-10's draft exists, and the server-side
    // like search for "sd-op:OP-1" also returns it.
    const one = response("stock-entry-marker-one");
    const rows = (one as { body: { data: { remarks: string }[] } }).body.data;
    const other = {
      ...one,
      body: {
        data: [
          { ...rows[0]!, remarks: "sd-op:OP-10 transfer request draft; not a dispatch or receipt" },
        ],
      },
    };
    const transport = replay(on("POST", STOCK_ENTRY, lost), on("GET", STOCK_ENTRY, other));
    const connector = writer(transport);
    const { record } = await connector.createTransferRequestDraft({
      ...command,
      operationId: "OP-1",
    });
    expect(record).toMatchObject({ state: "unknown", nativeName: null });
    const later = await connector.reconcile("OP-1");
    expect(later).toMatchObject({ state: "unknown", nativeName: null });
    expect(transport.sent.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("records a zero quantity as refused without sending", async () => {
    const transport = replay();
    const { record } = await writer(transport).createTransferRequestDraft({
      ...command,
      operationId: "OP-0",
      quantity: "0",
    });
    expect(record).toMatchObject({
      state: "refused",
      reason: "business_validation",
      requestsSent: 0,
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("hands two marked records to an operator", async () => {
    const one = response("stock-entry-marker-one");
    const rows = (one as { body: { data: unknown[] } }).body.data;
    const two = {
      ...one,
      body: { data: [...rows, { ...(rows[0] as object), name: "MAT-STE-2026-00099" }] },
    };
    const transport = replay(on("POST", STOCK_ENTRY, lost), on("GET", STOCK_ENTRY, two));
    const { record } = await writer(transport).createTransferRequestDraft(command);
    expect(record.state).toBe("manual_reconciliation");
  });
});

describe("operation journal and unsupported operations", () => {
  it("survives a restart: a new writer on the same file refuses the operation again", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sd-journal-")), "operations.json");
    const before = await readBefore();
    const transport = replay(on("PUT", PO_PATH, response("put-stale-417")));
    await writer(transport, new FileJournal(path)).updateScheduleDate(update(before));
    const restarted = await writer(transport, new FileJournal(path)).updateScheduleDate(
      update(before),
    );
    expect(restarted.outcome).toBe("duplicate_operation");
    expect(transport.sent).toHaveLength(1);
  });

  it("after a crash mid-request, a restarted writer refuses to resend and reconciles by read-back", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sd-journal-")), "operations.json");
    const before = await readBefore();
    // The first process journals the operation as dispatching and dies in the request.
    const crashed = replay();
    await expect(
      writer(crashed, new FileJournal(path)).updateScheduleDate(update(before)),
    ).rejects.toThrow();
    expect(new FileJournal(path).get("OP-1")).toMatchObject({
      state: "dispatching",
      requestsSent: 1,
    });
    const transport = replay(
      on("GET", PO_PATH, response("po-stale-after-update")),
      on("GET", LIST_PO, response("po-no-successors")),
    );
    const restarted = writer(transport, new FileJournal(path));
    const repeated = await restarted.updateScheduleDate(update(before));
    expect(repeated.outcome).toBe("duplicate_operation");
    const reconciled = await restarted.reconcile("OP-1");
    expect(reconciled).toMatchObject({ state: "applied", requestsSent: 1 });
    expect(transport.sent.every((request) => request.method === "GET")).toBe(true);
  });

  it("records unsupported operations as never sent", () => {
    const transport = replay();
    const { record } = writer(transport).unsupported({
      operationId: "OP-9",
      kind: "split_line",
      target: { doctype: "Purchase Order", name: PO },
    });
    expect(record).toMatchObject({
      state: "unsupported",
      requestsSent: 0,
      intent: { kind: "not_sent" },
    });
    expect(record.history[0]!.note).toMatch(/^manual: /);
    expect(transport.sent).toHaveLength(0);
  });
});

describe("configuration and evidence", () => {
  it("accepts only a loopback sandbox origin", () => {
    expect(loadErpnextConfig({})).toEqual({ kind: "absent" });
    const remote = loadErpnextConfig({
      ERPNEXT_BASE_URL: "https://erp.example.com",
      ERPNEXT_CREDENTIALS_FILE: "x",
    });
    expect(remote).toMatchObject({
      kind: "invalid",
      issues: ["ERPNEXT_BASE_URL must be a loopback sandbox origin"],
    });
    const named = loadErpnextConfig({
      ERPNEXT_BASE_URL: "http://localhost:18082",
      ERPNEXT_CREDENTIALS_FILE: "x",
    });
    expect(named.kind).toBe("invalid");
    const local = loadErpnextConfig(
      { ERPNEXT_BASE_URL: "http://127.0.0.1:18082", ERPNEXT_CREDENTIALS_FILE: "creds.env" },
      "/work",
    );
    expect(local).toEqual({
      kind: "ok",
      config: {
        baseUrl: "http://127.0.0.1:18082",
        timeoutMs: 10_000,
        credentialsFile: "/work/creds.env",
      },
    });
  });

  it("never exposes a principal's key or secret, and names no path in errors", () => {
    const config = {
      baseUrl: "http://127.0.0.1:18082",
      timeoutMs: 1000,
      credentialsFile: "/nonexistent/private.env",
    };
    expect(() => readPrincipal(config, "reader")).toThrow(
      /^ERPNEXT_CREDENTIALS_FILE cannot be read$/,
    );
    expect(JSON.stringify(principal)).toBe('{"user":"sd35-prober@example.invalid"}');
    const dir = mkdtempSync(join(tmpdir(), "sd-creds-"));
    const file = join(dir, "short.env");
    writeFileSync(
      file,
      "SD_API_USER=reader@example.invalid\nSD_API_KEY=abc\nSD_API_SECRET=0123456789\n",
    );
    expect(() => readPrincipal({ ...config, credentialsFile: file }, "reader")).toThrow(
      /^credentials file holds a too-short SD_API_KEY for the reader principal$/,
    );
  });

  it("redacts every secret value, however short", () => {
    expect(redactText('{"note":"k7x and k7x"}', ["k7x", ""])).toBe(
      '{"note":"[REDACTED] and [REDACTED]"}',
    );
  });

  it("records exchanges with no credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-evidence-"));
    const recorder = new FileRecorder(dir);
    recorder.step("T1");
    recorder.record(
      {
        principal: principal.user,
        request: {
          method: "PUT",
          path: PO_PATH,
          url: `${SITE}${PO_PATH}`,
          body: { note: "test-secret-0001" },
        },
        startedAt: "2026-10-22T11:16:00.000Z",
        result: response("put-stale-417"),
      },
      principal.secretValues(),
    );
    const text = readFileSync(join(dir, "T1-01-put.json"), "utf8");
    expect(text).not.toContain("test-secret-0001");
    expect(text).not.toContain("test-key-0001");
    expect(text).not.toMatch(/authorization/i);
    expect(JSON.parse(text)).toMatchObject({
      principal: "sd35-prober@example.invalid",
      response: { status: 417, body: { exc: "[traceback omitted by the recorder]" } },
    });
  });
});
