import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SCHEMA_TAG } from "../../packages/db/src/schema-tag.ts";

describe("schema tag", () => {
  it("names the last migration in the Drizzle journal", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("../../packages/db/drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    );
    const last = journal.entries.toSorted((a, b) => a.idx - b.idx).at(-1);
    expect(SCHEMA_TAG).toBe(last.tag);
  });
});
