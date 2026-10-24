# Extraction evaluation: smoke-2 (live)

Prototype evaluation on fictional fixtures. Targets are prototype acceptance targets, not observed production performance.

- Revision: `unpublished development revision`
- Scenario set: `dev` (repository), 1 cases; set SHA-256 `e20795bdf59819c1fda92a21932b526ffa54b9f2bcda15e6b458931eec56b092` (manifests); manifests SHA-256 `e20795bdf59819c1fda92a21932b526ffa54b9f2bcda15e6b458931eec56b092`
- Model `claude-haiku-5-5`; system prompt SHA-256 `0f2fa624d9ae438b119729b66527e1db79098efd2960990cabb6c5f0da53ad8f`; tools SHA-256 `97dc351afa3414d3a51f8cb6b8f6ab2aa0157ecc628bb0abd6a827b563404fdc`
- Tool budget 10 (ceiling 12); case cap USD 0.0500; run cap USD 0.0500; downstream none
- Generated: 2026-10-23T17:29:13.781Z
- Metered spend this run: USD 0.0005; project ledger committed USD 0.0760 before, USD 0.0765 after
- Project ledger limit USD 1.0000; cases with unknown usage, counted at their full case cap: 0

## Summary

| Arm                            | Cases | Outcome correct | Exact proposals | Required fields exact | Semantic provenance | Accepted-plan provenance | Completed / escalated | Unnecessary escalations | Critical violations | Unregistered tool attempts | Mean tool calls | Latency | Cost       |
| ------------------------------ | ----- | --------------- | --------------- | --------------------- | ------------------- | ------------------------ | --------------------- | ----------------------- | ------------------- | -------------------------- | --------------- | ------- | ---------- |
| baseline                       | 1     | 1               | 1 / 1           | 9 / 9 (100.0%)        | 9 / 9 (100.0%)      | n/a                      | 1 / 0                 | 0                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| oracle-normalized              | 1     | 1               | 1 / 1           | 9 / 9 (100.0%)        | n/a                 | n/a                      | 1 / 0                 | 0                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| model (live, claude-haiku-5-5) | 1     | 1               | 1 / 1           | 9 / 9 (100.0%)        | 9 / 9 (100.0%)      | n/a                      | 1 / 0                 | 0                       | 0                   | 0                          | 3.0             | 6.3 s   | USD 0.0005 |

Exact proposals and required fields count only cases whose manifest expects a proposal and allows no pause (supported, unambiguous inputs); a pause scores zero fields. Semantic provenance checks, for every proposed required field, that the locator reproduces the cited email span or record field and that the located value is the expected one. Accepted-plan provenance restricts that to proposals intake accepted on PostgreSQL. The oracle-normalized arm carries the manifest's expected terms and no locators; it is scored downstream, where the real workflow decides.

## Downstream

| Arm                            | PostgreSQL | Paused before intake | Pause allowed | In-memory only | Not run | Agree | Disagree | Of which world or setup gap | Unstated | Case state agrees |
| ------------------------------ | ---------- | -------------------- | ------------- | -------------- | ------- | ----- | -------- | --------------------------- | -------- | ----------------- |
| baseline                       | 0          | 0                    | 0             | 0              | 1       | 0     | 0        | 0                           | 0        | 0 / 0             |
| oracle-normalized              | 0          | 0                    | 0             | 0              | 1       | 0     | 0        | 0                           | 0        | 0 / 0             |
| model (live, claude-haiku-5-5) | 0          | 0                    | 0             | 0              | 1       | 0     | 0        | 0                           | 0        | 0 / 0             |

A proposal runs through the API workflow's intake and assessment on a fresh clone of the seeded PostgreSQL database; a paused arm leaves the case in needs_clarification with its pause reason and never reaches intake. Agreement compares only what the manifest's downstream note states in machine-checkable terms (an `intake <disposition>`, case state names and snake_case reason codes); prose is not scored. When the manifest allows a pause and the arm paused, only the case state is compared (pause allowed). A disagreement the oracle-normalized arm shares is flagged as a world or setup gap: the expected terms through the real workflow miss the note too, because the seeded world or a setup the scenario format cannot carry (an earlier delivery, changed demand) differs. The seeded world holds PO-120 and its registered sender only, so other rows are in-memory only.

| Case | World            | Why               |
| ---- | ---------------- | ----------------- |
| D01  | postgres-not-run | --downstream none |

## baseline: every miss

None.

## oracle-normalized: every miss

None.

## model (live, claude-haiku-5-5): every miss

None.

## Model-backed cases

| Case | Outcome  | Reason | Tools | Model calls | Latency | Cost       |
| ---- | -------- | ------ | ----- | ----------- | ------- | ---------- |
| D01  | proposed |        | 3     | 3           | 6.3 s   | USD 0.0005 |
