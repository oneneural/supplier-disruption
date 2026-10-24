import { createHash } from "node:crypto";
import {
  actorSchema,
  canonicalJson,
  instantSchema,
  itemMappingSchema,
  itemSchema,
  organizationAliasSchema,
  policySchema,
  scenarioTimingSchema,
  supplierInputIdentitySchema,
  supplierProposalTermsSchema,
  vendorSchema,
  type Actor,
  type Instant,
  type Item,
  type ItemMapping,
  type OrganizationAlias,
  type Policy,
  type ScenarioTiming,
  type SupplierInputIdentity,
  type SupplierProposalTerms,
  type Vendor,
} from "@supplier-disruption/contracts";
import type { InitTransaction } from "../columns.js";
import { knownOrNull } from "../values.js";
import {
  actor,
  businessClock,
  item,
  itemMapping,
  organizationAlias,
  policy,
  scenarioTiming,
  supplierInput,
  vendor,
  vendorContact,
} from "./schema.js";

/**
 * The content hash of structured supplier input: SHA-256 of the UTF-8
 * canonical JSON of the supplier-stated terms. The message ID and other
 * delivery metadata are not part of it.
 */
export function supplierContentSha256(terms: SupplierProposalTerms): string {
  return createHash("sha256")
    .update(canonicalJson(supplierProposalTermsSchema.parse(terms)), "utf8")
    .digest("hex");
}

export interface SupplierInputSeed {
  identity: Omit<SupplierInputIdentity, "contentSha256">;
  terms: SupplierProposalTerms;
}

export interface ReferenceInputs {
  organization: OrganizationAlias;
  vendors: readonly Vendor[];
  items: readonly Item[];
  mappings: readonly ItemMapping[];
  actors: readonly Actor[];
  policies: readonly Policy[];
  supplierInputs: readonly SupplierInputSeed[];
  scenarioTimings: readonly ScenarioTiming[];
  /** The controlled clock's initial instant; later advances are never reset by a seed. */
  clockStart: Instant;
}

/** Initialization only: inserts reference rows and the initial clock row. */
export async function initializeReference(
  tx: InitTransaction,
  inputs: ReferenceInputs,
): Promise<void> {
  const organization = organizationAliasSchema.parse(inputs.organization);
  await tx.insert(organizationAlias).values({
    label: organization.label,
    organizationId: organization.organizationId,
    name: organization.name,
  });
  for (const input of inputs.vendors) {
    const parsed = vendorSchema.parse(input);
    await tx.insert(vendor).values({ vendorId: parsed.vendorId, name: parsed.name });
    for (const address of parsed.registeredSenders) {
      await tx
        .insert(vendorContact)
        .values({ vendorId: parsed.vendorId, address, purpose: "registered_sender" });
    }
  }
  for (const input of inputs.items) {
    const parsed = itemSchema.parse(input);
    await tx
      .insert(item)
      .values({ sku: parsed.sku, stockUom: parsed.stockUom, integral: parsed.integral });
  }
  for (const input of inputs.mappings) {
    const parsed = itemMappingSchema.parse(input);
    await tx.insert(itemMapping).values({
      mappingId: parsed.mappingId,
      version: parsed.version,
      vendorId: parsed.vendorId,
      vendorItem: parsed.vendorItem,
      sourceUom: parsed.sourceUom,
      sku: parsed.sku,
      stockUom: parsed.stockUom,
      ratioNumerator: parsed.ratio.numerator,
      ratioDenominator: parsed.ratio.denominator,
      effectiveFrom: parsed.effectiveFrom,
      effectiveThrough: parsed.effectiveThrough,
      provenance: parsed.provenance,
    });
  }
  for (const input of inputs.actors) {
    const parsed = actorSchema.parse(input);
    await tx.insert(actor).values({
      actorId: parsed.actorId,
      role: parsed.role,
      vendorId: parsed.vendorId,
      simulated: parsed.simulated,
    });
  }
  for (const input of inputs.policies) {
    const parsed = policySchema.parse(input);
    // Identity columns are stored separately; the remaining fields are the parameters.
    const parameters = Object.fromEntries(
      Object.entries(parsed).filter(
        ([key]) => key !== "contractVersion" && key !== "policyId" && key !== "version",
      ),
    );
    await tx
      .insert(policy)
      .values({ policyId: parsed.policyId, version: parsed.version, parameters });
  }
  for (const input of inputs.supplierInputs) {
    const terms = supplierProposalTermsSchema.parse(input.terms);
    const identity = supplierInputIdentitySchema.parse({
      ...input.identity,
      contentSha256: supplierContentSha256(terms),
    });
    await tx.insert(supplierInput).values({
      sourceSystem: identity.sourceSystem,
      messageId: identity.messageId,
      inputVersion: identity.inputVersion,
      contentSha256: identity.contentSha256,
      sender: identity.sender,
      proposalId: identity.proposalId,
      evidenceRef: identity.evidenceRef,
      authoredAt: knownOrNull(identity.authoredAt, (value) => value),
      receivedAt: knownOrNull(identity.receivedAt, (value) => value),
      content: terms,
    });
  }
  for (const input of inputs.scenarioTimings) {
    const parsed = scenarioTimingSchema.parse(input);
    await tx
      .insert(scenarioTiming)
      .values({ scenario: parsed.scenario, name: parsed.name, instant: parsed.instant });
  }
  await tx.insert(businessClock).values({ id: 1, instant: instantSchema.parse(inputs.clockStart) });
}
