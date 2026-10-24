import { randomUUID } from "node:crypto";
import { SCHEMA_TAG } from "@supplier-disruption/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiReadiness, currentBootHeartbeat } from "../src/health.js";
import { Observer, secret, startTestApi, type TestApi } from "./support.js";

let observer: Observer;
let apiPool: pg.Pool;
const pools: pg.Pool[] = [];

function pool(url: string): pg.Pool {
  const created = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2_000 });
  created.on("error", () => undefined);
  pools.push(created);
  return created;
}

beforeAll(() => {
  observer = new Observer();
  apiPool = pool(secret("host/database_url_api"));
});

afterAll(async () => {
  await Promise.all(pools.map((created) => created.end()));
  await observer?.close();
});

const queueStarted = () => true;

describe("API readiness", () => {
  it("is ready with the API role, the build's schema tag and a started queue", async () => {
    expect(await apiReadiness({ pool: apiPool, bootId: undefined, queueStarted })).toEqual({
      ready: true,
    });
  });

  it("is not ready before the queue producer starts", async () => {
    expect(
      await apiReadiness({ pool: apiPool, bootId: undefined, queueStarted: () => false }),
    ).toEqual({
      ready: false,
      reason: "queue_unavailable",
    });
  });

  it("is not ready when the recorded schema tag differs from the build's", async () => {
    try {
      await observer.query("UPDATE app.schema_tag SET tag = 'not-this-build'");
      expect(await apiReadiness({ pool: apiPool, bootId: undefined, queueStarted })).toEqual({
        ready: false,
        reason: "schema_incompatible",
      });
    } finally {
      await observer.query("UPDATE app.schema_tag SET tag = $1", [SCHEMA_TAG]);
    }
  });

  it("reports a schema it cannot read as missing", async () => {
    // The worker role has no access to app.schema_tag, like a database before migration.
    const workerPool = pool(secret("host/database_url_worker"));
    expect(await apiReadiness({ pool: workerPool, bootId: undefined, queueStarted })).toEqual({
      ready: false,
      reason: "schema_missing",
    });
  });

  it("reports an unreachable database", async () => {
    const closed = pool("postgres://nobody:nothing@127.0.0.1:1/none");
    expect(await apiReadiness({ pool: closed, bootId: undefined, queueStarted })).toEqual({
      ready: false,
      reason: "database_unreachable",
    });
  });
});

describe("current-boot worker heartbeat", () => {
  const heartbeat = (bootId: string | undefined) =>
    currentBootHeartbeat({ pool: apiPool, bootId, queueStarted });

  async function insertRow(bootId: string, ageSeconds: number): Promise<void> {
    await observer.query(
      `INSERT INTO worker.heartbeat (boot_id, build_revision, started_at, observed_at)
       VALUES ($1, 'health-test', now() - make_interval(secs => $2), now() - make_interval(secs => $2))`,
      [bootId, ageSeconds],
    );
  }

  it("needs a configured boot ID", async () => {
    expect(await heartbeat(undefined)).toEqual({ fresh: false, reason: "boot_id_unconfigured" });
  });

  it("ignores fresh rows from other boots", async () => {
    await insertRow(randomUUID(), 0);
    expect(await heartbeat(randomUUID())).toEqual({ fresh: false, reason: "no_current_boot_row" });
  });

  it("is fresh below the bound and stale above it, by the database clock", async () => {
    const fresh = randomUUID();
    const stale = randomUUID();
    await insertRow(fresh, 1);
    await insertRow(stale, 11);
    expect(await heartbeat(fresh)).toMatchObject({ fresh: true });
    expect(await heartbeat(stale)).toMatchObject({ fresh: false, reason: "stale" });
  });
});

describe("health routes", () => {
  let api: TestApi;
  const bootId = randomUUID();

  beforeAll(async () => {
    api = await startTestApi(undefined, { bootId });
  });

  afterAll(async () => {
    await api?.close();
  });

  it("answers readiness and the worker heartbeat with status codes and reasons only", async () => {
    const ready = await fetch(`${api.baseUrl}/internal/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });

    const missing = await fetch(`${api.baseUrl}/internal/health/worker`);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ fresh: false, reason: "no_current_boot_row" });

    await observer.query(
      `INSERT INTO worker.heartbeat (boot_id, build_revision) VALUES ($1, 'health-test')`,
      [bootId],
    );
    const fresh = await fetch(`${api.baseUrl}/internal/health/worker`);
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ fresh: true });
  });
});
