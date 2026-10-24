/** The worker refreshes its current-boot heartbeat row this often. */
export const HEARTBEAT_INTERVAL_MS = 2_000;

/**
 * A heartbeat row counts as fresh while it is younger than this. Ages are
 * measured with the database clock, which also stamps every write.
 */
export const HEARTBEAT_FRESHNESS_MS = 10_000;
