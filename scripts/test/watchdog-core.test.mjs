import { describe, expect, it } from "vitest";
import {
  BOUNDS,
  haltForHungWatchdog,
  initialState,
  step,
  watchdogHung,
} from "../../infra/app/rootfs/opt/sd/lib/watchdog-core.mjs";

const ok = { ok: true, detail: "ready" };
const down = { ok: false, detail: "no_response" };
const unknown = { ok: false, detail: "api_no_response", unknown: true };
const allUp = { api: true, web: true, worker: true };
const allOk = { api: ok, web: ok, worker: ok };

/** Feeds observations at the given times and returns every action taken. */
function drive(observations, state = initialState(0)) {
  const actions = [];
  for (const observation of observations) {
    const result = step(state, { wantedUp: allUp, ...observation });
    state = result.state;
    if (result.action !== null) actions.push({ at: observation.now, ...result.action });
  }
  return { actions, state };
}

const every = (from, to, probes, extra = {}) => {
  const list = [];
  for (let now = from; now <= to; now += BOUNDS.intervalMs) list.push({ now, probes, ...extra });
  return list;
};

describe("watchdog startup bound", () => {
  it("reports first readiness once all three probes pass", () => {
    const { actions, state } = drive([
      { now: 0, probes: { api: ok, web: down, worker: down } },
      { now: 2_000, probes: allOk },
    ]);
    expect(actions).toEqual([{ at: 2_000, kind: "ready", afterMs: 2_000 }]);
    expect(state.phase).toBe("running");
  });

  it("halts with startup-timeout at the bound, naming what never became ready", () => {
    const { actions } = drive(
      every(0, BOUNDS.startupMs, {
        api: { ok: false, detail: "schema_incompatible" },
        web: down,
        worker: down,
      }),
    );
    expect(actions).toEqual([
      {
        at: BOUNDS.startupMs,
        kind: "halt",
        reason: "startup-timeout",
        detail: "api:schema_incompatible,web:no_response,worker:no_response",
      },
    ]);
  });

  it("does not halt just before the bound", () => {
    const { actions } = drive(
      every(0, BOUNDS.startupMs - 1, { api: down, web: down, worker: down }),
    );
    expect(actions).toEqual([]);
  });
});

describe("watchdog hang bound", () => {
  const running = () => drive([{ now: 0, probes: allOk }]).state;

  it("halts once a wanted-up service fails continuously for the hang bound", () => {
    const { actions } = drive(
      every(2_000, 2_000 + BOUNDS.hangMs, { api: ok, web: down, worker: ok }),
      running(),
    );
    expect(actions).toEqual([
      {
        at: 2_000 + BOUNDS.hangMs,
        kind: "halt",
        reason: "hang:web",
        service: "web",
        detail: "no_response",
      },
    ]);
  });

  it("restarts the window when the probe passes once", () => {
    const observations = [
      ...every(2_000, 20_000, { api: ok, web: down, worker: ok }),
      { now: 22_000, probes: allOk },
      ...every(24_000, 24_000 + BOUNDS.hangMs - 2_000, { api: ok, web: down, worker: ok }),
    ];
    expect(drive(observations, running()).actions).toEqual([]);
  });

  it("ignores a service that s6 reports as wanted down, then starts a fresh window", () => {
    const wantedDown = every(
      2_000,
      2_000 + 3 * BOUNDS.hangMs,
      { api: ok, web: ok, worker: down },
      {
        wantedUp: { ...allUp, worker: false },
      },
    );
    const afterUp = every(100_000, 100_000 + BOUNDS.hangMs, { api: ok, web: ok, worker: down });
    const { actions } = drive([...wantedDown, ...afterUp], running());
    expect(actions).toEqual([
      {
        at: 100_000 + BOUNDS.hangMs,
        kind: "halt",
        reason: "hang:worker",
        service: "worker",
        detail: "no_response",
      },
    ]);
  });

  it("neither starts nor clears a worker window while the worker is unobservable", () => {
    // The API stops answering, so the worker's heartbeat cannot be read; the API itself hangs.
    const { actions } = drive(
      every(2_000, 2_000 + BOUNDS.hangMs, { api: down, web: ok, worker: unknown }),
      running(),
    );
    expect(actions.map((a) => a.reason)).toEqual(["hang:api"]);

    const stale = { ok: false, detail: "stale" };
    const observations = [
      ...every(2_000, 20_000, { api: ok, web: ok, worker: stale }),
      ...every(22_000, 30_000, { api: ok, web: ok, worker: unknown }),
      { now: 32_000, probes: { api: ok, web: ok, worker: stale } },
    ];
    expect(drive(observations, running()).actions).toEqual([
      { at: 32_000, kind: "halt", reason: "hang:worker", service: "worker", detail: "stale" },
    ]);
  });
});

describe("hung watchdog (healthcheck side)", () => {
  const running = { up: true, wantedUp: true, upForMs: BOUNDS.watchdogStaleMs };

  it("reports hang:watchdog once a running watchdog's beat reaches the bound", () => {
    expect(watchdogHung({ now: BOUNDS.watchdogStaleMs - 1, beatAt: 0, ...running })).toBeNull();
    expect(watchdogHung({ now: BOUNDS.watchdogStaleMs, beatAt: 0, ...running })).toEqual({
      reason: "hang:watchdog",
      detail: `beat_age_ms=${BOUNDS.watchdogStaleMs}`,
    });
  });

  it("never reports a watchdog that is brought down, stopping or unobservable", () => {
    const now = BOUNDS.watchdogStaleMs * 10;
    for (const state of [
      { up: true, wantedUp: false },
      { up: false, wantedUp: true },
      { up: null, wantedUp: true },
      { up: true, wantedUp: null },
      { up: true, wantedUp: true, upForMs: null },
      // Just brought up again: its first beat is still due.
      { up: true, wantedUp: true, upForMs: BOUNDS.watchdogStaleMs - 1 },
    ]) {
      expect(watchdogHung({ now, beatAt: 0, ...state })).toBeNull();
    }
    expect(watchdogHung({ now, beatAt: null, ...running })).toBeNull();
    expect(watchdogHung({ now, beatAt: Number.NaN, ...running })).toBeNull();
  });
});

describe("halt retry for a hung watchdog", () => {
  it("halts on its own claim and retries while the record holds hang:watchdog", () => {
    expect(haltForHungWatchdog({ claimed: true, record: null })).toBe(true);
    expect(
      haltForHungWatchdog({
        claimed: false,
        record: "reason=hang:watchdog detail=beat_age_ms=21000 source=healthcheck",
      }),
    ).toBe(true);
  });

  it("leaves another failure's halt to the process that claimed it", () => {
    expect(
      haltForHungWatchdog({ claimed: false, record: "reason=exit service=api exit=256 signal=9" }),
    ).toBe(false);
    expect(haltForHungWatchdog({ claimed: false, record: "reason=hang:worker detail=stale" })).toBe(
      false,
    );
    expect(haltForHungWatchdog({ claimed: false, record: null })).toBe(false);
  });
});
