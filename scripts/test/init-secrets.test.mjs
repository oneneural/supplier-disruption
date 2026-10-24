import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../init-secrets.sh", import.meta.url));

// The script writes to <its directory>/../.secrets, so each test runs a copy in
// a temporary checkout and never touches the real .secrets directory.
let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sd-init-secrets-"));
  await mkdir(join(root, "scripts"));
  await copyFile(SCRIPT, join(root, "scripts", "init-secrets.sh"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const mode = async (path) => (await stat(path)).mode & 0o777;
const init = () => run("sh", [join(root, "scripts", "init-secrets.sh")]);

describe("init-secrets.sh", () => {
  it("tightens existing loose directories to owner-only", async () => {
    await mkdir(join(root, ".secrets", "host"), { recursive: true });
    await chmod(join(root, ".secrets"), 0o755);
    await chmod(join(root, ".secrets", "host"), 0o777);

    await init();

    expect(await mode(join(root, ".secrets"))).toBe(0o700);
    expect(await mode(join(root, ".secrets", "host"))).toBe(0o700);
  });

  it("creates readable files inside owner-only directories and prints no values", async () => {
    const { stdout } = await init();
    const names = await readdir(join(root, ".secrets"));
    expect(names).toContain("better_auth_secret");
    for (const name of names.filter((entry) => entry !== "host" && entry !== "container")) {
      const path = join(root, ".secrets", name);
      expect(await mode(path)).toBe(0o644);
      const value = (await readFile(path, "utf8")).trim();
      expect(value.length).toBeGreaterThanOrEqual(32);
      expect(stdout).not.toContain(value);
    }
  });

  it("writes container URLs for the db service without changing the host URLs", async () => {
    await init();
    const host = join(root, ".secrets", "host");
    const container = join(root, ".secrets", "container");
    const hostBefore = {};
    for (const name of await readdir(host))
      hostBefore[name] = await readFile(join(host, name), "utf8");

    // A second run keeps the host files and fills in container files deleted since.
    await rm(container, { recursive: true });
    await init();

    expect(await mode(container)).toBe(0o700);
    const roles = {
      database_url_migrator: ["sd_migrator", "db_migrator_password"],
      database_url_api: ["sd_api", "db_api_password"],
      database_url_worker: ["sd_worker", "db_worker_password"],
    };
    expect((await readdir(container)).sort()).toEqual(Object.keys(roles).sort());
    for (const [name, [role, passwordFile]] of Object.entries(roles)) {
      const password = (await readFile(join(root, ".secrets", passwordFile), "utf8")).trim();
      expect((await readFile(join(container, name), "utf8")).trim()).toBe(
        `postgres://${role}:${password}@db:5432/supplier_disruption`,
      );
      expect(await mode(join(container, name))).toBe(0o644);
      expect(await readFile(join(host, name), "utf8")).toBe(hostBefore[name]);
      expect(hostBefore[name]).toContain("@127.0.0.1:");
    }
  });

  it("never overwrites existing files", async () => {
    await init();
    const path = join(root, ".secrets", "worker_service_token");
    const before = await readFile(path, "utf8");
    const { stdout } = await init();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(stdout).toContain("kept     .secrets/worker_service_token");
    expect(stdout).not.toContain("created");
  });
});
