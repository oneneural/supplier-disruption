# Extraction evaluation: holdout-3 (live)

Prototype evaluation on fictional fixtures. Targets are prototype acceptance targets, not observed production performance.

- Revision: `unpublished development revision`
- Scenario set: `holdout-3` (external), 16 cases; set SHA-256 `e18dc47b20c27f6935f646e7e3a458fac43031ffe352ef087a577c3da6e1a1c3` (MANIFEST.sha256); manifests SHA-256 `783f74431bacabb48562d37f25a8102d824516fb7744eabc25289497a114334d`
- Model `claude-haiku-5-5`; system prompt SHA-256 `0f2fa624d9ae438b119729b66527e1db79098efd2960990cabb6c5f0da53ad8f`; tools SHA-256 `97dc351afa3414d3a51f8cb6b8f6ab2aa0157ecc628bb0abd6a827b563404fdc`
- Tool budget 10 (ceiling 12); case cap USD 0.0500; run cap USD 0.5000; downstream postgres
- Generated: 2026-10-23T18:23:27.779Z
- Set check: MANIFEST.sha256: 52 files match; every file under cases/ and case-index.json is listed
- Set check: 16 cases match the strict scenario format
- Set check: 16 oracles: ids and declared digests match
- Set check: case-index.json: entries match the cases
- Case index: required-field denominator 84, expected segments 17, proposed 10, paused 6
- Metered spend this run: USD 0.0085; project ledger committed USD 0.0765 before, USD 0.0850 after
- Project ledger limit USD 1.0000; cases with unknown usage, counted at their full case cap: 0

## Summary

| Arm                            | Cases | Outcome correct | Exact proposals | Required fields exact | Semantic provenance | Accepted-plan provenance | Completed / escalated | Unnecessary escalations | Critical violations | Unregistered tool attempts | Mean tool calls | Latency | Cost       |
| ------------------------------ | ----- | --------------- | --------------- | --------------------- | ------------------- | ------------------------ | --------------------- | ----------------------- | ------------------- | -------------------------- | --------------- | ------- | ---------- |
| baseline                       | 16    | 6               | 4 / 10          | 58 / 84 (69.0%)       | 58 / 89 (65.2%)     | 25 / 41 (61.0%)          | 11 / 5                | 3                       | 4                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| oracle-normalized              | 16    | 16              | 10 / 10         | 84 / 84 (100.0%)      | n/a                 | n/a                      | 10 / 6                | 0                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| model (live, claude-haiku-5-5) | 16    | 16              | 10 / 10         | 84 / 84 (100.0%)      | 84 / 84 (100.0%)    | 43 / 43 (100.0%)         | 10 / 6                | 0                       | 0                   | 0                          | 2.6             | 80.2 s  | USD 0.0085 |

Exact proposals and required fields count only cases whose manifest expects a proposal and allows no pause (supported, unambiguous inputs); a pause scores zero fields. Semantic provenance checks, for every proposed required field, that the locator reproduces the cited email span or record field and that the located value is the expected one. Accepted-plan provenance restricts that to proposals intake accepted on PostgreSQL. The oracle-normalized arm carries the manifest's expected terms and no locators; it is scored downstream, where the real workflow decides.

## Downstream

| Arm                            | PostgreSQL | Paused before intake | Pause allowed | In-memory only | Not run | Agree | Disagree | Of which world or setup gap | Unstated | Case state agrees |
| ------------------------------ | ---------- | -------------------- | ------------- | -------------- | ------- | ----- | -------- | --------------------------- | -------- | ----------------- |
| baseline                       | 6          | 5                    | 2             | 5              | 0       | 0     | 1        | 1                           | 10       | 0 / 1             |
| oracle-normalized              | 5          | 6                    | 6             | 5              | 0       | 0     | 1        | 1                           | 10       | 0 / 1             |
| model (live, claude-haiku-5-5) | 5          | 6                    | 6             | 5              | 0       | 0     | 1        | 1                           | 10       | 0 / 1             |

A proposal runs through the API workflow's intake and assessment on a fresh clone of the seeded PostgreSQL database; a paused arm leaves the case in needs_clarification with its pause reason and never reaches intake. Agreement compares only what the manifest's downstream note states in machine-checkable terms (an `intake <disposition>`, case state names and snake_case reason codes); prose is not scored. When the manifest allows a pause and the arm paused, only the case state is compared (pause allowed). A downstream miss the oracle-normalized arm has word for word for the same case is flagged as a world or setup gap, and a disagreement counts as one only when all its misses are: the declared terms through the real workflow miss the note too, because the seeded world or a setup the scenario format cannot carry (an earlier delivery, changed demand) differs. The seeded world holds PO-120 and its registered sender only, so other rows are in-memory only.

| Case | World          | Why                                                                                           |
| ---- | -------------- | --------------------------------------------------------------------------------------------- |
| J01  | in-memory-only | PO-121 is not in the seeded world                                                             |
| J02  | in-memory-only | PO-123 is not in the seeded world                                                             |
| J03  | in-memory-only | PO-122 is not in the seeded world                                                             |
| J04  | in-memory-only | PO-122 is not in the seeded world                                                             |
| J05  | postgres       |                                                                                               |
| J06  | postgres       |                                                                                               |
| J07  | in-memory-only | PO-123 is not in the seeded world                                                             |
| J08  | postgres       |                                                                                               |
| J09  | postgres       |                                                                                               |
| J10  | postgres       |                                                                                               |
| J11  | in-memory-only | PO-121 is not in the seeded world                                                             |
| J12  | in-memory-only | sender sales@harbor-supply.test is V-200 in the evaluation world and unregistered in the seed |
| J13  | no-intake      | the oracle-normalized arm also misses the downstream note: world or setup gap                 |
| J14  | postgres       |                                                                                               |
| J15  | no-intake      |                                                                                               |
| J16  | postgres       |                                                                                               |

## baseline: every miss

| Case | Family                                                     | Downstream observed                                                                | Misses                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J02  | Full delay with PO-sourced line and revision               | intake not_invoked; case needs_clarification (agent_escalated)                     | outcome paused (agent_escalated); required fields 0 / 7                                                                                                                                                     |
| J04  | Consolidated quantity without a line allocation            | in-memory-only                                                                     | outcome proposed; provenance no proposal was expected; CRITICAL proposal                                                                                                                                    |
| J05  | Quantity range without a firm count                        | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed; provenance no proposal was expected; CRITICAL proposal                                                                                                                                    |
| J06  | All supply undated despite an invoice-processing date      | intake not_invoked; case needs_clarification (agent_escalated)                     | outcome paused (agent_escalated); required fields 0 / 7                                                                                                                                                     |
| J08  | Boxes distinguished from empty returnable packaging        | intake not_invoked; case needs_clarification (agent_escalated)                     | outcome paused (agent_escalated); required fields 0 / 9                                                                                                                                                     |
| J09  | Alternative existing item with no ordered-item schedule    | intake accept; case escalated (unresolved_shortage)                                | outcome proposed; provenance no proposal was expected; CRITICAL proposal                                                                                                                                    |
| J10  | Current correction supersedes quoted schedule history      | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed, terms not exact; provenance segments[2].quantity: located value 120 is not the expected undefined; provenance segments[2].arrival: located value 2026-10-23 is not the expected undefined |
| J11  | Copied subject explicitly corrected in the body            | intake blocked stale_base_revision; case needs_clarification (stale_base_revision) | outcome proposed, terms not exact; required fields 6 / 7; provenance poNumber: located value PO-120 is not the expected PO-121                                                                              |
| J12  | Another registered vendor forwards a disclaimed offer      | in-memory-only                                                                     | outcome proposed; provenance no proposal was expected; CRITICAL proposal                                                                                                                                    |
| J13  | Mail transport receipt without business acceptance         | intake not_invoked; case needs_clarification (agent_escalated)                     | downstream case needs_clarification, expected awaiting_acknowledgement (world or setup gap)                                                                                                                 |
| J16  | Authoritative attachment with mixed dated and undated lots | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed, terms not exact; required fields 7 / 9                                                                                                                                                    |

## oracle-normalized: every miss

| Case | Family                                             | Downstream observed                                            | Misses                                                                                      |
| ---- | -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| J13  | Mail transport receipt without business acceptance | intake not_invoked; case needs_clarification (agent_escalated) | downstream case needs_clarification, expected awaiting_acknowledgement (world or setup gap) |

## model (live, claude-haiku-5-5): every miss

| Case | Family                                             | Downstream observed                                            | Misses                                                                                      |
| ---- | -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| J13  | Mail transport receipt without business acceptance | intake not_invoked; case needs_clarification (agent_escalated) | downstream case needs_clarification, expected awaiting_acknowledgement (world or setup gap) |

## Model-backed cases

| Case | Outcome  | Reason          | Tools | Model calls | Latency | Cost       |
| ---- | -------- | --------------- | ----- | ----------- | ------- | ---------- |
| J01  | proposed |                 | 3     | 3           | 6.7 s   | USD 0.0011 |
| J02  | proposed |                 | 3     | 3           | 6.5 s   | USD 0.0006 |
| J03  | proposed |                 | 3     | 3           | 4.9 s   | USD 0.0006 |
| J04  | paused   | agent_escalated | 2     | 2           | 3.6 s   | USD 0.0003 |
| J05  | paused   | agent_escalated | 2     | 2           | 3.5 s   | USD 0.0003 |
| J06  | proposed |                 | 3     | 3           | 5.4 s   | USD 0.0005 |
| J07  | proposed |                 | 3     | 3           | 5.5 s   | USD 0.0006 |
| J08  | proposed |                 | 3     | 3           | 5.6 s   | USD 0.0006 |
| J09  | paused   | agent_escalated | 2     | 2           | 4.3 s   | USD 0.0003 |
| J10  | proposed |                 | 2     | 2           | 5.5 s   | USD 0.0006 |
| J11  | proposed |                 | 3     | 3           | 6.2 s   | USD 0.0006 |
| J12  | paused   | agent_escalated | 2     | 2           | 4.0 s   | USD 0.0004 |
| J13  | paused   | agent_escalated | 2     | 2           | 3.5 s   | USD 0.0003 |
| J14  | proposed |                 | 3     | 3           | 5.7 s   | USD 0.0006 |
| J15  | paused   | agent_escalated | 2     | 2           | 3.1 s   | USD 0.0003 |
| J16  | proposed |                 | 3     | 3           | 6.1 s   | USD 0.0007 |
