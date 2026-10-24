import Anthropic from "@anthropic-ai/sdk";
import { canonicalJson } from "@supplier-disruption/contracts";
import { sha256Hex } from "./evidence.js";

/**
 * The small provider adapter the graph calls. Requests and responses are plain
 * JSON in the Messages API shape, so a run can be checkpointed, recorded and
 * replayed. A recording holds request digests and response bodies only, never
 * headers, keys or account identifiers.
 */
export interface ModelRequest {
  model: string;
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  maxTokens: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelResponse {
  model: string;
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: ModelUsage;
  latencyMs: number;
}

export interface ModelProvider {
  /** `anthropic`, `replay` or `scripted`, recorded on the run. */
  readonly name: string;
  readonly model: string;
  /**
   * Whether a call can cost money. Only an explicit `false` (replays and test
   * fakes) skips the project spend admission (ADR 0017).
   */
  readonly metered?: boolean;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * What kind of provider failure a pause records (ADR 0019): the provider could
 * not serve the configured model, or the call failed for another reason (an
 * error status, a timeout or a lost connection).
 */
export type ProviderFailureKind = "model_unavailable" | "provider_error";

/**
 * A provider failure the graph turns into a safe pause; `detail` carries no
 * secret. `usageUnknown` is true unless the failure happened before any
 * request was sent: a timeout or error after sending may still be billed.
 */
export class ProviderError extends Error {
  constructor(
    readonly detail: string,
    readonly usageUnknown = true,
    readonly kind: ProviderFailureKind = "provider_error",
  ) {
    super(detail);
    this.name = "ProviderError";
  }
}

/**
 * Standard first-party prices in USD per million tokens (claude-api skill,
 * cached 2026-10-06, prompts up to 100K tokens). Cache reads cost 0.1x and
 * five-minute cache writes 1.25x the input price.
 */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** Metered cost of one response in micro-USD, rounded up. Unknown models are refused. */
export function costMicroUsd(model: string, usage: ModelUsage): number {
  const price = MODEL_PRICES[model];
  // The response exists, so the call was billed at a price we do not know.
  if (price === undefined) throw new ProviderError(`no price is configured for ${model}`);
  return Math.ceil(
    usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.input * 0.1 +
      usage.cacheWriteTokens * price.input * 1.25,
  );
}

/**
 * Tokens the API adds around a request (the tool-use system prompt and
 * message framing), allowed generously on top of the serialized request.
 */
const REQUEST_OVERHEAD_TOKENS = 2_048;

/**
 * The most one call can cost, in micro-USD, before it is sent. Every input
 * token covers at least one UTF-8 byte, so the serialized request's byte
 * length plus an overhead allowance bounds input tokens; each is priced as a
 * five-minute cache write (1.25x, the dearest input rate this provider uses),
 * and output is bounded by `maxTokens`, which includes thinking.
 */
export function worstCaseCostMicroUsd(request: ModelRequest): number {
  const price = MODEL_PRICES[request.model];
  if (price === undefined) {
    throw new ProviderError(
      `no price is configured for ${request.model}`,
      false,
      "model_unavailable",
    );
  }
  const inputTokens =
    new TextEncoder().encode(canonicalJson(request)).length + REQUEST_OVERHEAD_TOKENS;
  return Math.ceil(inputTokens * price.input * 1.25 + request.maxTokens * price.output);
}

export function requestDigest(request: ModelRequest): string {
  return sha256Hex(canonicalJson(request));
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Calls the Messages API. The stable system prompt and tool list form the
 * cached prefix; top-level automatic caching also reuses the growing
 * conversation within a run. Thinking stays adaptive at low effort, and
 * returned content is passed back unchanged on the next turn.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly metered = true;
  readonly model: string;
  readonly #client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      // No hidden retries: a retried request could be billed twice while only
      // the last attempt reports usage. A failed call pauses the run instead.
      maxRetries: 0,
      timeout: options.timeoutMs ?? 60_000,
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    try {
      const message = await this.#client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        tools: request.tools,
        messages: request.messages,
        cache_control: { type: "ephemeral" },
        output_config: { effort: "low" },
      });
      return {
        model: message.model,
        content: message.content,
        stopReason: message.stop_reason,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        // The Messages API answers 404 `not_found_error` for a model it does not serve.
        throw new ProviderError(
          `provider returned ${String(error.status ?? "no status")}`,
          true,
          error.status === 404 ? "model_unavailable" : "provider_error",
        );
      }
      throw new ProviderError(error instanceof Error ? error.name : "provider call failed");
    }
  }
}

/** One recorded exchange: the request digest and the response body. */
export interface RecordedExchange {
  requestDigest: string;
  response: ModelResponse;
}

/** Wraps a provider and keeps each exchange for a replay file. */
export class RecordingProvider implements ModelProvider {
  readonly exchanges: RecordedExchange[] = [];
  constructor(readonly inner: ModelProvider) {}
  get name() {
    return this.inner.name;
  }
  get metered() {
    return this.inner.metered;
  }
  get model() {
    return this.inner.model;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.inner.complete(request);
    this.exchanges.push({ requestDigest: requestDigest(request), response });
    return response;
  }
}

/**
 * Replays recorded responses in order, offline. `digestMismatches` counts
 * requests that differ from the recording (for example after a prompt
 * change), so a report can say the replay no longer matches its prompt.
 */
export class ReplayProvider implements ModelProvider {
  readonly name = "replay";
  readonly metered = false;
  readonly model: string;
  digestMismatches = 0;
  #next = 0;

  constructor(readonly exchanges: readonly RecordedExchange[]) {
    this.model = exchanges[0]?.response.model ?? "replay";
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    const exchange = this.exchanges[this.#next];
    this.#next += 1;
    if (exchange === undefined) {
      return Promise.reject(new ProviderError("the replay has no further recorded response"));
    }
    if (exchange.requestDigest !== requestDigest(request)) this.digestMismatches += 1;
    return Promise.resolve(exchange.response);
  }
}

/**
 * Serves a recorded run by request digest, offline and stateless, so every
 * run of exactly the recorded email gets the recorded responses and any other
 * request fails as a provider error (the run then pauses for the buyer). The
 * recorded usage is reported unchanged: its cost is what the recording spent,
 * not new spend. Used by the demonstration mode (ADR 0012).
 */
export class RecordedRunProvider implements ModelProvider {
  readonly name = "replay";
  readonly metered = false;
  readonly model: string;
  readonly #byDigest: ReadonlyMap<string, ModelResponse>;

  constructor(exchanges: readonly RecordedExchange[]) {
    this.model = exchanges[0]?.response.model ?? "replay";
    this.#byDigest = new Map(
      exchanges.map((exchange) => [exchange.requestDigest, exchange.response]),
    );
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    const response = this.#byDigest.get(requestDigest(request));
    return response === undefined
      ? Promise.reject(
          new ProviderError(
            "the recorded run has no response for this request; only the recorded email replays",
          ),
        )
      : Promise.resolve(structuredClone(response));
  }
}

/** A scripted response; `usage` defaults to 1,000 input and 100 output tokens. */
export type ScriptedStep = Pick<ModelResponse, "content" | "stopReason"> & {
  usage?: ModelUsage | null;
};

const SCRIPTED_USAGE: ModelUsage = {
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Test provider: each call returns the next scripted response (or throws it).
 * Unmetered unless `metered` is set, which makes it stand in for a paid
 * provider in spend admission tests; it never calls a network service.
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  readonly requests: ModelRequest[] = [];
  readonly metered: boolean;
  #next = 0;

  constructor(
    readonly model: string,
    readonly script: readonly (
      | ScriptedStep
      | ProviderError
      | ((request: ModelRequest) => Pick<ModelResponse, "content" | "stopReason">)
    )[],
    options: { metered?: boolean } = {},
  ) {
    this.metered = options.metered ?? false;
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const step = this.script[this.#next];
    this.#next += 1;
    if (step === undefined) return Promise.reject(new ProviderError("script exhausted"));
    if (step instanceof ProviderError) return Promise.reject(step);
    const { usage, ...body }: ScriptedStep = typeof step === "function" ? step(request) : step;
    return Promise.resolve({
      model: this.model,
      ...body,
      // null stands for a response that reported no usage.
      usage: (usage === undefined ? SCRIPTED_USAGE : usage) as ModelUsage,
      latencyMs: 1,
    });
  }
}
