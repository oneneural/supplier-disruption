import {
  DOMAIN_CONTRACT_VERSION,
  demandSnapshotSchema,
  type DemandSnapshot,
  type Instant,
} from "@supplier-disruption/contracts";
import type pg from "pg";
import { SourceRejectedError, readTransaction, type SourceOptions } from "../runtime.js";
import { instantFromPostgres, knownFromColumn } from "../values.js";

/** A demand version as read, with the current version and the business time of the read. */
export interface DemandRead {
  readAt: Instant;
  currentVersion: string;
  record: DemandSnapshot;
}

/** Read-only: no runtime method changes demand, its supply links or customer promises. */
export interface DemandSource {
  /** The order system's current version, or a specific retained one. */
  readDemand(query: { organization: string; version?: string }): Promise<DemandRead>;
}

async function currentVersion(client: pg.PoolClient, organization: string): Promise<string> {
  const { rows } = await client.query<{ version: string }>(
    "SELECT version FROM fixture_demand.demand_head WHERE organization = $1",
    [organization],
  );
  const [head] = rows;
  if (head === undefined) {
    throw new SourceRejectedError("demand", "source.not_found", `${organization} has no demand`);
  }
  return head.version;
}

async function loadSnapshot(
  client: pg.PoolClient,
  organization: string,
  version: string,
): Promise<DemandSnapshot | null> {
  const { rows } = await client.query<{ observed_at: string | null }>(
    `SELECT observed_at::text AS observed_at FROM fixture_demand.demand_snapshot
      WHERE version = $1 AND organization = $2`,
    [version, organization],
  );
  const [snapshot] = rows;
  if (snapshot === undefined) return null;
  const { rows: lines } = await client.query<{
    sales_order: string;
    line: string;
    sku: string;
    uom: string;
    open_quantity: string;
    delivered_quantity: string | null;
    destination: string;
    receipt_cutoff: string;
    calendar_policy_id: string;
    calendar_policy_version: number;
    priority: number;
  }>(
    `SELECT sales_order, line, sku, uom, open_quantity::text AS open_quantity,
            delivered_quantity::text AS delivered_quantity, destination,
            receipt_cutoff::text AS receipt_cutoff, calendar_policy_id, calendar_policy_version,
            priority
       FROM fixture_demand.demand_line WHERE version = $1 ORDER BY sales_order, line`,
    [version],
  );
  const { rows: links } = await client.query<{
    sales_order: string;
    line: string;
    po_number: string;
    po_line: string;
  }>(
    `SELECT sales_order, line, po_number, po_line FROM fixture_demand.supply_link
      WHERE version = $1 ORDER BY sales_order, line, po_number, po_line`,
    [version],
  );
  return demandSnapshotSchema.parse({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    organization,
    version,
    observedAt: knownFromColumn(
      snapshot.observed_at === null ? null : instantFromPostgres(snapshot.observed_at),
    ),
    lines: lines.map((line) => ({
      salesOrder: line.sales_order,
      line: line.line,
      sku: line.sku,
      uom: line.uom,
      open: line.open_quantity,
      delivered: knownFromColumn(line.delivered_quantity),
      destination: line.destination,
      receiptCutoff: line.receipt_cutoff,
      calendar: { policyId: line.calendar_policy_id, version: line.calendar_policy_version },
      priority: line.priority,
      // Explicit links only; a PO link carries no revision and survives amendments.
      supplyLinks: links
        .filter((link) => link.sales_order === line.sales_order && link.line === line.line)
        .map((link) => ({ poNumber: link.po_number, poLine: link.po_line })),
    })),
  });
}

/** The fixture demand authority's read-only runtime module; see ADR 0005. */
export function createDemandSource(options: SourceOptions): DemandSource {
  return {
    async readDemand(query) {
      const readAt = await options.clock.now();
      return readTransaction(options, async (client) => {
        const current = await currentVersion(client, query.organization);
        const version = query.version ?? current;
        const record = await loadSnapshot(client, query.organization, version);
        if (record === null) {
          throw new SourceRejectedError(
            "demand",
            "source.not_found",
            `${query.organization} has no demand version ${version}`,
          );
        }
        return { readAt, currentVersion: current, record };
      });
    },
  };
}
