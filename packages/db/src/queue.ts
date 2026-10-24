/** pg-boss is installed in its own schema by the migrator; runtime roles never migrate it. */
export const PGBOSS_SCHEMA = "pgboss";

export const PILOT_QUEUE = "pilot-operation";

export interface PilotJobData {
  operationId: string;
}

/** Explicit pilot job policy, set on the queue and repeated on every send. */
export const PILOT_JOB_OPTIONS = {
  expireInSeconds: 30,
  retryLimit: 3,
  retryDelay: 1,
  retryBackoff: false,
  retentionSeconds: 24 * 60 * 60,
  deleteAfterSeconds: 24 * 60 * 60,
} as const;

/**
 * `exclusive` allows one queued-or-active job per singleton key; jobs are keyed
 * by operation ID. Business deduplication still belongs to the application tables.
 */
export const PILOT_QUEUE_OPTIONS = { policy: "exclusive", ...PILOT_JOB_OPTIONS } as const;

/** Durable case application jobs (ADR 0009): one queued-or-active job per case. */
export const CASE_QUEUE = "case-application";

export interface CaseJobData {
  caseId: string;
}

/**
 * A failed attempt is retried with exponential backoff capped at five minutes
 * and no practical limit, so an API outage of any length delays a case but
 * never strands it. The API decides each run from the durable action journal,
 * so a retry never resubmits blindly, and it bounds the read-backs that cannot
 * prove an outcome itself (ADR 0016).
 *
 * The worker refreshes a job's heartbeat while it runs. A worker that dies
 * mid-run, or before it acknowledges a finished run, stops refreshing it, so
 * the supervisor retries the job after `heartbeatSeconds` rather than leaving
 * it active, and the case's singleton key blocked, until `expireInSeconds`.
 */
export const CASE_JOB_OPTIONS = {
  expireInSeconds: 120,
  heartbeatSeconds: 10,
  retryLimit: 1_000_000,
  retryDelay: 1,
  retryBackoff: true,
  retryDelayMax: 300,
  retentionSeconds: 24 * 60 * 60,
  deleteAfterSeconds: 24 * 60 * 60,
} as const;

export const CASE_QUEUE_OPTIONS = { policy: "exclusive", ...CASE_JOB_OPTIONS } as const;
