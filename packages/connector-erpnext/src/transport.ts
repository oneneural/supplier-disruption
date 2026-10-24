import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiPrincipal } from "./config.js";

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT";
  /** Path with already encoded segments, such as `/api/resource/Purchase%20Order/PO-1`. */
  readonly path: string;
  /** Query values; arrays and objects are sent as JSON, as Frappe expects for filters and fields. */
  readonly query?: Readonly<Record<string, string | number | readonly unknown[]>>;
  readonly body?: unknown;
}

/**
 * What one request produced. A transport error (connection reset, timeout,
 * withheld response) says nothing about whether the source committed.
 */
export type HttpResult =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: unknown;
      readonly elapsedMs: number;
    }
  | {
      readonly kind: "transport_error";
      readonly error: string;
      readonly timedOut: boolean;
      readonly elapsedMs: number;
    };

export interface Transport {
  /** Origin of the source site; part of every native record reference. */
  readonly site: string;
  /** Sends one request; `principal` null sends no credentials. */
  send(principal: ApiPrincipal | null, request: HttpRequest): Promise<HttpResult>;
}

export interface RecordedExchange {
  readonly principal: string | null;
  readonly request: HttpRequest & { readonly url: string };
  readonly startedAt: string;
  readonly result: HttpResult;
}

/** Receives every exchange together with the values it must redact. */
export interface ExchangeRecorder {
  record(exchange: RecordedExchange, redact: readonly string[]): void;
}

export function requestUrl(base: string, request: HttpRequest): string {
  let url = base + request.path;
  if (request.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query)) {
      params.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    url += `?${params.toString()}`;
  }
  return url;
}

function describeError(error: unknown): { message: string; timedOut: boolean } {
  if (!(error instanceof Error)) return { message: String(error), timedOut: false };
  const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code;
  const detail = cause ? `; cause ${typeof code === "string" ? code : cause.name}` : "";
  return { message: `${error.name}: ${error.message}${detail}`, timedOut };
}

/**
 * A `fetch` transport. It sends each request exactly once, with no retry and
 * no redirect following; a timeout aborts the client side only.
 */
export function createFetchTransport(options: {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly recorder?: ExchangeRecorder;
}): Transport {
  const site = new URL(options.baseUrl).origin;
  return {
    site,
    async send(principal, request) {
      const url = requestUrl(site, request);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (principal) headers.Authorization = principal.authorization();
      if (request.body !== undefined) headers["Content-Type"] = "application/json";
      const startedAt = new Date().toISOString();
      const started = performance.now();
      let result: HttpResult;
      try {
        const response = await fetch(url, {
          method: request.method,
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        const text = await response.text();
        let body: unknown = null;
        if (text !== "") {
          try {
            body = JSON.parse(text);
          } catch {
            body = { nonJson: text.slice(0, 2000) };
          }
        }
        result = {
          kind: "response",
          status: response.status,
          body,
          elapsedMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        const { message, timedOut } = describeError(error);
        result = {
          kind: "transport_error",
          error: message,
          timedOut,
          elapsedMs: Math.round(performance.now() - started),
        };
      }
      options.recorder?.record(
        { principal: principal?.user ?? null, request: { ...request, url }, startedAt, result },
        principal?.secretValues() ?? [],
      );
      return result;
    },
  };
}

/** Frappe tracebacks are long and add nothing to the evidence beyond `exc_type`. */
function trimBody(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && "exc" in body) {
    return { ...body, exc: "[traceback omitted by the recorder]" };
  }
  return body;
}

export function redactText(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value !== "") out = out.split(value).join("[REDACTED]");
  }
  return out;
}

/**
 * Writes each exchange as `<step>-<nn>-<method>.json` under `dir`. Only the
 * method, URL, principal user, request body and its SHA-256, timing, status
 * and response body are kept: no request or response headers, so no
 * `Authorization`, cookie or session value can reach a file, and every secret
 * value of the principal is replaced before writing.
 */
export class FileRecorder implements ExchangeRecorder {
  #step = "run";
  #count = 0;
  readonly #extraRedactions: string[] = [];

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /** Starts a new evidence step; later exchanges are numbered within it. */
  step(name: string): void {
    this.#step = name;
    this.#count = 0;
  }

  /** Adds values, such as a deliberately invalid token, that must never be written. */
  redactAlso(values: readonly string[]): void {
    this.#extraRedactions.push(...values);
  }

  record(exchange: RecordedExchange, redact: readonly string[]): void {
    this.#count += 1;
    const { result, request } = exchange;
    const file = `${this.#step}-${String(this.#count).padStart(2, "0")}-${request.method.toLowerCase()}.json`;
    const requestBody = request.body ?? null;
    const entry = {
      step: this.#step,
      principal: exchange.principal,
      request: {
        method: request.method,
        url: request.url,
        body: requestBody,
        bodySha256:
          requestBody === null
            ? null
            : createHash("sha256").update(JSON.stringify(requestBody)).digest("hex"),
      },
      startedAt: exchange.startedAt,
      elapsedMs: result.elapsedMs,
      response:
        result.kind === "response"
          ? { status: result.status, body: trimBody(result.body) }
          : { transportError: result.error, timedOut: result.timedOut },
    };
    const text = redactText(JSON.stringify(entry, null, 2), [...redact, ...this.#extraRedactions]);
    writeFileSync(join(this.dir, file), `${text}\n`);
  }
}
