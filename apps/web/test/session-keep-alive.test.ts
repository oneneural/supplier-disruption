import { describe, expect, it } from "vitest";
import {
  KEEP_ALIVE_INTERVAL_MS,
  SESSION_REFRESH_PATH,
  callRefresh,
  keepAliveDue,
} from "../lib/session-keep-alive";

describe("keepAliveDue", () => {
  const base = {
    now: 10 * KEEP_ALIVE_INTERVAL_MS,
    lastCallAt: 0,
    lastActivityAt: 1,
    visible: true,
  };

  it("is due for a visible page used since the last call, once the interval passed", () => {
    expect(keepAliveDue(base)).toBe(true);
  });

  it("is never due for a hidden page, an idle page or within the interval", () => {
    expect(keepAliveDue({ ...base, visible: false })).toBe(false);
    expect(keepAliveDue({ ...base, lastCallAt: 5, lastActivityAt: 4 })).toBe(false);
    expect(
      keepAliveDue({
        ...base,
        lastCallAt: base.now - KEEP_ALIVE_INTERVAL_MS + 1,
        lastActivityAt: base.now,
      }),
    ).toBe(false);
  });
});

describe("callRefresh", () => {
  const answering = (answer: Response | Error) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const request = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }) as typeof fetch;
    return { request, calls };
  };

  it("calls the refresh route through the same origin with the cookie only", async () => {
    const { request, calls } = answering(Response.json({ session: {}, user: {} }));
    expect(await callRefresh(request)).toBe("active");
    expect(calls).toEqual([
      { url: SESSION_REFRESH_PATH, init: { credentials: "same-origin", cache: "no-store" } },
    ]);
  });

  it("reports a missing session as signed out and anything else as unknown", async () => {
    expect(await callRefresh(answering(Response.json(null)).request)).toBe("signed-out");
    expect(await callRefresh(answering(new Response(null, { status: 429 })).request)).toBe(
      "unknown",
    );
    expect(await callRefresh(answering(new TypeError("network")).request)).toBe("unknown");
  });
});
