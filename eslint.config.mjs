import { builtinModules } from "node:module";
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Builds a no-restricted-imports rule from forbidden module groups. Groups use
 * gitignore semantics, so an exact package name that must stay importable by
 * subpath goes in `paths` instead.
 */
function forbid(groups, paths = []) {
  return {
    "no-restricted-imports": [
      "error",
      { paths, patterns: groups.map(([group, message]) => ({ group, message })) },
    ],
  };
}

// Relative specifiers that reach into another package's source or build output.
const crossPackageRelative = [
  [
    "**/apps/**",
    "**/packages/**",
    "**/api/src/**",
    "**/api/dist/**",
    "**/worker/src/**",
    "**/worker/dist/**",
    "**/web/app/**",
    "**/web/lib/**",
    "**/db/src/**",
    "**/db/dist/**",
    "**/config/src/**",
    "**/config/dist/**",
    "**/contracts/src/**",
    "**/contracts/dist/**",
    "**/domain/src/**",
    "**/domain/dist/**",
  ],
  "Import workspace packages by name, never by relative path.",
];

// Groups every shared package keeps, repeated wherever a narrower block
// replaces the package's rule.
const sharedPackageGroups = [
  [
    ["@supplier-disruption/api", "@supplier-disruption/worker", "@supplier-disruption/web"],
    "shared packages must not import applications.",
  ],
  crossPackageRelative,
];

// Each fixture authority's tables, initialization and runtime SQL stay in its
// own directory. A directory's own relative imports never name an owner, so
// any specifier naming one reaches into another authority (ADR 0005).
const otherAuthority = [
  ["**/purchasing/**", "**/inventory/**", "**/demand/**", "**/reference/**"],
  "a fixture authority must not import another authority's tables or modules.",
];

// Inside the db package a self-reference by package name, such as
// @supplier-disruption/db/inventory, would bypass the path rules above.
const dbSelfReference = [
  ["@supplier-disruption/db", "@supplier-disruption/db/*"],
  "db package files import their own modules by relative path, never by package name.",
];

// Domain policy is consumed by db tests and later API composition, never by
// db runtime code, so the db package has no runtime domain dependency (ADR 0007).
const domainFromDbRuntime = [
  ["@supplier-disruption/domain", "@supplier-disruption/domain/*"],
  "db runtime code must not import domain policy; only db tests compose it.",
];

// Domain purity (ADR 0007): every Node built-in except node:crypto's createHash,
// derived from the running Node so a new built-in is covered without a list edit.
const domainBuiltinMessage =
  "domain may use only node:crypto among Node built-ins: no file, network, process or timer access.";
const domainBuiltinPaths = [
  ...builtinModules
    .filter((name) => !name.startsWith("node:"))
    .map((name) => ({ name, message: domainBuiltinMessage })),
  {
    name: "node:crypto",
    allowImportNames: ["createHash"],
    message: "domain may use only createHash from node:crypto: no random values or keys.",
  },
];

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "apps/web/next-env.d.ts",
    "docs/**",
    "fixtures/**",
    "tests/**",
    "supplier_disruption/**",
  ]),

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // contracts: pure, browser-safe schemas. No persistence, framework or Node imports.
  {
    files: ["packages/contracts/**/*.ts"],
    rules: forbid([
      [
        ["@supplier-disruption/*", "node:*", "pg", "pg-boss", "drizzle-orm", "drizzle-orm/*"],
        "contracts must not depend on other workspace packages, Node built-ins or persistence.",
      ],
      [
        ["fastify", "fastify/*", "next", "next/*", "react", "react/*", "react-dom", "react-dom/*"],
        "contracts must not import Fastify, Next or React.",
      ],
      [["better-auth", "better-auth/*", "@better-auth/*"], "contracts must not import auth code."],
      crossPackageRelative,
    ]),
  },

  // domain: pure policy over contracts. No persistence, I/O, clock, framework or
  // model provider; stateless node:crypto hashing is the only Node built-in (ADR 0007).
  {
    files: ["packages/domain/**/*.ts"],
    rules: forbid(
      [
        [
          ["@supplier-disruption/*", "!@supplier-disruption/contracts"],
          "domain may import only @supplier-disruption/contracts among workspace packages.",
        ],
        [["node:*", "!node:crypto"], domainBuiltinMessage],
        [
          [
            "pg",
            "pg-boss",
            "drizzle-orm",
            "drizzle-orm/*",
            "fastify",
            "fastify/*",
            "next",
            "next/*",
            "react",
            "react/*",
            "react-dom",
            "react-dom/*",
            "better-auth",
            "better-auth/*",
            "@better-auth/*",
            "@anthropic-ai/*",
            "@langchain/*",
            "langchain",
            "langchain/*",
            "openai",
          ],
          "domain must not import persistence, frameworks, auth or model providers.",
        ],
        crossPackageRelative,
      ],
      domainBuiltinPaths,
    ),
  },
  // Domain source takes time, IDs and data only from its argument: no wall
  // clock, randomness, process state, network or timers through globals.
  {
    files: ["packages/domain/src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...[
          "process",
          "fetch",
          "crypto",
          "performance",
          "setTimeout",
          "setInterval",
          "setImmediate",
          "queueMicrotask",
          "require",
          "globalThis",
        ].map((name) => ({
          name,
          message: "domain policy is pure: no process, network, clock or timer globals.",
        })),
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "domain takes time only from its input." },
        { object: "Math", property: "random", message: "domain takes IDs only from its input." },
        {
          object: "crypto",
          property: "randomUUID",
          message: "domain takes IDs only from its input.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "domain takes time only from its input: new Date() reads the wall clock.",
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: "domain takes time only from its input: Date() reads the wall clock.",
        },
      ],
    },
  },

  // web: presentation only. No database, server config, API or worker internals.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: forbid([
      [
        [
          "@supplier-disruption/db",
          "@supplier-disruption/db/*",
          "@supplier-disruption/config",
          "@supplier-disruption/domain",
          "@supplier-disruption/domain/*",
          "@supplier-disruption/api",
          "@supplier-disruption/api/*",
          "@supplier-disruption/worker",
          "@supplier-disruption/worker/*",
        ],
        "web may import only @supplier-disruption/contracts; business authority stays in the API.",
      ],
      [
        ["pg", "pg-boss", "drizzle-orm", "drizzle-orm/*", "better-auth", "@better-auth/*"],
        "web must not import database or server auth modules.",
      ],
      crossPackageRelative,
    ]),
  },

  // worker: queue and heartbeat access only; business changes go through the API.
  {
    files: ["apps/worker/**/*.ts"],
    rules: forbid(
      [
        [
          ["@supplier-disruption/db/*", "!@supplier-disruption/db/worker"],
          "worker may import only @supplier-disruption/db/worker (heartbeat and queue constants).",
        ],
        [
          ["@supplier-disruption/api", "@supplier-disruption/api/*", "@supplier-disruption/web"],
          "worker must not import API or web internals.",
        ],
        [["better-auth", "better-auth/*", "@better-auth/*"], "worker has no user sessions."],
        crossPackageRelative,
      ],
      [
        {
          name: "@supplier-disruption/db",
          message:
            "worker may import only @supplier-disruption/db/worker (heartbeat and queue constants).",
        },
      ],
    ),
  },

  // api: authoritative service. Never imports worker or web code, and reaches
  // fixture sources only through their public runtime modules.
  {
    files: ["apps/api/**/*.ts"],
    rules: forbid([
      [
        [
          "@supplier-disruption/db/*",
          "!@supplier-disruption/db/purchasing",
          "!@supplier-disruption/db/inventory",
          "!@supplier-disruption/db/demand",
          "!@supplier-disruption/db/reference",
        ],
        "api may import only the db root and the public source modules @supplier-disruption/db/{purchasing,inventory,demand,reference}; source tables stay private.",
      ],
      [
        [
          "@supplier-disruption/worker",
          "@supplier-disruption/web",
          "next",
          "next/*",
          "react",
          "react-dom",
        ],
        "api must not import worker, web, Next or React code.",
      ],
      crossPackageRelative,
    ]),
  },

  {
    files: ["packages/config/**/*.ts"],
    rules: forbid(sharedPackageGroups),
  },

  {
    files: ["packages/db/**/*.ts"],
    rules: forbid([...sharedPackageGroups, dbSelfReference]),
  },

  {
    files: ["packages/db/src/**/*.ts"],
    rules: forbid([...sharedPackageGroups, dbSelfReference, domainFromDbRuntime]),
  },

  // Fixture authorities: no authority imports another's tables or modules.
  {
    files: ["packages/db/src/authorities/**/*.ts"],
    rules: forbid([...sharedPackageGroups, dbSelfReference, domainFromDbRuntime, otherAuthority]),
  },

  // Runtime source modules and their public entries use their own SQL; the
  // owner's Drizzle tables and initialization stay private to setup.
  {
    files: [
      "packages/db/src/authorities/*/index.ts",
      "packages/db/src/authorities/*/source.ts",
      "packages/db/src/authorities/runtime.ts",
    ],
    rules: forbid([
      ...sharedPackageGroups,
      dbSelfReference,
      domainFromDbRuntime,
      otherAuthority,
      [
        ["**/schema", "**/schema.js", "**/initialize", "**/initialize.js"],
        "runtime source modules must not import or expose source tables or initialization.",
      ],
    ]),
  },

  // The db root and worker entries never expose source tables or runtime
  // source modules; those have their own public subpaths.
  {
    files: ["packages/db/src/index.ts", "packages/db/src/worker.ts"],
    rules: forbid([
      ...sharedPackageGroups,
      dbSelfReference,
      domainFromDbRuntime,
      [
        [
          "**/authorities/*/schema",
          "**/authorities/*/schema.js",
          "**/authorities/*/source",
          "**/authorities/*/source.js",
          "**/authorities/*/index",
          "**/authorities/*/index.js",
          "**/authorities/runtime",
          "**/authorities/runtime.js",
        ],
        "db root exports must not expose source tables or runtime source modules; use @supplier-disruption/db/{purchasing,inventory,demand,reference}.",
      ],
    ]),
  },

  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    settings: { next: { rootDir: "apps/web/" } },
    languageOptions: { globals: globals.browser },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
]);
