import type { CaseDetail, CaseEvidence } from "@supplier-disruption/contracts";
import { Badge } from "../../../components/ui/badge";
import { Notice, Panel } from "../../../components/ui/panel";
import { Table, Td, Th } from "../../../components/ui/table";
import { arrival, codeLabel, instant, locatorId } from "../../../lib/format";

type Leaf = { path: string; value: string };

/** Every scalar in the stored message with its JSON path, in document order. */
function leaves(value: unknown, path = ""): Leaf[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leaves(item, `${path}[${String(index)}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      leaves(item, path === "" ? key : `${path}.${key}`),
    );
  }
  return [{ path, value: typeof value === "string" ? value : JSON.stringify(value) }];
}

function parse(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

/** The element ID of one path inside one stored delivery. */
export function evidenceAnchor(deliveryIndex: number, path: string): string {
  return locatorId(`d${String(deliveryIndex)}-${path}`);
}

/** The element ID of one stored delivery, for links from questions and corrections. */
export function deliveryAnchor(deliveryId: string): string {
  return `delivery-${deliveryId}`;
}

/**
 * The index of the delivery whose bytes the case was assessed from: the
 * latest accepted one, which after a correction is the corrected input.
 */
export function assessedDelivery(evidence: CaseEvidence[], messageId?: string): number {
  const index = evidence.findLastIndex(
    (item) =>
      item.disposition === "accept" && (messageId === undefined || item.messageId === messageId),
  );
  return index < 0 ? 0 : index;
}

export function EvidencePanel({ evidence }: { evidence: CaseEvidence[] }) {
  return (
    <Panel
      id="evidence"
      title="Original supplier messages"
      description="The exact stored bytes of every delivery, reply and corrected input, shown as text. Nothing here is a summary."
    >
      {evidence.length === 0 ? (
        <Notice tone="warning">No stored delivery for this case.</Notice>
      ) : (
        <ol className="space-y-6">
          {evidence.map((item, index) => {
            const parsed = parse(item.content);
            return (
              <li
                key={item.deliveryId}
                id={deliveryAnchor(item.deliveryId)}
                className="space-y-3"
                data-disposition={item.disposition}
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono font-semibold">
                    {item.messageId}@{item.inputVersion}
                  </span>
                  <Badge tone={item.disposition === "accept" ? "verified" : "neutral"}>
                    {codeLabel(item.disposition)}
                  </Badge>
                  {item.reason !== null && <span>{codeLabel(item.reason)}</span>}
                  <span className="text-muted">received {instant(item.receivedAt)}</span>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-xs text-muted">
                  <dt>Delivery</dt>
                  <dd className="font-mono break-all">{item.deliveryId}</dd>
                  <dt>SHA-256</dt>
                  <dd className="font-mono break-all" data-evidence-sha256>
                    {item.contentSha256}
                  </dd>
                  <dt>Size</dt>
                  <dd>{item.byteLength} bytes</dd>
                </dl>
                {parsed === null ? (
                  <Notice tone="warning">
                    The stored bytes are not JSON; the raw text is below.
                  </Notice>
                ) : (
                  <Table label={`Fields of ${item.messageId} delivery ${String(index + 1)}`}>
                    <thead>
                      <tr>
                        <Th>Locator</Th>
                        <Th>Stored value</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaves(parsed).map((leaf) => (
                        <tr key={leaf.path} id={evidenceAnchor(index, leaf.path)}>
                          <Td className="font-mono text-xs break-all">{leaf.path}</Td>
                          <Td className="font-mono text-xs break-all">{leaf.value}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium">Raw stored text</summary>
                  <pre className="mt-2 max-h-80 overflow-auto rounded-[var(--radius-control)] bg-surface-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
                    {item.content}
                  </pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

interface FieldRow {
  field: string;
  current: string;
  proposed: string;
  path: string;
  changed: boolean;
}

export function FieldsPanel({ detail }: { detail: CaseDetail }) {
  const { fields, impact, evidence } = detail;
  if (fields === null) {
    return (
      <Panel id="fields" title="Current and proposed fields">
        <Notice tone="warning">
          No accepted proposal. The stored message is shown for review; the case reason says what is
          missing.
        </Notice>
      </Panel>
    );
  }
  const { terms } = fields.proposal;
  const accepted = (impact?.supply ?? []).filter(
    (bucket) => bucket.supply.kind === "po_segment" && bucket.supply.projection === "accepted",
  );
  const currentSegment = (sequence: number) => {
    const bucket = accepted.find(
      (item) => item.supply.kind === "po_segment" && item.supply.sequence === sequence,
    );
    return bucket === undefined
      ? "no segment"
      : `${bucket.quantity} ${bucket.uom}, arriving ${arrival(bucket.arrival)}`;
  };
  const delivery = assessedDelivery(evidence, fields.proposal.messageId);
  const rows: FieldRow[] = [
    {
      field: "Sender",
      current: `registered for ${fields.proposal.vendorId}`,
      proposed: fields.proposal.sender,
      path: "identity.sender",
      changed: false,
    },
    {
      field: "Purchase order and line",
      current:
        fields.current === null
          ? "unknown"
          : `${fields.current.key}, revision ${fields.current.version ?? "unknown"}`,
      proposed: `${terms.poNumber} line ${terms.poLine}`,
      path: "proposal.terms.poNumber",
      changed: false,
    },
    {
      field: "Base revision",
      current: fields.current?.currentVersion ?? "unknown",
      proposed: terms.baseRevision,
      path: "proposal.terms.baseRevision",
      changed: fields.current?.currentVersion !== terms.baseRevision,
    },
    {
      field: "Vendor item",
      current: "item master mapping",
      proposed: `${terms.vendorItem} (${fields.proposal.conversion.mappingId} v${String(fields.proposal.conversion.version)}, ${fields.proposal.conversion.numerator}:${fields.proposal.conversion.denominator})`,
      path: "proposal.terms.vendorItem",
      changed: false,
    },
    {
      field: "Unit of measure",
      current: accepted[0]?.uom ?? "unknown",
      proposed: terms.uom,
      path: "proposal.terms.uom",
      changed: accepted[0] !== undefined && accepted[0].uom !== terms.uom,
    },
    ...terms.segments.map((segment, index) => ({
      field: `Schedule segment ${String(segment.sequence)}`,
      current: currentSegment(segment.sequence),
      proposed: `${segment.quantity} ${terms.uom}, arriving ${arrival(segment.arrival)}`,
      path: `proposal.terms.segments[${String(index)}].quantity`,
      changed: true,
    })),
  ];
  return (
    <Panel
      id="fields"
      title="Current and proposed fields"
      description={`Proposal ${fields.proposal.proposalId} from ${fields.proposal.vendorId}. Each locator opens the stored value it came from.`}
    >
      <Table label="Current and proposed fields">
        <thead>
          <tr>
            <Th>Field</Th>
            <Th>Current record</Th>
            <Th>Supplier proposal</Th>
            <Th>Source locator</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field}>
              <Td className="font-medium">{row.field}</Td>
              <Td>{row.current}</Td>
              <Td>
                {row.proposed}
                {row.changed && (
                  <Badge tone="suggested" className="ml-2">
                    Proposed change
                  </Badge>
                )}
              </Td>
              <Td>
                <a
                  href={`#${evidenceAnchor(delivery, row.path)}`}
                  className="font-mono text-xs break-all text-accent underline underline-offset-4"
                >
                  {fields.proposal.evidenceRef} {row.path}
                </a>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {terms.unresolvedFields.length > 0 && (
        <Notice tone="warning" className="mt-3">
          Unresolved in the message: {terms.unresolvedFields.join(", ")}
        </Notice>
      )}
      <p className="mt-3 text-xs text-muted">
        A supplier proposal is not an accepted purchase-order amendment. The record changes only
        when the approved plan is applied and read back.
      </p>
    </Panel>
  );
}
