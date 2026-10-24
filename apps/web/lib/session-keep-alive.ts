/**
 * The browser's session refresh (ADR 0020). Only `GET /api/auth/get-session`
 * slides a session and re-sends its httpOnly cookie, and only once the
 * session is due (a day into its 7-day lifetime). The page asks at most once
 * per interval, only while it is visible and someone has used it since the
 * last call, so an idle or hidden tab never keeps a session alive.
 */
export const KEEP_ALIVE_INTERVAL_MS = 5 * 60_000;
/** How often the page checks whether a call is due. */
export const KEEP_ALIVE_CHECK_MS = 60_000;
export const SESSION_REFRESH_PATH = "/api/auth/get-session";

export interface KeepAliveState {
  now: number;
  lastCallAt: number;
  lastActivityAt: number;
  visible: boolean;
}

export function keepAliveDue({
  now,
  lastCallAt,
  lastActivityAt,
  visible,
}: KeepAliveState): boolean {
  return visible && lastActivityAt > lastCallAt && now - lastCallAt >= KEEP_ALIVE_INTERVAL_MS;
}

/**
 * One call to the refresh route through the Next rewrite. The cookie travels
 * as an httpOnly cookie; this code never reads or holds the token.
 * `"signed-out"` means the API found no current session (revoked, expired
 * or signed out elsewhere) and extended nothing; `"unknown"` covers a
 * refusal, a rate limit or a network failure, and the next due check asks again.
 */
export async function callRefresh(
  request: typeof fetch = fetch,
): Promise<"active" | "signed-out" | "unknown"> {
  try {
    const response = await request(SESSION_REFRESH_PATH, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return "unknown";
    const body: unknown = await response.json();
    return body === null ? "signed-out" : "active";
  } catch {
    return "unknown";
  }
}
