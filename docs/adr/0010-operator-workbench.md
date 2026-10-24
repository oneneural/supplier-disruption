# ADR 0010: Operator workbench on the case API

- Status: historical decision record; see [verification results](../verification.md)
- Date: 2026-10-21

## Context

ADR 0009 carries a supplier case from a stored message to
`plan_verified` through API routes, but the browser still showed only the
toolchain pilot. SPEC "Operator experience" asks for a small functional
workbench: an exception queue, a case view with the supplier's words beside
current and proposed fields, a demand-impact table, recovery options, review
controls and an action timeline. This record states how the web app provides
them on Next 16.4.2 without moving any business authority out of the API.

## Stack

- Tailwind CSS 4.3.3 through `@tailwindcss/postcss`, set up as the bundled
  Next 16.4.2 CSS guide describes. It installed and built cleanly on the pinned
  Next, React and pnpm versions, with no dependency build script.
- shadcn conventions without the shadcn CLI or registry: the few primitives the
  screens use (`Button`, `Badge`, `Panel`, `Notice`, `Table`) are owned source
  under `apps/web/components/ui/`, written in the shadcn style with
  `class-variance-authority` 0.7.1, `clsx` 2.1.1 and `tailwind-merge` 3.7.0
  through the usual `cn` helper. Fetching registry content is an external
  service outside this task's authority, and the screens need no Base UI
  primitive: native `select`, `details`, `fieldset` and form controls already
  give keyboard access and accessible names. There is no `components.json`;
  adopting a registry component later is a reviewed source change.
- All new pins are exact catalog entries published at least two weeks before
  2026-10-21.
- Semantic color tokens live as CSS custom properties in `app/globals.css`
  with light and dark values and a teal procurement accent, exposed to
  Tailwind through `@theme inline`. Text uses the system UI font stack; no font
  file is hosted yet.

## Screens

| Route         | Kind                                                          | Content                                                                                                                         |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/`           | Server Component                                              | Sign-in form when signed out; otherwise the exception queue and the "Load fixture message" control                              |
| `/cases/[id]` | Server Component with two client islands                      | Case summary, demand impact, fields and locators, recovery options, original message, review controls, action timeline, history |
| `/pilot`      | Server Component with the proxy and stream pilot client panel | The pilot operation and its status stream, moved from `/`                                                                       |

Every page reads the API server side with the caller's cookie and
`cache: "no-store"`; the browser bundle imports only `@supplier-disruption/contracts`
types and calls `/api/*` through the existing same-origin rewrite. Client
components are limited to the sign-in and sign-out buttons, the fixture loader,
the review controls and the case auto-refresh.

- Queue: case reference, state, severity reason (the case reason code with a
  readable label), owner, next action, business-clock age and message.
- Fields: sender, PO and line, base revision, vendor item mapping, unit and
  each schedule segment, current against proposed. The current schedule comes
  from the assessment's accepted PO segments. Each row links to the exact
  value in the stored message.
- Original message: the stored bytes of every delivery with digest and size,
  flattened into JSON paths so a locator lands on one highlighted row, and the
  raw text. Nothing on the page summarizes the message.
- Impact: the four totals, demand lines with cutoffs, eligible stock with the
  unrelated reservations kept, every supply bucket with its outcome, and
  shortfalls with reason and owner.
- Options: transfer options with feasibility, cost, quote validity, terms hash
  and the reason when disallowed; substitute offers as disallowed; the AUTH-1
  cost, limits and minimum approver; required decisions as recorded or
  outstanding; the plan's assumptions; and the bound source versions.
- Timeline: each plan action's effect state (planned, authorized, pending,
  confirmed, failed or unknown, always as text), operation ID, attempts,
  receipt and read-back; the verification evidence; and the statement that no
  supplier or transfer receipt is recorded, so a verified plan is not physical
  delivery. The full event history follows.

## Review controls and simulated roles

The controls send exactly the API commands of ADR 0009 and show the API's
answer: the HTTP status, error code and a plain explanation for a refusal, or
the resulting state. "Act as (simulated role)" lists only the actors the API
returns for the signed-in user and says that choosing one grants nothing.
Switching identity means signing out. The buyer's approval of EUR 160 is
therefore sent and visibly refused with `over_approval_limit`; the page never
hides or pre-empts a decision the API would refuse. Buttons are disabled while
a command is pending and outside the states that accept it; the API remains
the check.

While a case is `applying`, `verifying` or `partially_applied` with
`outcome_unknown`, the case page re-reads itself every second and says so in a
status region. A stopped refresh shows the last read, never a completed
effect.

## API additions

Two small routes, both behind the session, membership and (for the command)
origin checks of the existing case routes:

- `GET /api/cases/actors?organizationId=` returns the active simulated actors
  bound to the caller, so the page offers only those.
- `POST /api/cases/:id/notes` records an extraction correction or a question as
  a `question` or `extraction_correction` case event, as a simulated actor the
  caller may act as. It changes no field, state, decision or plan; richer
  correction and reassessment stay for later tasks.

Contracts gain `caseNoteCommandSchema`, `caseActorSchema` and type-only read
models of the case responses (`packages/contracts/src/domain/workbench.ts`).

## Verification

`scripts/container/workbench.test.mjs` (W1) drives C-01 in Chromium against a
disposable project of the packaged image: the buyer signs in, loads the fixture
message, sees 70, 50, 50 and 0 EA and EUR 160, follows a field locator to its
stored value, is refused the approval with HTTP 422, and records the simulated
supplier acknowledgement; the manager approves and records the warehouse
planner's confirmation; the page reaches `plan_verified` with each action
confirmed and its read-back evidence. The only non-2xx response allowed is
that refusal, and every other origin is blocked. P1 now opens the pilot from
the queue page.

### Business clock in W1

The C-01 fixture is time-bound: an approval given after 18:00 Copenhagen time
expires at once (ADR 0009), and the TRO-1 quote is valid until
2026-10-22T10:00:00Z. Under the system clock W1 would therefore fail on most
days. W1 instead runs its own disposable project on the controlled business
clock of ADR 0004, which the image's init seeds at the fixture's start,
2026-10-21T09:00:00+02:00, and which nothing advances:

- `scripts/container/support.mjs` lets a gate add app environment variables to
  its own project through an override file beside the run; `compose.yaml` is
  unchanged.
- W1 sets `NODE_ENV=test` and `DOMAIN_CLOCK_MODE=controlled`. The config still
  accepts `controlled` only with `NODE_ENV=test` and `DATA_MODE=fixture`; that
  guard is unchanged. Next selects its development runtime only for
  `NODE_ENV=development`, so the web server keeps its production runtime. The
  API sets the origin and CSRF checks explicitly; in this project only, Better
  Auth's sign-in rate limit is off, as in the integration tests.
- The image's API service script forwards `DOMAIN_CLOCK_MODE` only when the
  container sets it. The default image and Compose file set nothing, so D12
  still finds no override and the system clock.
- W1 asserts the API logged `controlled`, the clock row holds the seeded
  instant before and after the flow, and every case event carries that instant.

## Limitations

- The packaged app runs on the system business clock (ADR 0004), so a live
  demonstration of C-01 in the default project still depends on wall time:
  after 18:00 Copenhagen time an approval expires at once, and after
  2026-10-22T10:00:00Z the TRO-1 quote has expired. W1 is independent of wall
  time; a demonstration project would need the same controlled-clock settings
  as W1 or a decision on fixture dates.
- W1 runs its container with `NODE_ENV=test`, so it does not exercise the
  production sign-in rate limit; P1 and P3 cover the production-mode image.
- The fixture loader offers the one stored C-01 message, MSG-0001.
- Notes are recorded only; nothing reads them back into an assessment yet.
- No automated accessibility scan or screen-reader test was run. The design
  uses semantic headings, labelled controls, text states, a skip link, visible
  focus and live regions, but that is not a conformance claim.
- Development with `next dev` writes `apps/web/AGENTS.md` and
  `apps/web/.next/dev/types`; neither is committed, and a stale
  `.next/dev/types` makes `typecheck` fail until it is removed.
