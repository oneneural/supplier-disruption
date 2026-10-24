import type { CaseDetail, SupplyRef } from "@supplier-disruption/contracts";
import { Badge } from "../../../components/ui/badge";
import { Notice, Panel } from "../../../components/ui/panel";
import { Table, Td, Th } from "../../../components/ui/table";
import { arrival, codeLabel, knowable, roleLabel } from "../../../lib/format";

function supplyLabel(supply: SupplyRef): string {
  switch (supply.kind) {
    case "stock":
      return `Stock ${supply.warehouse} (${supply.stockVersion})`;
    case "po_segment":
      return `${supply.poNumber} line ${supply.poLine} rev ${supply.revision} segment ${String(supply.sequence)}, ${supply.projection}`;
    case "transfer_option":
      return `Transfer option ${supply.optionId} (based on ${supply.basedOn})`;
    case "in_transit":
      return `In transit ${supply.transitId}`;
    case "prior_commitment":
      return `${supply.planId} ${supply.commitmentId} transfer ${supply.requestId ?? "(request not found)"}, already committed`;
  }
}

function Stat({
  label,
  value,
  uom,
  id,
}: {
  label: string;
  value: string;
  uom: string;
  id: string;
}) {
  return (
    <div className="rounded-[var(--radius-control)] border border-border bg-surface-muted px-4 py-3">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums" data-total={id}>
        {value} <span className="text-sm font-normal text-muted">{uom}</span>
      </dd>
    </div>
  );
}

export function ImpactPanel({ detail }: { detail: CaseDetail }) {
  const { impact } = detail;
  if (impact === null) {
    return (
      <Panel id="impact" title="Demand impact">
        <Notice tone="warning">
          No assessment yet. The case reason names the evidence that is missing.
        </Notice>
      </Panel>
    );
  }
  const { totals } = impact;
  const uom = totals.uom ?? "";
  // Present only for a later revision of a verified case (ADR 0015).
  const prior = totals.priorCommitment;
  return (
    <Panel
      id="impact"
      title="Demand impact"
      description="Customer commitments against eligible supply, before and after the conditional transfer."
    >
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          id="pre-transfer-coverage"
          label="Covered before transfer"
          value={knowable(totals.preTransferCoverage)}
          uom={uom}
        />
        <Stat
          id="pre-transfer-shortage"
          label="Shortage before transfer"
          value={knowable(totals.preTransferShortage)}
          uom={uom}
        />
        {prior !== undefined && (
          <Stat
            id="prior-commitment"
            label="Covered by earlier committed transfers"
            value={knowable(prior)}
            uom={uom}
          />
        )}
        <Stat
          id="conditional-transfer"
          label="Covered by conditional transfer"
          value={knowable(totals.conditionalTransfer)}
          uom={uom}
        />
        <Stat
          id="conditional-shortage"
          label="Shortage after transfer"
          value={knowable(totals.conditionalShortage)}
          uom={uom}
        />
      </dl>
      <p className="mt-2 text-xs text-muted">
        Open demand {knowable(totals.demandOpen)} {uom}.
      </p>

      <h3 className="mt-5 mb-2 text-sm font-semibold">Demand lines</h3>
      <Table label="Demand lines">
        <thead>
          <tr>
            <Th>Sales order</Th>
            <Th>Priority</Th>
            <Th>Item</Th>
            <Th className="text-right">Open</Th>
            <Th>Receipt cutoff</Th>
            <Th className="text-right">Covered before transfer</Th>
            <Th className="text-right">Gap before transfer</Th>
            {prior !== undefined && <Th className="text-right">Earlier committed transfer</Th>}
            <Th className="text-right">Conditional transfer</Th>
            <Th className="text-right">Gap after transfer</Th>
          </tr>
        </thead>
        <tbody>
          {impact.demand.map((line) => (
            <tr key={`${line.salesOrder}-${line.line}`}>
              <Td className="font-mono">
                {line.salesOrder}/{line.line}
              </Td>
              <Td>{line.priority}</Td>
              <Td>
                {line.sku} to {line.destination}
              </Td>
              <Td className="text-right">
                {line.open} {line.uom}
              </Td>
              <Td>{line.receiptCutoff}</Td>
              <Td className="text-right">{knowable(line.preTransferCovered)}</Td>
              <Td className="text-right">{knowable(line.preTransferGap)}</Td>
              {prior !== undefined && (
                <Td className="text-right">{knowable(line.priorCommitment)}</Td>
              )}
              <Td className="text-right">{knowable(line.conditionalTransfer)}</Td>
              <Td className="text-right">{knowable(line.conditionalGap)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <h3 className="mt-5 mb-2 text-sm font-semibold">Eligible stock</h3>
      <Table label="Eligible stock by warehouse">
        <thead>
          <tr>
            <Th>Warehouse</Th>
            <Th className="text-right">Physical</Th>
            <Th className="text-right">Quality hold</Th>
            <Th className="text-right">Safety stock</Th>
            <Th>Unrelated reservations (kept)</Th>
            <Th className="text-right">Eligible</Th>
          </tr>
        </thead>
        <tbody>
          {impact.eligibility.map((row) =>
            row.state === "known" ? (
              <tr key={row.warehouse}>
                <Td>
                  {row.warehouse} <span className="text-xs text-muted">({row.stockVersion})</span>
                </Td>
                <Td className="text-right">{row.physical}</Td>
                <Td className="text-right">{row.qualityHold}</Td>
                <Td className="text-right">{row.safetyStock}</Td>
                <Td>
                  {row.unrelatedReservations.length === 0
                    ? "none"
                    : row.unrelatedReservations
                        .map((item) => `${item.reservationId} ${item.quantity}`)
                        .join(", ")}
                  {row.commitmentReservations !== undefined && (
                    <span className="block text-xs" data-commitment-reservations>
                      Committed by an earlier plan, counted once:{" "}
                      {row.commitmentReservations
                        .map((item) => `${item.reservationId} ${item.quantity} (${item.planId})`)
                        .join(", ")}
                    </span>
                  )}
                </Td>
                <Td className="text-right font-semibold">
                  {row.eligible} {row.uom}
                </Td>
              </tr>
            ) : (
              <tr key={row.warehouse}>
                <Td>{row.warehouse}</Td>
                <Td colSpan={5}>Unknown: {codeLabel(row.reason)}</Td>
              </tr>
            ),
          )}
        </tbody>
      </Table>

      <h3 className="mt-5 mb-2 text-sm font-semibold">Supply considered</h3>
      <Table label="Supply considered">
        <thead>
          <tr>
            <Th>Supply</Th>
            <Th className="text-right">Quantity</Th>
            <Th>Arrival</Th>
            <Th className="text-right">Allocated</Th>
            <Th>Outcome</Th>
          </tr>
        </thead>
        <tbody>
          {impact.supply.map((bucket, index) => (
            <tr key={index}>
              <Td>{supplyLabel(bucket.supply)}</Td>
              <Td className="text-right">
                {bucket.quantity} {bucket.uom}
              </Td>
              <Td>{arrival(bucket.arrival)}</Td>
              <Td className="text-right">{bucket.allocated}</Td>
              <Td>
                {codeLabel(bucket.disposition)}
                {bucket.reason !== null && (
                  <span className="block text-xs text-muted">{codeLabel(bucket.reason)}</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <h3 className="mt-5 mb-2 text-sm font-semibold">Shortfalls</h3>
      {impact.shortfalls.length === 0 ? (
        <p className="text-sm">No shortfall.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {impact.shortfalls.map((item, index) => (
            <li key={index} className="flex flex-wrap items-center gap-2">
              <Badge tone={item.stage === "conditional" ? "blocked" : "warning"}>
                {item.stage === "conditional" ? "After transfer" : "Before transfer"}
              </Badge>
              <span>
                {item.quantity} {item.uom} short on {item.demandLine.salesOrder}/
                {item.demandLine.line} by {item.receiptCutoff}: {codeLabel(item.reason)}. Owner:{" "}
                {roleLabel(item.owner)}.
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
