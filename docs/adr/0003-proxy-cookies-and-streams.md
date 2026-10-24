# ADR 0003: Same-origin proxy, cookies and the pilot status stream

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-19

## Context

The application image packaged the web server, API and worker into one image. The browser
reaches the API only through the Next standalone server's `beforeFiles`
rewrite of `/api/:path*` to `http://127.0.0.1:3001`. The proxy tests prove that path
in a real browser and at the HTTP level: cookies, Origin and CSRF checks, the
internal boundary, a bounded server-sent event stream, and a graceful stop with
a stream open. This record states the choices made and what was observed in
Next 16.4.2, Fastify 5.12.7, Better Auth 1.7.10 and Chromium.

## Proxy

- The rewrite is unchanged: no custom Next server, no route-handler BFF, no
  `proxy.ts`. `/internal/**` is never rewritten.
- `compress: false` in `next.config.mjs`. Next's compression middleware would
  hold event bytes until a buffer fills; the API also sends
  `Cache-Control: no-cache, no-transform`, which that middleware respects.
  Static assets and pages are therefore served uncompressed on loopback.
- `app/icon.svg` exists so the page declares an icon. Without it Chromium
  requests `/favicon.ico`, which 404s and would count as a failed page asset.
- Observed (source, `dist/server/lib/router-utils/proxy-request.js`): the
  rewrite proxies through httpxy with `changeOrigin`, a 30 s proxy timeout and
  `x-forwarded-host`, and destroys the upstream request when the browser
  response closes. Observed (P2): every upstream `Set-Cookie` arrives as its
  own header.

### Encoded paths

Gate P4 sends the receipt route's method, a valid worker token and a valid body
through the published port with raw request targets. Observed outcomes:

| Request target (after `/api/`)                                              | Outcome                                                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/internal/...` (no `/api/` prefix)                                         | Next 404; never reaches the API                                                                          |
| `%2e%2e/internal/...`, `%2E%2E/internal/...`, `../internal/...`             | Next 404; Next resolves the dot segment before matching, so the path leaves `/api/` and is not rewritten |
| `..%2finternal/...`, `%2e%2e%2finternal/...`, `%252e%252e%252finternal/...` | Forwarded verbatim; the API's router matches no route and answers its 404                                |

No proxied variant matched the receipt route (API route log). The boundary
therefore rests on two facts: the rewrite only forwards `/api/*`, and the
API's router does not decode `%2f` into a path separator or resolve dot
segments. Both are checked by P4 on every container run.

## Cookies

Better Auth sign-in with `rememberMe: false` sets two cookies,
`supplier-disruption.session_token` and `supplier-disruption.dont_remember`;
sign-out clears three (`session_token`, `session_data`, `dont_remember`). Both
arrive through the proxy as separate headers with the same names and
attributes as directly from Fastify: `HttpOnly`, `SameSite=Lax`, `Path=/`, no
`Secure` on loopback HTTP. The prefix keeps them apart from other applications
on `127.0.0.1`; a default-named `better-auth.session_token` cookie is neither
read nor changed by sign-in or sign-out.

## Pilot status stream

`GET /api/pilot/operations/:id/events`, authorized like the operation read:
anonymous 401, a non-member gets the same 404 body as a missing ID, a
malformed ID 400. Any member may read it.

- `text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`,
  `X-Accel-Buffering: no`. The body is a `PassThrough` handed to
  `reply.send`, so every write reaches the socket as it happens.
- The first event is written as soon as the stream opens, then one per second
  scheduled from the opening time, five in total, then the server ends the
  response. An 8 s timer closes any stream regardless, for example one whose
  state reads stall (`PILOT_STREAM_*` in `packages/contracts`; an API test
  stalls a read and observes `reason=max_duration`).
- The route is registered with `exposeHeadRoute: false`. Fastify's automatic
  HEAD route would drain the stream body without ever closing it, so a HEAD
  request would start a stream that runs to its end with nobody reading. HEAD
  gets a 404.
- Every other API response is sent `Cache-Control: no-store`, overriding
  any value a handler or Better Auth set; only a `text/event-stream`
  response keeps its own policy.
- Each event is `event: status` with `{ seq, operationId, state, emittedAt,
final }`. `state` is read fresh for each event. No job, receipt, session or
  user identifier is included. There is no `id:` field, because replay after
  an event ID is deferred; the page closes its `EventSource` on the final
  event so the browser does not reconnect and start a new stream.
- Disconnect: when the response closes early, Fastify destroys the body
  stream; its `close` handler clears the timers and unregisters the stream,
  and the log records `pilot stream closed` with `reason=client_disconnect`.
  Through the proxy, the browser's disconnect reaches the API because Next
  destroys the upstream request when its own response closes.
- `GET /internal/health/streams` on the loopback listener reports
  `openPilotStreams` for this API process. It is under `/internal`, so the
  web server never proxies it.
- Shutdown: a `preClose` hook closes every open stream (`reason=shutdown`) so
  `app.close()` does not wait for a stream's own end.

Deferred at this revision: session refresh, stream revocation and replay after
a last-seen event ID. The original open stream checks authorization only at
opening and ends within 8 s. ADR 0020 supersedes these limits.

### Shutdown with an open stream

`rc.shutdown` stops `web` before `api`. On SIGTERM the Next standalone server
stops accepting connections and waits for in-flight responses before it exits
143 (`server.close()` in `dist/server/lib/start-server.js`; it closes all
connections only in development). An open stream through the proxy therefore
runs to its natural end while `web` drains, and the API is still up because it
stops after `web`. Observed in P8: the stream opened before the stop delivered
all five events and ended normally about 3.9 s into a 13 s stop, closed with
`reason=completed`. If anything were still open when the API stops, its
`preClose` hook would end it (`reason=shutdown`, covered by an API test).

A stream lasts about 4 s and is capped at 8 s, 2 s under the web service's
s6 `timeout-kill` of 10000 ms, so even a stream that reaches its cap after
opening just before a stop ends before `web` could be killed (an API test
reads the s6 file and keeps that margin). The application image stop budget is
unchanged: the worker's 10 s drain, not the stream, sets the longest step.

## Request route log

The API's Fastify `LogController` is replaced by one that writes, on arrival,
`{ msg: "request", method, route, target }`: the matched route pattern
(`none` when no route matched) and the raw request target exactly as received.
Writing it on arrival also records a stream request whose client disconnects,
which never reaches Fastify's completion hooks. Fastify's completion and error
lines are unchanged. Routes registered with `logLevel: "warn"`, the readiness
probes that arrive every second or two, are not logged; they return status
words only.

## Client address and rate limiting

Better Auth keys its sign-in rate limit, and records a session's
`ip_address`, on `X-Forwarded-For` (its only default IP header). The Next
proxy does not set that header. A `beforeFiles` rewrite to an external URL is
proxied in `dist/server/lib/router-server.js` through `proxyRequest`
(`dist/server/lib/router-utils/proxy-request.js`) and httpxy, which copies the
incoming headers and adds forwarding headers only with its `xfwd` option,
which Next leaves off. The `x-forwarded-for ??=` in
`dist/server/base-server.js` runs only when Next itself renders a request.
A client's header therefore reached the API unchanged, and a client that
changed it on every attempt got a fresh rate-limit bucket each time.

The API's auth route adapter now drops any client `X-Forwarded-For` and sets
it to the connecting socket address, consistent with `trustProxy: false`.
Behind the proxy that is always `127.0.0.1`, so sign-in attempts through the
web server share one bucket: 3 requests, with the count reset only after
10 s without an allowed request (each allowed request moves the window's
start; a rejected one changes nothing). Requests without the header had
already shared one bucket; the adapter makes that deliberate and
unforgeable. `disableIpTracking` was not used, because Better Auth then skips
rate limiting entirely, and `trustedProxies` would not help, because nothing
appends the real client address.

The shared bucket is a trade-off. Better Auth resets the count only once
10 s pass after the last allowed attempt (`decideConsume` in
`dist/api/rate-limiter/index.mjs`), so a client that makes three attempts
about every 10 s keeps every other sign-in through the proxy rejected with
429 for as long as it continues. That is acceptable for this single-user
pilot on loopback, and no worse than before: honest clients, which send no
header, already shared one bucket, and a client could also exhaust it. A
multi-user deployment needs a per-client key from a trusted proxy header,
which belongs with the workbench identity work.

P3 checks it through the proxy: four sign-ins inside one window, each with a
different forged `X-Forwarded-For`, give 200, 200, 200 and 429, and the
session records `127.0.0.1`. An API test checks the recorded address. The
gates keep the production limit and pace every sign-in with `SignInPacer` in
`scripts/container/gates.mjs`.

## Browser tests

Playwright 1.64.1 is a root dev dependency from the catalog. The P1 test uses
the library inside the existing container harness rather than the Playwright
test runner, so it shares the clone, image build and disposable projects. It
launches the headless shell for Playwright's Chromium build from the default
per-user cache (`corepack pnpm exec playwright install chromium-headless-shell`
if absent). Every request to another origin is aborted and fails the test, and
so does any non-2xx response the page receives or any request that fails.

One exception, recorded with each run: after `router.refresh()` (sign-in and
sign-out), Chromium reports the router's `?_rsc=` fetch as `net::ERR_ABORTED`
although its 200 response had arrived and the page rendered the refreshed
tree. The test tolerates exactly that case: an RSC fetch whose 2xx response
was received in the same step. The cancellation happens in Next's client
router; its cause was not traced further.

## Limits

- Only linux/arm64 and Docker Desktop on macOS were tested.
- The P5 emission bound converts the container's emission times to host time
  with the midpoint of a measured skew bracket narrower than 250 ms; the
  bracket is recorded with each run.
- Session refresh, stream revocation and replay are not implemented.
