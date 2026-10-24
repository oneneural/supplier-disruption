# Extraction evaluation: dev-3 (live)

Prototype evaluation on fictional fixtures. Targets are prototype acceptance targets, not observed production performance.

- Revision: `unpublished development revision`
- Scenario set: `dev` (repository), 25 cases; set SHA-256 `e20795bdf59819c1fda92a21932b526ffa54b9f2bcda15e6b458931eec56b092` (manifests); manifests SHA-256 `e20795bdf59819c1fda92a21932b526ffa54b9f2bcda15e6b458931eec56b092`
- Model `claude-haiku-5-5`; system prompt SHA-256 `0f2fa624d9ae438b119729b66527e1db79098efd2960990cabb6c5f0da53ad8f`; tools SHA-256 `97dc351afa3414d3a51f8cb6b8f6ab2aa0157ecc628bb0abd6a827b563404fdc`
- Tool budget 10 (ceiling 12); case cap USD 0.0500; run cap USD 0.3000; downstream postgres
- Generated: 2026-10-23T17:27:39.733Z
- Metered spend this run: USD 0.0168; project ledger committed USD 0.0533 before, USD 0.0701 after
- Project ledger limit USD 1.0000; cases with unknown usage, counted at their full case cap: 0

## Summary

| Arm                            | Cases | Outcome correct | Exact proposals | Required fields exact | Semantic provenance | Accepted-plan provenance | Completed / escalated | Unnecessary escalations | Critical violations | Unregistered tool attempts | Mean tool calls | Latency | Cost       |
| ------------------------------ | ----- | --------------- | --------------- | --------------------- | ------------------- | ------------------------ | --------------------- | ----------------------- | ------------------- | -------------------------- | --------------- | ------- | ---------- |
| baseline                       | 25    | 13              | 8 / 18          | 117 / 154 (76.0%)     | 142 / 156 (91.0%)   | 106 / 119 (89.1%)        | 20 / 5                | 2                       | 1                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| oracle-normalized              | 25    | 25              | 18 / 18         | 154 / 154 (100.0%)    | n/a                 | n/a                      | 22 / 3                | 0                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| model (live, claude-haiku-5-5) | 25    | 25              | 18 / 18         | 154 / 154 (100.0%)    | 197 / 197 (100.0%)  | 154 / 154 (100.0%)       | 23 / 2                | 0                       | 0                   | 0                          | 2.9             | 200.3 s | USD 0.0168 |

Exact proposals and required fields count only cases whose manifest expects a proposal and allows no pause (supported, unambiguous inputs); a pause scores zero fields. Semantic provenance checks, for every proposed required field, that the locator reproduces the cited email span or record field and that the located value is the expected one. Accepted-plan provenance restricts that to proposals intake accepted on PostgreSQL. The oracle-normalized arm carries the manifest's expected terms and no locators; it is scored downstream, where the real workflow decides.

## Downstream

| Arm                            | PostgreSQL | Paused before intake | Pause allowed | In-memory only | Not run | Agree | Disagree | Of which world or setup gap | Unstated | Case state agrees |
| ------------------------------ | ---------- | -------------------- | ------------- | -------------- | ------- | ----- | -------- | --------------------------- | -------- | ----------------- |
| baseline                       | 17         | 5                    | 3             | 3              | 0       | 11    | 1        | 1                           | 10       | 1 / 1             |
| oracle-normalized              | 19         | 3                    | 3             | 3              | 0       | 11    | 1        | 1                           | 10       | 1 / 1             |
| model (live, claude-haiku-5-5) | 20         | 2                    | 2             | 3              | 0       | 11    | 1        | 1                           | 10       | 1 / 1             |

A proposal runs through the API workflow's intake and assessment on a fresh clone of the seeded PostgreSQL database; a paused arm leaves the case in needs_clarification with its pause reason and never reaches intake. Agreement compares only what the manifest's downstream note states in machine-checkable terms (an `intake <disposition>`, case state names and snake_case reason codes); prose is not scored. When the manifest allows a pause and the arm paused, only the case state is compared (pause allowed). A disagreement the oracle-normalized arm shares is flagged as a world or setup gap: the expected terms through the real workflow miss the note too, because the seeded world or a setup the scenario format cannot carry (an earlier delivery, changed demand) differs. The seeded world holds PO-120 and its registered sender only, so other rows are in-memory only.

| Case | World          | Why                                                                                           |
| ---- | -------------- | --------------------------------------------------------------------------------------------- |
| D01  | postgres       |                                                                                               |
| D02  | postgres       |                                                                                               |
| D03  | postgres       |                                                                                               |
| D04  | postgres       |                                                                                               |
| D05  | postgres       |                                                                                               |
| D06  | in-memory-only | PO-123 is not in the seeded world                                                             |
| D07  | postgres       |                                                                                               |
| D08  | postgres       |                                                                                               |
| D09  | in-memory-only | PO-121 is not in the seeded world                                                             |
| D10  | no-intake      |                                                                                               |
| D11  | postgres       |                                                                                               |
| D12  | in-memory-only | sender sales@harbor-supply.test is V-200 in the evaluation world and unregistered in the seed |
| D13  | postgres       | the oracle-normalized arm also misses the downstream note: world or setup gap                 |
| D14  | postgres       |                                                                                               |
| D15  | postgres       |                                                                                               |
| D16  | postgres       |                                                                                               |
| D17  | postgres       |                                                                                               |
| D18  | postgres       |                                                                                               |
| D19  | postgres       |                                                                                               |
| D20  | postgres       |                                                                                               |
| D21  | postgres       |                                                                                               |
| D22  | postgres       |                                                                                               |
| D23  | postgres       |                                                                                               |
| D24  | postgres       |                                                                                               |
| D25  | postgres       |                                                                                               |

## baseline: every miss

| Case | Family                                       | Downstream observed                                                                | Misses                                                                                                                                                                                                                      |
| ---- | -------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D03  | Stock mostly reserved to other customers     | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed, terms not exact; required fields 7 / 9                                                                                                                                                                    |
| D05  | Unknown backorder date                       | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed, terms not exact; required fields 7 / 9                                                                                                                                                                    |
| D09  | Already partially received PO                | in-memory-only                                                                     | outcome proposed, terms not exact; required fields 6 / 9; provenance segments[0].quantity: located value 150 is not the expected 100                                                                                        |
| D12  | Unknown sender or wrong vendor               | in-memory-only                                                                     | outcome proposed, terms not exact                                                                                                                                                                                           |
| D13  | Duplicate event or moved-message replay      | intake accept; case awaiting_approval (policy_plan_ready_for_approval)             | downstream reason policy_plan_ready_for_approval, expected one of intake_possible_duplicate (world or setup gap)                                                                                                            |
| D14  | Older revision received after a newer one    | intake blocked stale_base_revision; case needs_clarification (stale_base_revision) | outcome proposed, terms not exact; required fields 7 / 9                                                                                                                                                                    |
| D15  | Email and attachment disagree                | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed; provenance no proposal was expected; CRITICAL proposal                                                                                                                                                    |
| D17  | Buyer above limit or wrong-currency approval | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed, terms not exact; required fields 7 / 9                                                                                                                                                                    |
| D18  | Supplier suggests a substitute               | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed, terms not exact; required fields 7 / 9                                                                                                                                                                    |
| D20  | Write succeeds then response times out       | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed, terms not exact; required fields 7 / 9                                                                                                                                                                    |
| D21  | PO update succeeds but transfer fails        | intake not_invoked; case needs_clarification (agent_escalated)                     | outcome paused (agent_escalated); required fields 0 / 9                                                                                                                                                                     |
| D22  | Restart during a wait or partial write       | intake not_invoked; case needs_clarification (agent_escalated)                     | outcome paused (agent_escalated); required fields 0 / 9                                                                                                                                                                     |
| D24  | Transfer dispatched but not received         | intake accept; case needs_clarification (policy_schedule_total_mismatch)           | outcome proposed, terms not exact; required fields 5 / 9; provenance segments[0].quantity: located value 80 is not the expected 40; provenance segments[0].arrival: located value 2026-10-26 is not the expected 2026-10-23 |

## oracle-normalized: every miss

| Case | Family                                  | Downstream observed                                                    | Misses                                                                                                           |
| ---- | --------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D13  | Duplicate event or moved-message replay | intake accept; case awaiting_approval (policy_plan_ready_for_approval) | downstream reason policy_plan_ready_for_approval, expected one of intake_possible_duplicate (world or setup gap) |

## model (live, claude-haiku-5-5): every miss

| Case | Family                                  | Downstream observed                                                    | Misses                                                                                                           |
| ---- | --------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D13  | Duplicate event or moved-message replay | intake accept; case awaiting_approval (policy_plan_ready_for_approval) | downstream reason policy_plan_ready_for_approval, expected one of intake_possible_duplicate (world or setup gap) |

## Model-backed cases

| Case | Outcome  | Reason          | Tools | Model calls | Latency | Cost       |
| ---- | -------- | --------------- | ----- | ----------- | ------- | ---------- |
| D01  | proposed |                 | 3     | 3           | 17.0 s  | USD 0.0010 |
| D02  | proposed |                 | 3     | 3           | 7.1 s   | USD 0.0006 |
| D03  | proposed |                 | 3     | 3           | 7.1 s   | USD 0.0007 |
| D04  | proposed |                 | 3     | 3           | 6.6 s   | USD 0.0005 |
| D05  | proposed |                 | 3     | 3           | 8.7 s   | USD 0.0006 |
| D06  | proposed |                 | 3     | 3           | 7.8 s   | USD 0.0005 |
| D07  | proposed |                 | 3     | 3           | 7.8 s   | USD 0.0006 |
| D08  | proposed |                 | 4     | 4           | 12.9 s  | USD 0.0014 |
| D09  | proposed |                 | 3     | 3           | 8.1 s   | USD 0.0008 |
| D10  | paused   | agent_escalated | 3     | 3           | 5.5 s   | USD 0.0004 |
| D11  | proposed |                 | 3     | 3           | 8.0 s   | USD 0.0007 |
| D12  | proposed |                 | 3     | 3           | 9.9 s   | USD 0.0007 |
| D13  | proposed |                 | 3     | 3           | 8.1 s   | USD 0.0006 |
| D14  | proposed |                 | 3     | 3           | 7.4 s   | USD 0.0007 |
| D15  | paused   | agent_escalated | 2     | 2           | 3.3 s   | USD 0.0003 |
| D16  | proposed |                 | 3     | 3           | 5.4 s   | USD 0.0006 |
| D17  | proposed |                 | 3     | 3           | 7.9 s   | USD 0.0007 |
| D18  | proposed |                 | 3     | 3           | 9.7 s   | USD 0.0008 |
| D19  | proposed |                 | 3     | 3           | 6.3 s   | USD 0.0006 |
| D20  | proposed |                 | 3     | 3           | 6.4 s   | USD 0.0007 |
| D21  | proposed |                 | 2     | 2           | 7.7 s   | USD 0.0006 |
| D22  | proposed |                 | 3     | 3           | 9.3 s   | USD 0.0008 |
| D23  | proposed |                 | 3     | 3           | 8.7 s   | USD 0.0007 |
| D24  | proposed |                 | 2     | 2           | 5.9 s   | USD 0.0006 |
| D25  | proposed |                 | 3     | 3           | 7.7 s   | USD 0.0008 |
