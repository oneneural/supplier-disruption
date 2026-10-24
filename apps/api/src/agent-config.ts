import { readFileSync } from "node:fs";
import { AnthropicProvider, MODEL_PRICES } from "@supplier-disruption/agent";
import { AGENT_DEFAULT_TOOL_BUDGET, AGENT_TOOL_CEILING } from "@supplier-disruption/contracts";
import {
  AGENT_CHECKPOINT_SCHEMA,
  ModelSpendLedger,
  OWNER_PAUSE_MICRO_USD,
} from "@supplier-disruption/db";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type pg from "pg";
import type { AgentSettings } from "./cases/extraction.js";
import type { Demonstration } from "./demonstration/index.js";

/**
 * Extraction agent settings from the API environment (ADR 0011). The default
 * provider is `none`: email cases then pause `agent_provider_unavailable`
 * and nothing is metered. `anthropic` reads the key only from
 * ANTHROPIC_API_KEY_FILE; the key is never logged or returned. Each metered
 * run reserves AGENT_RUN_COST_CAP_USD in the project spend ledger shared with
 * the evaluation runner and pauses once the project total would pass
 * AGENT_TOTAL_COST_CAP_USD (ADR 0017). The demonstration mode always replays
 * the recorded C-01 run and refuses a metered provider (ADR 0012).
 */
export function loadAgentSettings(
  env: NodeJS.ProcessEnv,
  pool: pg.Pool,
  demonstration?: Demonstration,
): AgentSettings {
  const checkpointer = new PostgresSaver(pool, undefined, { schema: AGENT_CHECKPOINT_SCHEMA });
  const provider = env.AGENT_PROVIDER ?? "none";
  const toolBudget = Number(env.AGENT_TOOL_BUDGET ?? AGENT_DEFAULT_TOOL_BUDGET);
  if (!Number.isInteger(toolBudget) || toolBudget < 1 || toolBudget > AGENT_TOOL_CEILING) {
    throw new Error(`AGENT_TOOL_BUDGET must be an integer from 1 to ${String(AGENT_TOOL_CEILING)}`);
  }
  const capUsd = Number(env.AGENT_RUN_COST_CAP_USD ?? "0.05");
  if (!(capUsd > 0 && capUsd <= 1))
    throw new Error("AGENT_RUN_COST_CAP_USD must be above 0 and at most 1");
  const totalUsd = Number(env.AGENT_TOTAL_COST_CAP_USD ?? "1");
  if (!(totalUsd >= 0 && totalUsd * 1_000_000 <= OWNER_PAUSE_MICRO_USD))
    throw new Error("AGENT_TOTAL_COST_CAP_USD must be from 0 to 15");
  const base = {
    checkpointer,
    toolBudget,
    costCapMicroUsd: Math.round(capUsd * 1_000_000),
    totalCostCapMicroUsd: Math.round(totalUsd * 1_000_000),
    spendLedger: new ModelSpendLedger(pool),
  };
  if (demonstration !== undefined) {
    if (provider !== "none") throw new Error("the demonstration mode refuses AGENT_PROVIDER");
    return { ...base, provider: demonstration.provider };
  }
  if (provider === "none") return { ...base, provider: null };
  if (provider !== "anthropic") throw new Error("AGENT_PROVIDER must be none or anthropic");
  const model = env.AGENT_MODEL ?? "claude-haiku-5-5";
  if (MODEL_PRICES[model] === undefined)
    throw new Error(`AGENT_MODEL ${model} has no configured price`);
  const keyFile = env.ANTHROPIC_API_KEY_FILE;
  if (keyFile === undefined || keyFile === "") {
    throw new Error("AGENT_PROVIDER=anthropic needs ANTHROPIC_API_KEY_FILE");
  }
  const apiKey = readFileSync(keyFile, "utf8").trim();
  if (apiKey === "") throw new Error("ANTHROPIC_API_KEY_FILE is empty");
  return { ...base, provider: new AnthropicProvider({ apiKey, model }) };
}
