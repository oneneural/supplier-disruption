import { RecordedRunProvider } from "@supplier-disruption/agent";
import { DOMAIN_CONTRACT_VERSION, type DemonstrationControl } from "@supplier-disruption/contracts";
import type { CaseFaultHooks } from "../cases/workflow.js";
import { C01_RECORDED_RUN } from "./c01-recorded-run.js";

/**
 * The explicit demonstration mode (ADR 0012): `DOMAIN_CLOCK_MODE=demonstration`.
 * The business clock is the fixture clock row, which init seeds inside the
 * C-01 window and nothing advances; email extraction replays the recorded
 * C-01 run with no model call; and two labelled controls stand in for events
 * a live demonstration cannot wait for. Nothing here is reachable in any
 * other mode.
 */
export const DEMONSTRATION_NOTICE =
  "Demonstration mode. Simulated business clock fixed inside the C-01 fixture window; " +
  "email extraction replays a recorded model run (no model call); simulated actors and fixture source adapters.";

export const DEMONSTRATION_CONTROLS: readonly DemonstrationControl[] = [
  "foreign_reservation",
  "uncertain_reservation_write",
];

/** Another order's reservation at the transfer source: the SPEC's stale-plan example. */
export const FOREIGN_RESERVATION = {
  contractVersion: DOMAIN_CONTRACT_VERSION,
  kind: "reserve",
  operationId: "DEMO-FOREIGN-ORDER-1",
  planId: "DEMO-FOREIGN-ORDER",
  actionId: "DEMO-1",
  sku: "PART-A",
  warehouse: "WH-B",
  uom: "EA",
  quantity: "20",
} as const;

/** The action whose response the uncertain-write control loses: the source reservation. */
const UNCERTAIN_ACTION = "ACT-2";

export class Demonstration {
  readonly provider = new RecordedRunProvider(C01_RECORDED_RUN.exchanges);
  readonly #armed = new Set<string>();

  /**
   * Loses the response of the next ACT-2 reservation write of an armed case
   * once, after the source committed it. The workflow then records the action
   * `unknown` and reconciles it by operation ID and read-back before any retry.
   * The arming lives in this API process only; a restart disarms it.
   */
  readonly faults: CaseFaultHooks = {
    afterSourceWrite: ({ caseId, actionId }) => {
      if (actionId !== UNCERTAIN_ACTION || !this.#armed.delete(caseId)) return Promise.resolve();
      return Promise.reject(
        new Error("demonstration control: the reservation response was lost after the commit"),
      );
    },
  };

  arm(caseId: string): void {
    this.#armed.add(caseId);
  }
}
