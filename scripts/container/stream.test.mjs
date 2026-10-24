// P5 SSE flushing, P6 stream authorization and cleanup, and P8 a
// graceful stop with a job in flight and a stream open, through the Next
// proxy on the published port of one disposable project. P9 closes
// an open stream on revocation and resumes one after Last-Event-ID (ADR 0020).
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SignInPacer,
  apiLogs,
  httpCall,
  managerSignIn,
  openStream,
  openStreamCount,
  pilotCommand,
  submitThroughProxy,
  waitForEvents,
} from "./gates.mjs";
import {
  FIXTURE_MANAGER_EMAIL,
  GATE_BOUNDS,
  Project,
  fields,
  must,
  record,
  waitFor,
} from "./support.mjs";

const project = new Project("stream");
const pacer = new SignInPacer();
const ESSENTIAL = ["api", "watchdog", "web", "worker"];
// Exit codes on SIGTERM (ADR 0002): the Next server exits 143, the others 0.
const STOP_EXIT = { api: "0", watchdog: "0", web: "143", worker: "0" };

let manager;

beforeAll(async () => {
  await project.start();
  manager = await managerSignIn(project, pacer);
  expect(manager.status).toBe(200);
});

afterAll(async () => {
  await project.remove();
});

const eventsPath = (id) => `/api/pilot/operations/${id}/events`;

async function newOperation(payload) {
  const result = await submitThroughProxy(project, manager.cookie, pilotCommand(payload));
  expect(result.status).toBe(202);
  return result.json.operationId;
}

/**
 * Host clock minus container clock, bracketed by the host time around a
 * docker exec; the narrowest of up to ten brackets, stopping early once one
 * is under 100 ms. P5 converts the container's emission times to host time
 * with the midpoint, so a skew in either direction neither hides a delay nor
 * fails an honest stream. Under host load a single docker exec can take
 * longer than the 250 ms guard; more samples narrow the measurement without
 * relaxing the guard.
 */
async function clockSkew() {
  let best;
  for (let sample = 0; sample < 10; sample += 1) {
    if (best !== undefined && best.highMs - best.lowMs < 100) break;
    const before = Date.now();
    const { stdout } = await must("docker", [
      "exec",
      project.app,
      "node",
      "-e",
      "console.log(Date.now())",
    ]);
    const after = Date.now();
    const container = Number(stdout.trim());
    const bracket = { lowMs: before - container, highMs: after - container };
    if (best === undefined || bracket.highMs - bracket.lowMs < best.highMs - best.lowMs) {
      best = bracket;
    }
  }
  return { ...best, midMs: Math.round((best.lowMs + best.highMs) / 2) };
}

describe("P5 SSE flushing", () => {
  it("delivers each event through the proxy as it is emitted, not at the end", async () => {
    const id = await newOperation({ note: "flushing" });
    const skew = await clockSkew();
    const stream = openStream(project.origin, eventsPath(id), manager.cookie);
    const response = await stream.response;
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers["content-encoding"]).toBeUndefined();
    const ended = await stream.ended;

    const { events } = stream;
    const first = events[0].arrivedAt;
    const timings = events.map((event) => ({
      seq: event.data.seq,
      sinceFirstMs: event.arrivedAt - first,
      // Emission in host time: container time plus the measured skew.
      afterEmissionMs: event.arrivedAt - (Date.parse(event.data.emittedAt) + skew.midMs),
    }));
    record(
      `P5 event arrivals (host minus container clock ${skew.lowMs} to ${skew.highMs} ms, midpoint ${skew.midMs} ms applied; ` +
        `first event ${first - stream.opened} ms after the request; stream ${ended.how} after ${ended.at - stream.opened} ms): ${JSON.stringify(timings)}`,
    );
    // The correction is only as good as the bracket around it.
    expect(skew.highMs - skew.lowMs).toBeLessThan(250);
    expect(events.map((event) => event.data.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(first - stream.opened).toBeLessThan(1_000);
    timings.forEach((timing, index) => {
      expect(timing.sinceFirstMs, `event ${timing.seq}`).toBeGreaterThanOrEqual(800 * index);
      expect(timing.afterEmissionMs, `event ${timing.seq}`).toBeLessThanOrEqual(500);
    });
    expect(ended.how).toBe("end");
    expect(ended.at - stream.opened).toBeLessThanOrEqual(10_000);
  });
});

describe("P6 SSE authorization and cleanup", () => {
  it("answers anonymous 401 and a non-member 404 indistinguishable from a missing ID", async () => {
    const id = await newOperation({ note: "authorization" });
    const anonymous = await httpCall(project.origin, { path: eventsPath(id) });
    expect(anonymous.status).toBe(401);
    expect(anonymous.json).toEqual({ error: "unauthenticated" });

    // An operation of an organization the manager does not belong to,
    // written by the observer as the superuser.
    const otherOrg = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await project.execSql(
      `INSERT INTO app.organization (id, slug, name) VALUES ('${otherOrg}', 'ct-other-${otherOrg.slice(0, 8)}', 'Other (synthetic)');
       INSERT INTO app.pilot_operation (operation_id, organization_id, submitted_by, contract_version, payload, payload_sha256)
         SELECT '${foreign}', '${otherOrg}', id, 'pilot-operation.v1', '{"note":"foreign"}', repeat('0', 64)
           FROM auth."user" WHERE email = '${FIXTURE_MANAGER_EMAIL}';`,
    );
    const nonMember = await httpCall(project.origin, {
      path: eventsPath(foreign),
      headers: { cookie: manager.cookie },
    });
    const missing = await httpCall(project.origin, {
      path: eventsPath(crypto.randomUUID()),
      headers: { cookie: manager.cookie },
    });
    expect(nonMember.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(nonMember.text).toBe(missing.text);
    expect(nonMember.headers["content-type"]).toBe(missing.headers["content-type"]);
  });

  it("releases a stream whose client disconnects after event 2 and produces no more events", async () => {
    const id = await newOperation({ note: "disconnect" });
    const before = await openStreamCount(project);
    const stream = openStream(project.origin, eventsPath(id), manager.cookie);
    await waitForEvents(stream, 1);
    const during = await openStreamCount(project);
    await waitForEvents(stream, 2);
    stream.abort();
    const disconnectedAt = Date.now();
    expect(during).toBe(before + 1);
    expect(stream.events).toHaveLength(2);

    await waitFor(
      "the open-stream count to return",
      async () => (await openStreamCount(project)) === before,
      {
        timeoutMs: 2_000,
        intervalMs: 50,
      },
    );
    const releasedMs = Date.now() - disconnectedAt;
    // Events 3 and 4 would have been produced in this time had the stream continued.
    await delay(3_000);
    const lines = (await apiLogs(project)).filter((line) => line.operationId === id);
    const produced = lines
      .filter((line) => line.msg === "pilot stream event")
      .map((line) => line.seq);
    const closed = lines.filter((line) => line.msg === "pilot stream closed");
    record(
      `P6 open streams ${before} -> ${during} -> ${before} within ${releasedMs} ms; produced ${JSON.stringify(produced)}; closed ${JSON.stringify(closed.map((l) => ({ reason: l.reason, events: l.events })))}`,
    );
    expect(produced).toEqual([1, 2]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ reason: "client_disconnect", events: 2 });
  });
});

describe("P9 revocation and resume through the proxy", () => {
  it("closes an open stream before its next event once its session is deleted", async () => {
    const own = await managerSignIn(project, pacer);
    expect(own.status).toBe(200);
    const token = decodeURIComponent(
      /supplier-disruption\.session_token=([^;]+)/.exec(own.cookie)[1],
    ).split(".")[0];
    const id = await newOperation({ note: "revocation" });
    const stream = openStream(project.origin, eventsPath(id), own.cookie);
    await waitForEvents(stream, 2);
    await project.execSql(`DELETE FROM auth.session WHERE token = '${token}'`);
    const revokedAt = Date.now();
    const ended = await stream.ended;
    const closed = await waitFor(
      "the close line",
      async () =>
        (await apiLogs(project)).find(
          (line) => line.operationId === id && line.msg === "pilot stream closed",
        ),
      { timeoutMs: 5_000, intervalMs: 100 },
    );
    record(
      `P9 revoked stream ${ended.how} ${ended.at - revokedAt} ms after the session was deleted, after ${stream.events.length} events; closed ${JSON.stringify({ reason: closed.reason, events: closed.events })}`,
    );
    expect(ended.how).toBe("end");
    expect(stream.events.map((event) => event.data.seq)).toEqual([1, 2]);
    expect(ended.at - revokedAt).toBeLessThan(2_000);
    expect(closed).toMatchObject({ reason: "revoked", events: 2 });
    const again = await httpCall(project.origin, {
      path: eventsPath(id),
      headers: { cookie: own.cookie, "last-event-id": `${id}:2` },
    });
    expect(again.status).toBe(401);
  });

  it("resumes after Last-Event-ID in order, ends with 204 and refuses another operation's ID", async () => {
    const id = await newOperation({ note: "resume" });
    const first = openStream(project.origin, eventsPath(id), manager.cookie);
    await waitForEvents(first, 2);
    first.abort();
    expect(first.events.map((event) => event.id)).toEqual([`${id}:1`, `${id}:2`]);

    const resumed = openStream(project.origin, eventsPath(id), manager.cookie, {
      headers: { "last-event-id": `${id}:2` },
    });
    expect((await resumed.ended).how).toBe("end");
    record(`P9 resumed events: ${JSON.stringify(resumed.events.map((event) => event.id))}`);
    expect(resumed.events.map((event) => event.data.seq)).toEqual([3, 4, 5]);
    expect(resumed.events.map((event) => event.id)).toEqual([`${id}:3`, `${id}:4`, `${id}:5`]);
    expect(resumed.events.at(-1).data.final).toBe(true);

    const done = await httpCall(project.origin, {
      path: eventsPath(id),
      headers: { cookie: manager.cookie, "last-event-id": `${id}:5` },
    });
    expect(done.status).toBe(204);
    const other = await newOperation({ note: "foreign id" });
    const foreign = await httpCall(project.origin, {
      path: eventsPath(id),
      headers: { cookie: manager.cookie, "last-event-id": `${other}:2` },
    });
    expect(foreign.status).toBe(400);
    expect(foreign.json).toEqual({ error: "invalid_request" });
  });
});

describe("P8 shutdown with an open stream", () => {
  it("drains a held job and ends an open stream from the server within the stop budget", async () => {
    const boot = await project.bootId();
    const id = await newOperation({ note: "stop with stream", holdMs: 8_000 });
    const started = `pilot handler started operation=${id} boot=${boot}`;
    await waitFor(
      "the handler start line",
      async () => (await project.logLines()).some((line) => line.text.includes(started)),
      { timeoutMs: 30_000, intervalMs: 100 },
    );
    const inFlight = await project.operation(id);
    expect(inFlight.attempts).toBeGreaterThanOrEqual(1);
    expect(inFlight.receipt_id).toBeNull();

    const stream = openStream(project.origin, eventsPath(id), manager.cookie, {
      timeoutMs: 40_000,
    });
    await waitForEvents(stream, 1);
    expect(await openStreamCount(project)).toBeGreaterThanOrEqual(1);
    const [{ now: stopRequested }] = await project.sql("SELECT now() AS now");

    const stopStart = Date.now();
    const stop = await project.mustCompose(["stop", "app"]);
    const ended = await stream.ended;
    record(
      `P8: docker compose stop app took ${stop.ms} ms (budget ${GATE_BOUNDS.stopMs} ms); stream ${ended.how} ` +
        `${ended.at - stopStart} ms after the stop began, after ${stream.events.length} events`,
    );
    expect(stop.ms).toBeLessThan(GATE_BOUNDS.stopMs);
    // The stream was open when the stop began, and the server side ended it
    // inside the stop: Next drains in-flight responses before it exits
    // (ADR 0003), so it may complete; it is never left to the client's timeout.
    expect(["end", "aborted"]).toContain(ended.how);
    expect(ended.at - stopStart).toBeLessThan(stop.ms);

    const info = await project.inspect();
    expect(info.State.Status).toBe("exited");
    expect(info.State.ExitCode).toBe(0);
    const segment = (await project.boots()).find((b) => b.bootId === boot);
    const texts = segment.lines.map((line) => line.text);
    const lifecycle = texts.filter((text) => text.startsWith("sd-lifecycle ")).map(fields);
    expect(lifecycle.map((entry) => entry.service).sort()).toEqual(ESSENTIAL);
    for (const entry of lifecycle) {
      expect(entry, entry.service).toMatchObject({
        wanted: "down",
        signal: "none",
        exit: STOP_EXIT[entry.service],
      });
    }
    expect(texts.filter((text) => text.startsWith("sd-first-failure"))).toEqual([]);
    expect(texts.filter((text) => /timed out|SIGKILL|sending KILL/i.test(text))).toEqual([]);

    const done = await project.operation(id);
    expect(done.receipt_id).not.toBeNull();
    expect(Date.parse(done.receipt_recorded_at)).toBeGreaterThan(Date.parse(stopRequested));
    const closed = (await apiLogs(project)).filter(
      (line) => line.operationId === id && line.msg === "pilot stream closed",
    );
    record(`P8 stream close reasons: ${JSON.stringify(closed.map((l) => l.reason))}`);
    expect(closed).toHaveLength(1);
    expect(["completed", "client_disconnect", "shutdown"]).toContain(closed[0].reason);
  });
});
