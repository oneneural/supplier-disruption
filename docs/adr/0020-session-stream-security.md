# ADR 0020: Session refresh, sign-in limits and open-stream authorization

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-22
- Supersedes in part: [ADR 0003](0003-proxy-cookies-and-streams.md) (the
  shared sign-in bucket, the deferred session refresh, stream revocation and
  replay after an event ID)

## Context

ADR 0003 proved sign-in, cookies and the bounded pilot status stream through
the Next rewrite, and deferred three things. A stream checked the session and
membership only when it opened, so revoked access kept receiving events until
the stream ended (up to 8 s). There was no event ID, so a reconnect started
the sequence again. Every sign-in through the proxy shared one rate-limit
bucket keyed on 127.0.0.1, so one client making three attempts every 10 s kept
every other user out. Session refresh through the proxy was not observed.

Checkpoint recovery exposed that `POST /api/cases/ingest` answered 500
when a corrected delivery arrived for an escalated blocked case: intake's
state guard threw `CaseStateConflict` and nothing caught it on that route.

## Decisions

### Sign-in limits

- Each account gets Better Auth's own sign-in rule, 3 attempts per 10 s with
  the same reset semantics (the count resets once 10 s pass after the last
  allowed attempt; a rejected attempt changes nothing). The API's auth route
  adapter keys it on the submitted email, trimmed and lowercased, before
  Better Auth sees the request (`SignInLimiter` in `apps/api/src/auth.ts`). A
  refusal is Better Auth's own 429 body with `X-Retry-After`.
- The adapter matches the sign-in path after folding repeated and trailing
  slashes. Better Auth answers 404 to those spellings (better-call does not
  skip trailing slashes by default), so they never sign in; the adapter
  counts them against the account's limit anyway, so a later routing change
  could not open a way around it.
- Better Auth's per-address bucket for `/sign-in/email` is raised to 30
  attempts per 10 s with `customRules`. Behind the proxy every request comes
  from 127.0.0.1 (ADR 0003 keeps the forwarded address unforgeable), so it is
  a shared ceiling across accounts. Other Better Auth limits are unchanged.
- Both limits are active only where Better Auth limits (`NODE_ENV=production`),
  so the container gates see the deployed policy and the in-process tests opt
  in explicitly.

A forged `X-Forwarded-For` or another spelling of the email does not reach a
fresh bucket. One user exhausting their account's limit does not stop any
other user. Spraying many accounts still reaches the shared ceiling and then
blocks every sign-in for 10 s after the last allowed attempt; that is the
deliberate bound on guessing across accounts, not an unexpected lockout. A
targeted user can still be kept out by someone sending 3 attempts every 10 s
for that email. Both counters live in the API process's memory, so a restart
clears them.

### Session refresh

Sessions are read from PostgreSQL with the cookie cache off (ADR 0003).
`GET /api/auth/get-session` refreshes a session once its `updateAge` (1 day)
of the 7-day lifetime has passed and sends `Set-Cookie` for the same token
with `Max-Age=604800`. The auth adapter forwards it, and the Next rewrite
passes it through unchanged. A `rememberMe: false` session is never
refreshed, by Better Auth's design. Server components read `/api/session`
directly on loopback and cannot set cookies; the web client does not call
`get-session` today, so a browser's cookie keeps the lifetime it got at
sign-in unless something calls that route.

### Open-stream revalidation

Before every event after the first, the stream reads the session again
(cookie cache off, refresh off, so polling never extends a session) and the
user's membership of the operation's organization. If the session is gone,
expired or belongs to someone else, or the membership was removed, the
stream closes with `reason=revoked` and writes nothing further.

The bound: each event's check is the last step before its write, after the
state read, with nothing awaited between them, so no event is written after
a check that saw the revocation. Events are 1 s apart, so the stream closes
at most one interval plus one state, session and membership read after
revocation commits. Only an event whose check finished before the commit can
still arrive. The 8 s cap is unchanged. A reconnect is authorized from scratch:
anonymous 401, non-member 404.

### Last-Event-ID resume

- Each event now has `id: <operationId>:<seq>`. A reconnect with
  `Last-Event-ID` resumes at `seq + 1` of the same 5-event sequence, in order,
  with no duplicates. The resumed stream gets its own 8 s cap and its own
  1 s schedule.
- Resumed states are read fresh. There is no stored event log: a resume is a
  continuation of the bounded status sequence, not a replay of the states the
  client missed.
- `Last-Event-ID` for the final event answers 204, which tells an
  `EventSource` to stop reconnecting.
- Anything else is refused with 400 `invalid_request` after authorization
  and without opening a stream: an ID of another operation, sequence 0 or
  above 5, leading zeros, an uppercase operation ID, an empty value or any
  other form.

This is the bounded pilot demonstration stream only. It is not durable case
event replay, and no case route streams events; case pages read on request.
The pilot page still closes its `EventSource` on an error, so the browser
does not resume on its own.

### Case evidence, agent steps and errors

No behavior changed. A test now runs an email case whose scripted model turns
carry `thinking`, signature and `redacted_thinking` canaries, and one through
the real Anthropic adapter against a loopback stand-in that echoes the key it
received in a 401. The case detail and list, actor list, 400, 404 and 409
refusals, the stored step records and, for the key, the run's pause detail
contain none of them. The adapter records only text blocks and an error's
status. These runs are in-process and capture no API or worker log. No test
checks API or worker logs for the provider key. The container gate P7 scans
the container log only for the secrets the container mounts, those
`scripts/init-secrets.sh` creates; the container has no provider key or
provider variables.

### Ingest conflicts

`POST /api/cases/ingest` catches `CaseStateConflict` and answers 409
`invalid_case_state` with the case's current state. The ingest transaction
has rolled back, so the delivery's bytes are not stored. The extraction
hand-off keeps its own catch.

### Browser refresh and resume (2026-10-24)

This amends the last sentences of the session refresh and Last-Event-ID
sections above.

- The API's own session reads (`/api/session`, the case routes and the
  demonstration controls) pass `disableRefresh`. They authorize without
  sliding a session, because they cannot send the renewed cookie back. Only
  `GET /api/auth/get-session` refreshes a due session, and it re-sends the
  httpOnly cookie through the rewrite. Before this change a page load slid
  the database row, the refresh route then found nothing due, and the browser
  cookie still expired 7 days after sign-in.
- A signed-in page calls the refresh route through the rewrite at most once
  per 5 minutes, only while the page is visible and someone has used it since
  the last call (`apps/web/lib/session-keep-alive.ts`). It checks once a
  minute. Client code never reads the token. When the route reports no
  session, the page stops calling; a revoked or expired session gets a
  clearing cookie and is never extended. The worker token is unchanged and
  still refused as a session.
- The pilot page reads its stream with `fetch` instead of `EventSource`, which
  cannot set `Last-Event-ID` on a reconnect it did not schedule and hides the
  status (`apps/web/lib/pilot-stream.ts`). After an interruption it reconnects
  with the last event ID received after 0.5 s, 1 s and 2 s; a reconnect that
  delivers an event starts the count again, and three in a row that deliver
  nothing end it as interrupted. It stops at the final event, on 204, and on
  400, 401, 403 or 404. A revoked session ends the stream without a final
  event, and the reconnect is then refused with 401 or 404. An event at or
  below the last sequence shown is not shown again. This continues the
  bounded status sequence; it is not a replay of missed states.

## Evidence

- `apps/api/test/session-stream.test.ts`: per-account limits with a forged
  address, another spelling and a trailing slash, other users at once, the
  shared ceiling; refresh with the same token; a stream closed after session
  deletion, expiry and membership removal; resume order, 204 and forged IDs;
  the worker token refused as a session.
- `apps/api/test/case-leakage.test.ts`: the 409, and the reasoning and key
  canaries above, on a disposable database.
- Container gates: P2 refresh through the rewrite, P3 another account signing
  in straight after one account's 429, P9 revocation and resume through the
  proxy.
- 2026-10-24: `apps/api/test/session-stream.test.ts` adds API reads leaving a
  due session to the refresh route, and expired or deleted sessions never
  extended. `apps/web/test/` covers the stream parser, reconnect bounds and
  refusals, and the keep-alive schedule. The P1 browser gate adds a refresh
  while the page is used (none while idle) and a stream resumed after the
  network drops it after event 2.

## Limits

- Counters are per API process and in memory.
- The revocation bound depends on the 1 s interval; a stalled state read
  delays the check up to the 8 s cap.
- The browser refreshes only while a page is open, visible and used. A
  session left idle in every tab still expires 7 days after its last refresh,
  and a `rememberMe: false` session is never refreshed.
- Stream resume is proven in the browser for a body that ends early. Other
  network failures are covered by unit tests with a scripted `fetch`.
- No enterprise identity, multi-instance limit store or durable event log is
  claimed.
