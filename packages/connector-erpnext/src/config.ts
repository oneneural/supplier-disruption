import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";

/**
 * Connector settings, read only by callers that opt in (the live sandbox
 * test). Nothing in the API, worker or demonstration loads them: the
 * connector is a sandbox proof, not production configuration (ADR 0018).
 */
export interface ErpnextConfig {
  /** Origin of the sandbox site, such as `http://127.0.0.1:18082`. */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Path of the credentials file; read when a principal is requested, never logged. */
  readonly credentialsFile: string;
}

export type ConfigResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly issues: readonly string[] }
  | { readonly kind: "ok"; readonly config: ErpnextConfig };

// IP literals only: a name such as localhost depends on resolver configuration.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
// Shorter values could not be redacted from evidence without mangling it.
const MIN_CREDENTIAL_LENGTH = 8;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Reads `ERPNEXT_BASE_URL`, `ERPNEXT_CREDENTIALS_FILE` and `ERPNEXT_TIMEOUT_MS`.
 * Both required values unset means the connector is not configured. The base
 * URL must be a loopback IP origin: this proof never talks to a shared or
 * hosted ERP.
 */
export function loadErpnextConfig(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): ConfigResult {
  const base = env.ERPNEXT_BASE_URL?.trim() ?? "";
  const file = env.ERPNEXT_CREDENTIALS_FILE?.trim() ?? "";
  if (base === "" && file === "") return { kind: "absent" };
  const issues: string[] = [];
  let origin = "";
  try {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push("ERPNEXT_BASE_URL must use http or https");
    } else if (!LOOPBACK_HOSTS.has(url.hostname)) {
      issues.push("ERPNEXT_BASE_URL must be a loopback sandbox origin");
    } else if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      issues.push("ERPNEXT_BASE_URL must be an origin without a path or query");
    }
    origin = url.origin;
  } catch {
    issues.push("ERPNEXT_BASE_URL is not a URL");
  }
  if (file === "") issues.push("ERPNEXT_CREDENTIALS_FILE is required");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.ERPNEXT_TIMEOUT_MS?.trim();
  if (rawTimeout !== undefined && rawTimeout !== "") {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      issues.push("ERPNEXT_TIMEOUT_MS must be an integer from 100 to 120000");
    }
  }
  if (issues.length > 0) return { kind: "invalid", issues };
  return {
    kind: "ok",
    config: { baseUrl: origin, timeoutMs, credentialsFile: resolve(cwd, file) },
  };
}

/** The sandbox's two API principals and the credentials-file keys that hold them. */
export type PrincipalRole = "reader" | "writer";

const PRINCIPAL_KEYS: Record<PrincipalRole, readonly [string, string, string]> = {
  reader: ["SD_API_USER", "SD_API_KEY", "SD_API_SECRET"],
  writer: ["SD_PROBE_USER", "SD_PROBE_API_KEY", "SD_PROBE_API_SECRET"],
};

/**
 * A token-authenticated API user. The key and secret live in private fields,
 * so serializing or inspecting a principal shows only the user name.
 */
export class ApiPrincipal {
  readonly #key: string;
  readonly #secret: string;

  constructor(
    readonly user: string,
    key: string,
    secret: string,
  ) {
    this.#key = key;
    this.#secret = secret;
  }

  /** The `Authorization` header value: `token <key>:<secret>`. */
  authorization(): string {
    return `token ${this.#key}:${this.#secret}`;
  }

  /** Values a recorder must replace before anything is written. */
  secretValues(): readonly string[] {
    return [this.#key, this.#secret];
  }

  toJSON(): { user: string } {
    return { user: this.user };
  }

  [inspect.custom](): string {
    return `ApiPrincipal(${this.user})`;
  }
}

/**
 * Reads one principal from a `KEY=value` credentials file at call time. Errors
 * name the missing key, never the file path or a value.
 */
export function readPrincipal(config: ErpnextConfig, role: PrincipalRole): ApiPrincipal {
  let text: string;
  try {
    text = readFileSync(config.credentialsFile, "utf8");
  } catch {
    throw new Error("ERPNEXT_CREDENTIALS_FILE cannot be read");
  }
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at > 0) values.set(trimmed.slice(0, at), trimmed.slice(at + 1));
  }
  const [userKey, keyKey, secretKey] = PRINCIPAL_KEYS[role];
  const missing = [userKey, keyKey, secretKey].filter((name) => !values.get(name));
  if (missing.length > 0) {
    throw new Error(`credentials file lacks ${missing.join(", ")} for the ${role} principal`);
  }
  const short = [keyKey, secretKey].filter(
    (name) => values.get(name)!.length < MIN_CREDENTIAL_LENGTH,
  );
  if (short.length > 0) {
    throw new Error(
      `credentials file holds a too-short ${short.join(", ")} for the ${role} principal`,
    );
  }
  return new ApiPrincipal(values.get(userKey)!, values.get(keyKey)!, values.get(secretKey)!);
}
