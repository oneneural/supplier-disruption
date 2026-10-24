import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Observer, REPO_ROOT, baseEnv, freePort, secret } from "./support.js";

const run = promisify(execFile);

async function startupFailure(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  try {
    await run(process.execPath, [script], { cwd: REPO_ROOT, env, timeout: 15_000 });
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
  throw new Error(`${script} started although its configuration is invalid`);
}

function expectNoSecrets(output: string, extra: string[] = []): void {
  for (const name of [
    "better_auth_secret",
    "worker_service_token",
    "host/database_url_api",
    "host/database_url_worker",
  ]) {
    expect(output).not.toContain(secret(name));
  }
  const workerUrl = new URL(secret("host/database_url_worker"));
  for (const value of [decodeURIComponent(workerUrl.password), workerUrl.password, ...extra]) {
    expect(output).not.toContain(value);
  }
}

describe("G2 process startup", () => {
  it("the API exits 1 naming a missing variable, without printing secrets", async () => {
    const env = baseEnv(await freePort());
    delete env.BETTER_AUTH_SECRET_FILE;
    const { code, output } = await startupFailure("apps/api/dist/main.js", env);
    expect(code).toBe(1);
    expect(output).toContain("BETTER_AUTH_SECRET is required");
    expectNoSecrets(output);
  });

  it("the API exits 1 when a secret is set both inline and by file", async () => {
    const env = {
      ...baseEnv(await freePort()),
      WORKER_SERVICE_TOKEN: secret("worker_service_token"),
    };
    const { code, output } = await startupFailure("apps/api/dist/main.js", env);
    expect(code).toBe(1);
    expect(output).toContain(
      "WORKER_SERVICE_TOKEN and WORKER_SERVICE_TOKEN_FILE are both set; set only one",
    );
    expectNoSecrets(output);
  });

  it("the worker exits 1 for an unsupported mode", async () => {
    const env = { ...baseEnv(await freePort()), AGENT_MODE: "llm" };
    const { code, output } = await startupFailure("apps/worker/dist/main.js", env);
    expect(code).toBe(1);
    expect(output).toContain("AGENT_MODE must be one of: rules");
    expectNoSecrets(output);
  });

  it("the worker refuses test hooks outside NODE_ENV=test", async () => {
    const env = {
      ...baseEnv(await freePort()),
      NODE_ENV: "production",
      PILOT_TEST_HOLD_AT: "before-receipt",
    };
    const { code, output } = await startupFailure("apps/worker/dist/main.js", env);
    expect(code).toBe(1);
    expect(output).toContain("PILOT_TEST_HOLD_AT is only accepted when NODE_ENV=test");
    expectNoSecrets(output);
  });
});

describe("G2 worker startup failures after configuration", () => {
  it("exits 1 when the database refuses the connection, without printing secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-worker-url-"));
    try {
      // The real worker credentials on a loopback port nothing listens on.
      const url = new URL(secret("host/database_url_worker"));
      url.port = String(await freePort());
      const file = join(dir, "database_url_worker");
      await writeFile(file, `${url.toString()}\n`, { mode: 0o600 });
      const env = { ...baseEnv(await freePort()), DATABASE_URL_WORKER_FILE: file };
      const startedAt = Date.now();
      const { code, output } = await startupFailure("apps/worker/dist/main.js", env);
      expect(code).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(output).toContain("worker: startup failed: Error: connect ECONNREFUSED");
      expectNoSecrets(output, [url.toString()]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 at once with the driver error when the heartbeat grant is missing", async () => {
    // A permanent error (42501) is not retried until the startup bound. The
    // grant is restored afterwards; if this run is killed first, db:migrate
    // reapplies it.
    const role = new URL(secret("host/database_url_worker")).username;
    const observer = new Observer();
    try {
      await observer.query(`REVOKE INSERT ON worker.heartbeat FROM "${role}"`);
      const startedAt = Date.now();
      const { code, output } = await startupFailure(
        "apps/worker/dist/main.js",
        baseEnv(await freePort()),
      );
      expect(code).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(output).toMatch(/worker: startup failed: Error: Failed query: insert into "worker"/);
      expect(output).toContain("; cause: error: permission denied for table heartbeat");
      expect(output).not.toContain("first heartbeat failed; retrying");
      expectNoSecrets(output);
    } finally {
      await observer.query(`GRANT INSERT ON worker.heartbeat TO "${role}"`);
      await observer.close();
    }
  });
});
