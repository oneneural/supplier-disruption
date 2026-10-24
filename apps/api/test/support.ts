import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PILOT_CONTRACT_VERSION } from "@supplier-disruption/contracts";
import { PGBOSS_SCHEMA, PILOT_QUEUE } from "@supplier-disruption/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { buildApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { FIXTURE_ORGANIZATION, type FixtureOrganization } from "../src/fixtures.js";
import { provisionFixtures } from "../src/provision.js";
import type { PilotFaultHooks } from "../src/routes/pilot.js";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SECRETS = `${REPO_ROOT}.secrets`;
export const APP_ORIGIN = "http://127.0.0.1:3102";
export const ORG_A = FIXTURE_ORGANIZATION;

export function secret(relative: string): string {
  try {
    return readFileSync(`${SECRETS}/${relative}`, "utf8").trim();
  } catch {
    throw new Error(`Missing .secrets/${relative}. Run: sh scripts/init-secrets.sh`);
  }
}

/** A second synthetic organization used only by tests. */
export const ORG_B: FixtureOrganization = {
  id: "3f2b8c1e-6d4a-4f7b-9e2c-1a5d8b7c6e40",
  slug: "test-organization-b",
  name: "Test Organization B (synthetic)",
};
export const MANAGER_B_EMAIL = "manager-b@fixture.local";

/** Deterministic per checkout, derived from a local secret, so reruns can sign in. */
export function managerBPassword(): string {
  return createHash("sha256")
    .update(`org-b:${secret("fixture_manager_password")}`)
    .digest("hex");
}

export const credentials = {
  manager: () => ({ email: "manager@fixture.local", password: secret("fixture_manager_password") }),
  buyer: () => ({ email: "buyer@fixture.local", password: secret("fixture_buyer_password") }),
  managerB: () => ({ email: MANAGER_B_EMAIL, password: managerBPassword() }),
};

export interface TestApi {
  baseUrl: string;
  close(): Promise<void>;
}

/** Starts the real Fastify app in-process on an ephemeral loopback port. */
export async function startTestApi(
  faults?: PilotFaultHooks,
  options: { appOrigin?: string; bootId?: string; logs?: LogCapture; production?: boolean } = {},
): Promise<TestApi> {
  const appOrigin = options.appOrigin ?? APP_ORIGIN;
  const databaseUrl = secret("host/database_url_api");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 20,
    application_name: "test-api",
  });
  const db = drizzle(pool);
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: PGBOSS_SCHEMA,
    max: 10,
    migrate: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  await boss.start();
  const app = buildApp({
    db,
    sourcePool: pool,
    auth: createAuth(db, {
      appOrigin,
      secret: secret("better_auth_secret"),
      // Production turns on the sign-in rate limits (ADR 0020).
      production: options.production ?? false,
      allowSignUp: false,
    }),
    boss,
    appOrigin,
    workerServiceToken: secret("worker_service_token"),
    logger: options.logs === undefined ? false : { level: "info", stream: options.logs.stream },
    health: { pool, bootId: options.bootId, queueStarted: () => true },
    ...(faults === undefined ? {} : { faults }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await app.close();
      await boss.stop({ graceful: false });
      await pool.end();
    },
  };
}

/** Collects the API's JSON log lines in memory. */
export class LogCapture {
  readonly lines: Array<Record<string, unknown>> = [];
  private partial = "";
  readonly stream = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      this.partial += chunk.toString("utf8");
      let newline;
      while ((newline = this.partial.indexOf("\n")) >= 0) {
        this.lines.push(JSON.parse(this.partial.slice(0, newline)) as Record<string, unknown>);
        this.partial = this.partial.slice(newline + 1);
      }
      done();
    },
  });

  matching(msg: string, fields: Record<string, unknown> = {}) {
    return this.lines.filter(
      (line) =>
        line.msg === msg && Object.entries(fields).every(([key, value]) => line[key] === value),
    );
  }
}

/** One parsed server-sent event and the client clock when its bytes arrived. */
export interface ReceivedEvent {
  /** The SSE `id:` field, when the event has one. */
  id?: string;
  event: string;
  data: unknown;
  arrivedAt: number;
}

/**
 * Reads server-sent events from a fetch response as they arrive. `onEvent`
 * may return true to stop reading and cancel the response.
 */
export async function readEvents(
  response: Response,
  onEvent: (event: ReceivedEvent, all: ReceivedEvent[]) => boolean | void = () => undefined,
): Promise<{ events: ReceivedEvent[]; endedAt: number; cancelled: boolean }> {
  const events: ReceivedEvent[] = [];
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    const now = Date.now();
    if (done) return { events, endedAt: now, cancelled: false };
    buffer += value;
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const fields = Object.fromEntries(
        block.split("\n").map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
        }),
      );
      const received: ReceivedEvent = {
        ...(fields.id === undefined ? {} : { id: fields.id }),
        event: fields.event ?? "message",
        data: JSON.parse(fields.data ?? "null") as unknown,
        arrivedAt: now,
      };
      events.push(received);
      if (onEvent(received, events) === true) {
        await reader.cancel();
        return { events, endedAt: Date.now(), cancelled: true };
      }
    }
  }
}

/** Creates organization B and its manager if absent (test-only fixture). */
export async function provisionOrganizationB(): Promise<void> {
  const pool = new pg.Pool({ connectionString: secret("host/database_url_migrator"), max: 2 });
  try {
    const db = drizzle(pool);
    const auth = createAuth(db, {
      appOrigin: APP_ORIGIN,
      secret: secret("better_auth_secret"),
      production: false,
      allowSignUp: true,
    });
    await provisionFixtures(db, auth, ORG_B, [
      {
        email: MANAGER_B_EMAIL,
        name: "Test Manager B",
        password: managerBPassword(),
        role: "manager",
      },
    ]);
  } finally {
    await pool.end();
  }
}

/** Independent observation connection (migrator role), separate from the code under test. */
export class Observer {
  private readonly pool = new pg.Pool({
    connectionString: secret("host/database_url_migrator"),
    max: 3,
    application_name: "test-observer",
  });

  async query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(text, values)).rows;
  }

  async operationRows(operationId: string) {
    return this.query<{
      organization_id: string;
      payload: unknown;
      payload_sha256: string;
      state: string;
      job_id: string | null;
      receipt_id: string | null;
    }>(
      `SELECT organization_id, payload, payload_sha256, state, job_id, receipt_id
         FROM app.pilot_operation WHERE operation_id = $1`,
      [operationId],
    );
  }

  async jobRows(operationId: string) {
    return this.query<{ id: string; state: string; retry_count: number }>(
      `SELECT id, state::text, retry_count FROM pgboss.job
        WHERE name = $1 AND (singleton_key = $2 OR data->>'operationId' = $2)`,
      [PILOT_QUEUE, operationId],
    );
  }

  async attemptRows(operationId: string) {
    return this.query<{ outcome: string; receipt_id: string }>(
      `SELECT outcome, receipt_id FROM app.pilot_receipt_attempt WHERE operation_id = $1 ORDER BY observed_at`,
      [operationId],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Signs in through /api/auth and returns the cookie header to send afterwards. */
export async function signIn(
  baseUrl: string,
  user: { email: string; password: string },
): Promise<{ cookie: string; setCookies: string[] }> {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify(user),
  });
  if (response.status !== 200) {
    throw new Error(`sign-in for ${user.email} returned ${response.status}`);
  }
  const setCookies = response.headers.getSetCookie();
  const cookie = setCookies.map((value) => value.split(";")[0]).join("; ");
  return { cookie, setCookies };
}

export function command(
  organizationId: string,
  overrides: Partial<{ operationId: string; note: string }> = {},
) {
  return {
    contractVersion: PILOT_CONTRACT_VERSION,
    operationId: overrides.operationId ?? randomUUID(),
    organizationId,
    payload: { note: overrides.note ?? "pilot" },
  };
}

export async function submit(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${baseUrl}/api/pilot/operations`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}
