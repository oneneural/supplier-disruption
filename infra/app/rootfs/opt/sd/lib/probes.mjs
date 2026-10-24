// Loopback probes shared by the healthcheck, the API readiness check and the
// watchdog. They report status words only, never response bodies or secrets.

export const ENDPOINTS = {
  api: "http://127.0.0.1:3001",
  web: "http://127.0.0.1:3000",
};

/** Each probe gives up after this long; a hung process fails its probe. */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * @typedef {{ ok: boolean, detail: string, unknown?: boolean }} ProbeResult
 * `unknown` marks a result that could not be observed because another
 * service (the API) did not answer.
 */

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/**
 * API readiness: its role reaches the database, the schema tag matches its
 * build and the queue producer has started.
 * @returns {Promise<ProbeResult>}
 */
export async function probeApi(endpoints = ENDPOINTS) {
  try {
    const { status, body } = await getJson(`${endpoints.api}/internal/health/ready`);
    if (status === 200 && body?.ready === true) return { ok: true, detail: "ready" };
    return { ok: false, detail: typeof body?.reason === "string" ? body.reason : `http_${status}` };
  } catch {
    return { ok: false, detail: "no_response" };
  }
}

/**
 * The worker heartbeat for this container boot, as the API reads it. When the
 * API does not answer, the worker's state is unknown rather than failed.
 * @returns {Promise<ProbeResult>}
 */
export async function probeWorker(endpoints = ENDPOINTS) {
  try {
    const { status, body } = await getJson(`${endpoints.api}/internal/health/worker`);
    if (status === 200 && body?.fresh === true) return { ok: true, detail: "fresh" };
    const reason = typeof body?.reason === "string" ? body.reason : `http_${status}`;
    return { ok: false, detail: reason, unknown: reason === "database_unreachable" };
  } catch {
    return { ok: false, detail: "api_no_response", unknown: true };
  }
}

/**
 * The web server answers on its loopback port by serving a public file.
 * @returns {Promise<ProbeResult>}
 */
export async function probeWeb(endpoints = ENDPOINTS) {
  try {
    const response = await fetch(`${endpoints.web}/robots.txt`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.arrayBuffer();
    return response.status === 200
      ? { ok: true, detail: "answering" }
      : { ok: false, detail: `http_${response.status}` };
  } catch {
    return { ok: false, detail: "no_response" };
  }
}

/** All three probes, run concurrently. */
export async function probeAll(endpoints = ENDPOINTS) {
  const [api, web, worker] = await Promise.all([
    probeApi(endpoints),
    probeWeb(endpoints),
    probeWorker(endpoints),
  ]);
  return { api, web, worker };
}

/** One line such as "api=ready web=answering worker=stale". */
export function summarize(probes) {
  return Object.entries(probes)
    .map(([service, result]) => `${service}=${result.detail}`)
    .join(" ");
}
