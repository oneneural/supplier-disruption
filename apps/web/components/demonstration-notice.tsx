import type { DemonstrationStatus } from "@supplier-disruption/contracts";
import { instant } from "../lib/format";

/** The labelled demonstration mode: the simulated business clock and what is replayed. */
export function DemonstrationNotice({ status }: { status: DemonstrationStatus }) {
  if (!status.active) return null;
  return (
    <p
      className="border-b border-warning-fg/30 bg-warning-bg px-4 py-1.5 text-center text-sm text-warning-fg"
      role="note"
      data-demonstration-clock={status.businessClock}
    >
      <strong>Simulated business clock: {instant(status.businessClock)}.</strong> {status.notice}
    </p>
  );
}
