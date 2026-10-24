/** How many causes `describeError` follows, which also ends a cyclic chain. */
const MAX_CAUSES = 5;

/** An error followed by its causes, such as the driver error under Drizzle's. */
export function describeError(error: unknown): string {
  const parts = [String(error)];
  let cause = error instanceof Error ? error.cause : undefined;
  while (cause instanceof Error && parts.length <= MAX_CAUSES) {
    parts.push(String(cause));
    cause = cause.cause;
  }
  return parts.join("; cause: ");
}

/** Whether `error` is the rejection of an aborted wait or operation. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
