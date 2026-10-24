import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, loadMigratorConfig } from "@supplier-disruption/config";
import { connectSpendLedger, type ModelSpendLedger } from "../spend.js";

/**
 * Operator commands for the project spend ledger (ADR 0017), run as the
 * migrator role:
 *
 *   spend.js status
 *   spend.js open --micro-usd <n> --evidence <text>
 *   spend.js reconcile --key <key> --micro-usd <n> --evidence <text>
 *
 * `open` records the carried-forward total once; `reconcile` settles a
 * reserved or uncertain attempt from external evidence. Prints amounts and
 * keys only, never a connection string.
 */
export async function runSpendCommand(
  ledger: ModelSpendLedger,
  args: readonly string[],
): Promise<string> {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      "micro-usd": { type: "string" },
      evidence: { type: "string" },
      key: { type: "string" },
    },
  });
  const amount = () => {
    const raw = values["micro-usd"];
    if (raw === undefined || !/^\d+$/.test(raw)) throw new RangeError("--micro-usd <integer>");
    return Number(raw);
  };
  const evidence = () => {
    if (values.evidence === undefined) throw new RangeError("--evidence <text> is required");
    return values.evidence;
  };
  switch (positionals[0]) {
    case "status": {
      const s = await ledger.status();
      return [
        `opened: ${String(s.opened)}${s.openingEvidence === null ? "" : ` (${s.openingEvidence})`}`,
        `opening: ${String(s.openingMicroUsd)} micro-USD`,
        `settled: ${String(s.settledMicroUsd)} micro-USD in ${String(s.counts.settled)} attempts`,
        `reserved: ${String(s.reservedMicroUsd)} micro-USD in ${String(s.counts.reserved)} attempts`,
        `uncertain: ${String(s.uncertainMicroUsd)} micro-USD in ${String(s.counts.uncertain)} attempts`,
        `committed: ${String(s.committedMicroUsd)} micro-USD`,
      ].join("\n");
    }
    case "open":
      return `open: ${await ledger.open(amount(), evidence())}`;
    case "reconcile": {
      if (values.key === undefined) throw new RangeError("--key <reservation key> is required");
      return `reconcile: ${await ledger.reconcile(values.key, amount(), evidence())}`;
    }
    default:
      throw new RangeError("usage: spend.js status | open | reconcile");
  }
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  let close: (() => Promise<void>) | undefined;
  try {
    const config = loadMigratorConfig(process.env);
    const connected = connectSpendLedger(config.databaseUrl, "sd-spend");
    close = connected.close;
    process.stdout.write(`${await runSpendCommand(connected.ledger, process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(
      error instanceof ConfigError ? `${error.message}\n` : `spend: ${String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await close?.();
  }
}
