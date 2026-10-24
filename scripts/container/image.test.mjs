// C1 reproducible image and the image half of C9. Canaries sit in every
// init-secrets.sh file, in .env and in nested .env and .secrets files. The
// build stage, which holds the whole build context, shows that .dockerignore
// kept them out; the final image's layers, history and configuration show that
// nothing the build produced carries them either.
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { context, must } from "./support.mjs";

const PLATFORM = `linux/${process.arch === "x64" ? "amd64" : process.arch}`;

describe("C1 reproducible image", () => {
  it("builds from a fresh clone with a frozen install and an unchanged lockfile", () => {
    const { evidence } = context();
    expect(evidence.mode).toBe("head");
    expect(evidence.revision).toBe(evidence.head);
    expect(evidence.lockfileSha256After).toBe(evidence.lockfileSha256Before);
    expect(evidence.lockfileSha256After).toBe(evidence.lockfileSha256Repository);
    // Only the canary files (ignored by Git) were added to the clone.
    expect(evidence.cloneStatus).toBe("");
  });

  it("records a native, non-root, production image pinned to digests", () => {
    const { evidence } = context();
    expect(evidence.platform).toBe(PLATFORM);
    expect(evidence.user).toBe("10001:10001");
    expect(evidence.nodeEnv).toBe("NODE_ENV=production");
    expect(evidence.revisionLabel).toBe(evidence.revision);
    expect(evidence.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.baseImages.map((base) => base.arg).sort()).toEqual([
      "ALPINE_IMAGE",
      "NODE_IMAGE",
    ]);
    for (const base of evidence.baseImages) expect(base.ref).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});

/** Decompresses one saved layer or config blob, whatever its encoding. */
function contents(blob) {
  if (blob[0] === 0x1f && blob[1] === 0x8b) return gunzipSync(blob);
  if (blob.length >= 4 && blob.readUInt32LE(0) === 0xfd2fb528) return zstdDecompressSync(blob);
  return blob;
}

describe("C9 secrets in the image", () => {
  it("has a nonempty canary inventory covering every init-secrets.sh file, .env and nested files", () => {
    const { canaries, evidence, secretFiles } = context();
    expect(evidence.secretInventory.length).toBeGreaterThan(0);
    expect(secretFiles.map((file) => file.name)).toEqual(evidence.secretInventory);
    const names = canaries.map((canary) => canary.name);
    for (const name of [
      ".env",
      "apps/web/.env.local",
      "apps/api/.env",
      "packages/db/.secrets/token",
    ])
      expect(names).toContain(name);
    // Every secret file holds a canary: a password itself or a URL built from one.
    for (const file of secretFiles) expect(file.value).toMatch(/ctcanary[0-9a-f]{32}/);
  });

  it("keeps every canary out of the build context the build stage received", async () => {
    const { buildStage, canaries } = context();
    // Lists each file under the build directory holding a canary, and counts
    // files holding strings the context must contain, as a positive control.
    const script = [
      "cat >/tmp/canaries",
      "printf 'controls=%s\\n' \"$(grep -rlF --exclude-dir=node_modules -e sd-first-failure -e SD_APP_HOST_PORT /src | wc -l)\"",
      "grep -rHoF --exclude-dir=node_modules -f /tmp/canaries /src || true",
    ].join("\n");
    const { stdout } = await must(
      "docker",
      ["run", "--rm", "-i", "--network", "none", "--entrypoint", "sh", buildStage, "-c", script],
      { input: `${canaries.map((canary) => canary.value).join("\n")}\n` },
    );
    const [controls, ...matches] = stdout.trim().split("\n");
    expect(Number(controls.replace("controls=", ""))).toBeGreaterThanOrEqual(2);
    const hits = matches.map((line) => {
      const value = line.slice(line.lastIndexOf(":") + 1);
      return `${canaries.find((canary) => canary.value === value)?.name} in ${line.slice(0, line.lastIndexOf(":"))}`;
    });
    expect(hits).toEqual([]);
  });

  it("keeps every canary out of saved layers, history and image configuration", async () => {
    const { canaries, image, work } = context();
    const dir = join(work, "saved");
    await mkdir(dir, { recursive: true });
    try {
      await must("docker", ["save", "--output", join(dir, "image.tar"), image]);
      await must("tar", ["-xf", join(dir, "image.tar"), "-C", dir]);
      await rm(join(dir, "image.tar"));
      const blobs = join(dir, "blobs", "sha256");
      const names = await readdir(blobs);
      expect(names.length).toBeGreaterThan(3);

      // Positive control: strings known to be in the image must be found, or the
      // decompression and search are not working.
      const controls = ["sd-first-failure", "s6-overlay"];
      const seen = new Set();
      const hits = [];
      for (const name of names) {
        const data = contents(await readFile(join(blobs, name)));
        for (const control of controls) if (data.includes(control)) seen.add(control);
        for (const canary of canaries)
          if (data.includes(canary.value)) hits.push(`${canary.name} in ${name}`);
      }
      expect([...seen].sort()).toEqual([...controls].sort());
      expect(hits).toEqual([]);

      const { stdout: history } = await must("docker", [
        "history",
        "--no-trunc",
        "--format",
        "{{json .}}",
        image,
      ]);
      const { stdout: config } = await must("docker", ["image", "inspect", image]);
      for (const canary of canaries) {
        expect(history).not.toContain(canary.value);
        expect(config).not.toContain(canary.value);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
