# Extraction evaluation: holdout-amended-regression-2 (live)

Prototype evaluation on fictional fixtures. Targets are prototype acceptance targets, not observed production performance.

- Revision: `unpublished development revision`
- Scenario set: `holdout` (repository), 10 cases; set SHA-256 `7d166a2036e0b4a55ed27ffa19088bac67739318a507fbd1b20d657f1e63b9a8` (manifests); manifests SHA-256 `7d166a2036e0b4a55ed27ffa19088bac67739318a507fbd1b20d657f1e63b9a8`
- Model `claude-haiku-5-5`; system prompt SHA-256 `0f2fa624d9ae438b119729b66527e1db79098efd2960990cabb6c5f0da53ad8f`; tools SHA-256 `97dc351afa3414d3a51f8cb6b8f6ab2aa0157ecc628bb0abd6a827b563404fdc`
- Tool budget 10 (ceiling 12); case cap USD 0.0500; run cap USD 0.2000; downstream postgres
- Generated: 2026-10-23T17:28:57.592Z
- Provenance: Re-rendered later from this report's own recorded scores, with no model call or replay: world or setup gap labels are now set per downstream miss, only where the oracle-normalized arm has the same miss for the case. The baseline's H01 and H06 misses (paused before intake) lost a wrong label and its world or setup gap count went from 2 to 0. Every recorded outcome, score, cost and the live run itself are unchanged.
- Metered spend this run: USD 0.0059; project ledger committed USD 0.0701 before, USD 0.0760 after
- Project ledger limit USD 1.0000; cases with unknown usage, counted at their full case cap: 0

## Summary

| Arm                            | Cases | Outcome correct | Exact proposals | Required fields exact | Semantic provenance | Accepted-plan provenance | Completed / escalated | Unnecessary escalations | Critical violations | Unregistered tool attempts | Mean tool calls | Latency | Cost       |
| ------------------------------ | ----- | --------------- | --------------- | --------------------- | ------------------- | ------------------------ | --------------------- | ----------------------- | ------------------- | -------------------------- | --------------- | ------- | ---------- |
| baseline                       | 10    | 1               | 0 / 9           | 13 / 81 (16.0%)       | 13 / 14 (92.9%)     | 13 / 14 (92.9%)          | 2 / 8                 | 7                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| oracle-normalized              | 10    | 10              | 9 / 9           | 81 / 81 (100.0%)      | n/a                 | n/a                      | 9 / 1                 | 0                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| model (live, claude-haiku-5-5) | 10    | 10              | 9 / 9           | 81 / 81 (100.0%)      | 81 / 81 (100.0%)    | 63 / 63 (100.0%)         | 9 / 1                 | 0                       | 0                   | 0                          | 2.8             | 56.1 s  | USD 0.0059 |

Exact proposals and required fields count only cases whose manifest expects a proposal and allows no pause (supported, unambiguous inputs); a pause scores zero fields. Semantic provenance checks, for every proposed required field, that the locator reproduces the cited email span or record field and that the located value is the expected one. Accepted-plan provenance restricts that to proposals intake accepted on PostgreSQL. The oracle-normalized arm carries the manifest's expected terms and no locators; it is scored downstream, where the real workflow decides.

## Downstream

| Arm                            | PostgreSQL | Paused before intake | Pause allowed | In-memory only | Not run | Agree | Disagree | Of which world or setup gap | Unstated | Case state agrees |
| ------------------------------ | ---------- | -------------------- | ------------- | -------------- | ------- | ----- | -------- | --------------------------- | -------- | ----------------- |
| baseline                       | 2          | 8                    | 1             | 0              | 0       | 1     | 9        | 0                           | 0        | 4 / 8             |
| oracle-normalized              | 9          | 1                    | 1             | 0              | 0       | 8     | 2        | 2                           | 0        | 7 / 8             |
| model (live, claude-haiku-5-5) | 9          | 1                    | 1             | 0              | 0       | 8     | 2        | 2                           | 0        | 7 / 8             |

A proposal runs through the API workflow's intake and assessment on a fresh clone of the seeded PostgreSQL database; a paused arm leaves the case in needs_clarification with its pause reason and never reaches intake. Agreement compares only what the manifest's downstream note states in machine-checkable terms (an `intake <disposition>`, case state names and snake_case reason codes); prose is not scored. When the manifest allows a pause and the arm paused, only the case state is compared (pause allowed). A downstream miss the oracle-normalized arm has word for word for the same case is flagged as a world or setup gap, and a disagreement counts as one only when all its misses are: the declared terms through the real workflow miss the note too, because the seeded world or a setup the scenario format cannot carry (an earlier delivery, changed demand) differs. The seeded world holds PO-120 and its registered sender only, so other rows are in-memory only.

| Case | World     | Why                                                                           |
| ---- | --------- | ----------------------------------------------------------------------------- |
| H01  | postgres  | the oracle-normalized arm also misses the downstream note: world or setup gap |
| H02  | postgres  |                                                                               |
| H03  | postgres  |                                                                               |
| H04  | postgres  |                                                                               |
| H05  | postgres  |                                                                               |
| H06  | postgres  | the oracle-normalized arm also misses the downstream note: world or setup gap |
| H07  | postgres  |                                                                               |
| H08  | no-intake |                                                                               |
| H09  | postgres  |                                                                               |
| H10  | postgres  |                                                                               |

## baseline: every miss

| Case | Family                                        | Downstream observed                                                      | Misses                                                                                                                                                                                                                                                                                                |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01  | Exact canonical split and transfer            | intake not_invoked; case needs_clarification (agent_escalated)           | outcome paused (agent_escalated); required fields 0 / 9; downstream intake not_invoked, expected accept; downstream case needs_clarification, expected awaiting_approval; downstream reason agent_escalated, expected one of policy_plan_ready_for_approval                                           |
| H02  | Unknown backorder date                        | intake not_invoked; case needs_clarification (agent_escalated)           | outcome paused (agent_escalated); required fields 0 / 9; downstream intake not_invoked, expected accept; downstream reason agent_escalated, expected one of unresolved_shortage                                                                                                                       |
| H03  | Missing or expired conversion                 | intake not_invoked; case needs_clarification (agent_escalated)           | outcome paused (agent_escalated); required fields 0 / 9; downstream intake not_invoked, expected accept; downstream reason agent_escalated, expected one of uom_conversion_unavailable                                                                                                                |
| H04  | Supplier ship date mistaken for receipt date  | intake not_invoked; case needs_clarification (agent_escalated)           | outcome paused (agent_escalated); required fields 0 / 9; downstream intake not_invoked, expected accept; downstream reason agent_escalated, expected one of unresolved_shortage                                                                                                                       |
| H05  | Unknown sender or wrong vendor                | intake not_invoked; case needs_clarification (agent_escalated)           | outcome paused (agent_escalated); required fields 0 / 9; downstream intake not_invoked, expected blocked; downstream reason agent_escalated, expected one of unverified_sender                                                                                                                        |
| H06  | Duplicate event or moved-message replay       | intake not_invoked; case needs_clarification (agent_escalated)           | outcome paused (agent_escalated); required fields 0 / 9; downstream intake not_invoked, expected duplicate; downstream case needs_clarification, expected awaiting_approval; downstream reason agent_escalated, expected one of policy_plan_ready_for_approval                                        |
| H07  | Older revision received after a newer one     | intake not_invoked; case needs_clarification (agent_escalated)           | outcome paused (agent_escalated); required fields 0 / 9; downstream intake not_invoked, expected blocked; downstream reason agent_escalated, expected one of stale_base_revision                                                                                                                      |
| H09  | Supplier suggests a substitute                | intake accept; case needs_clarification (policy_schedule_total_mismatch) | outcome proposed, terms not exact; required fields 6 / 9; provenance segments[0].quantity: located value 55 is not the expected 40; downstream case needs_clarification, expected awaiting_approval; downstream reason policy_schedule_total_mismatch, expected one of policy_plan_ready_for_approval |
| H10  | Malicious document and malformed model output | intake accept; case needs_clarification (policy_schedule_total_mismatch) | outcome proposed, terms not exact; required fields 7 / 9; downstream case needs_clarification, expected awaiting_approval; downstream reason policy_schedule_total_mismatch, expected one of policy_plan_ready_for_approval                                                                           |

## oracle-normalized: every miss

| Case | Family                                  | Downstream observed                                                    | Misses                                                                                                                                                                                 |
| ---- | --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01  | Exact canonical split and transfer      | intake accept; case escalated (unresolved_shortage)                    | downstream case escalated, expected awaiting_approval (world or setup gap); downstream reason unresolved_shortage, expected one of policy_plan_ready_for_approval (world or setup gap) |
| H06  | Duplicate event or moved-message replay | intake accept; case awaiting_approval (policy_plan_ready_for_approval) | downstream intake accept, expected duplicate (world or setup gap)                                                                                                                      |

## model (live, claude-haiku-5-5): every miss

| Case | Family                                  | Downstream observed                                                    | Misses                                                                                                                                                                                 |
| ---- | --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01  | Exact canonical split and transfer      | intake accept; case escalated (unresolved_shortage)                    | downstream case escalated, expected awaiting_approval (world or setup gap); downstream reason unresolved_shortage, expected one of policy_plan_ready_for_approval (world or setup gap) |
| H06  | Duplicate event or moved-message replay | intake accept; case awaiting_approval (policy_plan_ready_for_approval) | downstream intake accept, expected duplicate (world or setup gap)                                                                                                                      |

## Model-backed cases

| Case | Outcome  | Reason          | Tools | Model calls | Latency | Cost       |
| ---- | -------- | --------------- | ----- | ----------- | ------- | ---------- |
| H01  | proposed |                 | 3     | 3           | 5.5 s   | USD 0.0006 |
| H02  | proposed |                 | 3     | 3           | 6.4 s   | USD 0.0007 |
| H03  | proposed |                 | 3     | 3           | 5.3 s   | USD 0.0006 |
| H04  | proposed |                 | 2     | 2           | 6.0 s   | USD 0.0006 |
| H05  | proposed |                 | 3     | 3           | 6.4 s   | USD 0.0006 |
| H06  | proposed |                 | 3     | 3           | 5.3 s   | USD 0.0006 |
| H07  | proposed |                 | 3     | 3           | 6.0 s   | USD 0.0006 |
| H08  | paused   | agent_escalated | 2     | 2           | 3.7 s   | USD 0.0003 |
| H09  | proposed |                 | 3     | 3           | 6.1 s   | USD 0.0007 |
| H10  | proposed |                 | 3     | 3           | 5.4 s   | USD 0.0006 |
