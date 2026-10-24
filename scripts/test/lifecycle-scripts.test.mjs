import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../../infra/app/rootfs/opt/sd/bin/", import.meta.url));

// The scripts read their s6 paths from SD_* overrides, so these tests run them
// against a temporary directory with a stub s6-svstat and halt.
let dir;
let env;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sd-lifecycle-"));
  await mkdir(join(dir, "service"));
  await writeFile(join(dir, "svstat"), '#!/bin/sh\ncat "$SD_TEST_WANTED"\n');
  await writeFile(join(dir, "halt"), '#!/bin/sh\necho halted >>"$SD_TEST_HALTS"\n');
  await chmod(join(dir, "svstat"), 0o755);
  await chmod(join(dir, "halt"), 0o755);
  await writeFile(join(dir, "wanted"), "true\n");
  env = {
    PATH: process.env.PATH,
    SD_RUN_DIR: join(dir, "run"),
    SD_RESULTS_FILE: join(dir, "exitcode"),
    SD_HALT: join(dir, "halt"),
    SD_SVSTAT: join(dir, "svstat"),
    SD_TEST_WANTED: join(dir, "wanted"),
    SD_TEST_HALTS: join(dir, "halts"),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs finish-essential as s6-supervise would: args exit and signal, cwd the service dir. */
async function finish(service, code, signal) {
  try {
    const { stdout } = await run(
      "sh",
      [join(BIN, "finish-essential"), service, String(code), String(signal)],
      {
        env,
        cwd: join(dir, "service"),
      },
    );
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.code, stdout: error.stdout };
  }
}

const read = (name) => readFile(join(dir, name), "utf8").catch(() => null);
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("finish-essential", () => {
  it("records a SIGKILL while wanted up as the first failure and halts", async () => {
    const result = await finish("api", 256, 9);
    expect(result.status).toBe(125);
    expect(result.stdout).toBe(
      "sd-lifecycle service=api exit=256 signal=9 wanted=up\n" +
        "sd-first-failure reason=exit service=api exit=256 signal=9 container-exit=137\n",
    );
    expect(await read("exitcode")).toBe("137\n");
    expect(await read("run/first-failure/record")).toBe(
      "reason=exit service=api exit=256 signal=9\n",
    );
    expect(await read("run/first-failure/exit")).toBe("137\n");
    expect(await read("halts")).toBe("halted\n");
  });

  it("treats exit 0 while wanted up as a failure with container exit 1", async () => {
    const result = await finish("worker", 0, 0);
    expect(result.status).toBe(125);
    expect(result.stdout).toContain(
      "sd-first-failure reason=exit service=worker exit=0 signal=none container-exit=1",
    );
    expect(await read("exitcode")).toBe("1\n");
  });

  it("passes a nonzero exit code through", async () => {
    await finish("web", 3, 0);
    expect(await read("exitcode")).toBe("3\n");
  });

  it("never overwrites the first failure", async () => {
    await finish("api", 256, 9);
    const later = await finish("worker", 1, 0);
    expect(later.status).toBe(125);
    expect(later.stdout).toBe("sd-lifecycle service=worker exit=1 signal=none wanted=up\n");
    expect(await read("exitcode")).toBe("137\n");
    expect(await read("run/first-failure/record")).toContain("service=api");
    expect(await read("halts")).toBe("halted\n");
  });

  it("records nothing for a service stopped on request", async () => {
    await writeFile(join(dir, "wanted"), "false\n");
    const result = await finish("web", 143, 0);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("sd-lifecycle service=web exit=143 signal=none wanted=down\n");
    expect(await exists(join(dir, "run", "first-failure"))).toBe(false);
    expect(await read("exitcode")).toBeNull();
    expect(await read("halts")).toBeNull();
  });

  it("counts an unreadable wanted state as up, so a crash is never hidden", async () => {
    await rm(join(dir, "wanted"));
    const result = await finish("api", 256, 9);
    expect(result.stdout).toContain("wanted=unknown");
    expect(result.stdout).toContain("sd-first-failure");
    expect(await read("exitcode")).toBe("137\n");
  });
});

describe("boot-id-down", () => {
  const down = () => run("sh", [join(BIN, "boot-id-down")], { env });

  it("restores the first failure's exit code over a later stage-2 status", async () => {
    await finish("watchdog", 0, 0);
    await writeFile(join(dir, "exitcode"), "2\n");
    await down();
    expect(await read("exitcode")).toBe("1\n");
  });

  it("leaves the results file alone on a normal stop", async () => {
    await down();
    expect(await read("exitcode")).toBeNull();
  });
});
