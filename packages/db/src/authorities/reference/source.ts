import {
  DOMAIN_CONTRACT_VERSION,
  instantSchema,
  itemMappingSchema,
  itemSchema,
  labelSchema,
  policySchema,
  supplierInputIdentitySchema,
  supplierProposalTermsSchema,
  uomSchema,
  vendorSchema,
  versionNumberSchema,
  type Instant,
  type Item,
  type ItemMapping,
  type Policy,
  type SupplierInputIdentity,
  type SupplierProposalTerms,
  type Vendor,
} from "@supplier-disruption/contracts";
import type pg from "pg";
import type {
  CollectionBound,
  CompleteCollection,
  ReadAmbiguous,
  ReadFailureReason,
  ReadInvalidQuery,
  ReadNotFound,
  ReadOk,
  ReadScope,
  ReadUnavailable,
} from "../reads.js";
import { readTransaction, type SourceOptions } from "../runtime.js";
import { SourceDataError, instantFromPostgres, knownFromColumn } from "../values.js";

/**
 * The one organization the global fixture reference rows are deployed for.
 * It comes from trusted composition, never from supplier content, a sender
 * or a message, and it is not an application membership check.
 */
export interface FixtureOrganization {
  label: string;
  organizationId: string;
}

export interface ReferenceSourceOptions extends SourceOptions {
  fixtureOrganization: FixtureOrganization;
}

/** The trusted binding as checked against the alias row inside the read. */
export interface ValidatedBinding extends FixtureOrganization {
  state: "validated";
}

/** The trusted binding as configured, not (or not successfully) checked. */
export interface AttemptedBinding extends FixtureOrganization {
  state: "attempted";
}

export interface ReferenceScope<Resource extends string, Selectors, Binding> extends ReadScope<
  "reference",
  Resource,
  Selectors
> {
  binding: Binding;
}

/**
 * Every outcome of one reference read. Only a validated binding accompanies
 * a successful, absent or ambiguous record; an ambiguous fixture binding and
 * every unavailable read carry the attempted binding. A read with no absent
 * or ambiguous reason has no such member, so an exhaustive switch over a
 * mapping collection never meets an impossible `not_found`.
 */
export type ReferenceRead<
  Resource extends string,
  Selectors,
  Data,
  NotFound extends string = never,
  Ambiguous extends string = never,
> =
  | ReadOk<ReferenceScope<Resource, Selectors, ValidatedBinding>, Data>
  | ([NotFound] extends [never]
      ? never
      : ReadNotFound<ReferenceScope<Resource, Selectors, ValidatedBinding>, NotFound>)
  | ([Ambiguous] extends [never]
      ? never
      : ReadAmbiguous<ReferenceScope<Resource, Selectors, ValidatedBinding>, Ambiguous>)
  | ReadAmbiguous<
      ReferenceScope<Resource, Selectors, AttemptedBinding>,
      "fixture_binding_ambiguous"
    >
  | ReadUnavailable<ReferenceScope<Resource, Selectors, AttemptedBinding>>
  | ReadInvalidQuery<ReferenceScope<Resource, Selectors, AttemptedBinding>>;

/** The policies the first slice's planning reads by exact version. */
export type ReadablePolicyId = "CAL-CPH-1" | "ELIG-1" | "ALLOC-1" | "AUTH-1";

export type ItemRead = ReferenceRead<"item", { sku: string }, Item, "record_not_found">;
export type ItemMappingsRead = ReferenceRead<
  "item_mappings",
  { vendorId: string; vendorItem: string; sourceUom: string },
  CompleteCollection<ItemMapping>
>;
export type PolicyRead = ReferenceRead<
  "policy",
  { policyId: ReadablePolicyId; version: number },
  Policy,
  "record_not_found"
>;
export type CurrentPolicyRead = ReferenceRead<
  "current_policy",
  { policyId: ReadablePolicyId },
  Policy,
  "record_not_found"
>;
export type VendorRead = ReferenceRead<"vendor", { vendorId: string }, Vendor, "record_not_found">;
export type RegisteredVendorRead = ReferenceRead<
  "registered_vendor",
  { sender: string },
  Vendor,
  "record_not_found",
  "registered_sender_ambiguous"
>;
/** Stored identity and terms; the stored content hash is returned as stored, never recomputed. */
export interface SupplierInputRecord {
  identity: SupplierInputIdentity;
  terms: SupplierProposalTerms;
}
export type SupplierInputRead = ReferenceRead<
  "supplier_input",
  { sourceSystem: string; messageId: string; inputVersion: number },
  SupplierInputRecord,
  "record_not_found"
>;

/**
 * Read-only reference reads for the single configured fixture organization.
 * Each call checks the binding again in its own read transaction.
 */
export interface ReferenceSource {
  readItem(query: { organization: string; sku: string }): Promise<ItemRead>;
  /**
   * Every mapping version for the exact vendor, vendor item and source unit,
   * expired or not. No effective mapping is selected and nothing is converted.
   */
  readItemMappings(query: {
    organization: string;
    vendorId: string;
    vendorItem: string;
    sourceUom: string;
  }): Promise<ItemMappingsRead>;
  /** One exact policy version; a missing version never falls back to another. */
  readPolicy(query: {
    organization: string;
    policyId: ReadablePolicyId;
    version: number;
  }): Promise<PolicyRead>;
  /**
   * The current version of a policy: the highest stored version, because
   * versions are only ever appended. An older version's row remaining in the
   * store never makes it current again.
   */
  readCurrentPolicy(query: {
    organization: string;
    policyId: ReadablePolicyId;
  }): Promise<CurrentPolicyRead>;
  readVendor(query: { organization: string; vendorId: string }): Promise<VendorRead>;
  /**
   * The vendor registered for this exact sender string. A registry read: it
   * neither authenticates a mailbox nor accepts an intake event.
   */
  readRegisteredVendor(query: {
    organization: string;
    sender: string;
  }): Promise<RegisteredVendorRead>;
  /** One exact input version: no latest-version inference, no raw message or evidence bytes. */
  readSupplierInput(query: {
    organization: string;
    sourceSystem: string;
    messageId: string;
    inputVersion: number;
  }): Promise<SupplierInputRead>;
  /**
   * Appends one structured supplier input derived from a stored email (ADR
   * 0011), as a mail connector would. The trusted caller states the identity;
   * an existing input with the same key is never changed, and the result says
   * whether this call stored it. Intake then reads it back like any input.
   */
  recordSupplierInput(input: {
    identity: SupplierInputIdentity;
    terms: SupplierProposalTerms;
  }): Promise<"stored" | "exists">;
}

const BOUND: CollectionBound = 100;
const READABLE_POLICIES: readonly string[] = ["CAL-CPH-1", "ELIG-1", "ALLOC-1", "AUTH-1"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Check {
  safeParse(value: unknown): { success: boolean };
}

const oneOf = (allowed: readonly string[]): Check => ({
  safeParse: (value) => ({ success: typeof value === "string" && allowed.includes(value) }),
});

/** An exact query object: only the named fields, each valid. */
function validQuery(query: unknown, checks: Record<string, Check>): boolean {
  if (typeof query !== "object" || query === null) return false;
  const names = Object.keys(checks);
  return (
    Object.keys(query).length === names.length &&
    names.every(
      (name) =>
        Object.hasOwn(query, name) &&
        checks[name]?.safeParse((query as Record<string, unknown>)[name]).success,
    )
  );
}

function decode<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SourceDataError(`stored ${what} is not a valid record`);
  return parsed.data;
}

/** Classifies a failed read; nothing here is ever absence or an empty result. */
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

type Outcome<Data, NotFound extends string, Ambiguous extends string> =
  | { kind: "ok"; data: Data }
  | { kind: "not_found"; reason: NotFound }
  | { kind: "ambiguous"; reason: Ambiguous }
  | { kind: "unavailable"; reason: ReadFailureReason };

type BindingCheck =
  "validated" | "binding_missing" | "scope_mismatch" | "fixture_binding_ambiguous";

/**
 * The single fixture binding: exactly one alias row, with the trusted label
 * and UUID. Two rows are fetched so a second alias is ambiguous whichever
 * sorts first; nothing adopts the first alias it finds.
 */
async function checkBinding(
  client: pg.PoolClient,
  trusted: FixtureOrganization,
): Promise<BindingCheck> {
  const { rows } = await client.query<{ label: string; organization_id: string }>(
    `SELECT label, organization_id::text AS organization_id
       FROM fixture_reference.organization_alias ORDER BY label LIMIT 2`,
  );
  if (rows.length > 1) return "fixture_binding_ambiguous";
  const [alias] = rows;
  if (alias?.label !== trusted.label) return "binding_missing";
  return alias.organization_id === trusted.organizationId ? "validated" : "scope_mismatch";
}

/** A vendor and its complete registered contacts, or null when the vendor is absent. */
async function loadVendor(
  client: pg.PoolClient,
  vendorId: string,
): Promise<Vendor | "bound_exceeded" | null> {
  const { rows } = await client.query<{ vendor_id: string; name: string }>(
    "SELECT vendor_id, name FROM fixture_reference.vendor WHERE vendor_id = $1",
    [vendorId],
  );
  const [row] = rows;
  if (row === undefined) return null;
  const { rows: contacts } = await client.query<{ address: string }>(
    `SELECT address FROM fixture_reference.vendor_contact
      WHERE vendor_id = $1 AND purpose = 'registered_sender'
      ORDER BY address COLLATE "C" LIMIT $2`,
    [vendorId, BOUND + 1],
  );
  if (contacts.length > BOUND) return "bound_exceeded";
  // A vendor without contacts is invalid data, never an invented empty vendor.
  return decode(
    vendorSchema,
    {
      contractVersion: DOMAIN_CONTRACT_VERSION,
      vendorId: row.vendor_id,
      name: row.name,
      registeredSenders: contacts.map((contact) => contact.address),
    },
    `vendor ${vendorId}`,
  );
}

function vendorOutcome(
  vendor: Vendor | "bound_exceeded" | null,
): Outcome<Vendor, "record_not_found", never> {
  if (vendor === null) return { kind: "not_found", reason: "record_not_found" };
  if (vendor === "bound_exceeded") {
    return { kind: "unavailable", reason: "collection_bound_exceeded" };
  }
  return { kind: "ok", data: vendor };
}

const IDENTITY_KEYS = ["contractVersion", "policyId", "version"];

interface PolicyRow {
  policy_id: string;
  version: number;
  parameters: unknown;
}

/** A stored policy version as a contract record. */
function policyFromRow(row: PolicyRow): Policy {
  const { parameters } = row;
  const what = `policy ${row.policy_id}@${String(row.version)}`;
  // The row's identity columns are authoritative; parameters may not restate them.
  if (
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters) ||
    IDENTITY_KEYS.some((key) => Object.hasOwn(parameters, key))
  ) {
    throw new SourceDataError(`${what} has invalid parameters`);
  }
  return decode(
    policySchema,
    {
      ...parameters,
      contractVersion: DOMAIN_CONTRACT_VERSION,
      policyId: row.policy_id,
      version: row.version,
    },
    what,
  );
}

/**
 * The fixture reference authority's read-only runtime module (ADR 0006). The
 * reference tables are global and hold one fixture organization's data, so
 * every read is bound to the trusted alias it was composed with.
 */
export function createReferenceSource(options: ReferenceSourceOptions): ReferenceSource {
  const trusted: FixtureOrganization = {
    label: options.fixtureOrganization.label,
    organizationId: options.fixtureOrganization.organizationId,
  };
  if (!labelSchema.safeParse(trusted.label).success || !UUID.test(trusted.organizationId)) {
    throw new TypeError("the fixture organization needs a label and a lowercase UUID");
  }

  /**
   * Validates the query, samples the clock, then checks the binding and runs
   * the read in one read-only transaction. The outcome is decided only after
   * that transaction committed; any failure is unavailable.
   */
  async function read<
    Query extends { organization: string },
    Resource extends string,
    Selectors,
    Data,
    NotFound extends string,
    Ambiguous extends string,
  >(
    resource: Resource,
    query: Query,
    checks: Record<string, Check>,
    selectors: (query: Query) => Selectors,
    work: (client: pg.PoolClient, query: Query) => Promise<Outcome<Data, NotFound, Ambiguous>>,
  ): Promise<ReferenceRead<Resource, Selectors, Data, NotFound, Ambiguous>> {
    // An invalid query is still reported with the scope it attempted.
    const asked = (typeof query === "object" && query !== null ? query : {}) as Query;
    const scope = <Binding>(binding: Binding) => ({
      owner: "reference" as const,
      resource,
      organization: asked.organization,
      selectors: selectors(asked),
      binding,
    });
    const attempted = scope<AttemptedBinding>({ state: "attempted", ...trusted });
    const unavailable = (reason: ReadFailureReason, attemptedAt?: Instant) => ({
      status: "unavailable" as const,
      scope: attempted,
      reason,
      ...(attemptedAt === undefined ? {} : { attemptedAt }),
    });

    if (!validQuery(query, { organization: labelSchema, ...checks })) {
      return { status: "unavailable", scope: attempted, reason: "invalid_query" };
    }
    let readAt: Instant;
    try {
      readAt = await options.clock.now();
    } catch {
      return unavailable("clock_unavailable");
    }
    if (!instantSchema.safeParse(readAt).success) return unavailable("clock_unavailable");
    if (query.organization !== trusted.label) return unavailable("scope_mismatch", readAt);

    const progress = { entered: false };
    let outcome:
      | Outcome<Data, NotFound, Ambiguous>
      | { kind: "unbound"; reason: Exclude<BindingCheck, "validated"> };
    try {
      outcome = await readTransaction(options, async (client) => {
        progress.entered = true;
        const binding = await checkBinding(client, trusted);
        if (binding !== "validated") return { kind: "unbound" as const, reason: binding };
        return work(client, query);
      });
    } catch (error) {
      return unavailable(unavailableReason(error, progress.entered), readAt);
    }

    const validated = scope<ValidatedBinding>({ state: "validated", ...trusted });
    // The work produced this reason, so its member exists in the public type;
    // TypeScript cannot resolve that for a generic reason.
    type Read = ReferenceRead<Resource, Selectors, Data, NotFound, Ambiguous>;
    switch (outcome.kind) {
      case "ok":
        return {
          status: "ok",
          scope: validated,
          readAt,
          observedAt: { state: "unknown" },
          data: outcome.data,
        };
      case "not_found":
        return { status: "not_found", scope: validated, readAt, reason: outcome.reason } as Read;
      case "ambiguous":
        return { status: "ambiguous", scope: validated, readAt, reason: outcome.reason } as Read;
      case "unavailable":
        return unavailable(outcome.reason, readAt);
      case "unbound":
        return outcome.reason === "fixture_binding_ambiguous"
          ? { status: "ambiguous", scope: attempted, readAt, reason: outcome.reason }
          : unavailable(outcome.reason, readAt);
    }
  }

  return {
    readItem(query) {
      return read(
        "item",
        query,
        { sku: labelSchema },
        ({ sku }) => ({ sku }),
        async (client, { sku }): Promise<Outcome<Item, "record_not_found", never>> => {
          const { rows } = await client.query<{
            sku: string;
            stock_uom: string;
            integral: boolean;
          }>("SELECT sku, stock_uom, integral FROM fixture_reference.item WHERE sku = $1", [sku]);
          const [row] = rows;
          if (row === undefined) return { kind: "not_found", reason: "record_not_found" };
          const item = decode(
            itemSchema,
            {
              contractVersion: DOMAIN_CONTRACT_VERSION,
              sku: row.sku,
              stockUom: row.stock_uom,
              integral: row.integral,
            },
            `item ${sku}`,
          );
          return { kind: "ok", data: item };
        },
      );
    },

    readItemMappings(query) {
      return read(
        "item_mappings",
        query,
        { vendorId: labelSchema, vendorItem: labelSchema, sourceUom: uomSchema },
        ({ vendorId, vendorItem, sourceUom }) => ({ vendorId, vendorItem, sourceUom }),
        async (
          client,
          { vendorId, vendorItem, sourceUom },
        ): Promise<Outcome<CompleteCollection<ItemMapping>, never, never>> => {
          // Ratios and dates are read as text so they reach the contract unchanged.
          const { rows } = await client.query<{
            mapping_id: string;
            version: number;
            vendor_id: string;
            vendor_item: string;
            source_uom: string;
            sku: string;
            stock_uom: string;
            ratio_numerator: string;
            ratio_denominator: string;
            effective_from: string;
            effective_through: string | null;
            provenance: string;
          }>(
            `SELECT mapping_id, version, vendor_id, vendor_item, source_uom, sku, stock_uom,
                    ratio_numerator::text AS ratio_numerator,
                    ratio_denominator::text AS ratio_denominator,
                    effective_from::text AS effective_from,
                    effective_through::text AS effective_through, provenance
               FROM fixture_reference.item_mapping
              WHERE vendor_id = $1 AND vendor_item = $2 AND source_uom = $3
              ORDER BY mapping_id COLLATE "C", version LIMIT $4`,
            [vendorId, vendorItem, sourceUom, BOUND + 1],
          );
          if (rows.length > BOUND) {
            return { kind: "unavailable", reason: "collection_bound_exceeded" };
          }
          const records = rows.map((row) =>
            decode(
              itemMappingSchema,
              {
                contractVersion: DOMAIN_CONTRACT_VERSION,
                mappingId: row.mapping_id,
                version: row.version,
                vendorId: row.vendor_id,
                vendorItem: row.vendor_item,
                sourceUom: row.source_uom,
                sku: row.sku,
                stockUom: row.stock_uom,
                ratio: { numerator: row.ratio_numerator, denominator: row.ratio_denominator },
                effectiveFrom: row.effective_from,
                effectiveThrough: row.effective_through,
                provenance: row.provenance,
              },
              `mapping ${row.mapping_id}@${row.version}`,
            ),
          );
          return { kind: "ok", data: { records, complete: true } };
        },
      );
    },

    readPolicy(query) {
      return read(
        "policy",
        query,
        { policyId: oneOf(READABLE_POLICIES), version: versionNumberSchema },
        ({ policyId, version }) => ({ policyId, version }),
        async (
          client,
          { policyId, version },
        ): Promise<Outcome<Policy, "record_not_found", never>> => {
          const { rows } = await client.query<PolicyRow>(
            `SELECT policy_id, version, parameters FROM fixture_reference.policy
              WHERE policy_id = $1 AND version = $2`,
            [policyId, version],
          );
          const [row] = rows;
          if (row === undefined) return { kind: "not_found", reason: "record_not_found" };
          return { kind: "ok", data: policyFromRow(row) };
        },
      );
    },

    readCurrentPolicy(query) {
      return read(
        "current_policy",
        query,
        { policyId: oneOf(READABLE_POLICIES) },
        ({ policyId }) => ({ policyId }),
        async (client, { policyId }): Promise<Outcome<Policy, "record_not_found", never>> => {
          // Policy versions are append-only, so the highest one is the current head.
          const { rows } = await client.query<PolicyRow>(
            `SELECT policy_id, version, parameters FROM fixture_reference.policy
              WHERE policy_id = $1 ORDER BY version DESC LIMIT 1`,
            [policyId],
          );
          const [row] = rows;
          if (row === undefined) return { kind: "not_found", reason: "record_not_found" };
          return { kind: "ok", data: policyFromRow(row) };
        },
      );
    },

    readVendor(query) {
      return read(
        "vendor",
        query,
        { vendorId: labelSchema },
        ({ vendorId }) => ({ vendorId }),
        async (client, { vendorId }) => vendorOutcome(await loadVendor(client, vendorId)),
      );
    },

    readRegisteredVendor(query) {
      return read(
        "registered_vendor",
        query,
        { sender: supplierInputIdentitySchema.shape.sender },
        ({ sender }) => ({ sender }),
        async (
          client,
          { sender },
        ): Promise<Outcome<Vendor, "record_not_found", "registered_sender_ambiguous">> => {
          // Exact stored string only: no case folding, aliases or domain matching.
          // Two distinct vendors are enough to know the sender is ambiguous.
          const { rows } = await client.query<{ vendor_id: string }>(
            `SELECT DISTINCT vendor_id FROM fixture_reference.vendor_contact
              WHERE address = $1 AND purpose = 'registered_sender'
              ORDER BY vendor_id LIMIT 2`,
            [sender],
          );
          const [first, second] = rows;
          if (first === undefined) return { kind: "not_found", reason: "record_not_found" };
          if (second !== undefined) {
            return { kind: "ambiguous", reason: "registered_sender_ambiguous" };
          }
          const vendor = await loadVendor(client, first.vendor_id);
          if (vendor === null) {
            throw new SourceDataError(`registered sender names a missing vendor`);
          }
          return vendorOutcome(vendor);
        },
      );
    },

    async recordSupplierInput(input) {
      const identity = supplierInputIdentitySchema.parse(input.identity);
      const terms = supplierProposalTermsSchema.parse(input.terms);
      const at = (value: typeof identity.authoredAt) =>
        value.state === "known" ? value.value : null;
      const { rowCount } = await options.pool.query(
        `INSERT INTO fixture_reference.supplier_input
           (source_system, message_id, input_version, content_sha256, sender, proposal_id,
            evidence_ref, authored_at, received_at, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING`,
        [
          identity.sourceSystem,
          identity.messageId,
          identity.inputVersion,
          identity.contentSha256,
          identity.sender,
          identity.proposalId,
          identity.evidenceRef,
          at(identity.authoredAt),
          at(identity.receivedAt),
          JSON.stringify(terms),
        ],
      );
      return rowCount === 1 ? "stored" : "exists";
    },

    readSupplierInput(query) {
      return read(
        "supplier_input",
        query,
        { sourceSystem: labelSchema, messageId: labelSchema, inputVersion: versionNumberSchema },
        ({ sourceSystem, messageId, inputVersion }) => ({ sourceSystem, messageId, inputVersion }),
        async (
          client,
          { sourceSystem, messageId, inputVersion },
        ): Promise<Outcome<SupplierInputRecord, "record_not_found", never>> => {
          const { rows } = await client.query<{
            source_system: string;
            message_id: string;
            input_version: number;
            content_sha256: string;
            sender: string;
            proposal_id: string;
            evidence_ref: string;
            authored_at: string | null;
            received_at: string | null;
            content: unknown;
          }>(
            `SELECT source_system, message_id, input_version, content_sha256, sender, proposal_id,
                    evidence_ref, authored_at::text AS authored_at,
                    received_at::text AS received_at, content
               FROM fixture_reference.supplier_input
              WHERE source_system = $1 AND message_id = $2 AND input_version = $3`,
            [sourceSystem, messageId, inputVersion],
          );
          const [row] = rows;
          if (row === undefined) return { kind: "not_found", reason: "record_not_found" };
          const what = `supplier input ${messageId}@${inputVersion}`;
          const identity = decode(
            supplierInputIdentitySchema,
            {
              contractVersion: DOMAIN_CONTRACT_VERSION,
              sourceSystem: row.source_system,
              messageId: row.message_id,
              inputVersion: row.input_version,
              // As stored: downstream intake compares it with the terms.
              contentSha256: row.content_sha256,
              sender: row.sender,
              proposalId: row.proposal_id,
              evidenceRef: row.evidence_ref,
              authoredAt: knownFromColumn(
                row.authored_at === null ? null : instantFromPostgres(row.authored_at),
              ),
              receivedAt: knownFromColumn(
                row.received_at === null ? null : instantFromPostgres(row.received_at),
              ),
            },
            what,
          );
          const terms = decode(supplierProposalTermsSchema, row.content, what);
          return { kind: "ok", data: { identity, terms } };
        },
      );
    },
  };
}
