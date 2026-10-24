import { setTimeout as delay } from "node:timers/promises";

/** A failed first heartbeat write is tried again after this wait. */
export const FIRST_HEARTBEAT_RETRY_MS = 2_000;
/**
 * No first heartbeat attempt starts after this long, the container's startup
 * bound (ADR 0002); the last one can still run for its own bounds (connect and
 * statement timeouts) past it. The s6 watchdog counts the same bound from the
 * container's start, before the worker starts, so in the container the
 * watchdog will end a stalled start first. This give-up ends host runs.
 */
export const FIRST_HEARTBEAT_DEADLINE_MS = 90_000;

export interface StartupSteps {
  /** Starts pg-boss: connects and checks its schema. */
  start(): Promise<unknown>;
  /** Registers the case and pilot job handlers. */
  work(): Promise<unknown>;
  /** One attempt to write this boot's first heartbeat row. */
  writeFirstHeartbeat(): Promise<void>;
  /** Whether a failed attempt cannot succeed when retried; startup then fails at once. */
  isPermanent?(error: unknown): boolean;
  /** Reports a failed first heartbeat attempt that will be retried. */
  firstHeartbeatFailed?(error: unknown, attempt: number): void;
}

export interface StartupOptions {
  /** A shutdown request aborts startup, which then rejects promptly. */
  signal?: AbortSignal;
  /** For tests only; the worker uses FIRST_HEARTBEAT_DEADLINE_MS. */
  firstHeartbeatDeadlineMs?: number;
  /** For tests only; the worker uses FIRST_HEARTBEAT_RETRY_MS. */
  firstHeartbeatRetryMs?: number;
}

/**
 * Starts consuming jobs, then writes the first heartbeat. A current-boot
 * heartbeat row therefore means this worker started pg-boss and registered
 * its handler, so aggregate readiness never counts a worker that cannot claim
 * jobs. A failure in either step leaves no row and propagates.
 *
 * The first heartbeat write is retried until it succeeds or the deadline
 * passes, since a write blocked past the statement timeout (for example on a
 * lock) would otherwise end the worker and so halt its container. No attempt
 * starts after the deadline; the error then carries the last failure as its
 * cause. A permanent failure is not retried and propagates as it is.
 */
export async function startConsuming(
  steps: StartupSteps,
  {
    signal,
    firstHeartbeatDeadlineMs = FIRST_HEARTBEAT_DEADLINE_MS,
    firstHeartbeatRetryMs = FIRST_HEARTBEAT_RETRY_MS,
  }: StartupOptions = {},
): Promise<void> {
  await steps.start();
  signal?.throwIfAborted();
  await steps.work();
  const deadline = Date.now() + firstHeartbeatDeadlineMs;
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await untilAborted(steps.writeFirstHeartbeat(), signal);
      return;
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (steps.isPermanent?.(error) === true) throw error;
      if (Date.now() + firstHeartbeatRetryMs >= deadline) {
        throw new Error(
          `first heartbeat not written within ${firstHeartbeatDeadlineMs} ms (${attempt} attempts)`,
          { cause: error },
        );
      }
      steps.firstHeartbeatFailed?.(error, attempt);
      await delay(firstHeartbeatRetryMs, undefined, { signal });
    }
  }
}

/**
 * Settles with `attempt`, or rejects with the abort reason as soon as `signal`
 * aborts. An abandoned attempt still ends within its statement timeout.
 */
function untilAborted<T>(attempt: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return attempt;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", abort, { once: true });
    attempt.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
