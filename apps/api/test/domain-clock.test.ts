// D9 business clock. Runs against a disposable database; the shared
// development database's clock row is never advanced.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { systemClock } from "@supplier-disruption/config";
import { BusinessClockError, PGBOSS_SCHEMA, createControlledClock } from "@supplier-disruption/db";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { composeBusinessClock } from "../src/clock.js";
import {
  COMPOSE_TIMEOUT_MS,
  DisposableDatabase,
  MARGIN_MS,
  NODE_TIMEOUT_MS,
  START_TIMEOUT_MS,
} from "./disposable.js";
import { APP_ORIGIN, REPO_ROOT, SECRETS, credentials, secret, signIn } from "./support.js";

const run = promisify(execFile);
const db = new DisposableDatabase("clock");
let advancer: pg.Client;
let observer: pg.Client;

beforeAll(
  async () => {
    await db.start();
    expect((await db.migrate()).code).toBe(0);
    expect((await db.seed()).code).toBe(0);
    // Advances use one migrator connection; confirmations use another.
    advancer = await db.client("migrator", "d9-advance");
    observer = await db.client("migrator", "d9-observer");
  },
  START_TIMEOUT_MS + 2 * NODE_TIMEOUT_MS,
);

afterAll(async () => {
  await db.remove();
  expect(await db.leftovers()).toBe("");
}, COMPOSE_TIMEOUT_MS + MARGIN_MS);

async function advance(instant: string): Promise<void> {
  const { rowCount } = await advancer.query(
    "UPDATE fixture_reference.business_clock SET instant = $1 WHERE id = 1",
    [instant],
  );
  expect(rowCount).toBe(1);
}

/** The row as an independent connection sees it: Copenhagen wall time and equality with the instant. */
async function observed(instant: string): Promise<{ wall: string; equal: boolean }> {
  const { rows } = await observer.query<{ wall: string; equal: boolean }>(
    `SELECT to_char(instant AT TIME ZONE 'Europe/Copenhagen', 'YYYY-MM-DD HH24:MI') AS wall,
            instant = $1::timestamptz AS equal
       FROM fixture_reference.business_clock`,
    [instant],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

// [instant written by the test, Copenhagen wall time, what Clock.now() returns]
const STEPS = [
  ["2026-10-21T09:00:00+02:00", "2026-10-21 09:00", "2026-10-21T07:00:00.000Z"],
  ["2026-10-21T10:00:00+02:00", "2026-10-21 10:00", "2026-10-21T08:00:00.000Z"],
  ["2026-10-21T13:59:00+02:00", "2026-10-21 13:59", "2026-10-21T11:59:00.000Z"],
  ["2026-10-21T14:00:00+02:00", "2026-10-21 14:00", "2026-10-21T12:00:00.000Z"],
  ["2026-10-21T18:00:00+02:00", "2026-10-21 18:00", "2026-10-21T16:00:00.000Z"],
] as const;

describe("D9 controlled business clock", () => {
  it("two controlled clocks on one database read the seeded instant, then every direct advance", async () => {
    const library = createControlledClock(db.pool("api", "d9-clock-a"));
    const composed = composeBusinessClock("controlled", db.pool("api", "d9-clock-b"));

    for (const [index, [instant, wall, returned]] of STEPS.entries()) {
      // The first step is the seeded start; every later one is a direct advance.
      if (index > 0) await advance(instant);
      expect(await observed(instant)).toEqual({ wall, equal: true });
      for (const clock of [library, composed]) {
        const now = await clock.now();
        expect(now).toBe(returned);
        expect(Date.parse(now)).toBe(Date.parse(instant));
        // Read again without an advance: still the row, never a cached or sampled value.
        expect(await clock.now()).toBe(returned);
      }
    }
  });

  it("a recreated API clock composition and app keep the advanced instant", async () => {
    expect((await observed("2026-10-21T18:00:00+02:00")).equal).toBe(true);
    const pool = db.pool("api", "d9-recreated");
    const clock = composeBusinessClock("controlled", pool);
    expect(await clock.now()).toBe("2026-10-21T16:00:00.000Z");

    const app = buildApp({
      db: drizzle(pool),
      sourcePool: pool,
      auth: createAuth(drizzle(pool), {
        appOrigin: APP_ORIGIN,
        secret: secret("better_auth_secret"),
        production: false,
        allowSignUp: false,
      }),
      boss: new PgBoss({ connectionString: db.url("api"), schema: PGBOSS_SCHEMA }),
      appOrigin: APP_ORIGIN,
      workerServiceToken: secret("worker_service_token"),
      health: { pool, bootId: undefined, queueStarted: () => false },
      logger: false,
      clock,
    });
    expect(app.businessClock).toBe(clock);
    expect(await app.businessClock.now()).toBe("2026-10-21T16:00:00.000Z");
  });

  it("an app built without a clock uses the system clock", () => {
    const pool = db.pool("api", "d9-default");
    const app = buildApp({
      db: drizzle(pool),
      sourcePool: pool,
      auth: createAuth(drizzle(pool), {
        appOrigin: APP_ORIGIN,
        secret: secret("better_auth_secret"),
        production: false,
        allowSignUp: false,
      }),
      boss: new PgBoss({ connectionString: db.url("api"), schema: PGBOSS_SCHEMA }),
      appOrigin: APP_ORIGIN,
      workerServiceToken: secret("worker_service_token"),
      health: { pool, bootId: undefined, queueStarted: () => false },
      logger: false,
    });
    expect(app.businessClock).toBe(systemClock);
    expect(composeBusinessClock("system", pool)).toBe(systemClock);
  });

  it("system samples stay within real-time brackets while the controlled row is ahead", async () => {
    const clock = composeBusinessClock("system", db.pool("api", "d9-system"));
    for (let i = 0; i < 3; i += 1) {
      const before = Date.now();
      const now = await clock.now();
      const after = Date.now();
      expect(Date.parse(now)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(now)).toBeLessThanOrEqual(after);
      expect(now).not.toBe("2026-10-21T16:00:00.000Z");
    }
  });

  it("fails explicitly when the row is missing or unusable, never falling back to wall time", async () => {
    const clock = composeBusinessClock("controlled", db.pool("api", "d9-missing"));
    try {
      await advancer.query("DELETE FROM fixture_reference.business_clock");
      await expect(clock.now()).rejects.toThrow(
        new BusinessClockError("the controlled business clock row is missing"),
      );
      await advancer.query(
        "INSERT INTO fixture_reference.business_clock (id, instant) VALUES (1, 'infinity')",
      );
      await expect(clock.now()).rejects.toThrow(
        new BusinessClockError("the controlled business clock row holds no usable instant"),
      );
    } finally {
      await advancer.query("DELETE FROM fixture_reference.business_clock");
      await advancer.query(
        "INSERT INTO fixture_reference.business_clock (id, instant) VALUES (1, $1)",
        ["2026-10-21T18:00:00+02:00"],
      );
    }
    expect(await clock.now()).toBe("2026-10-21T16:00:00.000Z");
  });

  it(
    "the built API refuses controlled mode outside NODE_ENV=test",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "sd-d9-"));
      const bootIdFile = join(dir, "boot-id");
      writeFileSync(bootIdFile, "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f\n");
      const env = {
        PATH: process.env.PATH,
        APP_ID: "supplier-disruption",
        APP_ORIGIN,
        DATABASE_URL_API: db.url("api"),
        BETTER_AUTH_SECRET_FILE: `${SECRETS}/better_auth_secret`,
        WORKER_SERVICE_TOKEN_FILE: `${SECRETS}/worker_service_token`,
        BOOT_ID_FILE: bootIdFile,
        API_PORT: "1",
        DOMAIN_CLOCK_MODE: "controlled",
      };
      for (const nodeEnv of ["production", "development"]) {
        const failure = await run("node", ["apps/api/dist/main.js"], {
          cwd: REPO_ROOT,
          env: { ...env, NODE_ENV: nodeEnv },
          timeout: NODE_TIMEOUT_MS,
        }).then(
          () => null,
          (error: unknown) => error as { code?: number; stderr?: string },
        );
        expect(failure?.code).toBe(1);
        expect(failure?.stderr).toContain(
          "DOMAIN_CLOCK_MODE=controlled is only accepted with NODE_ENV=test and DATA_MODE=fixture",
        );
      }
    },
    2 * NODE_TIMEOUT_MS + MARGIN_MS,
  );
});

describe("D9 operational time stays real", () => {
  it("timers, Date and session records keep real time while business time is ahead", async () => {
    const pool = db.pool("api", "d9-operational");
    const clock = composeBusinessClock("controlled", pool);
    expect(await clock.now()).toBe("2026-10-21T16:00:00.000Z");

    // A real timer still elapses in real time, and Date matches the database's real clock.
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(99);
    expect(elapsed).toBeLessThan(2_000);
    const { rows } = await observer.query<{ now: Date }>("SELECT now() AS now");
    expect(Math.abs(rows[0]!.now.getTime() - Date.now())).toBeLessThan(5_000);

    // A sign-in through the app composed with the controlled clock stamps its
    // session with real time, not business time.
    const boss = new PgBoss({ connectionString: db.url("api"), schema: PGBOSS_SCHEMA });
    const app = buildApp({
      db: drizzle(pool),
      sourcePool: pool,
      auth: createAuth(drizzle(pool), {
        appOrigin: APP_ORIGIN,
        secret: secret("better_auth_secret"),
        production: false,
        allowSignUp: false,
      }),
      boss,
      appOrigin: APP_ORIGIN,
      workerServiceToken: secret("worker_service_token"),
      health: { pool, bootId: undefined, queueStarted: () => false },
      logger: false,
      clock,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const { port } = app.server.address() as AddressInfo;
      const before = Date.now();
      await signIn(`http://127.0.0.1:${port}`, credentials.buyer());
      const after = Date.now();
      const sessions = await observer.query<{ created_at: Date; expires_at: Date }>(
        `SELECT s.created_at, s.expires_at FROM auth.session s
           JOIN auth."user" u ON u.id = s.user_id WHERE u.email = 'buyer@fixture.local'`,
      );
      expect(sessions.rows).toHaveLength(1);
      const session = sessions.rows[0]!;
      expect(session.created_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(session.created_at.getTime()).toBeLessThanOrEqual(after + 1_000);
      expect(session.expires_at.getTime()).toBeGreaterThan(after);
    } finally {
      await app.close();
    }
  });
});
