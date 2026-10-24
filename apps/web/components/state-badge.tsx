import type { ActionState, CaseState } from "@supplier-disruption/contracts";
import { ACTION_STATE_LABELS, CASE_STATE_LABELS } from "../lib/format";
import { Badge } from "./ui/badge";

export function CaseStateBadge({ state }: { state: CaseState }) {
  const { label, tone } = CASE_STATE_LABELS[state];
  return (
    <Badge tone={tone} data-case-state={state}>
      {label}
    </Badge>
  );
}

export function ActionStateBadge({ state }: { state: ActionState }) {
  const { label, tone } = ACTION_STATE_LABELS[state];
  return (
    <Badge tone={tone} data-action-state={state}>
      {label}
    </Badge>
  );
}
