# Extraction evaluation: dev-1 (live)

Prototype evaluation on fictional fixtures. Targets are prototype acceptance targets, not observed production performance.

- Revision: `unpublished development revision`
- Scenario set: `dev`, 25 cases, manifests SHA-256 `e20795bdf59819c1fda92a21932b526ffa54b9f2bcda15e6b458931eec56b092`
- Generated: 2026-10-21T10:09:34.562Z
- Metered spend this run: USD 0.0153; cumulative ledger USD 0.0013 before, USD 0.0166 after

## Summary

| Mode                           | Cases | Outcome correct | Exact extraction (supported, unambiguous) | Provenance complete | Completed / escalated | Unnecessary escalations | Critical violations | Unregistered tool attempts | Mean tool calls | Latency | Cost       |
| ------------------------------ | ----- | --------------- | ----------------------------------------- | ------------------- | --------------------- | ----------------------- | ------------------- | -------------------------- | --------------- | ------- | ---------- |
| baseline                       | 25    | 13              | 8 / 18                                    | 20 / 20             | 20 / 5                | 2                       | 1                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| oracle-normalized              | 25    | 25              | 18 / 18                                   | 0 / 0               | 22 / 3                | 0                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| model (live, claude-haiku-5-5) | 25    | 23              | 16 / 18                                   | 19 / 19             | 19 / 6                | 2                       | 0                   | 0                          | 3.0             | 154.7 s | USD 0.0153 |

The oracle-normalized row supplies each manifest's expected outcome directly, so it isolates extraction errors from the scorer; downstream intake and assessment are covered by the domain and integration suites. Provenance is checked only for proposals carrying locators.

## baseline: failures

| Case | Family                                       | Outcome  | Reason          | Exact | Violations |
| ---- | -------------------------------------------- | -------- | --------------- | ----- | ---------- |
| D03  | Stock mostly reserved to other customers     | proposed |                 | false |            |
| D05  | Unknown backorder date                       | proposed |                 | false |            |
| D09  | Already partially received PO                | proposed |                 | false |            |
| D12  | Unknown sender or wrong vendor               | proposed |                 | false |            |
| D14  | Older revision received after a newer one    | proposed |                 | false |            |
| D15  | Email and attachment disagree                | proposed |                 | null  | proposal   |
| D17  | Buyer above limit or wrong-currency approval | proposed |                 | false |            |
| D18  | Supplier suggests a substitute               | proposed |                 | false |            |
| D20  | Write succeeds then response times out       | proposed |                 | false |            |
| D21  | PO update succeeds but transfer fails        | paused   | agent_escalated | null  |            |
| D22  | Restart during a wait or partial write       | paused   | agent_escalated | null  |            |
| D24  | Transfer dispatched but not received         | proposed |                 | false |            |

## oracle-normalized: failures

None.

## model (live, claude-haiku-5-5): failures

| Case | Family                                    | Outcome | Reason               | Exact | Violations |
| ---- | ----------------------------------------- | ------- | -------------------- | ----- | ---------- |
| D07  | Missing or expired conversion             | paused  | agent_low_confidence | null  |            |
| D14  | Older revision received after a newer one | paused  | agent_escalated      | null  |            |

## Model-backed cases

| Case | Outcome  | Reason               | Tools | Model calls | Latency | Cost       |
| ---- | -------- | -------------------- | ----- | ----------- | ------- | ---------- |
| D01  | proposed |                      | 3     | 3           | 5.7 s   | USD 0.0010 |
| D02  | proposed |                      | 3     | 3           | 9.2 s   | USD 0.0005 |
| D03  | proposed |                      | 3     | 3           | 7.3 s   | USD 0.0007 |
| D04  | proposed |                      | 3     | 3           | 5.9 s   | USD 0.0006 |
| D05  | proposed |                      | 3     | 3           | 6.3 s   | USD 0.0007 |
| D06  | proposed |                      | 3     | 3           | 6.2 s   | USD 0.0006 |
| D07  | paused   | agent_low_confidence | 3     | 3           | 6.0 s   | USD 0.0006 |
| D08  | proposed |                      | 3     | 3           | 6.9 s   | USD 0.0007 |
| D09  | proposed |                      | 3     | 3           | 7.2 s   | USD 0.0007 |
| D10  | paused   | agent_escalated      | 3     | 3           | 5.9 s   | USD 0.0004 |
| D11  | paused   | agent_escalated      | 3     | 3           | 5.1 s   | USD 0.0004 |
| D12  | paused   | agent_escalated      | 3     | 3           | 4.4 s   | USD 0.0004 |
| D13  | proposed |                      | 3     | 3           | 5.7 s   | USD 0.0006 |
| D14  | paused   | agent_escalated      | 3     | 3           | 6.0 s   | USD 0.0005 |
| D15  | paused   | agent_escalated      | 2     | 2           | 4.0 s   | USD 0.0002 |
| D16  | proposed |                      | 3     | 3           | 6.1 s   | USD 0.0006 |
| D17  | proposed |                      | 3     | 3           | 6.3 s   | USD 0.0006 |
| D18  | proposed |                      | 3     | 3           | 5.8 s   | USD 0.0006 |
| D19  | proposed |                      | 3     | 3           | 5.9 s   | USD 0.0006 |
| D20  | proposed |                      | 3     | 3           | 6.0 s   | USD 0.0006 |
| D21  | proposed |                      | 3     | 3           | 6.7 s   | USD 0.0007 |
| D22  | proposed |                      | 3     | 3           | 6.3 s   | USD 0.0007 |
| D23  | proposed |                      | 3     | 3           | 6.1 s   | USD 0.0006 |
| D24  | proposed |                      | 3     | 3           | 6.6 s   | USD 0.0007 |
| D25  | proposed |                      | 3     | 3           | 6.7 s   | USD 0.0008 |
