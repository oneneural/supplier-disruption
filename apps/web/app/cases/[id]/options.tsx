import type { CaseDetail } from "@supplier-disruption/contracts";
import { Badge, type Tone } from "../../../components/ui/badge";
import { Notice, Panel } from "../../../components/ui/panel";
import { Table, Td, Th } from "../../../components/ui/table";
import { arrival, codeLabel, instant, money, roleLabel, shortHash } from "../../../lib/format";

const OPTION_STATUS: Record<string, { label: string; tone: Tone }> = {
  supported: { label: "Feasible", tone: "verified" },
  blocked: { label: "Disallowed", tone: "blocked" },
  unknown: { label: "Feasibility unknown", tone: "warning" },
  not_needed: { label: "Not needed", tone: "neutral" },
};

const DECISION_LABELS: Record<string, string> = {
  approval: "Plan approval",
  supplier_acknowledgement: "Supplier acknowledgement",
  warehouse_planner_confirmation: "Warehouse planner confirmation",
};

export function OptionsPanel({ detail }: { detail: CaseDetail }) {
  const { options, plan } = detail;
  if (options === null || plan === null) {
    return (
      <Panel id="options" title="Recovery options">
        <Notice tone="warning">No plan has been proposed for this case.</Notice>
      </Panel>
    );
  }
  const { payload } = plan;
  const { authorization } = payload;
  const current = new Set(
    detail.decisions
      .filter(
        (decision) =>
          decision.planSha256 === plan.sha256 &&
          decision.outcome === "accepted" &&
          decision.status === "current",
      )
      .map((decision) => decision.kind),
  );
  return (
    <Panel
      id="options"
      title="Recovery options"
      description={`${payload.planId} version ${String(payload.planVersion)}, SHA-256 ${shortHash(plan.sha256)}. A plan is a proposal until it is approved, applied and read back.`}
    >
      <h3 className="mb-2 text-sm font-semibold">Transfer options</h3>
      {options.transferOptions.length === 0 ? (
        <p className="text-sm">No transfer option was offered.</p>
      ) : (
        <ul className="space-y-3">
          {options.transferOptions.map((option) => {
            const status = OPTION_STATUS[option.status] ?? {
              label: option.status,
              tone: "neutral" as const,
            };
            return (
              <li
                key={option.optionId}
                className="rounded-[var(--radius-control)] border border-border p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{option.optionId}</span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <span>
                    {option.terms.quantity} {option.terms.uom} {option.terms.sku} from{" "}
                    {option.terms.from} to {option.terms.to}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
                  <dt className="text-muted">Cost</dt>
                  <dd data-option-cost>{money(option.terms.cost)}</dd>
                  <dt className="text-muted">Dispatch and arrival</dt>
                  <dd>
                    {option.terms.dispatchDate} to {option.terms.arrivalDate}
                  </dd>
                  <dt className="text-muted">Quote valid until</dt>
                  <dd>{instant(option.terms.validUntil)}</dd>
                  <dt className="text-muted">Assigned in plan</dt>
                  <dd>
                    {option.assigned} {option.terms.uom}
                  </dd>
                  <dt className="text-muted">Evidence</dt>
                  <dd className="font-mono text-xs break-all">
                    based on {option.terms.basedOn}, terms SHA-256 {option.termsSha256}
                  </dd>
                  <dt className="text-muted">Owner</dt>
                  <dd>{roleLabel(option.terms.owner)}</dd>
                  {option.reasons.length > 0 && (
                    <>
                      <dt className="text-muted">Why</dt>
                      <dd>
                        {option.reasons
                          .map((item) => `${codeLabel(item.reason)} (${roleLabel(item.owner)})`)
                          .join("; ")}
                      </dd>
                    </>
                  )}
                </dl>
              </li>
            );
          })}
        </ul>
      )}

      {options.substitutes.length > 0 && (
        <>
          <h3 className="mt-5 mb-2 text-sm font-semibold">Substitute offers</h3>
          <ul className="space-y-2 text-sm">
            {options.substitutes.map((offer) => (
              <li key={offer.offerId} className="flex flex-wrap items-center gap-2">
                <Badge tone="blocked">Disallowed</Badge>
                <span>
                  {offer.offerId}: {offer.quantity} {offer.uom} {offer.sku}, arriving{" "}
                  {arrival(offer.arrival)}. {codeLabel(offer.reason)}; owner{" "}
                  {roleLabel(offer.owner)}. Customer acceptance of a substitute is never assumed.
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="mt-5 mb-2 text-sm font-semibold">Required approvals and confirmations</h3>
      <p className="mb-2 text-sm">
        Plan cost <strong data-plan-cost>{money(authorization.cost)}</strong> under{" "}
        {authorization.policy.policyId} version {authorization.policy.version}. Minimum approver:{" "}
        <strong>{roleLabel(authorization.minimumApproverRole)}</strong>.{" "}
        {authorization.currencyPermitted ? "" : "The currency is not permitted by the policy."}
      </p>
      <Table label="Approval limits">
        <thead>
          <tr>
            <Th>Role</Th>
            <Th className="text-right">Approval limit</Th>
            <Th>Covers this plan</Th>
          </tr>
        </thead>
        <tbody>
          {authorization.limits.map((limit) => (
            <tr key={limit.role}>
              <Td>{roleLabel(limit.role)}</Td>
              <Td className="text-right">
                {money({ minorUnits: limit.maxMinorUnits, currency: authorization.cost.currency })}
              </Td>
              <Td>
                {limit.maxMinorUnits >= authorization.cost.minorUnits ? (
                  <Badge tone="verified">Within limit</Badge>
                ) : (
                  <Badge tone="blocked">Over limit</Badge>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <ul className="mt-3 space-y-1 text-sm">
        {payload.decisions.map((required) => (
          <li key={required.kind} className="flex flex-wrap items-center gap-2">
            {current.has(required.kind) ? (
              <Badge tone="verified">Recorded</Badge>
            ) : (
              <Badge tone="warning">Outstanding</Badge>
            )}
            <span>
              {DECISION_LABELS[required.kind] ?? required.kind} by {roleLabel(required.role)} for{" "}
              <span className="font-mono">{required.subject}</span>
            </span>
          </li>
        ))}
      </ul>

      <h3 className="mt-5 mb-2 text-sm font-semibold">Unresolved assumptions</h3>
      {payload.assumptions.length === 0 ? (
        <p className="text-sm">None recorded.</p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {payload.assumptions.map((item) => (
            <li key={item}>
              {codeLabel(item)} <code className="text-xs text-muted">{item}</code>
            </li>
          ))}
        </ul>
      )}

      <details className="mt-5 text-sm">
        <summary className="cursor-pointer font-medium">
          Source versions the plan is bound to ({payload.bindings.length})
        </summary>
        <Table label="Source versions" className="mt-2">
          <thead>
            <tr>
              <Th>Source</Th>
              <Th>Key</Th>
              <Th>Version</Th>
              <Th>Read at</Th>
              <Th>Content SHA-256</Th>
            </tr>
          </thead>
          <tbody>
            {payload.bindings.map((binding) => (
              <tr key={`${binding.kind}-${binding.key}`}>
                <Td>{codeLabel(binding.kind)}</Td>
                <Td className="font-mono text-xs">{binding.key}</Td>
                <Td className="font-mono text-xs">{binding.version ?? "not returned"}</Td>
                <Td className="text-xs">{instant(binding.readAt)}</Td>
                <Td className="font-mono text-xs">{shortHash(binding.contentSha256)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </details>
    </Panel>
  );
}
