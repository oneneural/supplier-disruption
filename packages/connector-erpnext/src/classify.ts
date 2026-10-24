import type { ConnectorRefusalReason } from "@supplier-disruption/contracts";
import type { HttpResult } from "./transport.js";

/**
 * How the connector reads one response. `refused` means the source rejected
 * the request inside its transaction and nothing changed. `unknown` covers a
 * missing response and every 5xx: the sandbox answered a lost concurrent
 * update with HTTP 500 `QueryDeadlockError`, and a timeout or reset can
 * follow a commit, so neither is ever treated as a refusal.
 */
export type Classified =
  | { readonly kind: "ok"; readonly status: number; readonly body: unknown }
  | {
      readonly kind: "refused";
      readonly reason: ConnectorRefusalReason;
      readonly status: number;
      readonly sourceError: string | null;
    }
  | {
      readonly kind: "unknown";
      readonly status: number | null;
      readonly sourceError: string | null;
      readonly detail: string;
    };

export function sourceError(body: unknown): string | null {
  if (body && typeof body === "object" && "exc_type" in body) {
    const value = body.exc_type;
    if (typeof value === "string" && value.length <= 200) return value;
  }
  return null;
}

export function classify(result: HttpResult): Classified {
  if (result.kind === "transport_error") {
    return {
      kind: "unknown",
      status: null,
      sourceError: null,
      detail: result.timedOut ? "client timeout" : result.error,
    };
  }
  const { status, body } = result;
  const error = sourceError(body);
  if (status >= 200 && status < 300) return { kind: "ok", status, body };
  if (status >= 500) {
    return { kind: "unknown", status, sourceError: error, detail: `HTTP ${status}` };
  }
  const refused = (reason: ConnectorRefusalReason) =>
    ({ kind: "refused", reason, status, sourceError: error }) as const;
  if (status === 401) return refused("authentication_failed");
  if (status === 403) return refused("permission_denied");
  if (status === 404) return refused("not_found");
  // Frappe maps ValidationError, and so TimestampMismatchError, to HTTP 417.
  if (status === 417) {
    return refused(
      error === "TimestampMismatchError" ? "stale_source_token" : "business_validation",
    );
  }
  if (status >= 400) return refused("rejected");
  return { kind: "unknown", status, sourceError: error, detail: `unexpected HTTP ${status}` };
}
