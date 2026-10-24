// Reason values. The four unprefixed values are the frozen oracle's; every
// `policy_` value is an implementation contract decision recorded in ADR 0007,
// not an oracle addition.

export const REASONS = {
  // Oracle (N-12, N-14).
  unresolvedShortage: "unresolved_shortage",
  evidenceUnavailable: "evidence_unavailable",
  unsupportedSubstitution: "unsupported_substitution",
  uomConversionUnavailable: "uom_conversion_unavailable",

  // Evidence that was read but is missing, ambiguous or inconsistent.
  evidenceNotFound: "policy_evidence_not_found",
  evidenceAmbiguous: "policy_evidence_ambiguous",
  identityMismatch: "policy_identity_mismatch",
  baseRevisionMismatch: "policy_base_revision_mismatch",
  unsupportedPolicy: "policy_unsupported_policy_version",
  inconsistentStock: "policy_inconsistent_stock",
  planReservationUnsupported: "policy_plan_reservation_unsupported",
  mappingAmbiguous: "policy_mapping_ambiguous",
  conversionNonintegral: "policy_conversion_nonintegral",
  scheduleTotalMismatch: "policy_schedule_total_mismatch",
  supplyLinksUnsupported: "policy_supply_links_unsupported",
  quantityOutOfRange: "policy_quantity_out_of_range",
  allocationTie: "policy_allocation_tie",
  currencyNotPermitted: "policy_currency_not_permitted",
  noApproverWithinLimits: "policy_no_approver_within_limits",

  // Supply dispositions.
  arrivalAfterCutoff: "policy_arrival_after_cutoff",
  arrivalUndated: "policy_arrival_undated",
  replacedByProposal: "policy_replaced_by_proposal",
  scheduleNotProjected: "policy_schedule_not_projected",
  inTransitNotStock: "policy_in_transit_not_stock",

  // Transfer options.
  transferSkuMismatch: "policy_transfer_sku_mismatch",
  transferUomMismatch: "policy_transfer_uom_mismatch",
  transferDestinationMismatch: "policy_transfer_destination_mismatch",
  transferStockVersionMismatch: "policy_transfer_stock_version_mismatch",
  transferInsufficientStock: "policy_transfer_insufficient_eligible_stock",
  transferArrivalAfterCutoff: "policy_transfer_arrival_after_cutoff",
  transferQuoteExpired: "policy_transfer_quote_expired",
  transferOwnerUnsupported: "policy_transfer_owner_unsupported",
  transferNotNeeded: "policy_transfer_not_needed",
  multipleTransferOptions: "policy_multiple_transfer_options",

  // A verified predecessor plan's commitments (ADR 0015).
  priorCommitmentMismatch: "policy_prior_commitment_mismatch",
  priorCommitmentUnknown: "policy_prior_commitment_unknown",
  priorCommitmentSurplus: "policy_prior_commitment_surplus",
  priorCommitmentCovered: "policy_prior_commitment_covered",

  // Outcomes of a feasible assessment.
  conditionalTransferPending: "policy_conditional_transfer_pending",
  planReadyForApproval: "policy_plan_ready_for_approval",
} as const;

/** Recorded first-slice assumptions, bound into every plan payload. */
export const ASSUMPTIONS = [
  "policy_mapping_effective_on_assessment_date",
  "policy_quote_valid_strictly_before_valid_until",
  "policy_quote_is_not_confirmation",
  "policy_reads_are_separate_snapshots",
  "policy_single_organization_fixture",
] as const;
