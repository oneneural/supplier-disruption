"use client";

import { useEffect } from "react";
import { KEEP_ALIVE_CHECK_MS, callRefresh, keepAliveDue } from "../lib/session-keep-alive";

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "scroll"] as const;

/**
 * Refreshes the signed-in session while someone is using the page. It
 * renders nothing and stops for good once the API reports no session, so a
 * revoked or expired session is never retried, let alone extended.
 */
export function SessionKeepAlive() {
  useEffect(() => {
    let lastCallAt = 0;
    // Loading the page is activity: the first due check calls the refresh route.
    let lastActivityAt = Date.now();
    let inFlight = false;
    const onActivity = () => {
      lastActivityAt = Date.now();
    };
    const stop = () => {
      clearInterval(timer);
      for (const name of ACTIVITY_EVENTS)
        window.removeEventListener(name, onActivity, { capture: true });
    };
    const check = async () => {
      const due = keepAliveDue({
        now: Date.now(),
        lastCallAt,
        lastActivityAt,
        visible: document.visibilityState === "visible",
      });
      if (!due || inFlight) return;
      inFlight = true;
      lastCallAt = Date.now();
      const result = await callRefresh();
      inFlight = false;
      if (result === "signed-out") stop();
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onActivity, { passive: true, capture: true });
    }
    const timer = setInterval(() => void check(), KEEP_ALIVE_CHECK_MS);
    return stop;
  }, []);
  return null;
}
