import { readFileSync } from "node:fs";
import type { HttpRequest, HttpResult, Transport } from "../src/index.js";

export const SITE = "http://127.0.0.1:18082";

interface Fixture {
  readonly status: number;
  readonly body: unknown;
}

/** One recorded sandbox response, as a fresh copy. */
export function fixture(name: string): Fixture {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Fixture;
}

export function response(name: string): HttpResult {
  const { status, body } = fixture(name);
  return { kind: "response", status, body, elapsedMs: 1 };
}

export const lost: HttpResult = {
  kind: "transport_error",
  error: "TypeError: fetch failed; cause UND_ERR_SOCKET",
  timedOut: false,
  elapsedMs: 1,
};

type Route = (request: HttpRequest) => HttpResult | undefined;

/**
 * A transport that answers from recorded responses and logs every request.
 * Each route is tried in order; an unmatched request fails the test.
 */
export function replay(...routes: Route[]): Transport & { readonly sent: HttpRequest[] } {
  const sent: HttpRequest[] = [];
  return {
    site: SITE,
    sent,
    send(_principal, request) {
      sent.push(request);
      for (const route of routes) {
        const result = route(request);
        if (result) return Promise.resolve(result);
      }
      throw new Error(`no recorded response for ${request.method} ${request.path}`);
    },
  };
}

/** Matches a method and exact path, optionally only for the first `times` requests. */
export function on(
  method: HttpRequest["method"],
  path: string,
  answer: HttpResult | (() => HttpResult),
): Route {
  return (request) =>
    request.method === method && request.path === path
      ? typeof answer === "function"
        ? answer()
        : answer
      : undefined;
}

/** Answers with each result in turn, repeating the last. */
export function sequence(...results: HttpResult[]): () => HttpResult {
  let index = 0;
  return () => results[Math.min(index++, results.length - 1)]!;
}
