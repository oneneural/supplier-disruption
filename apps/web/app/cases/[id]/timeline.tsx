import type { CaseDetail } from "@supplier-disruption/contracts";
import { ActionStateBadge } from "../../../components/state-badge";
import { Notice, Panel } from "../../../components/ui/panel";
import { Table, Td, Th } from "../../../components/ui/table";
import { codeLabel, instant, roleLabel, shortHash } from "../../../lib/format";

const ACTION_KINDS: Record<string, string> = {
  amend_schedule: "Amend PO schedule",
  reserve: "Reserve stock",
  create_transfer_request: "Request transfer",
};

function Json({ value }: { value: unknown }) {
  return (
    <pre className="mt-1 max-h-64 overflow-auto rounded-[var(--radius-control)] bg-surface-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function receiptLine(receipt: Record<string, unknown>): string {
  const id = typeof receipt.receiptId === "string" ? receipt.receiptId : "unknown";
  const at = typeof receipt.recordedAt === "string" ? instant(receipt.recordedAt) : "unknown time";
  return `Receipt ${id} at ${at}`;
}

export function ActionTimelinePanel({ detail }: { detail: CaseDetail }) {
  const plan = detail.plan;
  const actions = detail.actions.filter(
    (action) => plan === null || action.planSha256 === plan.sha256,
  );
  const earlier = detail.actions.filter(
    (action) => plan !== null && action.planSha256 !== plan.sha256,
  );
  // Only a current read-back shows as verified (ADR 0015); the verification panel keeps the rest.
  const verified =
    detail.case.state === "plan_verified" && detail.verificationStatus.status === "current";
  return (
    <Panel
      id="actions"
      title="Action timeline"
      description="Each plan action, its source effect and the record read back to verify it."
    >
      {actions.length === 0 ? (
        <p className="text-sm">No planned action.</p>
      ) : (
        <Table label="Plan actions">
          <thead>
            <tr>
              <Th>Action</Th>
              <Th>Effect</Th>
              <Th>Operation</Th>
              <Th className="text-right">Attempts</Th>
              <Th>Receipt and read-back</Th>
            </tr>
          </thead>
          <tbody>
            {actions.map((action) => (
              <tr key={action.operationId} data-action-id={action.actionId}>
                <Td>
                  <span className="font-mono font-semibold">{action.actionId}</span>{" "}
                  {ACTION_KINDS[action.kind] ?? action.kind}
                </Td>
                <Td>
                  <ActionStateBadge state={action.state} />
                  {action.reason !== null && (
                    <span className="mt-1 block text-xs">{codeLabel(action.reason)}</span>
                  )}
                </Td>
                <Td className="font-mono text-xs">{action.operationId}</Td>
                <Td className="text-right">{action.attempts}</Td>
                <Td className="text-xs">
                  {action.receipt === null ? (
                    <span className="text-muted">No receipt</span>
                  ) : (
                    <details>
                      <summary className="cursor-pointer">{receiptLine(action.receipt)}</summary>
                      <Json value={action.receipt} />
                    </details>
                  )}
                  {action.readback !== null && (
                    <details className="mt-1" data-readback={action.actionId}>
                      <summary className="cursor-pointer">Read-back evidence</summary>
                      <Json value={action.readback} />
                    </details>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {earlier.length > 0 && (
        <p className="mt-2 text-xs text-muted">
          {earlier.length} action rows of earlier plan versions are kept in history and not shown
          here.
        </p>
      )}

      <div className="mt-4 space-y-3">
        {verified && detail.verification !== null ? (
          <Notice tone="verified" data-verification="plan_verified">
            <p className="font-semibold">Plan verified by read-back of the source records.</p>
            <details className="mt-1">
              <summary className="cursor-pointer">Read-back verification evidence</summary>
              <Json value={detail.verification} />
            </details>
          </Notice>
        ) : detail.verificationStatus.lastVerified !== null ? (
          <p className="text-sm text-muted">
            Not currently verified ({codeLabel(detail.verificationStatus.status)}). The earlier
            read-back evidence stays in the verification history.
          </p>
        ) : (
          <p className="text-sm text-muted">
            Not verified: the plan is verified only after every action is confirmed and the source
            records are read back.
          </p>
        )}
        <Notice tone="warning" data-physical-delivery>
          <p className="font-semibold">Physical delivery is not recorded.</p>
          <p>
            Supplier receipt: {codeLabel(detail.physicalDelivery.supplierReceipt)}. Transfer
            receipt: {codeLabel(detail.physicalDelivery.transferReceipt)}.{" "}
            {detail.physicalDelivery.note}
          </p>
        </Notice>
      </div>
    </Panel>
  );
}

export function HistoryPanel({ detail }: { detail: CaseDetail }) {
  return (
    <Panel
      id="history"
      title="Case history"
      description="Every recorded transition, decision, attempt and read-back, in order. Nothing is deleted."
    >
      <ol className="space-y-2 text-sm" aria-label="Case events">
        {detail.timeline.map((event) => (
          <li
            key={event.sequence}
            className="grid gap-1 border-b border-border pb-2 sm:grid-cols-[3rem_11rem_1fr]"
            data-event-kind={event.kind}
          >
            <span className="font-mono text-xs text-muted">#{event.sequence}</span>
            <span className="text-xs text-muted">{instant(event.occurredAt)}</span>
            <div>
              <span className="font-medium">{codeLabel(event.kind)}</span>
              {event.toState !== null && (
                <span>
                  {" "}
                  {event.fromState === null ? "" : `${codeLabel(event.fromState)} to `}
                  {codeLabel(event.toState)}
                </span>
              )}
              {event.reason !== null && <span>. Reason: {codeLabel(event.reason)}</span>}
              {event.owner !== null && <span>. Owner: {roleLabel(event.owner)}</span>}
              {event.actorId !== null && (
                <span>
                  . Simulated actor <span className="font-mono">{event.actorId}</span>
                </span>
              )}
              {Object.keys(event.detail).length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted">Details</summary>
                  <Json value={event.detail} />
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-muted">
        Plans:{" "}
        {detail.plans
          .map(
            (item) =>
              `${item.planId} v${String(item.planVersion)} ${shortHash(item.sha256)}${item.current ? " (current)" : ""}`,
          )
          .join(", ") || "none"}
      </p>
    </Panel>
  );
}
