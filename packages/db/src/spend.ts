import pg from "pg";

/**
 * Project-wide admission for metered model calls (ADR 0017). The API
 * and `evaluation/run.mjs` both admit through this class, against the same
 * `app.model_spend_*` tables, so concurrent runs from either side share one
 * total:
 *
 *   committed = opening + settled cost + every reserved or uncertain amount
 *
 * A run is admitted only if committed plus its worst-case cost stays within
 * the limit, which is never above the owner's USD 15 pause. Unknown usage
 * keeps its full reservation until an operator settles it with evidence; no
 * timer releases it.
 */

/** The owner's mandatory pause: no admission may take the project total past USD 15. */
export const OWNER_PAUSE_MICRO_USD = 15_000_000;

// Serializes every ledger write in this database, from any process or role.
const LEDGER_LOCK = "supplier-disruption:model-spend";

export type SpendSource = "api" | "evaluation";

export interface SpendUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: number;
}

export interface AdmissionRequest {
  /**
   * Unique per provider attempt. Repeating a key returns its reservation only
   * while it is still reserved for the same source, reference, model and amount.
   */
  key: string;
  source: SpendSource;
  /** The run being admitted: an agent run ID or an evaluation label and scenario. */
  reference: string;
  model: string;
  /** The attempt's worst-case cost: the run cap the graph never exceeds. */
  amountMicroUsd: number;
  /** An application limit below the owner pause; the lower of the two applies. */
  limitMicroUsd?: number;
}

export type Admission =
  | { admitted: true; key: string; reservedMicroUsd: number; committedMicroUsd: number }
  | {
      admitted: false;
      reason: "unopened" | "limit" | "key_in_use";
      committedMicroUsd: number;
      limitMicroUsd: number;
      detail: string;
    };

export interface SpendStatus {
  opened: boolean;
  openingMicroUsd: number;
  openingEvidence: string | null;
  settledMicroUsd: number;
  /** Admitted and not yet settled: in flight, or abandoned by a process that died. */
  reservedMicroUsd: number;
  /** Usage unknown; counted at the reserved amount until reconciled. */
  uncertainMicroUsd: number;
  committedMicroUsd: number;
  counts: { reserved: number; uncertain: number; settled: number };
}

/** A settlement that contradicts an earlier one for the same key. */
export class SpendLedgerConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendLedgerConflict";
  }
}

function whole(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer of at least ${String(minimum)}`);
  }
  return value;
}

const STATUS_SQL = `
  SELECT a.opening_micro_usd::text AS opening,
         a.opening_evidence AS evidence,
         coalesce(sum(r.settled_micro_usd) FILTER (WHERE r.status = 'settled'), 0)::text AS settled,
         coalesce(sum(r.reserved_micro_usd) FILTER (WHERE r.status = 'reserved'), 0)::text AS reserved,
         coalesce(sum(r.reserved_micro_usd) FILTER (WHERE r.status = 'uncertain'), 0)::text AS uncertain,
         count(r.key) FILTER (WHERE r.status = 'reserved')::int AS n_reserved,
         count(r.key) FILTER (WHERE r.status = 'uncertain')::int AS n_uncertain,
         count(r.key) FILTER (WHERE r.status = 'settled')::int AS n_settled
    FROM (SELECT 1) AS one
    LEFT JOIN app.model_spend_account a ON a.id = 1
    LEFT JOIN app.model_spend_reservation r ON true
   GROUP BY a.opening_micro_usd, a.opening_evidence`;

interface StatusRow {
  opening: string | null;
  evidence: string | null;
  settled: string;
  reserved: string;
  uncertain: string;
  n_reserved: number;
  n_uncertain: number;
  n_settled: number;
}

export class ModelSpendLedger {
  constructor(private readonly pool: pg.Pool) {}

  private async locked<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LEDGER_LOCK]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private static async status(client: pg.ClientBase): Promise<SpendStatus> {
    const { rows } = await client.query<StatusRow>(STATUS_SQL);
    const row = rows[0]!;
    const opening = Number(row.opening ?? 0);
    const settled = Number(row.settled);
    const reserved = Number(row.reserved);
    const uncertain = Number(row.uncertain);
    return {
      opened: row.opening !== null,
      openingMicroUsd: opening,
      openingEvidence: row.evidence,
      settledMicroUsd: settled,
      reservedMicroUsd: reserved,
      uncertainMicroUsd: uncertain,
      committedMicroUsd: opening + settled + reserved + uncertain,
      counts: { reserved: row.n_reserved, uncertain: row.n_uncertain, settled: row.n_settled },
    };
  }

  /** The current totals, read without taking the ledger lock. */
  async status(): Promise<SpendStatus> {
    const client = await this.pool.connect();
    try {
      return await ModelSpendLedger.status(client);
    } finally {
      client.release();
    }
  }

  /**
   * Reserves the attempt's worst-case cost, or refuses with nothing recorded.
   * Callers must not call the provider unless this returns `admitted: true`.
   */
  async admit(request: AdmissionRequest): Promise<Admission> {
    const amount = whole("amountMicroUsd", request.amountMicroUsd, 1);
    const limit = Math.min(
      whole("limitMicroUsd", request.limitMicroUsd ?? OWNER_PAUSE_MICRO_USD, 0),
      OWNER_PAUSE_MICRO_USD,
    );
    return this.locked(async (client) => {
      const { rows: existing } = await client.query<{
        source: string;
        reference: string;
        model: string;
        reserved: string;
        status: string;
      }>(
        `SELECT source, reference, model, reserved_micro_usd::text AS reserved, status
           FROM app.model_spend_reservation WHERE key = $1`,
        [request.key],
      );
      const status = await ModelSpendLedger.status(client);
      const prior = existing[0];
      if (prior !== undefined) {
        const same =
          prior.status === "reserved" &&
          prior.source === request.source &&
          prior.reference === request.reference &&
          prior.model === request.model &&
          Number(prior.reserved) === amount;
        return same
          ? {
              admitted: true,
              key: request.key,
              reservedMicroUsd: amount,
              committedMicroUsd: status.committedMicroUsd,
            }
          : {
              admitted: false,
              reason: "key_in_use",
              committedMicroUsd: status.committedMicroUsd,
              limitMicroUsd: limit,
              detail: `reservation key ${request.key} is already ${prior.status} for another admission; no model was called`,
            };
      }
      if (!status.opened) {
        return {
          admitted: false,
          reason: "unopened",
          committedMicroUsd: status.committedMicroUsd,
          limitMicroUsd: limit,
          detail: "the project spend ledger has no reconciled opening balance; no model was called",
        };
      }
      if (status.committedMicroUsd + amount > limit) {
        return {
          admitted: false,
          reason: "limit",
          committedMicroUsd: status.committedMicroUsd,
          limitMicroUsd: limit,
          detail: `settled and reserved model spend is ${String(status.committedMicroUsd)} micro-USD; reserving ${String(amount)} more would pass the ${String(limit)} micro-USD limit; no model was called`,
        };
      }
      await client.query(
        `INSERT INTO app.model_spend_reservation (key, source, reference, model, reserved_micro_usd, status)
         VALUES ($1, $2, $3, $4, $5, 'reserved')`,
        [request.key, request.source, request.reference, request.model, amount],
      );
      return {
        admitted: true,
        key: request.key,
        reservedMicroUsd: amount,
        committedMicroUsd: status.committedMicroUsd + amount,
      };
    });
  }

  /**
   * Settles a reserved attempt with the usage its provider reported. Repeating
   * the same settlement changes nothing; a different amount for a settled key
   * is a conflict and the first settlement stands. An attempt already marked
   * uncertain (for example by a later attempt that took it for stopped) stays
   * uncertain with the reported usage recorded: only an operator settles it.
   */
  async settle(
    key: string,
    usage: SpendUsage,
  ): Promise<"settled" | "already_settled" | "uncertain"> {
    const cost = whole("costMicroUsd", usage.costMicroUsd, 0);
    return this.locked(async (client) => {
      const updated = await client.query(
        `UPDATE app.model_spend_reservation
            SET status = 'settled', settled_micro_usd = $2, usage = $3, resolved_at = now()
          WHERE key = $1 AND status = 'reserved'`,
        [key, cost, JSON.stringify(usage)],
      );
      if ((updated.rowCount ?? 0) > 0) return "settled";
      const late = await client.query(
        `UPDATE app.model_spend_reservation
            SET usage = $2, detail = concat_ws('; ', detail, 'usage reported after it was marked uncertain')
          WHERE key = $1 AND status = 'uncertain'`,
        [key, JSON.stringify(usage)],
      );
      if ((late.rowCount ?? 0) > 0) return "uncertain";
      return ModelSpendLedger.repeated(client, key, cost);
    });
  }

  private static async repeated(
    client: pg.ClientBase,
    key: string,
    cost: number,
  ): Promise<"already_settled"> {
    const { rows } = await client.query<{ status: string; settled: string | null }>(
      "SELECT status, settled_micro_usd::text AS settled FROM app.model_spend_reservation WHERE key = $1",
      [key],
    );
    const row = rows[0];
    if (row === undefined) throw new SpendLedgerConflict(`no reservation ${key}`);
    if (row.status !== "settled" || Number(row.settled) !== cost) {
      throw new SpendLedgerConflict(
        `reservation ${key} is already settled at ${String(row.settled)} micro-USD`,
      );
    }
    return "already_settled";
  }

  /**
   * Records that an attempt's usage is unknown (a timeout after the request
   * was sent, missing usage, a crash). The full reservation
   * stays counted; usage known so far is kept for the reconciler.
   */
  async markUncertain(key: string, detail: string, known?: SpendUsage): Promise<void> {
    await this.locked((client) =>
      client.query(
        `UPDATE app.model_spend_reservation
            SET status = 'uncertain', detail = $2, usage = coalesce($3, usage)
          WHERE key = $1 AND status IN ('reserved', 'uncertain')`,
        [key, detail.slice(0, 500), known === undefined ? null : JSON.stringify(known)],
      ),
    );
  }

  /**
   * Marks every still-reserved attempt for a reference uncertain, before a
   * new attempt for it is admitted: an attempt that never settled belongs to a
   * process that stopped, and what it spent is unknown.
   */
  async abandon(reference: string, detail: string): Promise<number> {
    return this.locked(async (client) => {
      const updated = await client.query(
        `UPDATE app.model_spend_reservation SET status = 'uncertain', detail = $2
          WHERE reference = $1 AND status = 'reserved'`,
        [reference, detail.slice(0, 500)],
      );
      return updated.rowCount ?? 0;
    });
  }

  /**
   * Records the carried-forward opening balance once (migrator role). An
   * identical repeat changes nothing; a different one is refused, because the
   * opening is evidence, not a setting.
   */
  async open(openingMicroUsd: number, evidence: string): Promise<"opened" | "unchanged"> {
    const opening = whole("openingMicroUsd", openingMicroUsd, 0);
    if (evidence.trim() === "") throw new RangeError("the opening needs evidence");
    return this.locked(async (client) => {
      const { rows } = await client.query<{ opening: string; evidence: string }>(
        "SELECT opening_micro_usd::text AS opening, opening_evidence AS evidence FROM app.model_spend_account WHERE id = 1",
      );
      const row = rows[0];
      if (row === undefined) {
        await client.query(
          "INSERT INTO app.model_spend_account (id, opening_micro_usd, opening_evidence) VALUES (1, $1, $2)",
          [opening, evidence],
        );
        return "opened";
      }
      if (Number(row.opening) === opening && row.evidence === evidence) return "unchanged";
      throw new SpendLedgerConflict(
        `the ledger is already open at ${row.opening} micro-USD; an opening is never replaced`,
      );
    });
  }

  /**
   * Settles a reserved or uncertain attempt from external evidence, such as
   * the provider console's usage for that request (operator only).
   */
  async reconcile(
    key: string,
    settledMicroUsd: number,
    evidence: string,
  ): Promise<"settled" | "already_settled"> {
    const cost = whole("settledMicroUsd", settledMicroUsd, 0);
    if (evidence.trim() === "") throw new RangeError("reconciliation needs evidence");
    return this.locked(async (client) => {
      const updated = await client.query(
        `UPDATE app.model_spend_reservation
            SET status = 'settled', settled_micro_usd = $2, resolved_at = now(),
                detail = concat_ws('; ', detail, 'reconciled: ' || $3::text)
          WHERE key = $1 AND status IN ('reserved', 'uncertain')`,
        [key, cost, evidence.slice(0, 500)],
      );
      if ((updated.rowCount ?? 0) > 0) return "settled";
      return ModelSpendLedger.repeated(client, key, cost);
    });
  }
}

/** A ledger over its own small pool, for a command-line process such as the evaluation runner. */
export function connectSpendLedger(
  connectionString: string,
  applicationName: string,
): { ledger: ModelSpendLedger; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString, application_name: applicationName, max: 2 });
  pool.on("error", () => undefined);
  return { ledger: new ModelSpendLedger(pool), close: () => pool.end() };
}
