# Operator workbench design language

Blueprint 1.0, 2026-10-18. Shared design requirements for five distinct applications. This describes design intent; no visual implementation or accessibility result is claimed.

## Visual character

Use a restrained operational interface with readable evidence, clear decisions and careful spacing. Next.js, Tailwind v4 and shadcn components built on Base UI are the shared foundation. Start from `base-nova`, then own the component source and record generator/registry provenance. A shared blueprint does not require identical branding or domain wording.

| Token family | Guideline |
| --- | --- |
| Surfaces | Neutral canvas, raised panels and one clear selected surface; light and dark themes |
| Typography | One locally hosted readable sans family, monospace for IDs, tabular numerals for amounts; 14px dense rows and 16px reading text |
| Spacing | A 4px base scale with consistent 8/12/16/24/32px gaps |
| Shape | Modest 8px control and 12px panel radii; avoid nesting decorative cards |
| Color | Semantic tokens for text, border, focus, action, warning, blocked, suggested and verified |
| Controls | Comfortable 40px default height; compact tables retain keyboard access and usable targets |
| Motion | Short functional transitions; respect reduced motion; no endless decorative animation |
| Evidence | Plain text, highlighted source spans, date/version/provenance labels and stable identifiers |

These are starting design values, subject to visual and accessibility verification. Use CSS custom properties and Tailwind theme tokens. Specify contrast-tested pairs for both themes; do not derive semantic states from arbitrary accent opacity. Never communicate a decision by color alone.

Suggested accents: indigo for vulnerability, teal for procurement, blue for receivables, amber for field service, and violet for administrative healthcare. Accent color does not replace the same verified/warning/error semantics across products.

## Navigation and case layout

The entry view is a useful case queue, with status, owner, urgency, evidence freshness and next action. Saved filters and a clear search scope precede charts. Do not invent operational volume, savings or dashboard metrics.

Case detail has three cooperating areas: a case summary and timeline, source evidence, and an assessment/decision panel. On large screens show evidence and proposed action side by side. On smaller screens preserve the decision summary and source navigation without forcing three narrow columns. The queue can scroll horizontally when necessary, with an accessible non-table summary for critical content.

Shared components include `CaseQueue`, `EvidenceReference`, `SourceVersion`, `AssessmentPanel`, `ProposalDiff`, `ApprovalDialog`, `RunProgress`, `ActionHistory`, `ModeBadge` and `ConflictNotice`. Create only components used by that repo. Domain labels, readiness rules and closure logic stay outside the UI package.

## Evidence and review interactions

Every consequential claim opens its exact source version and locator. Show source observation, model proposal and accepted decision with different labels. An absent source, stale observation or conflicting document has a designed state. A model confidence value cannot replace evidence or policy applicability.

An approval preview names the precise action, affected record, quantity/amount, source revisions, unresolved conditions and approver role. Submitting shows pending state. Only the authoritative API result may show approved, reserved, released or verified. A revision conflict keeps the proposed content visible, explains what changed, and offers reassessment without silently resubmitting an approval.

History separates requested, approved, attempted, uncertain, reconciled and verified. A pending external result must not be rendered as complete because a spinner stopped. Failed work retains context and provides a specific recovery action. Review controls are keyboard accessible and protected against double submission, but server idempotency remains necessary.

## Product-specific screen priorities

| Use case | Central evidence | Outcome language |
| --- | --- | --- |
| Vulnerability | Advisory, package/version, change, checks, artifact and environment timeline | Deployed fix verified, unresolved, exception; merge alone is insufficient |
| Supplier | Split schedule, customer commitments, stock/reservations and plan diff | Recovery plan verified; delivery is a separate event |
| Invoice | Ordered, shipped, received and billed lines beside payment and credit ledger | Credit verified and balance explained; credits are not cash recovered |
| Field service | Exact asset/kit match, qualification, booking and access prerequisites | Administrative readiness and release; no repair or safety assurance |
| Prior authorization | Existing document chronology, requirement applicability and evidence gaps | Packet ready for qualified review; no clinical or payer approval |

## Frontend engineering

Use Server Components for layouts and initial case/evidence reads. Introduce client boundaries for local interaction, forms and live progress, rather than making the entire application a client component. Pass minimal presentation records. Keep provider keys and server packages outside the browser bundle.

Use Next's current Cache Components guidance for shell and public reference content. Operational case evidence is request-time by default. Any sensitive cache must include authorization scope and preserve original observation time. Final decisions always re-read authoritative state. Choose immediate read-after-write invalidation deliberately rather than showing stale data as a confirmed result.

Configure compatible `components.json` aliases in web/UI packages. Tailwind must scan workspace component sources; use complete class names instead of constructing fragments dynamically. Share semantic tokens, not copied per-screen CSS overrides. Component refreshes are reviewed source changes because the shadcn CLI version alone does not freeze registry content.

## States and accessibility

Design loading, empty, no-results, partial-evidence, permission-denied, disconnected, stale, conflicting, rate-limited, model-unavailable and recovery states. Fixture data, live model use and simulated actions have visible labels throughout the queue, case and exported report.

Target WCAG 2.2 AA with visible focus, semantic headings, labelled controls, meaningful link text, accessible names for icon buttons, correctly managed dialogs and contrast-tested themes. Status changes use restrained live-region announcements. Respect reduced motion. Test complete keyboard workflows and a screen reader in addition to automated accessibility checks. Base UI primitives and an automated scan do not prove conformance.

Accept the design only after reviewing a populated case, difficult evidence state, empty queue, stale approval, uncertain write and mobile layout in a production build. Keep screenshots with the tested revision and synthetic data provenance. Public use-case imagery must not imply real customer usage.
