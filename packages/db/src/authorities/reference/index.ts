// Public runtime surface of the fixture reference authority: reads, plus the
// supplier-input append of ADR 0011. Its tables and initialization stay
// private to this directory and the seed.
export {
  createReferenceSource,
  type AttemptedBinding,
  type CurrentPolicyRead,
  type FixtureOrganization,
  type ItemMappingsRead,
  type ItemRead,
  type PolicyRead,
  type ReadablePolicyId,
  type ReferenceRead,
  type ReferenceScope,
  type ReferenceSource,
  type ReferenceSourceOptions,
  type RegisteredVendorRead,
  type SupplierInputRead,
  type SupplierInputRecord,
  type ValidatedBinding,
  type VendorRead,
} from "./source.js";
export type {
  CollectionBound,
  CompleteCollection,
  ReadAmbiguous,
  ReadFailureReason,
  ReadInvalidQuery,
  ReadNotFound,
  ReadOk,
  ReadScope,
  ReadUnavailable,
  ReadUnavailableReason,
} from "../reads.js";
export { DEFAULT_SOURCE_TIMEOUTS, type SourceOptions, type SourceTimeouts } from "../runtime.js";
