// Prepares the container gate run: a fresh clone of the commit under test,
// canary values in every secret file, in .env and in nested secret-like files,
// and the image built from it, plus its build stage (the whole build context).
//
// SD_CT_SOURCE=worktree copies the working tree (tracked and untracked,
// unignored files) instead of cloning HEAD, for iterating before a commit.
// SD_CT_KEEP_IMAGE=1 keeps the built image after the run.
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { must, run, sweep } from "./support.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** Relative paths of every file under dir. */
async function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path, base)));
    else files.push(relative(base, path));
  }
  return files.sort();
}

async function prepareSource(work, mode) {
  const head = (await must("git", ["-C", REPO, "rev-parse", "HEAD"])).stdout.trim();
  const sourceDir = join(work, "source");
  if (mode === "worktree") {
    const { stdout } = await must("git", [
      "-C",
      REPO,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    for (const path of stdout.split("\0").filter(Boolean)) {
      const from = join(REPO, path);
      const info = await stat(from).catch(() => null);
      if (info === null || !info.isFile()) continue;
      await mkdir(dirname(join(sourceDir, path)), { recursive: true });
      await copyFile(from, join(sourceDir, path));
      if (info.mode & 0o111) await must("chmod", ["+x", join(sourceDir, path)]);
    }
    const dirty = (await must("git", ["-C", REPO, "status", "--porcelain"])).stdout.trim() !== "";
    return { sourceDir, revision: dirty ? `${head}-worktree` : head, head };
  }
  await must("git", ["clone", "--quiet", "--no-hardlinks", REPO, sourceDir]);
  await must("git", ["-C", sourceDir, "checkout", "--quiet", "--detach", head]);
  return { sourceDir, revision: head, head };
}

/**
 * Discovers every file init-secrets.sh produces by running it in a scratch
 * copy, then writes distinct canaries into the source's .secrets (and .env)
 * before init-secrets.sh derives the connection URLs from them.
 */
async function writeCanaries(work, sourceDir) {
  const probe = join(work, "inventory");
  await mkdir(join(probe, "scripts"), { recursive: true });
  await copyFile(
    join(sourceDir, "scripts", "init-secrets.sh"),
    join(probe, "scripts", "init-secrets.sh"),
  );
  await must("sh", [join(probe, "scripts", "init-secrets.sh")]);
  const inventory = await listFiles(join(probe, ".secrets"));
  if (inventory.length === 0) throw new Error("init-secrets.sh produced no secret files");

  const secrets = join(sourceDir, ".secrets");
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  const canaries = [];
  for (const name of inventory.filter((entry) => !entry.includes("/"))) {
    const value = `ctcanary${randomBytes(16).toString("hex")}`;
    await writeFile(join(secrets, name), `${value}\n`, { mode: 0o644 });
    canaries.push({ name, value });
  }
  // Connection URLs embed the canary passwords; init-secrets.sh keeps the files above.
  await must("sh", [join(sourceDir, "scripts", "init-secrets.sh")]);
  const written = await listFiles(secrets);
  for (const name of inventory) {
    if (!written.includes(name)) throw new Error(`secret ${name} was not written`);
  }
  const files = [];
  for (const name of written) {
    files.push({ name, value: (await readFile(join(secrets, name), "utf8")).trim() });
  }

  const envValue = `ctcanary${randomBytes(16).toString("hex")}`;
  const example = await readFile(join(sourceDir, ".env.example"), "utf8");
  await writeFile(join(sourceDir, ".env"), `${example}\nSD_CT_ENV_CANARY=${envValue}\n`);
  canaries.push({ name: ".env", value: envValue });

  // Nested files that Next standalone output (apps/web .env files), pnpm deploy
  // or the build context would carry if .dockerignore stopped excluding them.
  for (const name of ["apps/web/.env.local", "apps/api/.env", "packages/db/.secrets/token"]) {
    const value = `ctcanary${randomBytes(16).toString("hex")}`;
    await mkdir(dirname(join(sourceDir, name)), { recursive: true });
    await writeFile(join(sourceDir, name), `SD_CT_NESTED_CANARY=${value}\n`);
    canaries.push({ name, value });
  }

  return { inventory, canaries, files };
}

export async function setup(project) {
  const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const work = await mkdtemp(join(tmpdir(), `sd-ct-${runId}-`));
  const prefix = `supplier-disruption-ct-${runId}-`;
  let context;
  try {
    context = await prepare(project, runId, work);
  } catch (error) {
    // Nothing after this point would clean up: remove the clone, its canaries
    // and any image already built before reporting the failure.
    await sweep(prefix).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
    throw error;
  }
  const { sourceDir, images } = context;

  return async () => {
    const timings = await readFile(join(work, "timings.log"), "utf8").catch(() => "");
    if (timings !== "") process.stdout.write(`container gate evidence lines:\n${timings}`);
    // Any project a failed test could not remove: first through Compose, then
    // by label, which also finds volumes and networks Compose no longer lists.
    const { stdout } = await run("docker", ["compose", "ls", "--all", "--format", "json"]);
    for (const entry of JSON.parse(stdout || "[]")) {
      if (!entry.Name.startsWith(prefix)) continue;
      await run("docker", [
        "compose",
        "--project-name",
        entry.Name,
        "--project-directory",
        sourceDir,
        "--file",
        join(sourceDir, "compose.yaml"),
        "--profile",
        "init",
        "down",
        "--volumes",
        "--remove-orphans",
        "--timeout",
        "30",
      ]);
    }
    // SD_CT_KEEP_IMAGE keeps the final image; the build stage image always goes.
    const keep = process.env.SD_CT_KEEP_IMAGE === "1";
    if (keep) await run("docker", ["image", "rm", images.build]);
    const removed = await sweep(prefix, { images: !keep });
    if (removed.length > 0) process.stdout.write(`removed after the run:\n${removed.join("\n")}\n`);
    await rm(join(work, "source"), { recursive: true, force: true });
    await rm(join(work, "inventory"), { recursive: true, force: true });
  };
}

async function prepare(project, runId, work) {
  const mode = process.env.SD_CT_SOURCE === "worktree" ? "worktree" : "head";
  const { sourceDir, revision, head } = await prepareSource(work, mode);
  const lockBefore = await sha256(join(sourceDir, "pnpm-lock.yaml"));
  const { inventory, canaries, files } = await writeCanaries(work, sourceDir);

  const image = `supplier-disruption-ct-${runId}-app:test`;
  const buildStage = `supplier-disruption-ct-${runId}-build:test`;
  const dockerBuild = async (args) => {
    const result = await run(
      "docker",
      ["build", "--build-arg", `BUILD_REVISION=${revision}`, ...args, sourceDir],
      { timeout: 1_800_000 },
    );
    if (result.code !== 0) {
      throw new Error(`docker build failed (${result.code})\n${result.stderr.slice(-4000)}`);
    }
    return result;
  };
  const build = await dockerBuild(["--tag", image]);
  // The build stage holds the whole build context, so C9 can check that
  // .dockerignore kept every canary file out even where no later stage copies it.
  await dockerBuild(["--target", "build", "--tag", buildStage]);
  const [inspected] = JSON.parse((await must("docker", ["image", "inspect", image])).stdout);
  const dockerfile = await readFile(join(sourceDir, "Dockerfile"), "utf8");
  const evidence = {
    runId,
    mode,
    head,
    revision,
    image,
    imageId: inspected.Id,
    platform: `${inspected.Os}/${inspected.Architecture}`,
    sizeBytes: inspected.Size,
    user: inspected.Config.User,
    revisionLabel: inspected.Config.Labels?.["org.opencontainers.image.revision"] ?? null,
    nodeEnv: inspected.Config.Env.find((entry) => entry.startsWith("NODE_ENV=")) ?? null,
    baseImages: [...dockerfile.matchAll(/^ARG (\w+_IMAGE)=(\S+)$/gm)].map((m) => ({
      arg: m[1],
      ref: m[2],
    })),
    buildMs: build.ms,
    lockfileSha256Before: lockBefore,
    lockfileSha256After: await sha256(join(sourceDir, "pnpm-lock.yaml")),
    lockfileSha256Repository: await sha256(join(REPO, "pnpm-lock.yaml")),
    cloneStatus: (await run("git", ["-C", sourceDir, "status", "--porcelain"])).stdout,
    secretInventory: inventory,
  };
  const evidencePath = join(work, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`container gate evidence: ${evidencePath}\n`);

  const managerPassword = canaries.find((c) => c.name === "fixture_manager_password")?.value;
  project.provide("ct", {
    runId,
    work,
    sourceDir,
    image,
    buildStage,
    evidence,
    canaries,
    secretFiles: files,
    managerPassword,
  });

  return { sourceDir, images: { app: image, build: buildStage } };
}
