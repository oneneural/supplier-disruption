// Helpers for the proxy, cookie, stream and browser gates. Requests
// to the published port go through the Next server; requests "inside" run in
// the app container against the API's loopback listener directly.
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { FIXTURE_MANAGER_EMAIL, FIXTURE_ORGANIZATION_ID, context, must } from "./support.mjs";

export const FIXTURE_BUYER_EMAIL = "buyer@fixture.local";
export const COOKIE_PREFIX = "supplier-disruption.";
export const SESSION_COOKIE = `${COOKIE_PREFIX}session_token`;
export const RECEIPT_ROUTE = "/internal/pilot/operations/:id/receipt";

/** A canary value from the run's secret files, by file name. */
export function canary(name) {
  const value = context().canaries.find((entry) => entry.name === name)?.value;
  if (value === undefined) throw new Error(`no canary for ${name}`);
  return value;
}

export const passwords = {
  manager: () => canary("fixture_manager_password"),
  buyer: () => canary("fixture_buyer_password"),
};

/**
 * The production sign-in limit (ADR 0020): 3 attempts per account, and the
 * count resets only once 10 s pass with no allowed attempt, since each
 * allowed attempt moves the window's start; a rejected attempt changes
 * nothing. Behind the proxy every account also shares a ceiling of 30
 * attempts per 10 s. The pacer treats every sign-in in a project as one
 * account, which keeps under both limits. Every attempt, accepted or
 * rejected, waits here so the gates neither weaken nor trip the limit.
 */
export class SignInPacer {
  constructor(max = 3, windowMs = 10_000, slackMs = 750) {
    Object.assign(this, { max, windowMs, slackMs, count: 0, last: 0 });
  }

  async slot() {
    if (Date.now() - this.last >= this.windowMs + this.slackMs) this.count = 0;
    if (this.count >= this.max) {
      await delay(this.last + this.windowMs + this.slackMs - Date.now());
      this.count = 0;
    }
    this.count += 1;
    this.last = Date.now();
  }

  /** Waits until the bucket is empty, so a test can spend all `max` slots at once. */
  async fresh() {
    const wait = this.last + this.windowMs + this.slackMs - Date.now();
    if (wait > 0) await delay(wait);
    this.count = 0;
  }
}

/**
 * One HTTP/1.1 request with the path sent exactly as given. Returns the raw
 * header list as well, so repeated Set-Cookie headers stay separate.
 */
export function httpCall(origin, { method = "GET", path, headers = {}, body } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, method, path, headers, agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          const setCookies = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            if (res.rawHeaders[i].toLowerCase() === "set-cookie")
              setCookies.push(res.rawHeaders[i + 1]);
          }
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            setCookies,
            text,
            json,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** { name, value, attributes } with lowercased attribute names; flags map to true. */
export function parseSetCookie(header) {
  const [pair, ...rest] = header.split(";").map((part) => part.trim());
  const at = pair.indexOf("=");
  const attributes = {};
  for (const part of rest.filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) attributes[part.toLowerCase()] = true;
    else attributes[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  return { name: pair.slice(0, at), value: pair.slice(at + 1), attributes };
}

/** The Cookie header a client sends back after these Set-Cookie headers. */
export function cookieHeader(setCookies) {
  return setCookies
    .map(parseSetCookie)
    .filter((cookie) => cookie.value !== "")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

/**
 * Signs in through the published port (the Next proxy). A null pacer sends
 * the attempt at once, for a test that means to exceed the rate limit.
 */
export async function signInThroughProxy(
  project,
  pacer,
  { email, password, rememberMe, origin, headers = {} } = {},
) {
  await pacer?.slot();
  const body = JSON.stringify({
    email,
    password,
    ...(rememberMe === undefined ? {} : { rememberMe }),
  });
  const response = await httpCall(project.origin, {
    method: "POST",
    path: "/api/auth/sign-in/email",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      origin: origin ?? project.origin,
      ...headers,
    },
    body,
  });
  return { ...response, cookie: cookieHeader(response.setCookies) };
}

export const managerSignIn = (project, pacer, extra = {}) =>
  signInThroughProxy(project, pacer, {
    email: FIXTURE_MANAGER_EMAIL,
    password: passwords.manager(),
    ...extra,
  });

export const buyerSignIn = (project, pacer, extra = {}) =>
  signInThroughProxy(project, pacer, {
    email: FIXTURE_BUYER_EMAIL,
    password: passwords.buyer(),
    ...extra,
  });

/** A pilot command for the fixture organization. */
export function pilotCommand(payload = { note: "pilot-stream" }) {
  return {
    contractVersion: "pilot-operation.v1",
    operationId: crypto.randomUUID(),
    organizationId: FIXTURE_ORGANIZATION_ID,
    payload,
  };
}

export async function submitThroughProxy(project, cookie, command, headers = {}) {
  const body = JSON.stringify(command);
  return httpCall(project.origin, {
    method: "POST",
    path: "/api/pilot/operations",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      origin: project.origin,
      ...(cookie === undefined ? {} : { cookie }),
      ...headers,
    },
    body,
  });
}

/**
 * Sends exactly `text` over a fresh TCP connection and reads the response
 * until the server closes it. Returns the bytes written, so a test can assert
 * that no client library rewrote the request target.
 */
export function rawExchange(port, text) {
  const intended = Buffer.from(text, "latin1");
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const sent = [];
    const write = socket.write.bind(socket);
    socket.write = (chunk, ...rest) => {
      sent.push(Buffer.from(chunk));
      return write(chunk, ...rest);
    };
    const received = [];
    socket.on("data", (chunk) => received.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const response = Buffer.concat(received).toString("latin1");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? NaN);
      resolve({
        intended,
        sent: Buffer.concat(sent),
        bytesWritten: socket.bytesWritten,
        status,
        response,
      });
    });
    socket.on("connect", () => {
      socket.write(intended);
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error("raw exchange timed out")));
  });
}

/**
 * Opens a pilot status stream with node:http and records the client clock at
 * which each event's bytes arrived, with its SSE id. `ended` resolves with how the response
 * ended: "end" (the server finished it), "aborted" (the connection closed
 * before the end, from the server side unless `abort` was called) or
 * "client-timeout" (the client gave up after timeoutMs).
 */
export function openStream(
  origin,
  path,
  cookie,
  { timeoutMs = 20_000, onEvent, headers = {} } = {},
) {
  const url = new URL(origin);
  const events = [];
  let abortedByClient = false;
  let req;
  const opened = Date.now();
  const response = new Promise((resolveResponse, rejectResponse) => {
    req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path,
        headers: {
          accept: "text/event-stream",
          ...(cookie === undefined ? {} : { cookie }),
          ...headers,
        },
        agent: false,
      },
      resolveResponse,
    );
    req.on("error", rejectResponse);
    req.end();
  });
  const ended = response.then(
    (res) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ how: "client-timeout", at: Date.now() });
          req.destroy();
        }, timeoutMs);
        const finish = (how) => {
          clearTimeout(timer);
          resolve({ how: abortedByClient ? "client-abort" : how, at: Date.now() });
        };
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          const now = Date.now();
          buffer += chunk;
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const fields = Object.fromEntries(
              block
                .split("\n")
                .map((line) => [
                  line.slice(0, line.indexOf(":")),
                  line.slice(line.indexOf(":") + 1).trimStart(),
                ]),
            );
            const event = {
              id: fields.id,
              event: fields.event,
              data: JSON.parse(fields.data),
              arrivedAt: now,
            };
            events.push(event);
            onEvent?.(event, events);
          }
        });
        res.on("end", () => finish("end"));
        res.on("aborted", () => finish("aborted"));
        res.on("error", () => finish("aborted"));
        res.on("close", () => finish(res.complete ? "end" : "aborted"));
      }),
  );
  return {
    opened,
    events,
    response,
    ended,
    abort() {
      abortedByClient = true;
      req.destroy();
    },
  };
}

/** Waits until `count` events have arrived on a stream from openStream. */
export async function waitForEvents(stream, count, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (stream.events.length < count) {
    if (Date.now() > deadline)
      throw new Error(`only ${stream.events.length} of ${count} events arrived`);
    await delay(10);
  }
}

/**
 * Runs an ES module script with node inside the app container. Input goes
 * over stdin (never arguments); the script prints one JSON line.
 */
export async function inContainer(project, script, input = {}) {
  const { stdout } = await must(
    "docker",
    ["exec", "-i", project.app, "node", "--input-type=module", "--eval", script],
    { input: JSON.stringify(input) },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

/** The API's count of open pilot streams, read on its loopback listener. */
export async function openStreamCount(project) {
  const result = await inContainer(
    project,
    `const r = await fetch("http://127.0.0.1:3001/internal/health/streams");
     console.log(JSON.stringify(await r.json()));`,
  );
  return result.openPilotStreams;
}

/** The API's JSON log lines (pino) from the container log, each with its time. */
export async function apiLogs(project) {
  const lines = [];
  for (const line of await project.logLines()) {
    if (!line.text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line.text);
      if (parsed.service === undefined) lines.push({ time: line.time, ...parsed });
    } catch {
      // not a JSON line
    }
  }
  return lines;
}
