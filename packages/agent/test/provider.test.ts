import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicProvider, ProviderError, SYSTEM_PROMPT, TOOLS } from "../src/index.js";

// A retried request could be billed twice while only the last
// attempt reports usage, so the SDK client must make exactly one request.
// The provider is pointed at a local server; nothing leaves this machine.
let server: Server;
let requests = 0;
const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;

beforeAll(async () => {
  server = createServer((_request, response) => {
    requests += 1;
    // 529 is retryable: an SDK client with retries would ask again.
    response.writeHead(529, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Anthropic provider", () => {
  it("sends one request with no retry and reports the failure as possibly billed", async () => {
    const provider = new AnthropicProvider({
      apiKey: "placeholder, never a real key",
      model: "claude-haiku-5-5",
      timeoutMs: 5_000,
    });
    expect(provider.metered).toBe(true);
    const failure = await provider
      .complete({
        model: "claude-haiku-5-5",
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: [{ role: "user", content: "probe" }],
        maxTokens: 16,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ detail: "provider returned 529", usageUnknown: true });
    expect(requests).toBe(1);
  });
});
