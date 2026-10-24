import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FORMAT, compareState, isInside, parseArgs, restore } from "../backup-restore.mjs";

const temporary = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "sd-backup-test-"));
  temporary.push(dir);
  return dir;
}

const state = () => ({
  tables: {
    "app.supplier_case": { rows: 1, digest: "a" },
    "app.supplier_message": { rows: 2, digest: "b" },
  },
  evidence: { messages: 2, mismatched: 0 },
  foreignKeys: { total: 40, unvalidated: 0 },
});

describe("backup and restore arguments", () => {
  it("backs up the development project by default but restores only into a named project", () => {
    expect(parseArgs(["backup", "--output", "/x"])).toEqual({
      command: "backup",
      project: "supplier-disruption",
      output: "/x",
    });
    expect(() => parseArgs(["restore", "--input", "/x"])).toThrow(/usage/);
    expect(parseArgs(["restore", "--", "--input", "/x", "--project", "p"])).toEqual({
      command: "restore",
      project: "p",
      input: "/x",
    });
    expect(() => parseArgs(["backup", "--output", "/x", "--force", "1"])).toThrow(/unexpected/);
  });

  it("recognizes paths inside the checkout", () => {
    expect(isInside("/repo/backups/b1", "/repo")).toBe(true);
    expect(isInside("/repo", "/repo")).toBe(true);
    expect(isInside("/repository/b1", "/repo")).toBe(false);
    expect(isInside(join(tmpdir(), "b1"), "/repo")).toBe(false);
    // A name that merely starts with two dots is still inside.
    expect(isInside("/repo/..backups/b1", "/repo")).toBe(true);
  });

  it("compares real paths, so a symlink into the checkout counts as inside", async () => {
    const dir = await tempDir();
    const repo = join(dir, "repo");
    await mkdir(repo);
    await symlink(repo, join(dir, "link"));
    expect(isInside(join(dir, "link", "not-yet", "b1"), repo)).toBe(true);
    expect(isInside(join(dir, "elsewhere", "b1"), join(dir, "link"))).toBe(false);
  });
});

describe("restored state comparison", () => {
  it("accepts an identical restore", () => {
    expect(compareState(state(), state())).toEqual([]);
  });

  it("reports changed, missing and extra tables, broken evidence and foreign keys", () => {
    const restored = state();
    restored.tables["app.supplier_case"] = { rows: 1, digest: "changed" };
    delete restored.tables["app.supplier_message"];
    restored.tables["app.extra"] = { rows: 0, digest: "c" };
    restored.evidence = { messages: 2, mismatched: 1 };
    restored.foreignKeys = { total: 39, unvalidated: 1 };
    expect(compareState(state(), restored)).toEqual([
      "unexpected table app.extra",
      "table app.supplier_case: rows 1 -> 1, digest a -> changed",
      "missing table app.supplier_message",
      "1 message(s) no longer match their SHA-256",
      "foreign keys 40 -> 39",
      "1 foreign key(s) not validated",
    ]);
  });
});

describe("restore input check", () => {
  it("refuses a dump whose SHA-256 differs from the manifest before touching Docker", async () => {
    const dir = await tempDir();
    const original = Buffer.from("original dump bytes");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        format: FORMAT,
        dump: {
          file: "database.dump",
          bytes: original.length,
          sha256: createHash("sha256").update(original).digest("hex"),
        },
      }),
    );
    await writeFile(join(dir, "database.dump"), "tampered dump bytes");
    await expect(restore({ project: "supplier-disruption-unused", input: dir })).rejects.toThrow(
      /dump SHA-256 [0-9a-f]{64} does not match the manifest/,
    );
  });
});
