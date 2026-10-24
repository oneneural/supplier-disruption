// The project-wide model spend ledger (ADR 0017) on a disposable
// database. Two independent pools stand in for the API and the evaluation
// runner. No test calls a model provider: the evaluation runner is started
// with a provider base URL on a closed loopback port and must stop at
// admission before it would ever send a request.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelSpendLedger, OWNER_PAUSE_MICRO_USD, SpendLedgerConflict } from "../src/spend.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  NODE_TIMEOUT_MS,
  RESET_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import { REPO_ROOT } from "./support.js";

const run = promisify(execFile);
const db = new DisposableDatabase("spend");
let migrator: pg.Pool;
/** The ledger as the API process sees it. */
let api: ModelSpendLedger;
/** The ledger as a separate evaluation process sees it, on its own pool. */
let evaluation: ModelSpendLedger;
let owner: ModelSpendLedger;

const usage = (costMicroUsd: number) => ({
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicroUsd,
});

const request = (overrides: Partial<Parameters<ModelSpendLedger["admit"]>[0]> = {}) => ({
  key: `test:${randomUUID()}`,
  source: "api" as const,
  reference: randomUUID(),
  model: "claude-haiku-5-5",
  amountMicroUsd: 50_000,
  ...overrides,
});

async function sqlState(pool: pg.Pool, text: string, values: unknown[] = []): Promise<string> {
  try {
    await pool.query(text, values);
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

function connect() {
  migrator = db.pool("migrator", "spend-migrator");
  api = new ModelSpendLedger(db.pool("api", "spend-api"));
  evaluation = new ModelSpendLedger(db.pool("api", "spend-evaluation"));
  owner = new ModelSpendLedger(migrator);
}

beforeAll(async () => {
  await db.start();
  const migrated = await db.migrate();
  expect(migrated.code, migrated.stderr).toBe(0);
  connect();
}, START_TIMEOUT_MS + NODE_TIMEOUT_MS);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

describe("project spend ledger", () => {
  it("refuses every admission until an operator opens it with evidence", async () => {
    const refused = await api.admit(request());
    expect(refused).toMatchObject({ admitted: false, reason: "unopened" });
    expect((await api.status()).counts).toEqual({ reserved: 0, uncertain: 0, settled: 0 });
    // The API role can neither open nor change the opening.
    expect(
      await sqlState(
        db.pool("api", "spend-probe"),
        "INSERT INTO app.model_spend_account (id, opening_micro_usd, opening_evidence) VALUES (1, 0, 'x')",
      ),
    ).toBe("42501");
    await expect(api.open(0, "probe")).rejects.toMatchObject({ code: "42501" });

    expect(await owner.open(30_763, "evaluation ledger and four live reports")).toBe("opened");
    expect(await owner.open(30_763, "evaluation ledger and four live reports")).toBe("unchanged");
    await expect(owner.open(0, "a reset")).rejects.toBeInstanceOf(SpendLedgerConflict);
    expect(await api.status()).toMatchObject({ opened: true, committedMicroUsd: 30_763 });
  });

  it("admits exactly one of two concurrent runs whose sum passes the remaining limit", async () => {
    const before = (await api.status()).committedMicroUsd;
    const limit = before + 100_000;
    // Ten individually admissible runs from two processes; only one fits.
    const attempts = Array.from({ length: 10 }, (_, index) =>
      (index % 2 === 0 ? api : evaluation).admit(
        request({
          amountMicroUsd: 60_000,
          limitMicroUsd: limit,
          source: index % 2 === 0 ? "api" : "evaluation",
        }),
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((result) => result.admitted)).toHaveLength(1);
    for (const refused of results.filter((result) => !result.admitted)) {
      expect(refused).toMatchObject({ reason: "limit", limitMicroUsd: limit });
    }
    expect((await api.status()).committedMicroUsd).toBe(before + 60_000);

    // Exactly two of two that fit together are admitted.
    const pair = await Promise.all([
      api.admit(request({ amountMicroUsd: 20_000, limitMicroUsd: limit })),
      evaluation.admit(request({ amountMicroUsd: 20_000, limitMicroUsd: limit })),
    ]);
    expect(pair.every((result) => result.admitted)).toBe(true);
    expect((await api.status()).committedMicroUsd).toBe(limit);
  });

  it("never lets an application limit pass the owner's USD 15 pause", async () => {
    const status = await api.status();
    const refused = await api.admit(
      request({
        amountMicroUsd: OWNER_PAUSE_MICRO_USD - status.committedMicroUsd + 1,
        limitMicroUsd: 20_000_000,
      }),
    );
    expect(refused).toMatchObject({
      admitted: false,
      reason: "limit",
      limitMicroUsd: OWNER_PAUSE_MICRO_USD,
    });
  });

  it("settles with reported usage once; a repeat is idempotent and a different amount conflicts", async () => {
    const admitted = request();
    expect(await api.admit(admitted)).toMatchObject({ admitted: true });
    // Admitting the same key again returns the same reservation.
    expect(await api.admit(admitted)).toMatchObject({ admitted: true, reservedMicroUsd: 50_000 });
    const before = (await api.status()).committedMicroUsd;
    expect(await api.settle(admitted.key, usage(450))).toBe("settled");
    expect(await evaluation.settle(admitted.key, usage(450))).toBe("already_settled");
    await expect(api.settle(admitted.key, usage(0))).rejects.toBeInstanceOf(SpendLedgerConflict);
    await expect(api.markUncertain(admitted.key, "late timeout")).resolves.toBeUndefined();
    const after = await api.status();
    expect(after.committedMicroUsd).toBe(before - 50_000 + 450);
    const { rows } = await migrator.query(
      "SELECT status, settled_micro_usd::int AS settled, usage FROM app.model_spend_reservation WHERE key = $1",
      [admitted.key],
    );
    expect(rows).toEqual([{ status: "settled", settled: 450, usage: usage(450) }]);
  });

  it("returns an existing key only while it is reserved for the same admission", async () => {
    const first = request();
    expect(await api.admit(first)).toMatchObject({ admitted: true });
    expect(await evaluation.admit(first)).toMatchObject({ admitted: true, key: first.key });
    const before = (await api.status()).committedMicroUsd;
    for (const changed of [
      { amountMicroUsd: 40_000 },
      { model: "claude-sonnet-5-5" },
      { reference: "another-run" },
      { source: "evaluation" as const },
    ]) {
      expect(await api.admit({ ...first, ...changed })).toMatchObject({
        admitted: false,
        reason: "key_in_use",
      });
    }
    await api.settle(first.key, usage(150));
    expect(await api.admit(first)).toMatchObject({ admitted: false, reason: "key_in_use" });
    const unknown = request();
    await api.admit(unknown);
    await api.markUncertain(unknown.key, "timeout");
    expect(await api.admit(unknown)).toMatchObject({ admitted: false, reason: "key_in_use" });
    expect((await api.status()).committedMicroUsd).toBe(before - 50_000 + 150 + 50_000);
  });

  it("starts every reservation reserved, and only the operator settles unknown usage", async () => {
    const apiPool = db.pool("api", "spend-insert-probe");
    for (const pool of [apiPool, migrator]) {
      expect(
        await sqlState(
          pool,
          `INSERT INTO app.model_spend_reservation (key, source, reference, model, reserved_micro_usd, status, settled_micro_usd)
           VALUES ($1, 'api', 'probe', 'claude-haiku-5-5', 1, 'settled', 0)`,
          [`probe:${randomUUID()}`],
        ),
      ).toBe("23514");
      expect(
        await sqlState(
          pool,
          `INSERT INTO app.model_spend_reservation (key, source, reference, model, reserved_micro_usd, status)
           VALUES ($1, 'api', 'probe', 'claude-haiku-5-5', 1, 'uncertain')`,
          [`probe:${randomUUID()}`],
        ),
      ).toBe("23514");
    }
    const late = request();
    await api.admit(late);
    await api.markUncertain(late.key, "marked by a later attempt");
    // The attempt's own late settlement records its usage and stays uncertain.
    expect(await api.settle(late.key, usage(1))).toBe("uncertain");
    expect(
      await sqlState(
        apiPool,
        "UPDATE app.model_spend_reservation SET status = 'settled', settled_micro_usd = 0 WHERE key = $1",
        [late.key],
      ),
    ).toBe("42501");
    const { rows } = await migrator.query(
      "SELECT status, usage FROM app.model_spend_reservation WHERE key = $1",
      [late.key],
    );
    expect(rows).toEqual([{ status: "uncertain", usage: usage(1) }]);
    expect(await owner.reconcile(late.key, 1, "the attempt's reported usage, checked")).toBe(
      "settled",
    );
  });

  it("keeps unknown usage fully reserved until an operator reconciles it with evidence", async () => {
    const timedOut = request();
    await api.admit(timedOut);
    const before = (await api.status()).committedMicroUsd;
    await api.markUncertain(timedOut.key, "timeout after the request was sent", usage(150));
    const held = await api.status();
    expect(held.committedMicroUsd).toBe(before);
    expect(held.counts.uncertain).toBeGreaterThan(0);
    // The API role cannot release it: no return to reserved, no smaller amount, no delete.
    const apiPool = db.pool("api", "spend-release-probe");
    expect(
      await sqlState(
        apiPool,
        "UPDATE app.model_spend_reservation SET status = 'reserved' WHERE key = $1",
        [timedOut.key],
      ),
    ).toBe("23514");
    expect(
      await sqlState(
        apiPool,
        "UPDATE app.model_spend_reservation SET reserved_micro_usd = 1 WHERE key = $1",
        [timedOut.key],
      ),
    ).toBe("42501");
    expect(
      await sqlState(apiPool, "DELETE FROM app.model_spend_reservation WHERE key = $1", [
        timedOut.key,
      ]),
    ).toBe("42501");
    await expect(owner.reconcile(timedOut.key, 300, " ")).rejects.toBeInstanceOf(RangeError);
    expect(await owner.reconcile(timedOut.key, 300, "provider console usage for the request")).toBe(
      "settled",
    );
    expect(await owner.reconcile(timedOut.key, 300, "again")).toBe("already_settled");
    expect((await api.status()).committedMicroUsd).toBe(before - 50_000 + 300);
    // A settled reservation is final, even for the migrator.
    expect(
      await sqlState(
        migrator,
        "UPDATE app.model_spend_reservation SET status = 'uncertain' WHERE key = $1",
        [timedOut.key],
      ),
    ).toBe("23514");
  });

  it(
    "keeps reservations across a restart and fails closed on a recreated database",
    async () => {
      const crashed = request({ reference: "run-crashed" });
      await api.admit(crashed);
      const before = await api.status();
      // A new process: fresh pools, nothing carried in memory.
      connect();
      const restarted = await api.status();
      expect(restarted).toEqual(before);
      // The next attempt for the run marks the stopped one uncertain; it stays counted.
      expect(await api.abandon("run-crashed", "the process stopped before settling")).toBe(1);
      expect(await api.abandon("run-crashed", "again")).toBe(0);
      const abandoned = await api.status();
      expect(abandoned.committedMicroUsd).toBe(before.committedMicroUsd);
      expect(abandoned.counts.uncertain).toBe(before.counts.uncertain + 1);

      // Deleting the volume loses the ledger; the new one refuses until reopened.
      await db.recreate();
      const migrated = await db.migrate();
      expect(migrated.code, migrated.stderr).toBe(0);
      connect();
      expect(await api.admit(request())).toMatchObject({ admitted: false, reason: "unopened" });
    },
    RESET_TIMEOUT_MS,
  );

  it(
    "opens and reports through the operator command, printing no connection string",
    async () => {
      const env = {
        PATH: process.env.PATH,
        DATABASE_URL_MIGRATOR: db.url("migrator"),
      };
      const command = (...args: string[]) =>
        run("node", ["packages/db/dist/cli/spend.js", ...args], {
          cwd: REPO_ROOT,
          env,
          timeout: NODE_TIMEOUT_MS,
        });
      const opened = await command("open", "--micro-usd", "14990000", "--evidence", "test opening");
      expect(opened.stdout).toBe("open: opened\n");
      const status = await command("status");
      expect(status.stdout).toContain("committed: 14990000 micro-USD");
      expect(status.stdout + status.stderr).not.toContain("postgres");
      await expect(
        command("open", "--micro-usd", "0", "--evidence", "reset"),
      ).rejects.toMatchObject({ code: 1 });
    },
    3 * NODE_TIMEOUT_MS,
  );

  it(
    "stops the evaluation runner at admission, before any provider call",
    async () => {
      // 14.99 of 15 USD is committed (above); the 0.05 case cap cannot fit.
      const out = mkdtempSync(join(tmpdir(), "spend-evaluation-"));
      try {
        const keyFile = join(out, "placeholder-key");
        writeFileSync(keyFile, "placeholder, never a real key\n");
        // The real host record, which an --output-dir run reads and must not move.
        const hostRecord = join(REPO_ROOT, "evaluation/.spend-ledger.json");
        const recordBefore = existsSync(hostRecord) ? readFileSync(hostRecord, "utf8") : null;
        const live = (...extra: string[]) =>
          run(
            "node",
            [
              "evaluation/run.mjs",
              "--set",
              "dev",
              "--label",
              "admission-race",
              "--mode",
              "live",
              "--only",
              "D01",
              "--output-dir",
              out,
              ...extra,
            ],
            {
              cwd: REPO_ROOT,
              timeout: NODE_TIMEOUT_MS,
              env: {
                PATH: process.env.PATH,
                DATABASE_URL_API: db.url("api"),
                ANTHROPIC_API_KEY_FILE: keyFile,
                // A closed port: a request that got past admission would fail, not spend.
                ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
              },
            },
          );
        const stopped = await live();
        // --output-dir moves reports and replays, never the host spend record.
        expect(stopped.stdout).toContain(`spend record: ${hostRecord}\n`);
        expect(existsSync(join(out, ".spend-ledger.json"))).toBe(false);
        expect(existsSync(hostRecord) ? readFileSync(hostRecord, "utf8") : null).toBe(recordBefore);
        expect(stopped.stdout).toContain("stopping before D01: settled and reserved model spend");
        expect(stopped.stdout).not.toMatch(/D01 (proposed|paused)/);
        const report = JSON.parse(
          readFileSync(join(out, "reports/admission-race-live.json"), "utf8"),
        ) as { spend: Record<string, number> };
        expect(report.spend).toEqual({
          runMicroUsd: 0,
          uncertainCases: 0,
          projectLimitMicroUsd: OWNER_PAUSE_MICRO_USD,
          cumulativeBeforeMicroUsd: 14_990_000,
          cumulativeAfterMicroUsd: 14_990_000,
        });
        expect((await api.status()).counts).toEqual({ reserved: 0, uncertain: 0, settled: 0 });

        // Only an explicit --spend-record moves it. A record above the project
        // ledger means the ledger was reset, and the run refuses to start.
        const record = join(out, "record.json");
        writeFileSync(record, JSON.stringify({ cumulativeMicroUsd: 15_000_000, entries: [] }));
        const refused = live("--spend-record", record);
        await expect(refused).rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining(`spend record: ${record}\n`) as unknown,
          stderr: expect.stringContaining("is below the host record") as unknown,
        });
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    3 * NODE_TIMEOUT_MS,
  );
});
