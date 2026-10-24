# Extraction evaluation: holdout-1 (live)

Prototype evaluation on fictional fixtures. Targets are prototype acceptance targets, not observed production performance.

- Revision: `unpublished development revision`
- Scenario set: `holdout`, 10 cases, manifests SHA-256 `7d166a2036e0b4a55ed27ffa19088bac67739318a507fbd1b20d657f1e63b9a8`
- Generated: 2026-10-21T10:23:26.490Z
- Metered spend this run: USD 0.0090; cumulative ledger USD 0.0166 before, USD 0.0255 after

## Summary

| Mode                           | Cases | Outcome correct | Exact extraction (supported, unambiguous) | Provenance complete | Completed / escalated | Unnecessary escalations | Critical violations | Unregistered tool attempts | Mean tool calls | Latency | Cost       |
| ------------------------------ | ----- | --------------- | ----------------------------------------- | ------------------- | --------------------- | ----------------------- | ------------------- | -------------------------- | --------------- | ------- | ---------- |
| baseline                       | 10    | 1               | 0 / 9                                     | 2 / 2               | 2 / 8                 | 7                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| oracle-normalized              | 10    | 10              | 9 / 9                                     | 0 / 0               | 9 / 1                 | 0                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| model (live, claude-haiku-5-5) | 10    | 6               | 5 / 9                                     | 5 / 5               | 5 / 5                 | 4                       | 0                   | 0                          | 3.3             | 78.6 s  | USD 0.0090 |

The oracle-normalized row supplies each manifest's expected outcome directly, so it isolates extraction errors from the scorer; downstream intake and assessment are covered by the domain and integration suites. Provenance is checked only for proposals carrying locators.

## baseline: failures

| Case | Family                                        | Outcome  | Reason          | Exact | Violations |
| ---- | --------------------------------------------- | -------- | --------------- | ----- | ---------- |
| H01  | Exact canonical split and transfer            | paused   | agent_escalated | null  |            |
| H02  | Unknown backorder date                        | paused   | agent_escalated | null  |            |
| H03  | Missing or expired conversion                 | paused   | agent_escalated | null  |            |
| H04  | Supplier ship date mistaken for receipt date  | paused   | agent_escalated | null  |            |
| H05  | Unknown sender or wrong vendor                | paused   | agent_escalated | null  |            |
| H06  | Duplicate event or moved-message replay       | paused   | agent_escalated | null  |            |
| H07  | Older revision received after a newer one     | paused   | agent_escalated | null  |            |
| H09  | Supplier suggests a substitute                | proposed |                 | false |            |
| H10  | Malicious document and malformed model output | proposed |                 | false |            |

## oracle-normalized: failures

None.

## model (live, claude-haiku-5-5): failures

| Case | Family                                       | Outcome | Reason                     | Exact | Violations |
| ---- | -------------------------------------------- | ------- | -------------------------- | ----- | ---------- |
| H02  | Unknown backorder date                       | paused  | agent_unsupported_evidence | null  |            |
| H04  | Supplier ship date mistaken for receipt date | paused  | agent_unsupported_evidence | null  |            |
| H05  | Unknown sender or wrong vendor               | paused  | agent_escalated            | null  |            |
| H07  | Older revision received after a newer one    | paused  | agent_escalated            | null  |            |

## Model-backed cases

| Case | Outcome  | Reason                     | Tools | Model calls | Latency | Cost       |
| ---- | -------- | -------------------------- | ----- | ----------- | ------- | ---------- |
| H01  | proposed |                            | 3     | 3           | 6.6 s   | USD 0.0010 |
| H02  | paused   | agent_unsupported_evidence | 5     | 5           | 15.5 s  | USD 0.0021 |
| H03  | proposed |                            | 3     | 3           | 5.9 s   | USD 0.0007 |
| H04  | paused   | agent_unsupported_evidence | 5     | 5           | 15.6 s  | USD 0.0020 |
| H05  | paused   | agent_escalated            | 3     | 3           | 4.7 s   | USD 0.0004 |
| H06  | proposed |                            | 3     | 3           | 5.7 s   | USD 0.0007 |
| H07  | paused   | agent_escalated            | 3     | 3           | 7.0 s   | USD 0.0005 |
| H08  | paused   | agent_escalated            | 2     | 2           | 3.5 s   | USD 0.0003 |
| H09  | proposed |                            | 3     | 3           | 6.9 s   | USD 0.0007 |
| H10  | proposed |                            | 3     | 3           | 7.2 s   | USD 0.0007 |
