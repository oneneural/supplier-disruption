# Third-party notices

This project is licensed under the [MIT license](LICENSE). Its dependencies,
container base images and external services keep their own licenses. This file
is an inventory of declared licenses, compiled on 2026-10-24 from installed
package metadata and the packaged application image. It is not a legal opinion
or a substitute for each component's own license text, which stays inside that
component's package directory.

## Items that need attention before redistribution

| Component                                                              | Declared license                 | Where it is used                                                                                                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@img/sharp-libvips-*` 1.3.4 (native libvips 8.18.7 and its libraries) | LGPL-3.0-or-later                | Optional dependency of Next.js through `sharp` 0.35.5. The linux-arm64 build is present in the packaged image under `/opt/web` and `/opt/api`; the host install has the darwin-arm64 build. |
| `@img/sharp-*` native addon 0.35.5                                     | Apache-2.0                       | Same path as above, beside libvips                                                                                                                                                          |
| `lightningcss` 1.32.0 and 1.33.0 and their platform builds             | MPL-2.0                          | CSS build tooling only; not found in the packaged image                                                                                                                                     |
| `caniuse-lite` 1.0.30001816                                            | CC-BY-4.0 (attribution required) | Browser-support data used by Next.js; present in the packaged image under `/opt/api`                                                                                                        |
| ERPNext and Frappe 16.52.0                                             | GPL-3.0 (ERPNext), MIT (Frappe)  | External disposable sandbox for the isolated connector proof, reached over HTTP. No ERPNext or Frappe source is vendored here.                                                              |

The libvips bundle declares these bundled library versions in its
`versions.json`: aom 3.15.1, archive 3.8.9, cairo 1.18.6, cgif 0.5.4,
exif 0.6.26, expat 2.8.5, ffi 3.8.0, fontconfig 2.18.3, freetype 2.14.3,
fribidi 1.0.17, glib 2.90.0, harfbuzz 14.5.0, heif 1.23.5, highway 1.4.0,
imagequant 2.4.1, lcms 2.19.1, mozjpeg 0826579, pango 1.58.2, pixman 0.46.4,
png 1.6.58, proxy-libintl 0.5, rsvg 2.63.2, tiff 4.7.2, uhdr 2.0.2, vips 8.18.7,
webp 1.6.0, xml2 2.15.4 and zlib-ng 2.3.3. Their individual licenses were not
inventoried. Anyone distributing the image needs to review and meet the
LGPL-3.0 obligations for libvips (such as source availability and the right to
relink) and carry the attribution CC-BY-4.0 requires for caniuse-lite.

## Container images and runtime tools

| Component                                        | Source in this repository                     | Notes                                                               |
| ------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------- |
| `node:24.22.0-bookworm-slim` (digest pinned)     | [Dockerfile](Dockerfile)                      | Base of the application image; Node.js is MIT, Debian packages vary |
| `alpine:3.22` (digest pinned)                    | [Dockerfile](Dockerfile)                      | Build stage that unpacks s6-overlay; not part of the runtime image  |
| s6-overlay 3.2.3.2 (s6, execline, s6-linux-init) | [Dockerfile](Dockerfile)                      | ISC; supervises the three application processes                     |
| `postgres:18.6-bookworm` (digest pinned)         | [compose.yaml](compose.yaml)                  | PostgreSQL License; run as a separate container, not built here     |
| Playwright 1.64.1 and its Chromium builds        | [package.json](package.json) dev dependencies | Apache-2.0 tooling for tests and screenshots; not in the image      |

Debian and Alpine package licenses inside the base images were not inventoried.

## Data, recordings and media

The fixtures, evaluation scenarios, recorded model runs and screenshots are
synthetic material created for this repository and covered by its license. The
recorded runs contain Claude model output generated from that synthetic input.
The web app uses system font stacks and one simple SVG icon, with no vendored
fonts.

## How this inventory was produced

```sh
corepack pnpm -r licenses list --json
corepack pnpm -r licenses list --json --prod
```

The first command covers 356 installed package versions; the second marks the
138 that pnpm lists as runtime dependencies of the workspace packages. pnpm does
not list optional native packages in the runtime set, so libvips appears there
as "no" although the image contains it. The image contents were checked by
listing `node_modules/.pnpm` in `supplier-disruption-app:demo` built from this
repository.

The lockfile resolves 519 package versions. The 163 without installed metadata
are mostly platform builds for other operating systems or CPUs (for example
`@img/sharp-libvips-linux-x64` and `lightningcss-linux-x64-gnu`), plus package
manager tooling. Their licenses were not read. An image built for another
platform carries that platform's libvips build instead of linux-arm64.

## Installed package inventory

| Declared license  | Package versions | In the runtime dependency set |
| ----------------- | ---------------- | ----------------------------- |
| MIT               | 291              | 117                           |
| Apache-2.0        | 27               | 7                             |
| ISC               | 15               | 5                             |
| BSD-2-Clause      | 6                | 0                             |
| BSD-3-Clause      | 7                | 5                             |
| MPL-2.0           | 4                | 0                             |
| (MIT OR CC0-1.0)  | 1                | 1                             |
| 0BSD              | 1                | 1                             |
| BlueOak-1.0.0     | 1                | 0                             |
| CC-BY-4.0         | 1                | 1                             |
| LGPL-3.0-or-later | 1                | 0                             |
| Unlicense         | 1                | 1                             |

### MIT

| Package                                    | Versions                 | Runtime set |
| ------------------------------------------ | ------------------------ | ----------- |
| `@alloc/quick-lru`                         | 5.3.0                    | no          |
| `@anthropic-ai/sdk`                        | 0.131.0                  | yes         |
| `@babel/code-frame`                        | 7.29.7                   | no          |
| `@babel/compat-data`                       | 7.29.7                   | no          |
| `@babel/core`                              | 7.29.7                   | no          |
| `@babel/generator`                         | 7.29.8                   | no          |
| `@babel/helper-compilation-targets`        | 7.29.7                   | no          |
| `@babel/helper-globals`                    | 7.29.7                   | no          |
| `@babel/helper-module-imports`             | 7.29.7                   | no          |
| `@babel/helper-module-transforms`          | 7.29.7                   | no          |
| `@babel/helper-string-parser`              | 7.29.7                   | no          |
| `@babel/helper-validator-identifier`       | 7.29.7                   | no          |
| `@babel/helper-validator-option`           | 7.29.7                   | no          |
| `@babel/helpers`                           | 7.29.10                  | no          |
| `@babel/parser`                            | 7.29.9                   | no          |
| `@babel/runtime`                           | 7.29.10                  | yes         |
| `@babel/template`                          | 7.29.7                   | no          |
| `@babel/traverse`                          | 7.29.10                  | no          |
| `@babel/types`                             | 7.29.8                   | no          |
| `@better-auth/core`                        | 1.7.10                   | yes         |
| `@better-auth/drizzle-adapter`             | 1.7.10                   | yes         |
| `@better-auth/kysely-adapter`              | 1.7.10                   | yes         |
| `@better-auth/memory-adapter`              | 1.7.10                   | yes         |
| `@better-auth/mongo-adapter`               | 1.7.10                   | yes         |
| `@better-auth/prisma-adapter`              | 1.7.10                   | yes         |
| `@better-auth/telemetry`                   | 1.7.10                   | yes         |
| `@better-auth/utils`                       | 0.5.0                    | yes         |
| `@better-fetch/fetch`                      | 1.3.2                    | yes         |
| `@cacheable/memory`                        | 2.2.0                    | no          |
| `@cacheable/utils`                         | 2.5.0                    | no          |
| `@cfworker/json-schema`                    | 4.1.1                    | yes         |
| `@esbuild-kit/core-utils`                  | 3.3.2                    | no          |
| `@esbuild-kit/esm-loader`                  | 2.6.5                    | no          |
| `@esbuild/darwin-arm64`                    | 0.18.20, 0.25.12, 0.28.2 | no          |
| `@eslint-community/eslint-utils`           | 4.9.1, 4.10.1            | no          |
| `@eslint-community/regexpp`                | 4.12.2                   | no          |
| `@eslint/js`                               | 10.0.1                   | no          |
| `@fastify/ajv-compiler`                    | 4.0.7                    | yes         |
| `@fastify/deepmerge`                       | 3.2.2                    | yes         |
| `@fastify/error`                           | 4.2.1                    | yes         |
| `@fastify/fast-json-stringify-compiler`    | 5.1.1                    | yes         |
| `@fastify/forwarded`                       | 3.1.1                    | yes         |
| `@fastify/merge-json-schemas`              | 0.2.2                    | yes         |
| `@fastify/proxy-addr`                      | 5.1.2                    | yes         |
| `@img/colour`                              | 1.1.0                    | no          |
| `@jridgewell/gen-mapping`                  | 0.3.13                   | no          |
| `@jridgewell/remapping`                    | 2.3.5                    | no          |
| `@jridgewell/resolve-uri`                  | 3.1.2                    | no          |
| `@jridgewell/sourcemap-codec`              | 1.6.0                    | no          |
| `@jridgewell/trace-mapping`                | 0.3.31                   | no          |
| `@keyv/bigmap`                             | 1.3.1                    | no          |
| `@keyv/serialize`                          | 1.1.1                    | no          |
| `@langchain/core`                          | 1.2.17                   | yes         |
| `@langchain/langgraph`                     | 1.4.20                   | yes         |
| `@langchain/langgraph-checkpoint`          | 1.1.6                    | yes         |
| `@langchain/langgraph-checkpoint-postgres` | 1.0.6                    | yes         |
| `@langchain/langgraph-sdk`                 | 1.12.5                   | yes         |
| `@langchain/protocol`                      | 0.0.19                   | yes         |
| `@next/env`                                | 16.4.2                   | yes         |
| `@next/eslint-plugin-next`                 | 16.4.2                   | no          |
| `@next/swc-darwin-arm64`                   | 16.4.2                   | no          |
| `@noble/ciphers`                           | 2.4.0                    | yes         |
| `@noble/hashes`                            | 2.4.0                    | yes         |
| `@nodelib/fs.scandir`                      | 2.1.5                    | no          |
| `@nodelib/fs.stat`                         | 2.0.5                    | no          |
| `@nodelib/fs.walk`                         | 1.2.8                    | no          |
| `@oxc-project/types`                       | 0.154.0                  | no          |
| `@pinojs/redact`                           | 0.4.0                    | yes         |
| `@rolldown/binding-darwin-arm64`           | 1.2.14                   | no          |
| `@rolldown/pluginutils`                    | 1.0.1                    | no          |
| `@stablelib/base64`                        | 1.0.1                    | yes         |
| `@standard-schema/spec`                    | 1.1.0                    | yes         |
| `@tailwindcss/node`                        | 4.3.3                    | no          |
| `@tailwindcss/oxide`                       | 4.3.3                    | no          |
| `@tailwindcss/oxide-darwin-arm64`          | 4.3.3                    | no          |
| `@tailwindcss/postcss`                     | 4.3.3                    | no          |
| `@types/chai`                              | 5.2.3                    | no          |
| `@types/deep-eql`                          | 4.0.2                    | no          |
| `@types/esrecurse`                         | 4.3.1                    | no          |
| `@types/estree`                            | 1.0.9                    | no          |
| `@types/json-schema`                       | 7.0.15                   | yes         |
| `@types/node`                              | 24.19.2                  | no          |
| `@types/pg`                                | 8.23.1                   | no          |
| `@types/react`                             | 19.3.0                   | no          |
| `@types/react-dom`                         | 19.3.0                   | no          |
| `@typescript-eslint/eslint-plugin`         | 8.71.2                   | no          |
| `@typescript-eslint/parser`                | 8.71.2                   | no          |
| `@typescript-eslint/project-service`       | 8.71.2                   | no          |
| `@typescript-eslint/scope-manager`         | 8.71.2                   | no          |
| `@typescript-eslint/tsconfig-utils`        | 8.71.2                   | no          |
| `@typescript-eslint/type-utils`            | 8.71.2                   | no          |
| `@typescript-eslint/types`                 | 8.71.2                   | no          |
| `@typescript-eslint/typescript-estree`     | 8.71.2                   | no          |
| `@typescript-eslint/utils`                 | 8.71.2                   | no          |
| `@typescript-eslint/visitor-keys`          | 8.71.2                   | no          |
| `@vitest/mocker`                           | 5.0.5                    | no          |
| `@vitest/spy`                              | 5.0.5                    | no          |
| `abstract-logging`                         | 2.0.1                    | yes         |
| `acorn`                                    | 8.19.0                   | no          |
| `acorn-jsx`                                | 5.3.2                    | no          |
| `ajv`                                      | 6.15.0, 8.20.0           | yes         |
| `ajv-formats`                              | 3.0.1                    | yes         |
| `assertion-error`                          | 2.0.1                    | no          |
| `atomic-sleep`                             | 1.0.0                    | yes         |
| `avvio`                                    | 9.3.1                    | yes         |
| `balanced-match`                           | 4.0.4                    | no          |
| `base64-js`                                | 1.5.1                    | yes         |
| `better-auth`                              | 1.7.10                   | yes         |
| `better-call`                              | 1.4.2                    | yes         |
| `brace-expansion`                          | 5.0.12                   | no          |
| `braces`                                   | 3.0.3                    | no          |
| `browserslist`                             | 4.29.3                   | no          |
| `buffer-from`                              | 1.1.2                    | no          |
| `cacheable`                                | 2.5.0                    | no          |
| `chai`                                     | 6.3.0                    | no          |
| `client-only`                              | 0.0.1                    | yes         |
| `clsx`                                     | 2.1.1                    | yes         |
| `convert-source-map`                       | 2.0.0                    | no          |
| `cookie`                                   | 2.0.1                    | yes         |
| `cron-parser`                              | 5.10.2                   | yes         |
| `cross-spawn`                              | 7.0.6                    | no          |
| `csstype`                                  | 3.2.3                    | no          |
| `debug`                                    | 4.4.3                    | no          |
| `deep-is`                                  | 0.1.4                    | no          |
| `defu`                                     | 6.1.7                    | yes         |
| `dequal`                                   | 2.0.3                    | yes         |
| `drizzle-kit`                              | 0.31.11                  | no          |
| `enhanced-resolve`                         | 5.26.0                   | no          |
| `es-module-lexer`                          | 2.3.2                    | no          |
| `esbuild`                                  | 0.18.20, 0.25.12, 0.28.2 | no          |
| `escalade`                                 | 3.2.0                    | no          |
| `escape-string-regexp`                     | 4.0.0                    | no          |
| `eslint`                                   | 10.13.0                  | no          |
| `eslint-plugin-react-hooks`                | 7.1.1                    | no          |
| `estree-walker`                            | 3.0.3                    | no          |
| `eventemitter3`                            | 4.0.7, 5.0.4             | yes         |
| `fast-decode-uri-component`                | 1.0.1                    | yes         |
| `fast-deep-equal`                          | 3.1.3                    | yes         |
| `fast-glob`                                | 3.3.1                    | no          |
| `fast-json-stable-stringify`               | 2.1.0                    | no          |
| `fast-json-stringify`                      | 7.1.0                    | yes         |
| `fast-levenshtein`                         | 2.0.6                    | no          |
| `fast-querystring`                         | 1.1.2                    | yes         |
| `fastify`                                  | 5.12.7                   | yes         |
| `fdir`                                     | 6.5.0                    | no          |
| `file-entry-cache`                         | 11.1.5                   | no          |
| `fill-range`                               | 7.1.1                    | no          |
| `find-my-way`                              | 9.10.0                   | yes         |
| `find-up`                                  | 5.0.0                    | no          |
| `flat-cache`                               | 6.1.23                   | no          |
| `fsevents`                                 | 2.3.3                    | no          |
| `gensync`                                  | 1.0.0-beta.2             | no          |
| `get-tsconfig`                             | 4.14.3                   | no          |
| `globals`                                  | 17.13.0                  | no          |
| `hashery`                                  | 1.5.1                    | no          |
| `hermes-estree`                            | 0.25.1                   | no          |
| `hermes-parser`                            | 0.25.1                   | no          |
| `hookified`                                | 1.15.1, 2.2.0            | no          |
| `ignore`                                   | 5.3.2, 7.0.12            | no          |
| `imurmurhash`                              | 0.1.4                    | no          |
| `ipaddr.js`                                | 2.5.0                    | yes         |
| `is-extglob`                               | 2.1.1                    | no          |
| `is-glob`                                  | 4.0.3                    | no          |
| `is-network-error`                         | 1.3.2                    | yes         |
| `is-number`                                | 7.0.0                    | no          |
| `jiti`                                     | 2.7.0                    | no          |
| `jose`                                     | 6.2.12                   | yes         |
| `js-tiktoken`                              | 1.0.21                   | yes         |
| `js-tokens`                                | 4.0.0                    | no          |
| `jsesc`                                    | 3.1.0                    | no          |
| `json-schema-ref-resolver`                 | 3.0.1                    | yes         |
| `json-schema-to-ts`                        | 3.1.1                    | yes         |
| `json-schema-traverse`                     | 0.4.1, 1.0.0             | yes         |
| `json-stable-stringify-without-jsonify`    | 1.0.1                    | no          |
| `json5`                                    | 2.2.3                    | no          |
| `keyv`                                     | 5.6.0                    | no          |
| `kysely`                                   | 0.29.6                   | yes         |
| `langsmith`                                | 0.11.0                   | yes         |
| `levn`                                     | 0.4.1                    | no          |
| `locate-path`                              | 6.0.0                    | no          |
| `luxon`                                    | 3.7.2                    | yes         |
| `magic-string`                             | 0.30.21, 1.4.3           | no          |
| `merge2`                                   | 1.4.1                    | no          |
| `micromatch`                               | 4.0.8                    | no          |
| `ms`                                       | 2.1.3                    | no          |
| `mustache`                                 | 4.2.0                    | yes         |
| `nanoid`                                   | 3.3.20                   | yes         |
| `nanostores`                               | 1.5.5                    | yes         |
| `natural-compare`                          | 1.4.0                    | no          |
| `next`                                     | 16.4.2                   | yes         |
| `node-releases`                            | 2.0.59                   | no          |
| `non-error`                                | 0.1.0                    | yes         |
| `obug`                                     | 3.0.0                    | no          |
| `on-exit-leak-free`                        | 2.1.2                    | yes         |
| `optionator`                               | 0.9.4                    | no          |
| `p-finally`                                | 1.0.0                    | yes         |
| `p-limit`                                  | 3.1.0                    | no          |
| `p-locate`                                 | 5.0.0                    | no          |
| `p-queue`                                  | 6.6.2, 9.3.5             | yes         |
| `p-retry`                                  | 7.1.1                    | yes         |
| `p-timeout`                                | 3.2.0, 7.0.2             | yes         |
| `path-exists`                              | 4.0.0                    | no          |
| `path-key`                                 | 3.1.1                    | no          |
| `pg`                                       | 8.23.1                   | yes         |
| `pg-boss`                                  | 12.38.0                  | yes         |
| `pg-cloudflare`                            | 1.4.1                    | no          |
| `pg-connection-string`                     | 2.14.1                   | yes         |
| `pg-pool`                                  | 3.14.0                   | yes         |
| `pg-protocol`                              | 1.16.1                   | yes         |
| `pg-types`                                 | 2.2.0                    | yes         |
| `pgpass`                                   | 1.0.5                    | yes         |
| `picomatch`                                | 2.3.2, 4.0.7             | no          |
| `pino`                                     | 10.4.0                   | yes         |
| `pino-abstract-transport`                  | 3.0.0                    | yes         |
| `pino-std-serializers`                     | 7.1.0                    | yes         |
| `postcss`                                  | 8.5.23, 8.5.30           | yes         |
| `postgres-array`                           | 2.0.0                    | yes         |
| `postgres-bytea`                           | 1.0.1                    | yes         |
| `postgres-date`                            | 1.0.7                    | yes         |
| `postgres-interval`                        | 1.2.0                    | yes         |
| `prelude-ls`                               | 1.2.1                    | no          |
| `prettier`                                 | 3.9.10                   | no          |
| `process-warning`                          | 5.1.1                    | yes         |
| `punycode`                                 | 2.3.1                    | no          |
| `qified`                                   | 0.10.1                   | no          |
| `queue-microtask`                          | 1.2.3                    | no          |
| `quick-format-unescaped`                   | 4.0.4                    | yes         |
| `react`                                    | 19.3.1                   | yes         |
| `react-dom`                                | 19.3.1                   | yes         |
| `real-require`                             | 1.0.0                    | yes         |
| `require-from-string`                      | 2.0.2                    | yes         |
| `resolve-pkg-maps`                         | 1.0.0                    | no          |
| `ret`                                      | 0.5.0                    | yes         |
| `reusify`                                  | 1.1.0                    | yes         |
| `rfdc`                                     | 1.4.1                    | yes         |
| `rolldown`                                 | 1.2.14                   | no          |
| `rou3`                                     | 0.9.2                    | yes         |
| `rrule-temporal`                           | 2.2.8                    | yes         |
| `run-parallel`                             | 1.2.0                    | no          |
| `safe-regex2`                              | 5.1.2                    | yes         |
| `safe-stable-stringify`                    | 2.5.0                    | yes         |
| `scheduler`                                | 0.28.0                   | yes         |
| `serialize-error`                          | 13.0.2                   | yes         |
| `set-cookie-parser`                        | 3.1.4                    | yes         |
| `shebang-command`                          | 2.0.0                    | no          |
| `shebang-regex`                            | 3.0.0                    | no          |
| `sonic-boom`                               | 4.2.1                    | yes         |
| `source-map-support`                       | 0.5.21                   | no          |
| `standardwebhooks`                         | 1.1.1                    | yes         |
| `std-env`                                  | 4.3.0                    | no          |
| `styled-jsx`                               | 5.1.6                    | yes         |
| `tagged-tag`                               | 1.0.0                    | yes         |
| `tailwind-merge`                           | 3.7.0                    | yes         |
| `tailwindcss`                              | 4.3.3                    | no          |
| `tapable`                                  | 2.3.3                    | no          |
| `thread-stream`                            | 4.2.0                    | yes         |
| `tinybench`                                | 6.2.2                    | no          |
| `tinyexec`                                 | 1.3.1                    | no          |
| `tinyglobby`                               | 0.2.17                   | no          |
| `to-regex-range`                           | 5.0.1                    | no          |
| `toad-cache`                               | 3.7.4                    | yes         |
| `ts-algebra`                               | 2.0.0                    | yes         |
| `ts-api-utils`                             | 2.5.0                    | no          |
| `tsx`                                      | 4.23.15                  | no          |
| `type-check`                               | 0.4.0                    | no          |
| `typescript-eslint`                        | 8.71.2                   | no          |
| `undici-types`                             | 7.24.6                   | no          |
| `update-browserslist-db`                   | 1.3.4                    | no          |
| `vite`                                     | 8.3.4                    | no          |
| `vitest`                                   | 5.0.5                    | no          |
| `why-is-node-running`                      | 3.2.1                    | no          |
| `word-wrap`                                | 1.2.5                    | no          |
| `xtend`                                    | 4.0.2                    | yes         |
| `yocto-queue`                              | 0.1.0                    | no          |
| `zod`                                      | 4.6.7                    | yes         |
| `zod-validation-error`                     | 4.0.2                    | no          |

### Apache-2.0

| Package                               | Versions     | Runtime set |
| ------------------------------------- | ------------ | ----------- |
| `@drizzle-team/brocli`                | 0.10.2       | no          |
| `@eslint/config-array`                | 0.23.5       | no          |
| `@eslint/config-helpers`              | 0.7.0        | no          |
| `@eslint/core`                        | 1.2.1        | no          |
| `@eslint/object-schema`               | 3.0.5        | no          |
| `@eslint/plugin-kit`                  | 0.7.3        | no          |
| `@humanfs/core`                       | 0.19.2       | no          |
| `@humanfs/node`                       | 0.16.8       | no          |
| `@humanfs/types`                      | 0.15.0       | no          |
| `@humanwhocodes/module-importer`      | 1.0.1        | no          |
| `@humanwhocodes/retry`                | 0.4.3        | no          |
| `@img/sharp-darwin-arm64`             | 0.35.5       | no          |
| `@opentelemetry/api`                  | 1.9.1        | yes         |
| `@opentelemetry/semantic-conventions` | 1.43.0       | yes         |
| `@swc/helpers`                        | 0.5.23       | yes         |
| `baseline-browser-mapping`            | 2.11.29      | yes         |
| `class-variance-authority`            | 0.7.1        | yes         |
| `detect-libc`                         | 2.1.2        | no          |
| `drizzle-orm`                         | 0.45.4       | yes         |
| `eslint-visitor-keys`                 | 3.4.3, 5.0.1 | no          |
| `expect-type`                         | 1.4.0        | no          |
| `playwright`                          | 1.64.1       | no          |
| `playwright-core`                     | 1.64.1       | no          |
| `sharp`                               | 0.35.5       | no          |
| `temporal-spec`                       | 1.0.1        | yes         |
| `typescript`                          | 6.0.3        | no          |

### ISC

| Package                | Versions     | Runtime set |
| ---------------------- | ------------ | ----------- |
| `electron-to-chromium` | 1.5.459      | no          |
| `fastq`                | 1.20.3       | yes         |
| `flatted`              | 3.4.4        | no          |
| `glob-parent`          | 5.1.2, 6.0.2 | no          |
| `graceful-fs`          | 4.2.11       | no          |
| `isexe`                | 2.0.0        | no          |
| `lru-cache`            | 5.1.1        | no          |
| `pg-int8`              | 1.0.1        | yes         |
| `picocolors`           | 1.1.1        | yes         |
| `semver`               | 6.3.1, 7.8.5 | yes         |
| `split2`               | 4.2.0        | yes         |
| `which`                | 2.0.2        | no          |
| `yallist`              | 3.1.1        | no          |

### BSD-2-Clause

| Package        | Versions | Runtime set |
| -------------- | -------- | ----------- |
| `eslint-scope` | 9.1.2    | no          |
| `espree`       | 11.2.0   | no          |
| `esrecurse`    | 4.3.0    | no          |
| `estraverse`   | 5.3.0    | no          |
| `esutils`      | 2.0.3    | no          |
| `uri-js`       | 4.4.1    | no          |

### BSD-3-Clause

| Package             | Versions     | Runtime set |
| ------------------- | ------------ | ----------- |
| `esquery`           | 1.7.0        | no          |
| `fast-uri`          | 3.1.8, 4.2.2 | yes         |
| `light-my-request`  | 6.8.0        | yes         |
| `secure-json-parse` | 4.1.1        | yes         |
| `source-map`        | 0.6.1        | no          |
| `source-map-js`     | 1.2.2        | yes         |

### MPL-2.0

| Package                     | Versions       | Runtime set |
| --------------------------- | -------------- | ----------- |
| `lightningcss`              | 1.32.0, 1.33.0 | no          |
| `lightningcss-darwin-arm64` | 1.32.0, 1.33.0 | no          |

### (MIT OR CC0-1.0)

| Package     | Versions | Runtime set |
| ----------- | -------- | ----------- |
| `type-fest` | 5.10.0   | yes         |

### 0BSD

| Package | Versions | Runtime set |
| ------- | -------- | ----------- |
| `tslib` | 2.8.1    | yes         |

### BlueOak-1.0.0

| Package     | Versions | Runtime set |
| ----------- | -------- | ----------- |
| `minimatch` | 10.2.6   | no          |

### CC-BY-4.0

| Package        | Versions     | Runtime set |
| -------------- | ------------ | ----------- |
| `caniuse-lite` | 1.0.30001816 | yes         |

### LGPL-3.0-or-later

| Package                           | Versions | Runtime set |
| --------------------------------- | -------- | ----------- |
| `@img/sharp-libvips-darwin-arm64` | 1.3.4    | no          |

### Unlicense

| Package       | Versions | Runtime set |
| ------------- | -------- | ----------- |
| `fast-sha256` | 1.3.0    | yes         |
