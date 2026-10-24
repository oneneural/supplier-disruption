import { randomUUID } from "node:crypto";
import {
  DOMAIN_CONTRACT_VERSION,
  createTransferRequestCommandSchema,
  inTransitRecordSchema,
  instantSchema,
  inventoryReceiptSchema,
  labelSchema,
  reserveStockCommandSchema,
  stockSnapshotSchema,
  transferOptionSchema,
  transferRequestSchema,
  uomSchema,
  type CreateTransferRequestCommand,
  type InTransitRecord,
  type Instant,
  type InventoryReceipt,
  type Reservation,
  type ReservationReceipt,
  type ReserveStockCommand,
  type StockSnapshot,
  type TransferOption,
  type TransferRequest,
  type TransferRequestReceipt,
} from "@supplier-disruption/contracts";
import type pg from "pg";
import type {
  CollectionBound,
  CompleteCollection,
  ReadFailureReason,
  ReadInvalidQuery,
  ReadNotFound,
  ReadOk,
  ReadScope,
  ReadUnavailable,
} from "../reads.js";
import {
  SourceRejectedError,
  claimOperation,
  readTransaction,
  requestDigest,
  writeTransaction,
  type SourceOptions,
  type SourceWriteResult,
} from "../runtime.js";
import { SourceDataError, instantFromPostgres, knownFromColumn } from "../values.js";

/**
 * How a stock version came to be. A version produced by a reservation names
 * its parent and the receipt that caused it; the oracle's `INV-B@1+ACT-2` is
 * the stored label `INV-B@1.ACT-2` with parent `INV-B@1` and `ACT-2`'s receipt.
 * The successor keeps its parent's observation time, so `recordedAt` is when
 * the reservation was added. Initial and externally maintained versions have
 * no causing receipt here.
 */
export interface StockLineage {
  parentVersion: string;
  receiptId: string;
  operationId: string;
  planId: string;
  actionId: string;
  recordedAt: Instant;
}

/** A stock snapshot as read, with the current version and the business time of the read. */
export interface StockRead {
  readAt: Instant;
  currentVersion: string;
  record: StockSnapshot;
  lineage: StockLineage | null;
}

export interface TransferOptionRead {
  readAt: Instant;
  record: TransferOption;
}

export interface TransferOptionsQuery {
  organization: string;
  sku: string;
  uom: string;
  fromWarehouse: string;
  toWarehouse: string;
}

/** The exact scope of a transfer-option collection and its fixed bound. */
export interface TransferOptionsScope extends ReadScope<
  "inventory",
  "transfer_options",
  Omit<TransferOptionsQuery, "organization">
> {
  bound: CollectionBound;
}

/**
 * A complete scoped collection, the absence of a stock head that anchors the
 * scope, or unavailable evidence. Only `ok` says anything about which options
 * exist, and an empty `ok` only for these predicates at that read.
 */
export type TransferOptionsRead =
  | ReadOk<TransferOptionsScope, CompleteCollection<TransferOption>>
  | ReadNotFound<TransferOptionsScope, "scope_anchor_not_found">
  | ReadUnavailable<TransferOptionsScope>
  | ReadInvalidQuery<TransferOptionsScope>;

/** Dispatched transfers from or to a warehouse: neither source nor destination physical stock. */
export interface InTransitRead {
  readAt: Instant;
  records: InTransitRecord[];
}

export interface TransferRequestRead {
  readAt: Instant;
  record: TransferRequest;
}

/** A simulated warehouse observation of a requested transfer (ADR 0015). */
export interface TransferObservation {
  observationId: string;
  kind: "dispatched" | "received";
  quantity: string;
  observedOn: string;
  recordedAt: Instant;
}

/**
 * Every observation of one request, in kind order. An empty list means the
 * warehouse has observed neither dispatch nor receipt; it is not evidence
 * that the goods are still at the source.
 */
export interface TransferObservationsRead {
  readAt: Instant;
  records: TransferObservation[];
}

/**
 * An operation's native receipt and the records it affected as they are now.
 * A reservation is looked up in the warehouse's current stock version, so a
 * released reservation reads as null; a request is read from its own row. A
 * receipt is not a business acknowledgement or proof that records still match.
 */
export type InventoryOperationLookup =
  | {
      readAt: Instant;
      receipt: ReservationReceipt;
      currentVersion: string;
      reservation: Reservation | null;
    }
  | {
      readAt: Instant;
      receipt: TransferRequestReceipt;
      request: TransferRequest | null;
    };

export interface InventorySource {
  /** The current stock version of a SKU at a warehouse, or a specific retained one. */
  readStock(query: {
    organization: string;
    sku: string;
    warehouse: string;
    version?: string;
  }): Promise<StockRead>;
  readTransferOption(query: {
    organization: string;
    optionId: string;
  }): Promise<TransferOptionRead>;
  /**
   * Every option of exactly this SKU, unit and direction whose base stock
   * version belongs to the organization, including expired, late or
   * retained-base options, in option ID order. Nothing is filtered, ranked
   * or judged feasible; see ADR 0006.
   */
  readTransferOptions(query: TransferOptionsQuery): Promise<TransferOptionsRead>;
  readInTransit(query: {
    organization: string;
    sku: string;
    warehouse: string;
  }): Promise<InTransitRead>;
  readTransferRequest(query: {
    organization: string;
    requestId: string;
  }): Promise<TransferRequestRead>;
  /** Observations never change a request, a reservation or stock. */
  readTransferObservations(query: {
    organization: string;
    requestId: string;
  }): Promise<TransferObservationsRead>;
  /** Conditional reservation of eligible stock; see ADR 0005. */
  reserve(command: ReserveStockCommand): Promise<SourceWriteResult<ReservationReceipt>>;
  /**
   * The same conditional reservation recorded for demand outside any case
   * plan, as the warehouse system holds stock for other orders: the reserved
   * row carries no plan binding, so assessment deducts it as unrelated. The
   * receipt keeps the command's attribution. Only the demonstration's
   * simulated foreign source change uses it (ADR 0012).
   */
  reserveUnrelated(command: ReserveStockCommand): Promise<SourceWriteResult<ReservationReceipt>>;
  /** One requested transfer drawing on an existing plan reservation; see ADR 0005. */
  createTransferRequest(
    command: CreateTransferRequestCommand,
  ): Promise<SourceWriteResult<TransferRequestReceipt>>;
  /** Null when no committed operation has this ID. Absence alone never proves no effect. */
  lookupOperation(query: {
    organization: string;
    operationId: string;
  }): Promise<InventoryOperationLookup | null>;
}

const reject = (reason: ConstructorParameters<typeof SourceRejectedError>[1], message: string) =>
  new SourceRejectedError("inventory", reason, message);

const OPERATIONS = "fixture_inventory.operation";

async function headVersion(
  client: pg.PoolClient,
  key: { organization: string; sku: string; warehouse: string },
  lock: boolean,
): Promise<string> {
  const { rows } = await client.query<{ version: string }>(
    `SELECT version FROM fixture_inventory.stock_head
      WHERE organization = $1 AND sku = $2 AND warehouse = $3${lock ? " FOR UPDATE" : ""}`,
    [key.organization, key.sku, key.warehouse],
  );
  const [head] = rows;
  if (head === undefined) {
    throw reject(
      "source.not_found",
      `${key.organization} has no ${key.sku} stock at ${key.warehouse}`,
    );
  }
  return head.version;
}

async function loadSnapshot(
  client: pg.PoolClient,
  organization: string,
  version: string,
): Promise<StockSnapshot | null> {
  const { rows } = await client.query<{
    sku: string;
    warehouse: string;
    uom: string;
    observed_at: string | null;
    physical: string;
    quality_hold: string;
    safety_stock: string;
  }>(
    `SELECT sku, warehouse, uom, observed_at::text AS observed_at, physical::text AS physical,
            quality_hold::text AS quality_hold, safety_stock::text AS safety_stock
       FROM fixture_inventory.stock_snapshot WHERE version = $1 AND organization = $2`,
    [version, organization],
  );
  const [row] = rows;
  if (row === undefined) return null;
  const { rows: reservations } = await client.query<{
    reservation_id: string;
    quantity: string;
    plan_id: string | null;
  }>(
    `SELECT reservation_id, quantity::text AS quantity, plan_id
       FROM fixture_inventory.reservation WHERE snapshot_version = $1 ORDER BY reservation_id`,
    [version],
  );
  return stockSnapshotSchema.parse({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    organization,
    version,
    sku: row.sku,
    warehouse: row.warehouse,
    uom: row.uom,
    observedAt: knownFromColumn(
      row.observed_at === null ? null : instantFromPostgres(row.observed_at),
    ),
    physical: row.physical,
    qualityHold: row.quality_hold,
    safetyStock: row.safety_stock,
    reservations: reservations.map(toReservation),
  });
}

/** The snapshot a locked head names, which must be of the head's own SKU and warehouse. */
async function loadHeadSnapshot(
  client: pg.PoolClient,
  key: { organization: string; sku: string; warehouse: string },
  version: string,
): Promise<StockSnapshot> {
  const snapshot = await loadSnapshot(client, key.organization, version);
  if (snapshot?.sku !== key.sku || snapshot.warehouse !== key.warehouse) {
    throw new SourceDataError(
      `the ${key.sku} head at ${key.warehouse} names ${version}, which is not its stock`,
    );
  }
  return snapshot;
}

function toReservation(row: {
  reservation_id: string;
  quantity: string;
  plan_id: string | null;
}): Reservation {
  return {
    reservationId: row.reservation_id,
    quantity: row.quantity,
    binding: row.plan_id === null ? { kind: "unrelated" } : { kind: "plan", planId: row.plan_id },
  };
}

async function loadLineage(client: pg.PoolClient, version: string): Promise<StockLineage | null> {
  const { rows } = await client.query<{
    prior_version: string;
    receipt_id: string;
    operation_id: string;
    plan_id: string;
    action_id: string;
    recorded_at: string;
  }>(
    `SELECT prior_version, receipt_id, operation_id, plan_id, action_id,
            recorded_at::text AS recorded_at
       FROM fixture_inventory.operation_receipt WHERE successor_version = $1`,
    [version],
  );
  const [row] = rows;
  if (row === undefined) return null;
  return {
    parentVersion: row.prior_version,
    receiptId: row.receipt_id,
    operationId: row.operation_id,
    planId: row.plan_id,
    actionId: row.action_id,
    recordedAt: instantFromPostgres(row.recorded_at),
  };
}

interface ReceiptRow {
  receipt_id: string;
  operation_id: string;
  kind: "reserve" | "create_transfer_request";
  request_digest: string;
  plan_id: string;
  action_id: string;
  sku: string;
  warehouse: string;
  prior_version: string;
  successor_version: string | null;
  reservation_id: string;
  transfer_request_id: string | null;
  recorded_at: string;
  quantity: string;
  request_version: number | null;
}

const RECEIPT_SELECT = `
  SELECT r.receipt_id, r.operation_id, r.kind, o.request_digest, r.plan_id, r.action_id, r.sku,
         r.warehouse, r.prior_version, r.successor_version, r.reservation_id,
         r.transfer_request_id, r.recorded_at::text AS recorded_at, r.quantity::text AS quantity,
         r.request_version
    FROM fixture_inventory.operation_receipt r
    JOIN fixture_inventory.operation o USING (organization, operation_id)`;

/** Receipt fields are the values recorded at commit, never values edited since. */
function toReceipt(organization: string, row: ReceiptRow): InventoryReceipt {
  const base = {
    contractVersion: DOMAIN_CONTRACT_VERSION,
    receiptId: row.receipt_id,
    organization,
    operationId: row.operation_id,
    requestDigest: row.request_digest,
    planId: row.plan_id,
    actionId: row.action_id,
    recordedAt: instantFromPostgres(row.recorded_at),
    sku: row.sku,
    warehouse: row.warehouse,
    reservationId: row.reservation_id,
  };
  return inventoryReceiptSchema.parse(
    row.kind === "reserve"
      ? {
          ...base,
          kind: "reserve",
          priorVersion: row.prior_version,
          successorVersion: row.successor_version,
          quantity: row.quantity,
        }
      : {
          ...base,
          kind: "create_transfer_request",
          stockVersion: row.prior_version,
          transferRequestId: row.transfer_request_id,
          requestVersion: row.request_version,
        },
  );
}

async function loadReceipt(
  client: pg.PoolClient,
  organization: string,
  where: { operationId: string } | { receiptId: string },
): Promise<InventoryReceipt | null> {
  const { rows } = await client.query<ReceiptRow>(
    "operationId" in where
      ? `${RECEIPT_SELECT} WHERE r.organization = $1 AND r.operation_id = $2`
      : `${RECEIPT_SELECT} WHERE r.organization = $1 AND r.receipt_id = $2`,
    [organization, "operationId" in where ? where.operationId : where.receiptId],
  );
  const [row] = rows;
  return row === undefined ? null : toReceipt(organization, row);
}

async function replayed<Kind extends InventoryReceipt["kind"]>(
  client: pg.PoolClient,
  organization: string,
  operationId: string,
  kind: Kind,
): Promise<SourceWriteResult<Extract<InventoryReceipt, { kind: Kind }>>> {
  const receipt = await loadReceipt(client, organization, { operationId });
  if (receipt?.kind !== kind) throw new Error(`operation ${operationId} has no ${kind} receipt`);
  return { replayed: true, receipt: receipt as Extract<InventoryReceipt, { kind: Kind }> };
}

interface TransferOptionRow {
  option_id: string;
  sku: string;
  uom: string;
  from_warehouse: string;
  to_warehouse: string;
  quantity: string;
  dispatch_date: string;
  arrival_date: string;
  cost_minor_units: string;
  currency: string;
  valid_until: string;
  based_on: string;
  owner_role: string;
}

const TRANSFER_OPTION_SELECT = `
  SELECT o.option_id, o.sku, o.uom, o.from_warehouse, o.to_warehouse, o.quantity::text AS quantity,
         o.dispatch_date::text AS dispatch_date, o.arrival_date::text AS arrival_date,
         o.cost_minor_units::text AS cost_minor_units, o.currency,
         o.valid_until::text AS valid_until, o.based_on, o.owner_role`;

/** The contract input of a stored option, before validation. */
function transferOptionInput(row: TransferOptionRow) {
  return {
    contractVersion: DOMAIN_CONTRACT_VERSION,
    optionId: row.option_id,
    sku: row.sku,
    uom: row.uom,
    from: row.from_warehouse,
    to: row.to_warehouse,
    quantity: row.quantity,
    dispatchDate: row.dispatch_date,
    arrivalDate: row.arrival_date,
    // The column CHECK bounds it to safe integers, so Number is exact.
    cost: { minorUnits: Number(row.cost_minor_units), currency: row.currency },
    validUntil: instantFromPostgres(row.valid_until),
    basedOn: row.based_on,
    owner: row.owner_role,
  };
}

async function loadTransferOption(
  client: pg.PoolClient,
  organization: string,
  optionId: string,
): Promise<TransferOption | null> {
  // An option belongs to the organization that owns the stock version it is based on.
  const { rows } = await client.query<TransferOptionRow>(
    `${TRANSFER_OPTION_SELECT}
       FROM fixture_inventory.transfer_option o
       JOIN fixture_inventory.stock_snapshot s ON s.version = o.based_on
      WHERE o.option_id = $1 AND s.organization = $2`,
    [optionId, organization],
  );
  const [row] = rows;
  if (row === undefined) return null;
  return transferOptionSchema.parse(transferOptionInput(row));
}

async function loadTransferRequest(
  client: pg.PoolClient,
  organization: string,
  requestId: string,
): Promise<TransferRequest | null> {
  const { rows } = await client.query<{
    version: number;
    status: string;
    option_id: string;
    sku: string;
    uom: string;
    from_warehouse: string;
    to_warehouse: string;
    quantity: string;
    dispatch_date: string;
    arrival_date: string;
    stock_version: string;
    reservation_id: string;
    plan_id: string;
  }>(
    `SELECT version, status, option_id, sku, uom, from_warehouse, to_warehouse,
            quantity::text AS quantity, dispatch_date::text AS dispatch_date,
            arrival_date::text AS arrival_date, stock_version, reservation_id, plan_id
       FROM fixture_inventory.transfer_request WHERE request_id = $1 AND organization = $2`,
    [requestId, organization],
  );
  const [row] = rows;
  if (row === undefined) return null;
  return transferRequestSchema.parse({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    organization,
    requestId,
    version: row.version,
    status: row.status,
    optionId: row.option_id,
    sku: row.sku,
    uom: row.uom,
    from: row.from_warehouse,
    to: row.to_warehouse,
    quantity: row.quantity,
    dispatchDate: row.dispatch_date,
    arrivalDate: row.arrival_date,
    reservation: { stockVersion: row.stock_version, reservationId: row.reservation_id },
    planId: row.plan_id,
  });
}

const OPTIONS_BOUND: CollectionBound = 100;

/**
 * The stock unit of the organization's current head of this SKU at the
 * warehouse, or null without a head. A head naming a snapshot of another
 * organization, SKU or warehouse is invalid data.
 */
async function scopeAnchor(
  client: pg.PoolClient,
  key: { organization: string; sku: string; warehouse: string },
): Promise<string | null> {
  const { rows } = await client.query<{ version: string }>(
    `SELECT version FROM fixture_inventory.stock_head
      WHERE organization = $1 AND sku = $2 AND warehouse = $3`,
    [key.organization, key.sku, key.warehouse],
  );
  const [head] = rows;
  if (head === undefined) return null;
  return (await loadHeadSnapshot(client, key, head.version)).uom;
}

/** Classifies a failed collection read; nothing here is ever absence or an empty result. */
function unavailableReason(error: unknown, entered: boolean): ReadFailureReason {
  if (error instanceof SourceDataError) return "invalid_data";
  if (error instanceof Error && error.name === "ZodError") return "invalid_data";
  // Before the read ran, the pool, connection or BEGIN failed.
  if (!entered) return "connection_unavailable";
  const code = (error as { code?: unknown } | null)?.code;
  // lock_not_available (lock_timeout) and query_canceled (statement_timeout).
  if (code === "55P03" || code === "57014") return "read_timeout";
  if (code === "42501") return "permission_denied";
  if (typeof code === "string" && /^(08|57P)/.test(code)) return "connection_unavailable";
  return "read_failed";
}

const TRANSFER_OPTIONS_QUERY = {
  organization: labelSchema,
  sku: labelSchema,
  uom: uomSchema,
  fromWarehouse: labelSchema,
  toWarehouse: labelSchema,
} as const;

function validOptionsQuery(query: unknown): query is TransferOptionsQuery {
  if (typeof query !== "object" || query === null) return false;
  const names = Object.keys(TRANSFER_OPTIONS_QUERY) as Array<keyof typeof TRANSFER_OPTIONS_QUERY>;
  const fields = query as Record<string, unknown>;
  return (
    Object.keys(query).length === names.length &&
    names.every(
      (name) =>
        Object.hasOwn(query, name) && TRANSFER_OPTIONS_QUERY[name].safeParse(fields[name]).success,
    ) &&
    fields.fromWarehouse !== fields.toWarehouse
  );
}

/** ELIG-1's guard: physical minus holds, safety stock and each identified reservation once. */
function eligible(snapshot: StockSnapshot): bigint {
  return snapshot.reservations.reduce(
    (remaining, held) => remaining - BigInt(held.quantity),
    BigInt(snapshot.physical) - BigInt(snapshot.qualityHold) - BigInt(snapshot.safetyStock),
  );
}

/**
 * The fixture inventory and transfer authority's runtime module. Each method
 * runs in its own transaction on its own pooled connection; see ADR 0005.
 */
export function createInventorySource(options: SourceOptions): InventorySource {
  async function reserveStock(
    input: ReserveStockCommand,
    binding: "plan" | "unrelated",
  ): Promise<SourceWriteResult<ReservationReceipt>> {
    const command = reserveStockCommandSchema.parse(input);
    // An unrelated reservation never shares a request digest with a plan reservation.
    const digest =
      binding === "plan"
        ? requestDigest(command)
        : requestDigest({ ...command, binding } as { operationId: string });
    return writeTransaction(options, async (client) => {
      const claim = await claimOperation(client, "inventory", OPERATIONS, {
        organization: command.organization,
        operationId: command.operationId,
        kind: command.kind,
        digest,
      });
      if (claim === "replay") {
        return replayed(client, command.organization, command.operationId, "reserve");
      }

      // Lock order: operation identity (above), then the stock head.
      const base = await headVersion(client, command, true);
      if (base !== command.expectedVersion) {
        throw reject(
          "stale_source_stock",
          `${command.sku} at ${command.warehouse} is at ${base}, not ${command.expectedVersion}`,
        );
      }
      // Business time of the accepted change, sampled while the head is held.
      const recordedAt = await options.clock.now();
      const snapshot = await loadHeadSnapshot(client, command, base);
      if (snapshot.uom !== command.uom) {
        throw reject("source.uom_mismatch", `stock is in ${snapshot.uom}, not ${command.uom}`);
      }
      const available = eligible(snapshot);
      if (available < BigInt(command.quantity)) {
        throw reject(
          "inventory.insufficient_eligible_stock",
          `eligible ${available} at ${base} is less than ${command.quantity}`,
        );
      }
      const successor = `${base}.${command.actionId}`;
      const taken = await client.query(
        "SELECT 1 FROM fixture_inventory.stock_snapshot WHERE version = $1",
        [successor],
      );
      if (!labelSchema.safeParse(successor).success || (taken.rowCount ?? 0) > 0) {
        throw reject(
          "inventory.version_label_unavailable",
          `cannot label a successor ${successor}`,
        );
      }

      // Append the successor: the parent's buckets and reservations plus exactly this one.
      const reservationId = `RSV-${randomUUID()}`;
      await client.query(
        `INSERT INTO fixture_inventory.stock_snapshot
           (version, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock)
         SELECT $2, organization, sku, warehouse, uom, observed_at, physical, quality_hold, safety_stock
           FROM fixture_inventory.stock_snapshot WHERE version = $1`,
        [base, successor],
      );
      await client.query(
        `INSERT INTO fixture_inventory.reservation (snapshot_version, reservation_id, quantity, plan_id)
         SELECT $2, reservation_id, quantity, plan_id
           FROM fixture_inventory.reservation WHERE snapshot_version = $1`,
        [base, successor],
      );
      await client.query(
        `INSERT INTO fixture_inventory.reservation (snapshot_version, reservation_id, quantity, plan_id)
         VALUES ($1, $2, $3, $4)`,
        [successor, reservationId, command.quantity, binding === "plan" ? command.planId : null],
      );
      // Compare-and-set: the head moves only from the base this transaction checked.
      const moved = await client.query(
        `UPDATE fixture_inventory.stock_head SET version = $5
          WHERE organization = $1 AND sku = $2 AND warehouse = $3 AND version = $4`,
        [command.organization, command.sku, command.warehouse, base, successor],
      );
      if (moved.rowCount !== 1) {
        throw new Error(`${command.sku} head at ${command.warehouse} moved from ${base}`);
      }
      await client.query(
        `INSERT INTO fixture_inventory.operation_receipt
           (receipt_id, organization, operation_id, kind, plan_id, action_id, sku, warehouse,
            prior_version, successor_version, reservation_id, quantity, transfer_request_id,
            request_version, recorded_at)
         VALUES ($1, $2, $3, 'reserve', $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL, $12)`,
        [
          randomUUID(),
          command.organization,
          command.operationId,
          command.planId,
          command.actionId,
          command.sku,
          command.warehouse,
          base,
          successor,
          reservationId,
          command.quantity,
          recordedAt,
        ],
      );
      const receipt = await loadReceipt(client, command.organization, command);
      if (receipt?.kind !== "reserve") throw new Error("reservation receipt was not recorded");
      return { replayed: false, receipt };
    });
  }

  return {
    async readStock(query) {
      const readAt = await options.clock.now();
      return readTransaction(options, async (client) => {
        const current = await headVersion(client, query, false);
        const version = query.version ?? current;
        const record = await loadSnapshot(client, query.organization, version);
        if (record === null || record.sku !== query.sku || record.warehouse !== query.warehouse) {
          throw reject(
            "source.not_found",
            `no stock version ${version} for ${query.sku} at ${query.warehouse}`,
          );
        }
        return {
          readAt,
          currentVersion: current,
          record,
          lineage: await loadLineage(client, version),
        };
      });
    },

    async readTransferOption(query) {
      const readAt = await options.clock.now();
      return readTransaction(options, async (client) => {
        const record = await loadTransferOption(client, query.organization, query.optionId);
        if (record === null) {
          throw reject(
            "source.not_found",
            `${query.organization} has no transfer option ${query.optionId}`,
          );
        }
        return { readAt, record };
      });
    },

    async readTransferOptions(query) {
      // An invalid query is still reported with the scope it attempted.
      const asked = (
        typeof query === "object" && query !== null ? query : {}
      ) as TransferOptionsQuery;
      const scope: TransferOptionsScope = {
        owner: "inventory",
        resource: "transfer_options",
        organization: asked.organization,
        selectors: {
          sku: asked.sku,
          uom: asked.uom,
          fromWarehouse: asked.fromWarehouse,
          toWarehouse: asked.toWarehouse,
        },
        bound: OPTIONS_BOUND,
      };
      const unavailable = (
        reason: ReadFailureReason,
        attemptedAt?: Instant,
      ): TransferOptionsRead => ({
        status: "unavailable",
        scope,
        reason,
        ...(attemptedAt === undefined ? {} : { attemptedAt }),
      });

      if (!validOptionsQuery(query))
        return { status: "unavailable", scope, reason: "invalid_query" };
      let readAt: Instant;
      try {
        readAt = await options.clock.now();
      } catch {
        return unavailable("clock_unavailable");
      }
      if (!instantSchema.safeParse(readAt).success) return unavailable("clock_unavailable");

      const progress = { entered: false };
      let outcome:
        | { kind: "ok"; records: TransferOption[] }
        | { kind: "anchor_missing" }
        | { kind: "bound_exceeded" };
      try {
        outcome = await readTransaction(options, async (client) => {
          progress.entered = true;
          // Both stock heads anchor the scope; without one there is no scope to be
          // empty. Heads that agree on another unit are no scope for this unit;
          // heads that disagree on the SKU's stock unit are inconsistent evidence.
          const [source, destination] = [
            await scopeAnchor(client, { ...query, warehouse: query.fromWarehouse }),
            await scopeAnchor(client, { ...query, warehouse: query.toWarehouse }),
          ];
          if (source === null || destination === null) return { kind: "anchor_missing" as const };
          if (source !== destination) {
            throw new SourceDataError(
              `${query.sku} stock is in ${source} at ${query.fromWarehouse} but ${destination} at ${query.toWarehouse}`,
            );
          }
          if (source !== query.uom) return { kind: "anchor_missing" as const };
          const { rows } = await client.query<
            TransferOptionRow & { base_sku: string; base_warehouse: string; base_uom: string }
          >(
            `${TRANSFER_OPTION_SELECT}, s.sku AS base_sku, s.warehouse AS base_warehouse,
                    s.uom AS base_uom
               FROM fixture_inventory.transfer_option o
               JOIN fixture_inventory.stock_snapshot s ON s.version = o.based_on
              WHERE o.sku = $2 AND o.uom = $3 AND o.from_warehouse = $4 AND o.to_warehouse = $5
                AND s.organization = $1
              ORDER BY o.option_id COLLATE "C" LIMIT $6`,
            [
              query.organization,
              query.sku,
              query.uom,
              query.fromWarehouse,
              query.toWarehouse,
              OPTIONS_BOUND + 1,
            ],
          );
          if (rows.length > OPTIONS_BOUND) return { kind: "bound_exceeded" as const };
          const records = rows.map((row) => {
            // Corrupt linkage is reported, never dropped to manufacture absence.
            if (
              row.base_sku !== row.sku ||
              row.base_warehouse !== row.from_warehouse ||
              row.base_uom !== row.uom
            ) {
              throw new SourceDataError(
                `transfer option ${row.option_id} is based on ${row.based_on}, which is not its stock`,
              );
            }
            const parsed = transferOptionSchema.safeParse(transferOptionInput(row));
            if (!parsed.success) {
              throw new SourceDataError(`stored transfer option ${row.option_id} is not valid`);
            }
            return parsed.data;
          });
          return { kind: "ok" as const, records };
        });
      } catch (error) {
        return unavailable(unavailableReason(error, progress.entered), readAt);
      }

      switch (outcome.kind) {
        case "ok":
          return {
            status: "ok",
            scope,
            readAt,
            observedAt: { state: "unknown" },
            data: { records: outcome.records, complete: true },
          };
        case "anchor_missing":
          return { status: "not_found", scope, readAt, reason: "scope_anchor_not_found" };
        case "bound_exceeded":
          return unavailable("collection_bound_exceeded", readAt);
      }
    },

    async readInTransit(query) {
      const readAt = await options.clock.now();
      return readTransaction(options, async (client) => {
        // In-transit records carry no organization; the warehouse's stock head scopes them.
        await headVersion(client, query, false);
        const { rows } = await client.query<{
          transit_id: string;
          uom: string;
          from_warehouse: string;
          to_warehouse: string;
          quantity: string;
          dispatched_on: string | null;
          arrival_date: string | null;
        }>(
          `SELECT transit_id, uom, from_warehouse, to_warehouse, quantity::text AS quantity,
                  dispatched_on::text AS dispatched_on, arrival_date::text AS arrival_date
             FROM fixture_inventory.in_transit
            WHERE sku = $1 AND (from_warehouse = $2 OR to_warehouse = $2) ORDER BY transit_id`,
          [query.sku, query.warehouse],
        );
        return {
          readAt,
          records: rows.map((row) =>
            inTransitRecordSchema.parse({
              contractVersion: DOMAIN_CONTRACT_VERSION,
              transitId: row.transit_id,
              sku: query.sku,
              uom: row.uom,
              from: row.from_warehouse,
              to: row.to_warehouse,
              quantity: row.quantity,
              dispatchedOn: knownFromColumn(row.dispatched_on),
              arrival:
                row.arrival_date === null
                  ? { state: "undated" }
                  : { state: "dated", date: row.arrival_date },
            }),
          ),
        };
      });
    },

    async readTransferRequest(query) {
      const readAt = await options.clock.now();
      return readTransaction(options, async (client) => {
        const record = await loadTransferRequest(client, query.organization, query.requestId);
        if (record === null) {
          throw reject(
            "source.not_found",
            `${query.organization} has no transfer request ${query.requestId}`,
          );
        }
        return { readAt, record };
      });
    },

    async readTransferObservations(query) {
      const readAt = await options.clock.now();
      return readTransaction(options, async (client) => {
        const { rows } = await client.query<{
          observation_id: string;
          kind: "dispatched" | "received";
          quantity: string;
          observed_on: string;
          recorded_at: string;
        }>(
          `SELECT observation_id, kind, quantity::text AS quantity, observed_on::text AS observed_on,
                  to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at
             FROM fixture_inventory.transfer_observation
            WHERE request_id = $1 AND organization = $2 ORDER BY kind, observation_id`,
          [query.requestId, query.organization],
        );
        return {
          readAt,
          records: rows.map((row) => ({
            observationId: row.observation_id,
            kind: row.kind,
            quantity: row.quantity,
            observedOn: row.observed_on,
            recordedAt: row.recorded_at,
          })),
        };
      });
    },

    reserve(input) {
      return reserveStock(input, "plan");
    },

    reserveUnrelated(input) {
      return reserveStock(input, "unrelated");
    },

    async createTransferRequest(input) {
      const command = createTransferRequestCommandSchema.parse(input);
      const digest = requestDigest(command);
      return writeTransaction(options, async (client) => {
        const claim = await claimOperation(client, "inventory", OPERATIONS, {
          organization: command.organization,
          operationId: command.operationId,
          kind: command.kind,
          digest,
        });
        if (claim === "replay") {
          return replayed(
            client,
            command.organization,
            command.operationId,
            "create_transfer_request",
          );
        }

        // Lock order: operation identity (above), then the source warehouse's
        // stock head, which every reservation change and linkage takes, so it
        // also serializes use of the bound reservation.
        const key = {
          organization: command.organization,
          sku: command.sku,
          warehouse: command.from,
        };
        const base = await headVersion(client, key, true);
        if (base !== command.expectedStockVersion) {
          throw reject(
            "stale_source_stock",
            `${command.sku} at ${command.from} is at ${base}, not ${command.expectedStockVersion}`,
          );
        }
        // Business time of the accepted request, sampled while the head is held.
        const recordedAt = await options.clock.now();
        const snapshot = await loadHeadSnapshot(client, key, base);
        const held = snapshot.reservations.find(
          (item) => item.reservationId === command.reservationId,
        );
        if (
          held === undefined ||
          held.binding.kind !== "plan" ||
          held.binding.planId !== command.planId ||
          held.quantity !== command.quantity ||
          snapshot.uom !== command.uom
        ) {
          throw reject(
            "inventory.reservation_mismatch",
            `${base} holds no ${command.quantity} ${command.uom} reservation ${command.reservationId} for ${command.planId}`,
          );
        }
        const option = await loadTransferOption(client, command.organization, command.optionId);
        if (
          option === null ||
          option.sku !== command.sku ||
          option.uom !== command.uom ||
          option.from !== command.from ||
          option.to !== command.to ||
          option.quantity !== command.quantity ||
          option.dispatchDate !== command.dispatchDate ||
          option.arrivalDate !== command.arrivalDate
        ) {
          throw reject(
            "inventory.transfer_option_mismatch",
            `transfer option ${command.optionId} does not match the command`,
          );
        }
        // The bound version must be the option's base plus the named predecessor
        // reservation of this plan, never a foreign advance.
        const predecessor = await loadReceipt(client, command.organization, {
          receiptId: command.predecessorReceiptId,
        });
        if (
          predecessor?.kind !== "reserve" ||
          predecessor.planId !== command.planId ||
          predecessor.reservationId !== command.reservationId ||
          predecessor.successorVersion !== base ||
          predecessor.priorVersion !== option.basedOn
        ) {
          throw reject(
            "inventory.predecessor_receipt_mismatch",
            `receipt ${command.predecessorReceiptId} did not produce ${base} from ${option.basedOn} with this reservation`,
          );
        }
        const linked = await client.query(
          `SELECT 1 FROM fixture_inventory.transfer_request
            WHERE organization = $1 AND sku = $2 AND from_warehouse = $3 AND reservation_id = $4`,
          [command.organization, command.sku, command.from, command.reservationId],
        );
        if ((linked.rowCount ?? 0) > 0) {
          throw reject(
            "inventory.reservation_already_linked",
            `reservation ${command.reservationId} already backs a transfer request`,
          );
        }

        // Linking draws on the reservation as it is; no stock version changes.
        const requestId = `TRQ-${randomUUID()}`;
        await client.query(
          `INSERT INTO fixture_inventory.transfer_request
             (request_id, organization, version, status, option_id, sku, uom, from_warehouse,
              to_warehouse, quantity, dispatch_date, arrival_date, stock_version, reservation_id, plan_id)
           VALUES ($1, $2, 1, 'requested', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            requestId,
            command.organization,
            command.optionId,
            command.sku,
            command.uom,
            command.from,
            command.to,
            command.quantity,
            command.dispatchDate,
            command.arrivalDate,
            base,
            command.reservationId,
            command.planId,
          ],
        );
        await client.query(
          `INSERT INTO fixture_inventory.operation_receipt
             (receipt_id, organization, operation_id, kind, plan_id, action_id, sku, warehouse,
              prior_version, successor_version, reservation_id, quantity, transfer_request_id,
              request_version, recorded_at)
           VALUES ($1, $2, $3, 'create_transfer_request', $4, $5, $6, $7, $8, NULL, $9, $10, $11, 1, $12)`,
          [
            randomUUID(),
            command.organization,
            command.operationId,
            command.planId,
            command.actionId,
            command.sku,
            command.from,
            base,
            command.reservationId,
            command.quantity,
            requestId,
            recordedAt,
          ],
        );
        const receipt = await loadReceipt(client, command.organization, command);
        if (receipt?.kind !== "create_transfer_request") {
          throw new Error("transfer request receipt was not recorded");
        }
        return { replayed: false, receipt };
      });
    },

    async lookupOperation(query) {
      const readAt = await options.clock.now();
      return readTransaction(options, async (client) => {
        const receipt = await loadReceipt(client, query.organization, query);
        if (receipt === null) return null;
        if (receipt.kind === "create_transfer_request") {
          const request = await loadTransferRequest(
            client,
            query.organization,
            receipt.transferRequestId,
          );
          return { readAt, receipt, request };
        }
        const currentVersion = await headVersion(
          client,
          { organization: query.organization, sku: receipt.sku, warehouse: receipt.warehouse },
          false,
        );
        const { rows } = await client.query<{
          reservation_id: string;
          quantity: string;
          plan_id: string | null;
        }>(
          `SELECT reservation_id, quantity::text AS quantity, plan_id
             FROM fixture_inventory.reservation WHERE snapshot_version = $1 AND reservation_id = $2`,
          [currentVersion, receipt.reservationId],
        );
        const [row] = rows;
        return {
          readAt,
          receipt,
          currentVersion,
          reservation: row === undefined ? null : toReservation(row),
        };
      });
    },
  };
}
