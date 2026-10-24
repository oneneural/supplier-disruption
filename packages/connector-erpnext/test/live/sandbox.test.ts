// Opt-in live proof against the disposable ERPNext v16.52.0 sandbox (ADR 0018).
// Run with `corepack pnpm test:sandbox` after setting ERPNEXT_BASE_URL and
// ERPNEXT_CREDENTIALS_FILE. ERPNEXT_EVIDENCE_DIR additionally writes redacted
// request, response and read-back evidence. Writes touch only the sandbox's
// probe records (PO-P-STALE schedule dates and draft PROBE-A transfers); the
// canonical C-01 records are read and checked unchanged at the end.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApiPrincipal,
  ErpnextReader,
  ErpnextWriter,
  FileJournal,
  FileRecorder,
  classify,
  createFetchTransport,
  loadErpnextConfig,
  mapDemandSnapshot,
  mapStockSnapshot,
  masterConversion,
  purchaseOrderGaps,
  readPrincipal,
  resourcePath,
  type ErpnextConfig,
  type HttpRequest,
  type LabelMap,
  type PurchaseOrderRead,
  type ReadOutcome,
  type Transport,
} from "../../src/index.js";
import { startFaultProxy } from "./proxy.js";

// Like the other host commands, the proof reads the repository's .env when
// present and resolves relative paths from the repository root.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const loaded = loadErpnextConfig(process.env, root);
if (loaded.kind === "invalid") throw new Error(loaded.issues.join("; "));

// Native names assigned by the sandbox setup (its fixture map); a reset
// recreates them in the same order.
const COMPANY = "Nordlund Distribution (fictional)";
const OUT_OF_SCOPE_COMPANY = "SD35 Out Of Scope (fictional)";
const WH_A = "WH-A - NDL";
const WH_B = "WH-B - NDL";
const PO_120 = "PUR-ORD-2026-00001";
const PO_STALE = "PUR-ORD-2026-00002";
const PO_RECV = "PUR-ORD-2026-00006";
const SO_201 = "SAL-ORD-2026-00001";

const labels: LabelMap = {
  organization: { company: COMPANY, label: "ORG-NDL" },
  items: { "PART-A": "PART-A" },
  warehouses: { [WH_A]: "WH-A", [WH_B]: "WH-B" },
  units: { EA: "EA" },
};

function ok<T>(outcome: ReadOutcome<T>): T {
  if (outcome.kind !== "ok") throw new Error(`read failed: ${JSON.stringify(outcome)}`);
  return outcome.value;
}

/** Counts requests, so a test can show that a refused operation sent nothing. */
function counting(inner: Transport): Transport & { count: () => number } {
  let sent = 0;
  return {
    site: inner.site,
    count: () => sent,
    send(principal, request: HttpRequest) {
      sent += 1;
      return inner.send(principal, request);
    },
  };
}

function laterDates(current: string, count: number): string[] {
  const dates = [
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
    "2026-11-09",
  ];
  return dates.filter((date) => date !== current).slice(0, count);
}

// Vitest runs a describe body even to collect skipped tests, so an absent
// configuration registers one skipped test and never builds the live suite.
const config: ErpnextConfig | undefined = loaded.kind === "ok" ? loaded.config : undefined;

if (!config) {
  describe.skip("ERPNext sandbox connector (live)", () => {
    it("needs ERPNEXT_BASE_URL and ERPNEXT_CREDENTIALS_FILE", () => undefined);
  });
} else
  describe("ERPNext sandbox connector (live)", () => {
    const evidenceSetting = process.env.ERPNEXT_EVIDENCE_DIR?.trim();
    const evidenceDir = evidenceSetting ? resolve(root, evidenceSetting) : undefined;
    const recorder = evidenceDir ? new FileRecorder(evidenceDir) : undefined;
    const step = (name: string) => recorder?.step(name);
    const transport = counting(
      createFetchTransport({ baseUrl: config.baseUrl, timeoutMs: config.timeoutMs, recorder }),
    );
    const journalDir = mkdtempSync(join(tmpdir(), "sd-erpnext-journal-"));
    const journalPath = join(journalDir, "operations.json");
    const run = randomUUID().slice(0, 8);
    const summary: Record<string, unknown> = {};
    let reader: ErpnextReader;
    let writerReads: ErpnextReader;
    let writer: ErpnextWriter;
    let writerPrincipal: ApiPrincipal;
    let po120Before: string;

    beforeAll(() => {
      writerPrincipal = readPrincipal(config, "writer");
      reader = new ErpnextReader(transport, readPrincipal(config, "reader"));
      writerReads = new ErpnextReader(transport, writerPrincipal);
      writer = new ErpnextWriter(
        transport,
        writerPrincipal,
        new FileJournal(journalPath),
        writerReads,
      );
    });

    afterAll(() => {
      if (!evidenceDir) return;
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
      const journal = new FileJournal(journalPath).list();
      const result = {
        run,
        site: transport.site,
        connectorRevision: git("rev-parse", "HEAD"),
        connectorSourceChanged:
          git(
            "-C",
            root,
            "status",
            "--porcelain",
            "--",
            "packages/connector-erpnext",
            "packages/contracts",
          ) !== "",
        finishedAt: new Date().toISOString(),
        summary,
        operations: journal,
      };
      writeFileSync(join(evidenceDir, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
    });

    it("L01 identifies both dedicated principals and the pinned versions", async () => {
      step("L01-identity");
      expect(ok(await reader.whoAmI())).toBe("sd35-reader@example.invalid");
      expect(ok(await writerReads.whoAmI())).toBe("sd35-prober@example.invalid");
      const versions = classify(
        await transport.send(writerPrincipal, {
          method: "GET",
          path: "/api/method/frappe.utils.change_log.get_versions",
        }),
      );
      summary.versions =
        versions.kind === "ok" ? (versions.body as { message?: unknown }).message : versions;
    });

    it("L02 reads purchasing, units, demand, stock and reservations into contracts", async () => {
      step("L02-reads");
      const po = ok(await reader.purchaseOrder(PO_120)).record;
      po120Before = po.ref.modified;
      expect(po.ref.docstatus).toBe(1);
      expect(po.amendedBy).toEqual([]);
      const [partA, partU] = po.lines;
      expect(partA).toMatchObject({
        sku: "PART-A",
        uom: "EA",
        ordered: "120",
        stockQuantity: "120",
        conversion: { numerator: "1", denominator: "1" },
        scheduleDate: "2026-10-23",
        warehouse: WH_A,
        received: "0",
        canceled: { state: "unknown" },
        supplierItem: "KF-A-01",
      });
      expect(partU).toMatchObject({
        sku: "PART-U",
        uom: "Box",
        ordered: "6",
        stockQuantity: "60",
        conversion: { numerator: "10", denominator: "1" },
      });
      const gaps = purchaseOrderGaps(po).map((gap) => gap.code);
      expect(gaps).toContain("revision_not_native");
      expect(gaps).toContain("canceled_quantity_not_native");

      const received = ok(await reader.purchaseOrder(PO_RECV)).record;
      expect(received.lines[0]).toMatchObject({ sku: "PROBE-A", ordered: "20", received: "5" });

      const units = ok(await reader.itemUnits("PART-A"));
      expect(units.conversions).toEqual([
        { uom: "EA", ratio: { numerator: "1", denominator: "1" } },
        { uom: "Box", ratio: { numerator: "10", denominator: "1" } },
      ]);
      expect(units.effectiveDates).toEqual({ state: "unknown" });
      expect(masterConversion(units, "Unit")).toEqual({ status: "unlisted" });

      const demand = ok(await reader.salesOrder(SO_201));
      const mappedDemand = mapDemandSnapshot({
        salesOrder: demand,
        labels,
        orderLabel: "SO-201",
        lineLabels: { [demand.lines[0]!.rowId]: "10" },
        attributes: {
          [demand.lines[0]!.rowId]: {
            receiptCutoff: "2026-10-23",
            calendar: { policyId: "CAL-CPH-1", version: 1 },
            priority: 1,
            supplyLinks: [{ poNumber: "PO-120", poLine: "10" }],
          },
        },
      });
      expect(mappedDemand.status).toBe("mapped");
      if (mappedDemand.status === "mapped") {
        expect(mappedDemand.value.snapshot.lines[0]).toMatchObject({
          open: "70",
          destination: "WH-A",
        });
      }

      const bins = ok(await reader.availability("PART-A"));
      const reservations = ok(await reader.reservations("PART-A"));
      const buckets = { qualityHold: "0", safetyStock: "0", declaredBy: "sandbox fixture setup" };
      const eligible: Record<string, string> = {};
      for (const availability of bins) {
        const unresolved = mapStockSnapshot({ availability, reservations, labels });
        expect(unresolved.status).toBe("unresolved");
        const mapped = mapStockSnapshot({ availability, reservations, labels, buckets });
        if (mapped.status !== "mapped") throw new Error(JSON.stringify(mapped.gaps));
        const { snapshot } = mapped.value;
        const held = snapshot.reservations.reduce((sum, item) => sum + Number(item.quantity), 0);
        eligible[snapshot.warehouse] = String(Number(snapshot.physical) - held);
      }
      expect(eligible).toEqual({ "WH-A": "30", "WH-B": "50" });
      // Planning demand (Bin.reserved_qty) is not the physical hold and is never subtracted.
      const binA = bins.find((bin) => bin.warehouse === WH_A)!;
      expect([binA.planningReserved, binA.reservedStock]).toEqual(["130", "10"]);
      summary.reads = { po120: po.ref, eligiblePartA: eligible, poGaps: gaps };
    });

    it("L03 refuses unauthenticated, invalid, unauthorized and out-of-scope requests", async () => {
      step("L03-refusals");
      const anonymous = await new ErpnextReader(transport, null).purchaseOrder(PO_120);
      expect(anonymous).toMatchObject({ kind: "refused", reason: "permission_denied" });

      const invalid = new ApiPrincipal(
        "invalid-token",
        randomBytes(8).toString("hex"),
        randomBytes(8).toString("hex"),
      );
      recorder?.redactAlso(invalid.secretValues());
      const rejected = await new ErpnextReader(transport, invalid).purchaseOrder(PO_120);
      expect(rejected).toMatchObject({ kind: "refused", reason: "authentication_failed" });

      const outOfScope = classify(
        await transport.send(readPrincipal(config, "reader"), {
          method: "GET",
          path: resourcePath("Company", OUT_OF_SCOPE_COMPANY),
        }),
      );
      expect(outOfScope).toMatchObject({ kind: "refused", reason: "permission_denied" });

      const before = ok(await reader.purchaseOrder(PO_STALE));
      const readerWriter = new ErpnextWriter(
        transport,
        readPrincipal(config, "reader"),
        new FileJournal(journalPath),
        reader,
      );
      const [date] = laterDates(before.record.lines[0]!.scheduleDate, 1);
      const attempt = await readerWriter.updateScheduleDate({
        operationId: `L03-${run}`,
        purchaseOrder: before,
        rowId: before.record.lines[0]!.rowId,
        scheduleDate: date!,
      });
      expect(attempt.record).toMatchObject({
        state: "refused",
        reason: "permission_denied",
        requestsSent: 1,
      });
      const after = ok(await reader.purchaseOrder(PO_STALE));
      expect(after.record.ref.modified).toBe(before.record.ref.modified);
    });

    it("L04 to L06 apply a conditional update, refuse stale, tokenless and duplicate ones, across a restart", async () => {
      step("L04-conditional");
      const m0 = ok(await writerReads.purchaseOrder(PO_STALE));
      const row = m0.record.lines[0]!.rowId;
      const [first, second] = laterDates(m0.record.lines[0]!.scheduleDate, 2);
      const applied = await writer.updateScheduleDate({
        operationId: `L04-${run}`,
        purchaseOrder: m0,
        rowId: row,
        scheduleDate: first!,
      });
      expect(applied.record).toMatchObject({ state: "applied", requestsSent: 1 });
      expect(applied.record.observedModified).not.toBe(m0.record.ref.modified);

      const stale = await writer.updateScheduleDate({
        operationId: `L04-stale-${run}`,
        purchaseOrder: m0,
        rowId: row,
        scheduleDate: second!,
      });
      expect(stale.record).toMatchObject({ state: "refused", reason: "stale_source_token" });
      expect(stale.record.history.at(-1)).toMatchObject({
        status: 417,
        sourceError: "TimestampMismatchError",
      });
      const afterStale = ok(await writerReads.purchaseOrder(PO_STALE)).record;
      expect(afterStale.lines[0]!.scheduleDate).toBe(first);

      const sentBefore = transport.count();
      const tokenless: PurchaseOrderRead = { ...m0, native: { ...m0.native, modified: "" } };
      const missing = await writer.updateScheduleDate({
        operationId: `L04-tokenless-${run}`,
        purchaseOrder: tokenless,
        rowId: row,
        scheduleDate: second!,
      });
      expect(missing.record).toMatchObject({
        state: "refused",
        reason: "missing_source_token",
        requestsSent: 0,
      });

      step("L05-duplicate");
      const duplicate = await writer.updateScheduleDate({
        operationId: `L04-${run}`,
        purchaseOrder: m0,
        rowId: row,
        scheduleDate: first!,
      });
      expect(duplicate.outcome).toBe("duplicate_operation");
      expect(duplicate.record.state).toBe("applied");
      const conflict = await writer.updateScheduleDate({
        operationId: `L04-${run}`,
        purchaseOrder: m0,
        rowId: row,
        scheduleDate: second!,
      });
      expect(conflict.outcome).toBe("operation_conflict");

      step("L06-restart");
      const restarted = new ErpnextWriter(
        transport,
        writerPrincipal,
        new FileJournal(journalPath),
        writerReads,
      );
      const afterRestart = await restarted.updateScheduleDate({
        operationId: `L04-${run}`,
        purchaseOrder: m0,
        rowId: row,
        scheduleDate: first!,
      });
      expect(afterRestart.outcome).toBe("duplicate_operation");
      expect(transport.count()).toBe(sentBefore);
    });

    it("L07 resolves a lost update response by read-back, with one request", async () => {
      step("L07-lost-update");
      const proxy = await startFaultProxy(config.baseUrl, "forward_then_drop");
      try {
        const viaProxy = new ErpnextWriter(
          createFetchTransport({ baseUrl: proxy.url, timeoutMs: config.timeoutMs, recorder }),
          writerPrincipal,
          new FileJournal(journalPath),
          writerReads,
        );
        const current = ok(await writerReads.purchaseOrder(PO_STALE));
        const [date] = laterDates(current.record.lines[0]!.scheduleDate, 1);
        const result = await viaProxy.updateScheduleDate({
          operationId: `L07-${run}`,
          purchaseOrder: current,
          rowId: current.record.lines[0]!.rowId,
          scheduleDate: date!,
        });
        expect(proxy.forwarded()).toBe(1);
        expect(proxy.upstreamStatuses()).toEqual([200]);
        expect(result.record.history.map((event) => event.state)).toEqual([
          "dispatching",
          "unknown",
          "applied",
        ]);
        expect(result.record.requestsSent).toBe(1);
      } finally {
        await proxy.close();
      }
    });

    it("L08 resolves a lost create response by its marker, and L09 keeps an unforwarded one unknown", async () => {
      step("L08-lost-create");
      const binsBefore = ok(await writerReads.availability("PROBE-A"));
      const proxy = await startFaultProxy(config.baseUrl, "forward_then_drop");
      const transfer = {
        company: COMPANY,
        sku: "PROBE-A",
        stockUom: "EA",
        quantity: "7",
        from: WH_B,
        to: WH_A,
      };
      try {
        const viaProxy = new ErpnextWriter(
          createFetchTransport({ baseUrl: proxy.url, timeoutMs: config.timeoutMs, recorder }),
          writerPrincipal,
          new FileJournal(journalPath),
          writerReads,
        );
        const created = await viaProxy.createTransferRequestDraft({
          operationId: `L08-${run}`,
          ...transfer,
        });
        expect(proxy.forwarded()).toBe(1);
        expect(created.record.history.map((event) => event.state)).toEqual([
          "dispatching",
          "unknown",
          "applied",
        ]);
        expect(created.record.nativeName).toMatch(/^MAT-STE-/);
        const marked = ok(await writerReads.stockEntriesByMarker(created.record.marker!));
        expect(marked).toHaveLength(1);
      } finally {
        await proxy.close();
      }
      const binsAfter = ok(await writerReads.availability("PROBE-A"));
      expect(binsAfter.map((bin) => [bin.warehouse, bin.physical, bin.reservedStock])).toEqual(
        binsBefore.map((bin) => [bin.warehouse, bin.physical, bin.reservedStock]),
      );

      step("L09-dropped-create");
      const dropping = await startFaultProxy(config.baseUrl, "drop");
      try {
        const viaDrop = new ErpnextWriter(
          createFetchTransport({ baseUrl: dropping.url, timeoutMs: config.timeoutMs, recorder }),
          writerPrincipal,
          new FileJournal(journalPath),
          writerReads,
        );
        const dropped = await viaDrop.createTransferRequestDraft({
          operationId: `L09-${run}`,
          ...transfer,
        });
        expect(dropping.forwarded()).toBe(0);
        expect(dropped.record).toMatchObject({ state: "unknown", requestsSent: 1 });
        const again = await writer.reconcile(`L09-${run}`);
        expect(again).toMatchObject({ state: "unknown", requestsSent: 1 });
      } finally {
        await dropping.close();
      }
    });

    it("L10 lets at most one of two concurrent updates with one token apply", async () => {
      step("L10-concurrent");
      const current = ok(await writerReads.purchaseOrder(PO_STALE));
      const row = current.record.lines[0]!.rowId;
      const [a, b] = laterDates(current.record.lines[0]!.scheduleDate, 2);
      const results = await Promise.all(
        [a!, b!].map((date, index) =>
          writer.updateScheduleDate({
            operationId: `L10-${index}-${run}`,
            purchaseOrder: current,
            rowId: row,
            scheduleDate: date,
          }),
        ),
      );
      const states = results.map((result) => result.record.state);
      expect(states.filter((state) => state === "applied")).toHaveLength(1);
      const loser = results.find((result) => result.record.state !== "applied")!.record;
      expect(["refused", "manual_reconciliation"]).toContain(loser.state);
      const winner = results.find((result) => result.record.state === "applied")!;
      const final = ok(await writerReads.purchaseOrder(PO_STALE)).record;
      expect(final.lines[0]!.scheduleDate).toBe(
        winner.record.intent.kind === "update_schedule_date"
          ? winner.record.intent.scheduleDate
          : "",
      );
      summary.concurrent = results.map((result) => ({
        state: result.record.state,
        reason: result.record.reason,
        last: result.record.history.at(-1),
      }));
    });

    it("L11 records unsupported operations without sending them", () => {
      step("L11-unsupported");
      const sentBefore = transport.count();
      const kinds = [
        "update_items_quantity",
        "split_line",
        "cancel_and_amend",
        "plan_bound_reservation",
        "transfer_submission",
      ] as const;
      for (const kind of kinds) {
        const result = writer.unsupported({
          operationId: `L11-${kind.replaceAll("_", "-")}-${run}`,
          kind,
          target: { doctype: "Purchase Order", name: PO_120 },
        });
        expect(result.record).toMatchObject({ state: "unsupported", requestsSent: 0 });
      }
      expect(transport.count()).toBe(sentBefore);
    });

    it("L12 leaves the canonical C-01 purchase order unchanged", async () => {
      step("L12-canonical");
      const po = ok(await reader.purchaseOrder(PO_120)).record;
      expect(po.ref.modified).toBe(po120Before);
    });
  });
