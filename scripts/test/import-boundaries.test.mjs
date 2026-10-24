import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Lints in-memory snippets at virtual paths inside each package, so no fixture
 * file exists for the normal lint, typecheck or build to pick up. Type-aware
 * rules are turned off because the virtual files belong to no TypeScript project;
 * the import rules under test need no type information.
 */
let eslint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfig: [{ files: ["**/*.ts", "**/*.tsx"], ...tseslint.configs.disableTypeChecked }],
  });
});

async function restrictedImports(path, code) {
  const [result] = await eslint.lintText(code, { filePath: `${REPO_ROOT}${path}` });
  expect(result.messages.filter((message) => message.fatal)).toEqual([]);
  return result.messages
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

const WORKER = "apps/worker/src/zz-boundary-probe.ts";
const WEB = "apps/web/app/zz-boundary-probe.tsx";
const CONTRACTS = "packages/contracts/src/zz-boundary-probe.ts";
const API = "apps/api/src/zz-boundary-probe.ts";
const PURCHASING = "packages/db/src/authorities/purchasing/zz-boundary-probe.ts";
const DEMAND = "packages/db/src/authorities/demand/zz-boundary-probe.ts";
const INVENTORY_SOURCE = "packages/db/src/authorities/inventory/source.ts";
const PURCHASING_ENTRY = "packages/db/src/authorities/purchasing/index.ts";
const REFERENCE_SOURCE = "packages/db/src/authorities/reference/source.ts";
const REFERENCE_ENTRY = "packages/db/src/authorities/reference/index.ts";
const DB_ROOT = "packages/db/src/index.ts";
const DB_WORKER = "packages/db/src/worker.ts";
const SEED = "packages/db/src/seed/initialize.ts";
const DOMAIN = "packages/domain/src/zz-boundary-probe.ts";
const DOMAIN_TEST = "packages/domain/test/zz-boundary-probe.test.ts";
const DB_TEST = "packages/db/test/zz-boundary-probe.test.ts";

describe("import boundary lint rules", () => {
  it.each([
    [WORKER, 'import { pilotOperation } from "@supplier-disruption/db";', "worker may import only"],
    [
      WORKER,
      'import { user } from "@supplier-disruption/db/schema/auth";',
      "worker may import only",
    ],
    [WORKER, 'import { betterAuth } from "better-auth";', "worker has no user sessions"],
    [WORKER, 'import { buildApp } from "@supplier-disruption/api";', "worker must not import API"],
    [WORKER, 'import { buildApp } from "../../api/src/app.js";', "never by relative path"],
    [WEB, 'import pg from "pg";', "web must not import database"],
    [WEB, 'import { user } from "@supplier-disruption/db";', "web may import only"],
    [WEB, 'import { loadApiConfig } from "@supplier-disruption/config";', "web may import only"],
    [WEB, 'import { buildApp } from "@supplier-disruption/api";', "web may import only"],
    [WEB, 'import { buildApp } from "../../api/src/app.js";', "never by relative path"],
    [CONTRACTS, 'import Fastify from "fastify";', "contracts must not import Fastify"],
    [
      CONTRACTS,
      'import { useState } from "react";',
      "contracts must not import Fastify, Next or React",
    ],
    [CONTRACTS, 'import { createHash } from "node:crypto";', "contracts must not depend"],
    [CONTRACTS, 'import { user } from "@supplier-disruption/db";', "contracts must not depend"],
    [API, 'import "@supplier-disruption/worker";', "api must not import worker"],
    // Fixture source ownership (ADR 0005).
    [
      API,
      'import { poHead } from "@supplier-disruption/db/authorities/purchasing/schema";',
      "api may import only the db root and the public source modules",
    ],
    [
      API,
      'import { createInventorySource } from "@supplier-disruption/db/authorities/inventory/source";',
      "api may import only the db root and the public source modules",
    ],
    [
      API,
      'import { stockHead } from "../../../packages/db/src/authorities/inventory/schema.js";',
      "never by relative path",
    ],
    [
      WORKER,
      'import { createInventorySource } from "@supplier-disruption/db/inventory";',
      "worker may import only",
    ],
    [
      WEB,
      'import { createDemandSource } from "@supplier-disruption/db/demand";',
      "web may import only",
    ],
    [
      PURCHASING,
      'import { stockHead } from "../inventory/schema.js";',
      "another authority's tables",
    ],
    [
      PURCHASING,
      'import { createInventorySource } from "../inventory/source.js";',
      "another authority's tables",
    ],
    [DEMAND, 'import { seedMarker } from "../reference/schema.js";', "another authority's tables"],
    [
      INVENTORY_SOURCE,
      'import { reservation } from "./schema.js";',
      "runtime source modules must not",
    ],
    [PURCHASING_ENTRY, 'export { poHead } from "./schema.js";', "runtime source modules must not"],
    [
      PURCHASING_ENTRY,
      'export { initializePurchasing } from "./initialize.js";',
      "runtime source modules must not",
    ],
    [
      DB_ROOT,
      'export * from "./authorities/purchasing/schema.js";',
      "db root exports must not expose",
    ],
    [
      DB_ROOT,
      'export { createInventorySource } from "./authorities/inventory/source.js";',
      "db root exports must not expose",
    ],
    [DB_ROOT, 'export * from "./authorities/demand/index.js";', "db root exports must not expose"],
    // Reference reads (ADR 0006): the public entry only, never its tables.
    [
      API,
      'import { item } from "@supplier-disruption/db/authorities/reference/schema";',
      "api may import only the db root and the public source modules",
    ],
    [
      API,
      'import { initializeReference } from "@supplier-disruption/db/authorities/reference/initialize";',
      "api may import only the db root and the public source modules",
    ],
    [
      API,
      'import { createReferenceSource } from "@supplier-disruption/db/authorities/reference/source";',
      "api may import only the db root and the public source modules",
    ],
    [
      WORKER,
      'import { createReferenceSource } from "@supplier-disruption/db/reference";',
      "worker may import only",
    ],
    [
      WEB,
      'import { createReferenceSource } from "@supplier-disruption/db/reference";',
      "web may import only",
    ],
    [REFERENCE_SOURCE, 'import { item } from "./schema.js";', "runtime source modules must not"],
    [
      REFERENCE_SOURCE,
      'import { initializeReference } from "./initialize.js";',
      "runtime source modules must not",
    ],
    [REFERENCE_ENTRY, 'export { vendor } from "./schema.js";', "runtime source modules must not"],
    [
      REFERENCE_SOURCE,
      'import { createInventorySource } from "../inventory/source.js";',
      "another authority's tables",
    ],
    [
      INVENTORY_SOURCE,
      'import { createReferenceSource } from "../reference/source.js";',
      "another authority's tables",
    ],
    [
      INVENTORY_SOURCE,
      'import { createReferenceSource } from "../reference/index.js";',
      "another authority's tables",
    ],
    [
      DB_ROOT,
      'export { createReferenceSource } from "./authorities/reference/source.js";',
      "db root exports must not expose",
    ],
    [
      DB_ROOT,
      'export * from "./authorities/reference/index.js";',
      "db root exports must not expose",
    ],
    [
      DB_ROOT,
      'export * from "./authorities/reference/schema.js";',
      "db root exports must not expose",
    ],
    [
      DB_WORKER,
      'export * from "./authorities/reference/index.js";',
      "db root exports must not expose",
    ],
    [
      REFERENCE_SOURCE,
      'import { createInventorySource } from "@supplier-disruption/db/inventory";',
      "never by package name",
    ],
    [DB_ROOT, 'export * from "@supplier-disruption/db/reference";', "never by package name"],
    // A package self-reference would bypass the path rules.
    [
      PURCHASING,
      'import { createInventorySource } from "@supplier-disruption/db/inventory";',
      "never by package name",
    ],
    [DB_ROOT, 'export * from "@supplier-disruption/db/purchasing";', "never by package name"],
    [
      "packages/db/src/zz-boundary-probe.ts",
      'import "@supplier-disruption/db";',
      "never by package name",
    ],
    // Pure domain policy (ADR 0007): contracts and node:crypto only.
    [DOMAIN, 'import { pilotOperation } from "@supplier-disruption/db";', "domain may import only"],
    [
      DOMAIN,
      'import { createInventorySource } from "@supplier-disruption/db/inventory";',
      "domain may import only",
    ],
    [
      DOMAIN,
      'import { createInventorySource } from "../../db/src/authorities/inventory/index.js";',
      "never by relative path",
    ],
    [
      DOMAIN,
      'import { createInventorySource } from "../../db/dist/authorities/inventory/index.js";',
      "never by relative path",
    ],
    [
      DOMAIN,
      'import { loadApiConfig } from "@supplier-disruption/config";',
      "domain may import only",
    ],
    [DOMAIN, 'import pg from "pg";', "domain must not import persistence"],
    [DOMAIN, 'import { readFileSync } from "node:fs";', "domain may use only node:crypto"],
    [DOMAIN, 'import { readFileSync } from "fs";', "domain may use only node:crypto"],
    [
      DOMAIN,
      'import { setTimeout } from "node:timers/promises";',
      "domain may use only node:crypto",
    ],
    [DOMAIN, 'import { request } from "node:https";', "domain may use only node:crypto"],
    // The built-in list is derived from node:module builtinModules.
    [DOMAIN, 'import { createRequire } from "module";', "domain may use only node:crypto"],
    [DOMAIN, 'import { runInNewContext } from "vm";', "domain may use only node:crypto"],
    [DOMAIN, 'import { Readable } from "stream";', "domain may use only node:crypto"],
    [DOMAIN, 'import { inspect } from "util";', "domain may use only node:crypto"],
    [DOMAIN, 'import { connect } from "http2";', "domain may use only node:crypto"],
    [DOMAIN, 'import { gzipSync } from "zlib";', "domain may use only node:crypto"],
    [DOMAIN, 'import { createHash } from "crypto";', "domain may use only node:crypto"],
    [DOMAIN, 'import { randomUUID } from "node:crypto";', "only createHash from node:crypto"],
    [DOMAIN, 'import { randomBytes } from "node:crypto";', "only createHash from node:crypto"],
    [DOMAIN, 'import nodeCrypto from "node:crypto";', "only createHash from node:crypto"],
    [DOMAIN, 'import Anthropic from "@anthropic-ai/sdk";', "model providers"],
    [DOMAIN, 'import { ChatAnthropic } from "@langchain/anthropic";', "model providers"],
    [DOMAIN, 'import Fastify from "fastify";', "frameworks"],
    [
      DOMAIN_TEST,
      'import { createReferenceSource } from "@supplier-disruption/db/reference";',
      "domain may import only",
    ],
    [WEB, 'import { assessCoverage } from "@supplier-disruption/domain";', "web may import only"],
    [
      WEB,
      'import { assessCoverage } from "../../../packages/domain/src/index.js";',
      "never by relative path",
    ],
    [
      CONTRACTS,
      'import { assessCoverage } from "@supplier-disruption/domain";',
      "contracts must not depend",
    ],
    [
      INVENTORY_SOURCE,
      'import { assessCoverage } from "@supplier-disruption/domain";',
      "db runtime code must not import domain policy",
    ],
    [
      DB_ROOT,
      'export * from "@supplier-disruption/domain";',
      "db runtime code must not import domain policy",
    ],
    [
      "packages/db/src/zz-boundary-probe.ts",
      'import { assessCoverage } from "@supplier-disruption/domain";',
      "db runtime code must not import domain policy",
    ],
  ])("%s rejects: %s", async (path, code, expected) => {
    const messages = await restrictedImports(path, `${code}\n`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(expected);
  });

  it.each([
    [WORKER, 'import { workerHeartbeat } from "@supplier-disruption/db/worker";'],
    [WEB, 'import { PILOT_CONTRACT_VERSION } from "@supplier-disruption/contracts";'],
    [CONTRACTS, 'import { z } from "zod";'],
    [API, 'import { pilotOperation } from "@supplier-disruption/db";'],
    [API, 'import { createPurchasingSource } from "@supplier-disruption/db/purchasing";'],
    [API, 'import { createInventorySource } from "@supplier-disruption/db/inventory";'],
    [API, 'import { createDemandSource } from "@supplier-disruption/db/demand";'],
    [API, 'import { createReferenceSource } from "@supplier-disruption/db/reference";'],
    [REFERENCE_ENTRY, 'export { createReferenceSource } from "./source.js";'],
    [REFERENCE_SOURCE, 'import { readTransaction } from "../runtime.js";'],
    [REFERENCE_SOURCE, 'import type { ReadOk } from "../reads.js";'],
    [INVENTORY_SOURCE, 'import type { ReadOk } from "../reads.js";'],
    [INVENTORY_SOURCE, 'import { writeTransaction } from "../runtime.js";'],
    [INVENTORY_SOURCE, 'import { instantFromPostgres } from "../values.js";'],
    [PURCHASING_ENTRY, 'export { createPurchasingSource } from "./source.js";'],
    // Named setup exceptions: the seed orchestrates owner initialization and the marker.
    [SEED, 'import { seedMarker } from "../authorities/reference/schema.js";'],
    [SEED, 'import { initializeInventoryHeads } from "../authorities/inventory/initialize.js";'],
    [DB_ROOT, 'export { supplierContentSha256 } from "./authorities/reference/initialize.js";'],
    [DOMAIN, 'import { canonicalJson } from "@supplier-disruption/contracts";'],
    [DOMAIN, 'import { createHash } from "node:crypto";'],
    [DOMAIN_TEST, 'import { describe } from "vitest";'],
    [DB_TEST, 'import { assessCoverage } from "@supplier-disruption/domain";'],
    [DB_TEST, 'import { createReferenceSource } from "../src/authorities/reference/index.js";'],
  ])("%s allows: %s", async (path, code) => {
    expect(await restrictedImports(path, `${code}\n`)).toEqual([]);
  });
});

describe("domain purity lint rules", () => {
  const PURITY_RULES = [
    "no-restricted-globals",
    "no-restricted-properties",
    "no-restricted-syntax",
  ];

  async function purityMessages(path, code) {
    const [result] = await eslint.lintText(code, { filePath: `${REPO_ROOT}${path}` });
    expect(result.messages.filter((message) => message.fatal)).toEqual([]);
    return result.messages
      .filter((message) => PURITY_RULES.includes(message.ruleId))
      .map((message) => message.message);
  }

  it.each([
    ["export const now = Date.now();", "takes time only from its input"],
    ["export const now = new Date();", "new Date() reads the wall clock"],
    ["export const now = Date();", "Date() reads the wall clock"],
    ["export const id = Math.random();", "takes IDs only from its input"],
    ["export const id = crypto.randomUUID();", "domain"],
    ["export const env = process.env.TZ;", "no process, network, clock or timer globals"],
    [
      'export const res = fetch("http://127.0.0.1/");',
      "no process, network, clock or timer globals",
    ],
    ["setTimeout(() => undefined, 1);", "no process, network, clock or timer globals"],
    ["export const clock = globalThis.Date;", "no process, network, clock or timer globals"],
  ])("domain source rejects: %s", async (code, expected) => {
    const messages = await purityMessages(DOMAIN, `${code}\n`);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((message) => message.includes(expected))).toBe(true);
  });

  it.each([
    'export const at = Date.parse("2026-10-21T07:00:00.000Z");',
    'export const at = new Date("2026-10-21T07:00:00.000Z");',
    'export const at = new Date(Date.parse("2026-10-21T07:00:00.000Z"));',
  ])("domain source allows: %s", async (code) => {
    expect(await purityMessages(DOMAIN, `${code}\n`)).toEqual([]);
  });

  it("leaves domain tests free to read the clock", async () => {
    expect(await purityMessages(DOMAIN_TEST, "export const now = Date.now();\n")).toEqual([]);
  });
});

/**
 * Literal fixture-schema SQL belongs to its owning authority directory. The
 * named exceptions are setup, not runtime: the seed's canonical-table
 * collision check, the controlled clock's single business-clock read and the
 * Drizzle generation config. Tests and container gates are independent
 * observers and are not scanned. A deliberately small text check, not a SQL
 * analyzer.
 */
const SOURCE_SCHEMA = /\bfixture_(purchasing|inventory|demand|reference)\b(\.\w+)?/g;

function sourceSqlViolations(path, text) {
  const owned = /^packages\/db\/src\/authorities\/(purchasing|inventory|demand|reference)\//.exec(
    path,
  )?.[1];
  const violations = [];
  for (const match of text.matchAll(SOURCE_SCHEMA)) {
    const [literal, owner] = match;
    const allowed =
      owner === owned ||
      path === "packages/db/src/seed/initialize.ts" ||
      path === "packages/db/drizzle.config.ts" ||
      (path === "packages/db/src/clock.ts" && literal === "fixture_reference.business_clock");
    if (!allowed) violations.push(`${path}: ${literal}`);
  }
  return violations;
}

describe("source SQL boundary", () => {
  it("keeps every literal fixture-schema reference in its owner or a named setup exception", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "apps", "packages"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter((path) => /\.(ts|tsx|mjs|js)$/.test(path))
      .filter((path) => !/^(apps|packages)\/[^/]+\/test\//.test(path));
    expect(files).toContain("packages/db/src/authorities/inventory/source.ts");
    expect(files).toContain("packages/db/src/authorities/reference/source.ts");
    // The shared read types belong to no owner, so any fixture SQL there is a violation.
    expect(files).toContain("packages/db/src/authorities/reads.ts");
    const violations = files.flatMap((path) =>
      sourceSqlViolations(path, readFileSync(`${REPO_ROOT}${path}`, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it.each([
    ["apps/api/src/zz.ts", "SELECT * FROM fixture_inventory.reservation"],
    ["apps/worker/src/zz.ts", "UPDATE fixture_purchasing.po_head SET revision = 5"],
    ["packages/db/src/authorities/purchasing/zz.ts", "SELECT 1 FROM fixture_inventory.stock_head"],
    ["packages/db/src/authorities/demand/zz.ts", "SELECT 1 FROM fixture_reference.seed_marker"],
    ["packages/db/src/clock.ts", "SELECT 1 FROM fixture_reference.seed_marker"],
    ["packages/db/src/index.ts", "SELECT 1 FROM fixture_demand.demand_line"],
    ["packages/db/src/authorities/reads.ts", "SELECT 1 FROM fixture_reference.item"],
    [
      "packages/db/src/authorities/inventory/source.ts",
      "SELECT 1 FROM fixture_reference.organization_alias",
    ],
    [
      "packages/db/src/authorities/reference/source.ts",
      "SELECT 1 FROM fixture_inventory.stock_head",
    ],
    ["apps/api/src/zz.ts", "SELECT sku FROM fixture_reference.item"],
  ])("rejects %s: %s", (path, text) => {
    expect(sourceSqlViolations(path, text)).toHaveLength(1);
  });

  it.each([
    [
      "packages/db/src/authorities/inventory/source.ts",
      "SELECT 1 FROM fixture_inventory.stock_head",
    ],
    ["packages/db/src/clock.ts", "SELECT instant FROM fixture_reference.business_clock"],
    ["packages/db/src/seed/initialize.ts", "SELECT 1 FROM fixture_demand.demand_head"],
    [
      "packages/db/src/authorities/reference/source.ts",
      "SELECT label FROM fixture_reference.organization_alias",
    ],
  ])("allows %s: %s", (path, text) => {
    expect(sourceSqlViolations(path, text)).toEqual([]);
  });
});
