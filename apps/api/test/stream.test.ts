import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { PILOT_STREAM_MAX_MS, pilotStreamEventSchema } from "@supplier-disruption/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  LogCapture,
  ORG_A,
  ORG_B,
  command,
  credentials,
  provisionOrganizationB,
  readEvents,
  signIn,
  startTestApi,
  submit,
  type TestApi,
} from "./support.js";

let api: TestApi;
let logs: LogCapture;
let manager: string;
let buyer: string;
let managerB: string;
let operationId: string;

const eventsUrl = (id: string) => `${api.baseUrl}/api/pilot/operations/${id}/events`;

async function openStreams(base = api.baseUrl): Promise<number> {
  const response = await fetch(`${base}/internal/health/streams`);
  return ((await response.json()) as { openPilotStreams: number }).openPilotStreams;
}

beforeAll(async () => {
  await provisionOrganizationB();
  logs = new LogCapture();
  api = await startTestApi(undefined, { logs });
  manager = (await signIn(api.baseUrl, credentials.manager())).cookie;
  buyer = (await signIn(api.baseUrl, credentials.buyer())).cookie;
  managerB = (await signIn(api.baseUrl, credentials.managerB())).cookie;
  const body = command(ORG_A.id, { note: "stream" });
  expect((await submit(api.baseUrl, body, { cookie: manager })).status).toBe(202);
  operationId = body.operationId;
});

afterAll(async () => {
  await api?.close();
});

describe("pilot stream authorization", () => {
  it("rejects an anonymous or tampered session with 401", async () => {
    for (const cookie of [undefined, manager.replace(/=([^;]{4})/, "=xxxx")]) {
      const response = await fetch(eventsUrl(operationId), {
        headers: cookie === undefined ? {} : { cookie },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
    }
  });

  it("answers a non-member exactly like a missing operation", async () => {
    const other = await fetch(eventsUrl(operationId), { headers: { cookie: managerB } });
    const missing = await fetch(eventsUrl(randomUUID()), { headers: { cookie: manager } });
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.text()).toBe(await missing.text());
    expect(other.headers.get("content-type")).toBe(missing.headers.get("content-type"));
  });

  it("rejects a malformed ID with 400", async () => {
    const response = await fetch(eventsUrl("not-a-uuid"), { headers: { cookie: manager } });
    expect(response.status).toBe(400);
  });

  it("lets any member read the stream, including a buyer", async () => {
    const response = await fetch(eventsUrl(operationId), { headers: { cookie: buyer } });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("keeps organization B's manager out of organization A only", async () => {
    const body = command(ORG_B.id);
    expect((await submit(api.baseUrl, body, { cookie: managerB })).status).toBe(202);
    const own = await fetch(eventsUrl(body.operationId), { headers: { cookie: managerB } });
    expect(own.status).toBe(200);
    await own.body?.cancel();
    const cross = await fetch(eventsUrl(body.operationId), { headers: { cookie: manager } });
    expect(cross.status).toBe(404);
  });
});

describe("pilot stream timing and content", () => {
  it("sends five separately timed events with only the operation ID and state, then ends", async () => {
    const requested = Date.now();
    const response = await fetch(eventsUrl(operationId), { headers: { cookie: manager } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("content-encoding")).toBeNull();
    const { events, endedAt } = await readEvents(response);

    expect(events.map((event) => event.event)).toEqual(Array(5).fill("status"));
    const parsed = events.map((event) => pilotStreamEventSchema.parse(event.data));
    expect(parsed.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.map((event) => event.final)).toEqual([false, false, false, false, true]);
    expect(new Set(parsed.map((event) => event.operationId))).toEqual(new Set([operationId]));

    const first = events[0]!.arrivedAt;
    expect(first - requested).toBeLessThan(1_000);
    events.forEach((event, index) => {
      expect(event.arrivedAt - first).toBeGreaterThanOrEqual(800 * index);
      expect(event.arrivedAt - Date.parse(parsed[index]!.emittedAt)).toBeLessThan(500);
    });
    expect(endedAt - requested).toBeLessThan(10_000);
    expect(logs.matching("pilot stream closed", { operationId }).at(-1)).toMatchObject({
      reason: "completed",
      events: 5,
    });
  });
});

describe("pilot stream cleanup", () => {
  it("stops producing and unregisters a stream whose client disconnects after event 2", async () => {
    const created = command(ORG_A.id);
    expect((await submit(api.baseUrl, created, { cookie: manager })).status).toBe(202);
    const id = created.operationId;
    const before = await openStreams();
    const controller = new AbortController();
    const response = await fetch(eventsUrl(id), {
      headers: { cookie: manager },
      signal: controller.signal,
    });
    let duringCount = -1;
    const { events } = await readEvents(response, (_event, all) => {
      if (all.length === 1) void openStreams().then((count) => (duringCount = count));
      return all.length === 2;
    });
    controller.abort();
    const disconnectedAt = Date.now();
    expect(events).toHaveLength(2);
    expect(duringCount).toBe(before + 1);

    while ((await openStreams()) !== before) {
      expect(Date.now() - disconnectedAt).toBeLessThan(2_000);
      await delay(50);
    }
    // Long enough for events 3 and 4 to have been produced had the stream continued.
    await delay(2_500);
    const produced = logs.matching("pilot stream event", { operationId: id });
    expect(produced.map((line) => line.seq)).toEqual([1, 2]);
    expect(logs.matching("pilot stream closed", { operationId: id })).toMatchObject([
      { reason: "client_disconnect", events: 2 },
    ]);
    // The aborted stream request is recorded with its route although it never finished.
    expect(logs.matching("request")).toContainEqual(
      expect.objectContaining({
        route: "/api/pilot/operations/:id/events",
        target: `/api/pilot/operations/${id}/events`,
      }),
    );
  });

  it("ends open streams when the server closes, without waiting for them", async () => {
    const own = new LogCapture();
    const second = await startTestApi(undefined, { logs: own });
    let closed = false;
    try {
      const cookie = (await signIn(second.baseUrl, credentials.manager())).cookie;
      const response = await fetch(`${second.baseUrl}/api/pilot/operations/${operationId}/events`, {
        headers: { cookie },
      });
      const reading = readEvents(response);
      await delay(300);
      expect(await openStreams(second.baseUrl)).toBe(1);
      const closing = Date.now();
      await second.close();
      closed = true;
      const { events, endedAt } = await reading;
      expect(Date.now() - closing).toBeLessThan(2_000);
      expect(events.length).toBeLessThan(5);
      expect(endedAt - closing).toBeLessThan(2_000);
      expect(own.matching("pilot stream closed", { operationId }).at(-1)).toMatchObject({
        reason: "shutdown",
      });
    } finally {
      if (!closed) await second.close();
    }
  });
});

describe("pilot stream bounds", () => {
  it("caps a stream at least 2 s before s6 would kill the draining web server", () => {
    const webKill = new URL(
      "../../../infra/app/rootfs/etc/s6-overlay/s6-rc.d/web/timeout-kill",
      import.meta.url,
    );
    const webKillMs = Number(readFileSync(webKill, "utf8").trim());
    expect(webKillMs).toBe(10_000);
    expect(PILOT_STREAM_MAX_MS).toBeLessThanOrEqual(webKillMs - 2_000);
  });

  it("has no HEAD route, so a HEAD request opens no stream", async () => {
    const before = await openStreams();
    const response = await fetch(eventsUrl(operationId), {
      method: "HEAD",
      headers: { cookie: manager },
    });
    expect(response.status).toBe(404);
    expect(await openStreams()).toBe(before);
    await delay(1_500);
    expect(
      logs.matching("request", { method: "HEAD" }).map((line) => [line.route, line.target]),
    ).toEqual([["none", `/api/pilot/operations/${operationId}/events`]]);
    expect(await openStreams()).toBe(before);
  });

  it("closes a stalled stream at the cap and unregisters it", async () => {
    const own = new LogCapture();
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => (release = resolve));
    const second = await startTestApi(
      // Event 2 waits for its state read until the test releases it.
      { beforeStreamEvent: async (_id, seq) => (seq === 2 ? stalled : undefined) },
      { logs: own },
    );
    try {
      const cookie = (await signIn(second.baseUrl, credentials.manager())).cookie;
      const requested = Date.now();
      const response = await fetch(`${second.baseUrl}/api/pilot/operations/${operationId}/events`, {
        headers: { cookie },
      });
      const { events, endedAt } = await readEvents(response);
      expect(events).toHaveLength(1);
      expect(endedAt - requested).toBeGreaterThanOrEqual(PILOT_STREAM_MAX_MS - 100);
      expect(endedAt - requested).toBeLessThan(PILOT_STREAM_MAX_MS + 1_000);
      expect(await openStreams(second.baseUrl)).toBe(0);
      release();
      await delay(100);
      expect(own.matching("pilot stream event", { operationId }).map((l) => l.seq)).toEqual([1]);
      expect(own.matching("pilot stream closed", { operationId })).toMatchObject([
        { reason: "max_duration", events: 1 },
      ]);
    } finally {
      release();
      await second.close();
    }
  });
});

describe("response cache policy", () => {
  it("sends no-store on every response except event streams, whatever a handler set", async () => {
    const app = buildApp({
      db: {} as never,
      sourcePool: {} as never,
      auth: {} as never,
      boss: {} as never,
      appOrigin: "http://127.0.0.1:3102",
      workerServiceToken: "unused",
      health: {} as never,
      logger: false,
    });
    app.get("/test/cacheable", (_request, reply) =>
      reply.header("cache-control", "public, max-age=600").send({ ok: true }),
    );
    app.get("/test/stream", (_request, reply) =>
      reply
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache, no-transform")
        .send("data: x\n\n"),
    );
    try {
      const cacheable = await app.inject({ url: "/test/cacheable" });
      expect(cacheable.headers["cache-control"]).toBe("no-store");
      const stream = await app.inject({ url: "/test/stream" });
      expect(stream.headers["cache-control"]).toBe("no-cache, no-transform");
      const missing = await app.inject({ url: "/test/missing" });
      expect(missing.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});

describe("request route logging", () => {
  it("records the matched route pattern, or none, with the raw request target", async () => {
    await fetch(`${api.baseUrl}/api/pilot/operations/${operationId}`, {
      headers: { cookie: manager },
    });
    // node:http sends the path as given; fetch would resolve the %2e%2e segment first.
    const raw = "/api/%2e%2e/internal/pilot/operations/x/receipt";
    const status = await new Promise<number | undefined>((resolve, reject) => {
      request(`${api.baseUrl}`, { method: "POST", path: raw }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on("error", reject)
        .end();
    });
    expect(status).toBe(404);
    await delay(50);

    const lines = logs.matching("request");
    expect(lines).toContainEqual(
      expect.objectContaining({
        route: "/api/pilot/operations/:id",
        target: `/api/pilot/operations/${operationId}`,
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ route: "none", method: "POST", target: raw }),
    );
  });
});
