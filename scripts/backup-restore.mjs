#!/usr/bin/env node
// Logical backup and restore of one Compose project's PostgreSQL database
// (docs/operations/backup-restore.md, ADR 0021).
//
//   corepack pnpm db:backup  -- --output <new directory outside the checkout> [--project <name>]
//   corepack pnpm db:restore -- --input <backup directory> --project <name>
//
// Backup exports one REPEATABLE READ snapshot, runs pg_dump on it and computes
// the manifest's per-table digests, evidence-hash check and foreign-key count
// in the same transaction, so the manifest describes exactly the dump.
// Restore refuses a target database that already holds any table, loads the
// dump in one transaction and compares the restored digests with the manifest.
// Both run pg_dump and pg_restore inside the project's own db container, as
// its PostgreSQL superuser, so no host client or database port is needed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE = "supplier_disruption";
const DUMP = "database.dump";
const MANIFEST = "manifest.json";
export const FORMAT = "supplier-disruption-backup.v1";
/** Login roles the target's own initdb creates from its secrets (infra/postgres/initdb). */
const ROLES = ["sd_migrator", "sd_api", "sd_worker"];

const USAGE = `usage:
  backup-restore.mjs backup  --output <new directory> [--project supplier-disruption]
  backup-restore.mjs restore --input <backup directory> --project <name>`;

/** Parses `command --flag value ...`; throws on anything unexpected. */
export function parseArgs(argv) {
  const [command, ...rest] = argv.filter((arg) => arg !== "--");
  if (command !== "backup" && command !== "restore") throw new Error(USAGE);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!["--output", "--input", "--project"].includes(flag) || value === undefined) {
      throw new Error(`unexpected argument ${flag}\n${USAGE}`);
    }
    options[flag.slice(2)] = value;
  }
  if (command === "backup") {
    if (options.output === undefined || options.input !== undefined) throw new Error(USAGE);
    return { command, project: options.project ?? "supplier-disruption", output: options.output };
  }
  // A restore names its target explicitly; there is no default project to overwrite.
  if (options.input === undefined || options.project === undefined || options.output !== undefined)
    throw new Error(USAGE);
  return { command, project: options.project, input: options.input };
}

/**
 * The real path of `path`, resolving symlinks through its nearest existing
 * ancestor, so a path that does not exist yet compares like one that does.
 */
function realPathOrNearest(path) {
  const missing = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** True when path is root or lies under it, compared as real paths. */
export function isInside(path, root) {
  const rel = relative(realPathOrNearest(root), realPathOrNearest(path));
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Differences between the manifest's database description and the restored
 * one: tables missing, extra or with other row counts or digests, evidence
 * whose bytes no longer match their stored SHA-256, and foreign keys.
 * @returns {string[]} empty when they match
 */
export function compareState(expected, actual) {
  const problems = [];
  const names = new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)]);
  for (const name of [...names].sort()) {
    const want = expected.tables[name];
    const got = actual.tables[name];
    if (want === undefined) problems.push(`unexpected table ${name}`);
    else if (got === undefined) problems.push(`missing table ${name}`);
    else if (want.rows !== got.rows || want.digest !== got.digest)
      problems.push(
        `table ${name}: rows ${want.rows} -> ${got.rows}, digest ${want.digest} -> ${got.digest}`,
      );
  }
  if (actual.evidence.mismatched !== 0)
    problems.push(`${actual.evidence.mismatched} message(s) no longer match their SHA-256`);
  if (actual.evidence.messages !== expected.evidence.messages)
    problems.push(`messages ${expected.evidence.messages} -> ${actual.evidence.messages}`);
  if (actual.foreignKeys.total !== expected.foreignKeys.total)
    problems.push(`foreign keys ${expected.foreignKeys.total} -> ${actual.foreignKeys.total}`);
  if (actual.foreignKeys.unvalidated !== 0)
    problems.push(`${actual.foreignKeys.unvalidated} foreign key(s) not validated`);
  return problems;
}

/** Runs a command and resolves with its output; rejects on a nonzero exit. */
function exec(command, args, { input } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(stdout)
        : reject(new Error(`${command} ${args[0]} exited ${code}: ${stderr.trim()}`)),
    );
    child.stdin.end(input);
  });
}

/** The running db container of a Compose project, found by its labels. */
async function dbContainer(project) {
  const ids = (
    await exec("docker", [
      "ps",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      "label=com.docker.compose.service=db",
      "--format",
      "{{.ID}}",
    ])
  )
    .split("\n")
    .filter(Boolean);
  if (ids.length !== 1)
    throw new Error(`expected one running db container in project ${project}, found ${ids.length}`);
  return ids[0];
}

const psqlArgs = (container) => [
  "exec",
  "-i",
  container,
  "psql",
  "--username",
  "postgres",
  "--dbname",
  DATABASE,
  "--no-psqlrc",
  "--tuples-only",
  "--no-align",
  "--quiet",
  "--set",
  "ON_ERROR_STOP=1",
];

/**
 * One psql session in the db container. `query` sends statements and returns
 * the output they printed, delimited by a marker line, so several queries can
 * run inside one transaction while other commands use its exported snapshot.
 */
class Session {
  constructor(container) {
    this.child = spawn("docker", psqlArgs(container), { stdio: ["pipe", "pipe", "pipe"] });
    this.buffer = "";
    this.errors = "";
    this.waiting = null;
    this.sequence = 0;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      this.waiting?.();
    });
    this.child.stderr.on("data", (chunk) => (this.errors += chunk));
    this.exited = new Promise((done) => this.child.once("close", done));
    this.exited.then(() => this.waiting?.());
  }

  async query(sql) {
    const marker = `__sd_backup_${(this.sequence += 1)}__`;
    // psql runs a backslash command at once but holds SQL until its semicolon,
    // so every statement is terminated before the marker.
    const statement = sql.trimEnd().endsWith(";") ? sql : `${sql};`;
    this.child.stdin.write(`${statement}\n\\echo ${marker}\n`);
    for (;;) {
      const at = this.buffer.indexOf(`${marker}\n`);
      if (at >= 0) {
        const output = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + marker.length + 1);
        return output.trim();
      }
      if (this.child.exitCode !== null)
        throw new Error(`psql ended: ${this.errors.trim() || this.child.exitCode}`);
      await new Promise((wake) => (this.waiting = wake));
      this.waiting = null;
    }
  }

  async close() {
    this.child.stdin.end();
    await this.exited;
  }
}

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Row count and an order-independent digest per table, the evidence-hash
 * check and the foreign-key state, read in the session's current snapshot.
 * Text output is fixed by the session settings, so equal data gives equal digests.
 */
async function describeDatabase(session) {
  await session.query("SET TimeZone = 'UTC'; SET extra_float_digits = 3; SET DateStyle = 'ISO';");
  const tables = (
    await session.query(
      `SELECT schemaname || '.' || tablename FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
    )
  )
    .split("\n")
    .filter(Boolean);
  const state = { tables: {}, evidence: { messages: 0, mismatched: 0 }, foreignKeys: {} };
  for (const name of tables) {
    const [schema, table] = name.split(".");
    const relation = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    const row = await session.query(
      `SELECT json_build_object('rows', count(*),
              'digest', md5(coalesce(string_agg(md5(t::text), '' ORDER BY md5(t::text)), '')))
         FROM ${relation} t`,
    );
    state.tables[name] = JSON.parse(row);
  }
  if (tables.includes("app.supplier_message")) {
    state.evidence = JSON.parse(
      await session.query(
        `SELECT json_build_object('messages', count(*),
                'mismatched', count(*) FILTER (WHERE encode(sha256(content), 'hex') <> content_sha256))
           FROM app.supplier_message`,
      ),
    );
  }
  state.foreignKeys = JSON.parse(
    await session.query(
      `SELECT json_build_object('total', count(*), 'unvalidated', count(*) FILTER (WHERE NOT convalidated))
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
    ),
  );
  return state;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function backup({ project, output }) {
  const target = resolve(output);
  // A backup holds password hashes, session tokens and evidence bytes.
  if (isInside(target, ROOT))
    throw new Error(`refusing to write a backup inside the checkout (${ROOT})`);
  if (existsSync(target)) throw new Error(`refusing to reuse existing path ${target}`);
  const container = await dbContainer(project);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const session = new Session(container);
  let complete = false;
  try {
    await session.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    const snapshot = await session.query("SELECT pg_export_snapshot();");
    const dumpPath = join(target, DUMP);
    const dump = spawn(
      "docker",
      [
        "exec",
        container,
        "pg_dump",
        "--username",
        "postgres",
        "--dbname",
        DATABASE,
        "--format",
        "custom",
        `--snapshot=${snapshot}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let dumpErrors = "";
    dump.stderr.on("data", (chunk) => (dumpErrors += chunk));
    const dumped = new Promise((done) => dump.once("close", done));
    await pipeline(dump.stdout, createWriteStream(dumpPath, { mode: 0o600 }));
    const code = await dumped;
    if (code !== 0) throw new Error(`pg_dump exited ${code}: ${dumpErrors.trim()}`);

    const state = await describeDatabase(session);
    const server = await session.query("SHOW server_version_num;");
    const schemaTag = state.tables["app.schema_tag"]
      ? await session.query("SELECT tag FROM app.schema_tag;")
      : null;
    await session.query("COMMIT;");
    const manifest = {
      format: FORMAT,
      project,
      createdAt: new Date().toISOString(),
      serverVersionNum: Number(server),
      schemaTag,
      dump: { file: DUMP, bytes: (await stat(dumpPath)).size, sha256: await sha256File(dumpPath) },
      ...state,
    };
    await writeFile(join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    complete = true;
    return manifest;
  } finally {
    await session.close();
    // A failed dump or manifest leaves no partial backup that could be mistaken for one.
    if (!complete) await rm(target, { recursive: true, force: true });
  }
}

export async function restore({ project, input }) {
  const source = resolve(input);
  const manifest = JSON.parse(await readFile(join(source, MANIFEST), "utf8"));
  if (manifest.format !== FORMAT) throw new Error(`unknown backup format ${manifest.format}`);
  const dumpPath = join(source, manifest.dump.file);
  const digest = await sha256File(dumpPath);
  if (digest !== manifest.dump.sha256)
    throw new Error(`dump SHA-256 ${digest} does not match the manifest ${manifest.dump.sha256}`);

  const container = await dbContainer(project);
  const session = new Session(container);
  try {
    // A fresh volume: initdb created the roles and an empty database. Anything
    // else, such as a populated development database, is never overwritten.
    const tables = Number(
      await session.query(
        "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');",
      ),
    );
    if (tables !== 0)
      throw new Error(`refusing to restore: project ${project} already has ${tables} table(s)`);
    const server = Number(await session.query("SHOW server_version_num;"));
    if (Math.floor(server / 10_000) !== Math.floor(manifest.serverVersionNum / 10_000))
      throw new Error(`PostgreSQL ${server} cannot take a dump from ${manifest.serverVersionNum}`);
    const roles = (
      await session.query(
        `SELECT rolname FROM pg_roles WHERE rolname IN (${ROLES.map((r) => `'${r}'`).join(", ")}) ORDER BY 1;`,
      )
    )
      .split("\n")
      .filter(Boolean);
    if (roles.join(",") !== [...ROLES].sort().join(","))
      throw new Error(`target is missing login roles: found ${roles.join(", ") || "none"}`);

    const load = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "pg_restore",
        "--username",
        "postgres",
        "--dbname",
        DATABASE,
        "--exit-on-error",
        "--single-transaction",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let loadErrors = "";
    load.stderr.on("data", (chunk) => (loadErrors += chunk));
    const loaded = new Promise((done) => load.once("close", done));
    await pipeline(createReadStream(dumpPath), load.stdin);
    const code = await loaded;
    if (code !== 0) throw new Error(`pg_restore exited ${code}: ${loadErrors.trim()}`);

    await session.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    const state = await describeDatabase(session);
    await session.query("COMMIT;");
    const problems = compareState(manifest, state);
    return { manifest, state, problems };
  } finally {
    await session.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "backup") {
    const manifest = await backup(options);
    process.stdout.write(
      `backup of ${manifest.project}: ${Object.keys(manifest.tables).length} tables, ` +
        `${manifest.evidence.messages} messages, dump ${manifest.dump.bytes} bytes ` +
        `sha256 ${manifest.dump.sha256}\nwritten to ${resolve(options.output)}\n`,
    );
    return;
  }
  const { manifest, problems } = await restore(options);
  if (problems.length > 0) {
    process.stderr.write(`restored database differs from the backup:\n${problems.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `restored ${Object.keys(manifest.tables).length} tables into ${options.project}; ` +
      `row counts, digests, ${manifest.evidence.messages} message hashes and ` +
      `${manifest.foreignKeys.total} foreign keys match the backup\n` +
      `next: docker compose -p ${options.project} run --rm init, then start the app\n`,
  );
}

// Compared as real paths: import.meta.url is resolved through symlinks (such
// as macOS /var -> /private/var) while argv[1] is not.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
