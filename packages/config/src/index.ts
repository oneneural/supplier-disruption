import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Clock } from "@supplier-disruption/contracts";

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Raised when configuration is invalid. Messages name variables only; a value,
 * even a non-secret one, is never included so that secrets cannot leak through
 * a misplaced setting.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Reader {
  readonly issues: string[] = [];

  constructor(
    private readonly env: Environment,
    private readonly cwd: string,
  ) {}

  /** Reads a non-secret value; `_FILE` is not consulted. */
  plain(name: string): string | undefined {
    const value = this.env[name];
    return value === undefined || value === "" ? undefined : value;
  }

  /**
   * Reads a secret from `NAME` or the file named by `NAME_FILE`. Setting both
   * is rejected even when they agree, so the effective source is never ambiguous.
   */
  secret(name: string): string | undefined {
    const inline = this.plain(name);
    const filePath = this.plain(`${name}_FILE`);
    if (inline !== undefined && filePath !== undefined) {
      this.issues.push(`${name} and ${name}_FILE are both set; set only one`);
      return undefined;
    }
    if (filePath === undefined) {
      return inline;
    }
    let content: string;
    try {
      content = readFileSync(resolve(this.cwd, filePath), "utf8");
    } catch {
      this.issues.push(`${name}_FILE names a file that cannot be read`);
      return undefined;
    }
    const value = content.replace(/\r?\n$/, "");
    if (value === "") {
      this.issues.push(`${name}_FILE names an empty file`);
      return undefined;
    }
    return value;
  }

  /**
   * Reads the container boot ID from the file named by `name`. The image's
   * boot-id service writes a new random UUID there before any service starts.
   * Outside production the variable may be unset; callers then use their own ID.
   */
  bootId(name: string, nodeEnv: NodeEnvironment): string | undefined {
    const filePath = this.plain(name);
    if (filePath === undefined) {
      if (nodeEnv === "production") {
        this.issues.push(`${name} is required when NODE_ENV=production`);
      }
      return undefined;
    }
    let content: string;
    try {
      content = readFileSync(resolve(this.cwd, filePath), "utf8");
    } catch {
      this.issues.push(`${name} names a file that cannot be read`);
      return undefined;
    }
    const value = content.trim();
    if (!UUID_PATTERN.test(value)) {
      this.issues.push(`${name} must contain a UUID`);
      return undefined;
    }
    return value.toLowerCase();
  }

  required(name: string, value: string | undefined): string {
    if (value === undefined) {
      this.issues.push(`${name} is required`);
      return "";
    }
    return value;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = this.plain(name) ?? fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      this.issues.push(`${name} must be one of: ${allowed.join(", ")}`);
      return fallback;
    }
    return value as T;
  }

  minLength(name: string, value: string, length: number): void {
    if (value !== "" && value.length < length) {
      this.issues.push(`${name} must be at least ${length} characters`);
    }
  }

  postgresUrl(name: string, value: string): void {
    if (value === "") return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      this.issues.push(`${name} must be a postgres:// or postgresql:// URL`);
      return;
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      this.issues.push(`${name} must be a postgres:// or postgresql:// URL`);
    }
  }

  origin(name: string, value: string): void {
    if (value === "") return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      this.issues.push(`${name} must be an http(s) origin such as http://127.0.0.1:3102`);
      return;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
      this.issues.push(`${name} must be an http(s) origin such as http://127.0.0.1:3102`);
    }
  }

  port(name: string, fallback: number): number {
    const raw = this.plain(name);
    if (raw === undefined) return fallback;
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
      this.issues.push(`${name} must be a TCP port between 1 and 65535`);
      return fallback;
    }
    return port;
  }

  finish(): void {
    if (this.issues.length > 0) {
      throw new ConfigError(this.issues);
    }
  }
}

export interface LoadOptions {
  /** Base directory for relative `_FILE` paths. Defaults to the process working directory. */
  cwd?: string;
}

/** The only modes this pilot supports. Other blueprint values fail startup. */
export interface Modes {
  dataMode: "fixture";
  agentMode: "rules";
  authMode: "fixture";
}

export type NodeEnvironment = "production" | "development" | "test";

interface Common extends Modes {
  appId: string;
  nodeEnv: NodeEnvironment;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

/**
 * NODE_ENV=test is accepted for every service because the integration tests run
 * the built API and worker with it. It enables only the worker's test hooks.
 * Libraries may also read it (Better Auth relaxes origin and CSRF checks under
 * NODE_ENV=test or TEST), so the API sets those checks explicitly rather than
 * relying on library defaults. Deployments use production.
 */
function readCommon(r: Reader): Common {
  return {
    appId: r.required("APP_ID", r.plain("APP_ID")),
    nodeEnv: r.oneOf("NODE_ENV", ["production", "development", "test"], "production"),
    logLevel: r.oneOf("LOG_LEVEL", ["fatal", "error", "warn", "info", "debug", "trace"], "info"),
    dataMode: r.oneOf("DATA_MODE", ["fixture"], "fixture"),
    agentMode: r.oneOf("AGENT_MODE", ["rules"], "rules"),
    authMode: r.oneOf("AUTH_MODE", ["fixture"], "fixture"),
  };
}

function reader(env: Environment, options: LoadOptions): Reader {
  return new Reader(env, options.cwd ?? process.cwd());
}

export const API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 3001;

/**
 * Business-time source. `system` samples real wall time and is the default and
 * the packaged app's mode. `controlled` reads the fixture clock row on every
 * call and is accepted only for tests with fixture data (ADR 0004).
 * `demonstration` reads the same row in any NODE_ENV, labels the clock as
 * simulated and enables the demonstration controls and the recorded agent
 * run; it is accepted only with fixture data and only when set explicitly
 * (ADR 0012).
 */
export type DomainClockMode = "system" | "controlled" | "demonstration";

/** The server's business clock in system mode: real wall time on every call. */
export const systemClock: Clock = {
  now: () => Promise.resolve(new Date().toISOString()),
};

export interface ApiConfig extends Common {
  appOrigin: string;
  apiPort: number;
  databaseUrl: string;
  betterAuthSecret: string;
  workerServiceToken: string;
  /** This container boot's ID, which a current worker heartbeat must carry. */
  bootId: string | undefined;
  domainClockMode: DomainClockMode;
}

export function loadApiConfig(env: Environment, options: LoadOptions = {}): ApiConfig {
  const r = reader(env, options);
  const common = readCommon(r);
  const appOrigin = r.required("APP_ORIGIN", r.plain("APP_ORIGIN"));
  r.origin("APP_ORIGIN", appOrigin);
  const databaseUrl = r.required("DATABASE_URL_API", r.secret("DATABASE_URL_API"));
  r.postgresUrl("DATABASE_URL_API", databaseUrl);
  const betterAuthSecret = r.required("BETTER_AUTH_SECRET", r.secret("BETTER_AUTH_SECRET"));
  r.minLength("BETTER_AUTH_SECRET", betterAuthSecret, 32);
  const workerServiceToken = r.required("WORKER_SERVICE_TOKEN", r.secret("WORKER_SERVICE_TOKEN"));
  r.minLength("WORKER_SERVICE_TOKEN", workerServiceToken, 32);
  const apiPort = r.port("API_PORT", DEFAULT_API_PORT);
  const bootId = r.bootId("BOOT_ID_FILE", common.nodeEnv);
  const domainClockMode = r.oneOf<DomainClockMode>(
    "DOMAIN_CLOCK_MODE",
    ["system", "controlled", "demonstration"],
    "system",
  );
  if (
    domainClockMode === "controlled" &&
    (common.nodeEnv !== "test" || common.dataMode !== "fixture")
  ) {
    r.issues.push(
      "DOMAIN_CLOCK_MODE=controlled is only accepted with NODE_ENV=test and DATA_MODE=fixture",
    );
  }
  if (domainClockMode === "demonstration" && common.dataMode !== "fixture") {
    r.issues.push("DOMAIN_CLOCK_MODE=demonstration is only accepted with DATA_MODE=fixture");
  }
  r.finish();
  return {
    ...common,
    appOrigin,
    apiPort,
    databaseUrl,
    betterAuthSecret,
    workerServiceToken,
    bootId,
    domainClockMode,
  };
}

/**
 * Test-only worker hooks. They exist so integration tests can interrupt the
 * worker at exact points; outside NODE_ENV=test their variables fail startup.
 */
export interface WorkerTestHooks {
  /** Print a marker and block forever at this point so a test can SIGKILL the process. */
  holdAt: "before-receipt" | "after-receipt" | undefined;
  /** Delay inside the handler before the receipt call, to observe a drain. */
  handlerDelayMs: number;
}

export interface WorkerConfig extends Common {
  databaseUrl: string;
  workerServiceToken: string;
  apiInternalUrl: string;
  buildRevision: string;
  /** This container boot's ID; unset only outside production, where the worker makes its own. */
  bootId: string | undefined;
  testHooks: WorkerTestHooks | undefined;
}

const TEST_HOOK_VARIABLES = ["PILOT_TEST_HOLD_AT", "PILOT_TEST_HANDLER_DELAY_MS"] as const;

export function loadWorkerConfig(env: Environment, options: LoadOptions = {}): WorkerConfig {
  const r = reader(env, options);
  const common = readCommon(r);
  const databaseUrl = r.required("DATABASE_URL_WORKER", r.secret("DATABASE_URL_WORKER"));
  r.postgresUrl("DATABASE_URL_WORKER", databaseUrl);
  const workerServiceToken = r.required("WORKER_SERVICE_TOKEN", r.secret("WORKER_SERVICE_TOKEN"));
  r.minLength("WORKER_SERVICE_TOKEN", workerServiceToken, 32);
  const apiPort = r.port("API_PORT", DEFAULT_API_PORT);
  const buildRevision = r.plain("BUILD_REVISION") ?? "unknown";
  const bootId = r.bootId("BOOT_ID_FILE", common.nodeEnv);

  let testHooks: WorkerTestHooks | undefined;
  const hookSet = TEST_HOOK_VARIABLES.filter((name) => r.plain(name) !== undefined);
  if (common.nodeEnv === "test") {
    const holdAt = r.plain("PILOT_TEST_HOLD_AT");
    if (holdAt !== undefined && holdAt !== "before-receipt" && holdAt !== "after-receipt") {
      r.issues.push("PILOT_TEST_HOLD_AT must be one of: before-receipt, after-receipt");
    }
    const delayRaw = r.plain("PILOT_TEST_HANDLER_DELAY_MS");
    const handlerDelayMs = delayRaw === undefined ? 0 : Number(delayRaw);
    if (!Number.isInteger(handlerDelayMs) || handlerDelayMs < 0) {
      r.issues.push("PILOT_TEST_HANDLER_DELAY_MS must be a non-negative integer");
    }
    testHooks = {
      holdAt: holdAt as WorkerTestHooks["holdAt"],
      handlerDelayMs: Number.isInteger(handlerDelayMs) ? handlerDelayMs : 0,
    };
  } else {
    for (const name of hookSet) {
      r.issues.push(`${name} is only accepted when NODE_ENV=test`);
    }
  }
  r.finish();
  return {
    ...common,
    databaseUrl,
    workerServiceToken,
    apiInternalUrl: `http://${API_HOST}:${apiPort}`,
    buildRevision,
    bootId,
    testHooks,
  };
}

export interface MigratorConfig {
  databaseUrl: string;
  apiRole: string;
  workerRole: string;
}

export function loadMigratorConfig(env: Environment, options: LoadOptions = {}): MigratorConfig {
  const r = reader(env, options);
  const databaseUrl = r.required("DATABASE_URL_MIGRATOR", r.secret("DATABASE_URL_MIGRATOR"));
  r.postgresUrl("DATABASE_URL_MIGRATOR", databaseUrl);
  const apiRole = r.plain("DB_API_ROLE") ?? "sd_api";
  const workerRole = r.plain("DB_WORKER_ROLE") ?? "sd_worker";
  for (const [name, role] of [
    ["DB_API_ROLE", apiRole],
    ["DB_WORKER_ROLE", workerRole],
  ] as const) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
      r.issues.push(`${name} must be a lowercase PostgreSQL identifier`);
    }
  }
  r.finish();
  return { databaseUrl, apiRole, workerRole };
}

export interface SeedConfig extends Modes {
  appOrigin: string;
  databaseUrl: string;
  betterAuthSecret: string;
  buyerPassword: string;
  managerPassword: string;
}

export function loadSeedConfig(env: Environment, options: LoadOptions = {}): SeedConfig {
  const r = reader(env, options);
  const common = readCommon(r);
  const appOrigin = r.required("APP_ORIGIN", r.plain("APP_ORIGIN"));
  r.origin("APP_ORIGIN", appOrigin);
  const databaseUrl = r.required("DATABASE_URL_MIGRATOR", r.secret("DATABASE_URL_MIGRATOR"));
  r.postgresUrl("DATABASE_URL_MIGRATOR", databaseUrl);
  const betterAuthSecret = r.required("BETTER_AUTH_SECRET", r.secret("BETTER_AUTH_SECRET"));
  r.minLength("BETTER_AUTH_SECRET", betterAuthSecret, 32);
  const buyerPassword = r.required("FIXTURE_BUYER_PASSWORD", r.secret("FIXTURE_BUYER_PASSWORD"));
  r.minLength("FIXTURE_BUYER_PASSWORD", buyerPassword, 12);
  const managerPassword = r.required(
    "FIXTURE_MANAGER_PASSWORD",
    r.secret("FIXTURE_MANAGER_PASSWORD"),
  );
  r.minLength("FIXTURE_MANAGER_PASSWORD", managerPassword, 12);
  r.finish();
  return {
    dataMode: common.dataMode,
    agentMode: common.agentMode,
    authMode: common.authMode,
    appOrigin,
    databaseUrl,
    betterAuthSecret,
    buyerPassword,
    managerPassword,
  };
}
