// Pure decision logic for the container watchdog, separate from its I/O so
// that the startup bound and hang rules can be unit-tested.

/** Declared bounds. The ADR and the container tests use the same values. */
export const BOUNDS = {
  /** Aggregate readiness must be reached this long after the watchdog starts. */
  startupMs: 90_000,
  /** A wanted-up service failing its probe continuously for this long is hung. */
  hangMs: 30_000,
  /** Probe period, both before and after first readiness. */
  intervalMs: 2_000,
  /**
   * The watchdog records a beat every round. The Docker healthcheck halts the
   * container when a wanted-up watchdog has not beaten for this long (ADR 0021).
   */
  watchdogStaleMs: 20_000,
};

/** Container exit codes for watchdog-recorded failures. */
export const EXIT_CODES = { hang: 70, startupTimeout: 71 };

/** Probe order is also the order in which hangs are reported. */
export const SERVICES = ["api", "web", "worker"];

/** File the watchdog rewrites with its clock (epoch ms) every round. */
export const WATCHDOG_BEAT_FILE = "/run/sd/watchdog-beat";

/**
 * Whether the watchdog itself is hung, as the healthcheck sees it. Only a
 * watchdog that s6 reports both up and wanted up, for at least the bound, can
 * be hung: one brought down on purpose, one just brought up again whose first
 * beat is still due, or a container that is stopping never is. A missing or
 * unreadable beat (the watchdog has not started) or an unreadable s6 state
 * decides nothing, so a normal stop can never be recorded as a failure.
 *
 * @param {{ now: number, beatAt: number | null, up: boolean | null,
 *           wantedUp: boolean | null, upForMs: number | null }} observation
 * @returns {null | { reason: "hang:watchdog", detail: string }}
 */
export function watchdogHung({ now, beatAt, up, wantedUp, upForMs }, bounds = BOUNDS) {
  if (up !== true || wantedUp !== true) return null;
  if (beatAt === null || !Number.isFinite(beatAt)) return null;
  if (upForMs === null || !Number.isFinite(upForMs) || upForMs < bounds.watchdogStaleMs)
    return null;
  const ageMs = now - beatAt;
  if (ageMs < bounds.watchdogStaleMs) return null;
  return { reason: "hang:watchdog", detail: `beat_age_ms=${ageMs}` };
}

/**
 * Whether the healthcheck should ask s6-overlay to halt for a hung watchdog.
 * It halts when it has just claimed the first failure, and again on a later
 * round when the record already holds hang:watchdog, so a halt that failed is
 * retried. A record of any other failure belongs to the process that claimed
 * it, which halts on its own. Repeating a halt is safe: a container already
 * stopping has a watchdog that is no longer wanted up, so watchdogHung stops
 * reporting it before this is asked.
 *
 * @param {{ claimed: boolean, record: string | null }} firstFailure
 */
export function haltForHungWatchdog({ claimed, record }) {
  return claimed || /(^|\s)reason=hang:watchdog(\s|$)/.test(record ?? "");
}

export function initialState(startedAt) {
  return {
    phase: "starting",
    startedAt,
    failingSince: { api: null, web: null, worker: null },
  };
}

/**
 * Advances the watchdog by one observation.
 *
 * @param {ReturnType<typeof initialState>} state
 * @param {{ now: number,
 *           probes: Record<string, { ok: boolean, detail: string, unknown?: boolean }>,
 *           wantedUp: Record<string, boolean> }} observation
 * @param {typeof BOUNDS} bounds
 * @returns {{ state: ReturnType<typeof initialState>,
 *             action: null | { kind: "ready", afterMs: number }
 *                   | { kind: "halt", reason: string, service?: string, detail: string } }}
 */
export function step(state, observation, bounds = BOUNDS) {
  const { now, probes, wantedUp } = observation;

  if (state.phase === "starting") {
    if (SERVICES.every((service) => probes[service]?.ok === true)) {
      return {
        state: { ...state, phase: "running" },
        action: { kind: "ready", afterMs: now - state.startedAt },
      };
    }
    if (now - state.startedAt >= bounds.startupMs) {
      const waiting = SERVICES.filter((service) => probes[service]?.ok !== true)
        .map((service) => `${service}:${probes[service]?.detail ?? "unobserved"}`)
        .join(",");
      return { state, action: { kind: "halt", reason: "startup-timeout", detail: waiting } };
    }
    return { state, action: null };
  }

  const failingSince = { ...state.failingSince };
  let action = null;
  for (const service of SERVICES) {
    const probe = probes[service];
    if (wantedUp[service] === false) {
      // Brought down on purpose (s6-svc -d): not a hang, and a later s6-svc -u
      // starts a fresh failure window.
      failingSince[service] = null;
    } else if (probe?.ok === true) {
      failingSince[service] = null;
    } else if (probe?.unknown === true) {
      // Not observable this round (the API did not answer); keep the window as is.
    } else {
      failingSince[service] ??= now;
      if (action === null && now - failingSince[service] >= bounds.hangMs) {
        action = {
          kind: "halt",
          reason: `hang:${service}`,
          service,
          detail: probe?.detail ?? "unobserved",
        };
      }
    }
  }
  return { state: { ...state, failingSince }, action };
}
