// In-flight handlers get this long to finish after SIGTERM: the longest pilot
// hold (PILOT_MAX_HOLD_MS, 8 s) plus its receipt call. At this timeout pg-boss
// (12.38) fails every still-active job ("pg-boss shut down while active")
// before closing its pool, so the queue's retry policy makes the job available
// again after its 1 s retry delay. Only if that fail write itself fails does
// the job wait for its 30 s expiry instead.
export const DRAIN_TIMEOUT_MS = 10_000;
// Hard bound on the whole shutdown, covering the drain plus connection cleanup.
// The image's s6 timeout-kill for the worker (12000 ms) sits just above it; the
// container's worst-case stop is checked in scripts/test/drain-budget.test.mjs.
export const SHUTDOWN_DEADLINE_MS = 11_000;

export interface ShutdownSteps {
  /** Stops new claims and waits for in-flight handlers. */
  stopQueue(): Promise<void>;
  stopHeartbeat(): void;
  closePool(): Promise<void>;
}

/**
 * Drains the queue, then releases the heartbeat timer and the pool even when
 * draining fails, so the process can still exit instead of waiting for the
 * outer deadline. Errors are reported after cleanup; when draining and closing
 * both fail, neither is lost.
 */
export async function drainAndClose(steps: ShutdownSteps): Promise<void> {
  let drainFailed = false;
  let drainError: unknown;
  try {
    await steps.stopQueue();
  } catch (error) {
    drainFailed = true;
    drainError = error;
  }
  steps.stopHeartbeat();
  try {
    await steps.closePool();
  } catch (closeError) {
    if (drainFailed) {
      throw new AggregateError(
        [drainError, closeError],
        "worker shutdown failed: draining the queue and closing the pool both failed",
        { cause: closeError },
      );
    }
    throw closeError;
  }
  if (drainFailed) throw drainError;
}
