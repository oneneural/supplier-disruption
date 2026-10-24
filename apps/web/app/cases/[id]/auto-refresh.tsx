"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const INTERVAL_MS = 1000;

/**
 * Re-reads the case from the API while the worker is applying or verifying
 * it. The page shows only what the API returns; a stopped refresh never turns
 * a pending effect into a completed one.
 */
export function AutoRefresh({ active, label }: { active: boolean; label: string }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return (
    <p role="status" aria-live="polite" className="text-sm text-muted" data-live={active}>
      {active ? label : "Showing the last read of the case. Reload for newer records."}
    </p>
  );
}
