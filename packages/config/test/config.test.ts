import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadApiConfig,
  loadMigratorConfig,
  loadSeedConfig,
  loadWorkerConfig,
  systemClock,
  type Environment,
} from "../src/index.js";

const SECRET = "s3cret-value-that-must-never-be-printed-0123456789";
const TOKEN = "worker-token-that-must-never-be-printed-9876543210";
const DB_URL = "postgres://sd_api:db-password-never-printed@127.0.0.1:55102/supplier_disruption";
const BOOT_ID = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

function secretFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sd-config-"));
  const path = join(dir, "secret");
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

// Production is the default NODE_ENV, and production requires a boot ID file.
const BOOT_ID_FILE = secretFile(`${BOOT_ID}\n`);

const apiEnv: Environment = {
  APP_ID: "supplier-disruption",
  APP_ORIGIN: "http://127.0.0.1:3102",
  DATABASE_URL_API: DB_URL,
  BETTER_AUTH_SECRET: SECRET,
  WORKER_SERVICE_TOKEN: TOKEN,
  BOOT_ID_FILE,
};

function configError(load: () => unknown): ConfigError {
  try {
    load();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected configuration to be rejected");
}

function expectNoSecrets(error: ConfigError): void {
  const text = `${error.message}\n${error.issues.join("\n")}\n${String(error.stack)}`;
  for (const secret of [SECRET, TOKEN, DB_URL, "db-password-never-printed"]) {
    expect(text).not.toContain(secret);
  }
}

describe("G2 configuration", () => {
  it("accepts a complete API configuration with pilot modes", () => {
    const config = loadApiConfig(apiEnv);
    expect(config).toMatchObject({
      appOrigin: "http://127.0.0.1:3102",
      apiPort: 3001,
      dataMode: "fixture",
      agentMode: "rules",
      authMode: "fixture",
      nodeEnv: "production",
      bootId: BOOT_ID,
    });
  });

  it.each([
    "APP_ID",
    "APP_ORIGIN",
    "DATABASE_URL_API",
    "BETTER_AUTH_SECRET",
    "WORKER_SERVICE_TOKEN",
  ])("fails naming missing required variable %s", (name) => {
    const env = { ...apiEnv, [name]: undefined };
    const error = configError(() => loadApiConfig(env));
    expect(error.issues).toContain(`${name} is required`);
    expectNoSecrets(error);
  });

  it("treats an empty value as missing", () => {
    const error = configError(() => loadApiConfig({ ...apiEnv, BETTER_AUTH_SECRET: "" }));
    expect(error.issues).toContain("BETTER_AUTH_SECRET is required");
  });

  it("reads secrets from _FILE variables and strips one trailing newline", () => {
    const env = {
      ...apiEnv,
      BETTER_AUTH_SECRET: undefined,
      BETTER_AUTH_SECRET_FILE: secretFile(`${SECRET}\n`),
    };
    expect(loadApiConfig(env).betterAuthSecret).toBe(SECRET);
  });

  it("resolves relative _FILE paths against the given working directory", () => {
    const path = secretFile(TOKEN);
    const dir = join(path, "..");
    const env = { ...apiEnv, WORKER_SERVICE_TOKEN: undefined, WORKER_SERVICE_TOKEN_FILE: "secret" };
    expect(loadApiConfig(env, { cwd: dir }).workerServiceToken).toBe(TOKEN);
  });

  it("rejects inline plus _FILE for the same secret, even when the values agree", () => {
    const env = { ...apiEnv, BETTER_AUTH_SECRET_FILE: secretFile(SECRET) };
    const error = configError(() => loadApiConfig(env));
    expect(error.issues).toContain(
      "BETTER_AUTH_SECRET and BETTER_AUTH_SECRET_FILE are both set; set only one",
    );
    expectNoSecrets(error);
  });

  it("rejects an unreadable or empty secret file without printing its path content", () => {
    const missing = configError(() =>
      loadApiConfig({
        ...apiEnv,
        DATABASE_URL_API: undefined,
        DATABASE_URL_API_FILE: "/nonexistent/sd",
      }),
    );
    expect(missing.issues).toContain("DATABASE_URL_API_FILE names a file that cannot be read");
    const empty = configError(() =>
      loadApiConfig({
        ...apiEnv,
        DATABASE_URL_API: undefined,
        DATABASE_URL_API_FILE: secretFile(""),
      }),
    );
    expect(empty.issues).toContain("DATABASE_URL_API_FILE names an empty file");
  });

  it.each([
    ["DATA_MODE", "live"],
    ["DATA_MODE", "sandbox"],
    ["AGENT_MODE", "claude"],
    ["AUTH_MODE", "session"],
  ])("fails startup for unsupported %s=%s", (name, value) => {
    const error = configError(() => loadApiConfig({ ...apiEnv, [name]: value }));
    expect(error.issues.some((issue) => issue.startsWith(`${name} must be one of:`))).toBe(true);
    expect(error.message).not.toContain(value);
  });

  it("rejects malformed values without echoing them", () => {
    const error = configError(() =>
      loadApiConfig({
        ...apiEnv,
        DATABASE_URL_API: `mysql://${SECRET}@db/x`,
        BETTER_AUTH_SECRET: "short-secret-value",
        APP_ORIGIN: "http://127.0.0.1:3102/path",
        API_PORT: "70000",
      }),
    );
    expect(error.issues).toEqual(
      expect.arrayContaining([
        "DATABASE_URL_API must be a postgres:// or postgresql:// URL",
        "BETTER_AUTH_SECRET must be at least 32 characters",
        "APP_ORIGIN must be an http(s) origin such as http://127.0.0.1:3102",
        "API_PORT must be a TCP port between 1 and 65535",
      ]),
    );
    expectNoSecrets(error);
    expect(error.message).not.toContain("short-secret-value");
  });

  it("reports every problem at once", () => {
    const error = configError(() => loadApiConfig({ APP_ID: "x", DATA_MODE: "live" }));
    expect(error.issues.length).toBeGreaterThanOrEqual(5);
  });
});

describe("container boot ID", () => {
  it.each([
    ["API", () => loadApiConfig({ ...apiEnv, BOOT_ID_FILE: undefined })],
    [
      "worker",
      () =>
        loadWorkerConfig({
          APP_ID: "supplier-disruption",
          DATABASE_URL_WORKER: DB_URL,
          WORKER_SERVICE_TOKEN: TOKEN,
        }),
    ],
  ])("the %s requires BOOT_ID_FILE when NODE_ENV=production", (_service, load) => {
    expect(configError(load).issues).toContain("BOOT_ID_FILE is required when NODE_ENV=production");
  });

  it("is optional outside production, leaving the ID to the service", () => {
    const env = { ...apiEnv, NODE_ENV: "development", BOOT_ID_FILE: undefined };
    expect(loadApiConfig(env).bootId).toBeUndefined();
  });

  it("reads the UUID from the file, trimmed and lower-cased", () => {
    const env = { ...apiEnv, BOOT_ID_FILE: secretFile(` ${BOOT_ID.toUpperCase()}\n`) };
    expect(loadApiConfig(env).bootId).toBe(BOOT_ID);
  });

  it("rejects a missing file or one without a UUID, without echoing its content", () => {
    expect(
      configError(() => loadApiConfig({ ...apiEnv, BOOT_ID_FILE: "/nonexistent/boot-id" })).issues,
    ).toContain("BOOT_ID_FILE names a file that cannot be read");
    const error = configError(() =>
      loadApiConfig({ ...apiEnv, BOOT_ID_FILE: secretFile("not-a-boot-id-0123") }),
    );
    expect(error.issues).toContain("BOOT_ID_FILE must contain a UUID");
    expect(error.message).not.toContain("not-a-boot-id-0123");
  });
});

describe("worker configuration", () => {
  const workerEnv: Environment = {
    APP_ID: "supplier-disruption",
    DATABASE_URL_WORKER: DB_URL.replace("sd_api", "sd_worker"),
    WORKER_SERVICE_TOKEN: TOKEN,
    BOOT_ID_FILE,
  };

  it("derives the fixed loopback internal API URL", () => {
    const config = loadWorkerConfig({ ...workerEnv, API_PORT: "4100" });
    expect(config.apiInternalUrl).toBe("http://127.0.0.1:4100");
    expect(config.bootId).toBe(BOOT_ID);
    expect(config.testHooks).toBeUndefined();
  });

  it("rejects test hooks outside NODE_ENV=test", () => {
    const error = configError(() =>
      loadWorkerConfig({ ...workerEnv, PILOT_TEST_HOLD_AT: "before-receipt" }),
    );
    expect(error.issues).toContain("PILOT_TEST_HOLD_AT is only accepted when NODE_ENV=test");
  });

  it("accepts test hooks only under NODE_ENV=test", () => {
    const config = loadWorkerConfig({
      ...workerEnv,
      NODE_ENV: "test",
      PILOT_TEST_HOLD_AT: "after-receipt",
      PILOT_TEST_HANDLER_DELAY_MS: "250",
    });
    expect(config.testHooks).toEqual({ holdAt: "after-receipt", handlerDelayMs: 250 });
  });
});

describe("migrator and seed configuration", () => {
  it("requires the migrator URL and validates role identifiers", () => {
    const error = configError(() => loadMigratorConfig({ DB_API_ROLE: "Robert'); drop" }));
    expect(error.issues).toEqual([
      "DATABASE_URL_MIGRATOR is required",
      "DB_API_ROLE must be a lowercase PostgreSQL identifier",
    ]);
  });

  it("requires fixture passwords for seeding", () => {
    const error = configError(() =>
      loadSeedConfig({
        APP_ID: "supplier-disruption",
        APP_ORIGIN: "http://127.0.0.1:3102",
        DATABASE_URL_MIGRATOR: DB_URL,
        BETTER_AUTH_SECRET: SECRET,
      }),
    );
    expect(error.issues).toEqual([
      "FIXTURE_BUYER_PASSWORD is required",
      "FIXTURE_MANAGER_PASSWORD is required",
    ]);
    expectNoSecrets(error);
  });
});

describe("D9 business clock configuration", () => {
  const testEnv = { ...apiEnv, NODE_ENV: "test", BOOT_ID_FILE: undefined };
  const MESSAGE =
    "DOMAIN_CLOCK_MODE=controlled is only accepted with NODE_ENV=test and DATA_MODE=fixture";

  it("defaults to system mode, also in production", () => {
    expect(loadApiConfig(apiEnv).domainClockMode).toBe("system");
    expect(loadApiConfig(testEnv).domainClockMode).toBe("system");
    expect(loadApiConfig({ ...apiEnv, DOMAIN_CLOCK_MODE: "system" }).domainClockMode).toBe(
      "system",
    );
  });

  it("accepts controlled mode only with NODE_ENV=test and fixture data", () => {
    expect(
      loadApiConfig({ ...testEnv, DOMAIN_CLOCK_MODE: "controlled", DATA_MODE: "fixture" })
        .domainClockMode,
    ).toBe("controlled");
  });

  it.each([undefined, "production", "development"])(
    "rejects controlled mode with NODE_ENV=%s",
    (nodeEnv) => {
      const env = {
        ...apiEnv,
        NODE_ENV: nodeEnv,
        BOOT_ID_FILE: nodeEnv === "development" ? undefined : BOOT_ID_FILE,
        DOMAIN_CLOCK_MODE: "controlled",
      };
      expect(configError(() => loadApiConfig(env)).issues).toEqual([MESSAGE]);
    },
  );

  // Fixture is the only data mode today, so another one already fails startup.
  it("rejects controlled mode when the data mode is not fixture", () => {
    const error = configError(() =>
      loadApiConfig({ ...testEnv, DOMAIN_CLOCK_MODE: "controlled", DATA_MODE: "sandbox" }),
    );
    expect(error.issues).toContain("DATA_MODE must be one of: fixture");
  });

  // ADR 0012: the demonstration mode is explicit, fixture-only and works in the production image.
  it.each(["production", "development", "test"])(
    "accepts demonstration mode with NODE_ENV=%s and fixture data",
    (nodeEnv) => {
      const env = {
        ...apiEnv,
        NODE_ENV: nodeEnv,
        BOOT_ID_FILE: nodeEnv === "production" ? BOOT_ID_FILE : undefined,
        DOMAIN_CLOCK_MODE: "demonstration",
      };
      expect(loadApiConfig(env).domainClockMode).toBe("demonstration");
    },
  );

  it("rejects demonstration mode when the data mode is not fixture", () => {
    const error = configError(() =>
      loadApiConfig({ ...testEnv, DOMAIN_CLOCK_MODE: "demonstration", DATA_MODE: "sandbox" }),
    );
    expect(error.issues).toContain("DATA_MODE must be one of: fixture");
  });

  it.each(["frozen", "CONTROLLED", "DEMONSTRATION", "2026-10-21T09:00:00+02:00"])(
    "rejects DOMAIN_CLOCK_MODE=%s",
    (mode) => {
      const error = configError(() => loadApiConfig({ ...testEnv, DOMAIN_CLOCK_MODE: mode }));
      expect(error.issues).toEqual([
        "DOMAIN_CLOCK_MODE must be one of: system, controlled, demonstration",
      ]);
      expect(error.message).not.toContain(mode);
    },
  );

  it("samples real wall time on every call, with an offset", async () => {
    const samples: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const before = Date.now();
      const now = await systemClock.now();
      const after = Date.now();
      expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(now)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(now)).toBeLessThanOrEqual(after);
      samples.push(now);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(new Set(samples).size).toBe(3);
  });
});
