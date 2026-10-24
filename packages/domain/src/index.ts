// Pure coverage, eligibility and allocation policy (ADR 0007). No
// source, clock, storage, network or provider access: callers pass
// materialized reads and explicit times and IDs.
export { AssessmentInputError, assessCoverage } from "./assess.js";
// AUTH-1 approval check against the current policy version (ADR 0013).
export { approvalRefusal, type ApprovalRefusal, type ApprovalRequirement } from "./approval.js";
export { copenhagenDate } from "./calendar.js";
export {
  convertQuantity,
  selectMapping,
  type MappingOutcome,
  type MappingQuery,
} from "./conversion.js";
export { contentSha256 } from "./digest.js";
export { deriveEligibility, type Eligibility, type EligibilityOutcome } from "./eligibility.js";
// Intake identity and source guards ahead of assessment (ADR 0008).
export { IntakeInputError, intakeAndAssess } from "./intake.js";
export { QuantityRangeError, formatQuantity, parseQuantity } from "./quantity.js";
export { ASSUMPTIONS, REASONS } from "./reasons.js";
