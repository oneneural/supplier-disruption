# Extraction evaluation: smoke-1 (live)

Prototype evaluation on fictional fixtures. Targets are prototype acceptance targets, not observed production performance.

- Revision: `unpublished development revision`
- Scenario set: `dev`, 2 cases, manifests SHA-256 `0b8df84583545a83791aaa6d10f2b033e4a1e5762e9330140b352a9ec42b01a4`
- Generated: 2026-10-21T09:55:19.829Z
- Metered spend this run: USD 0.0013; cumulative ledger USD 0.0000 before, USD 0.0013 after

## Summary

| Mode                           | Cases | Outcome correct | Exact extraction (supported, unambiguous) | Provenance complete | Completed / escalated | Unnecessary escalations | Critical violations | Unregistered tool attempts | Mean tool calls | Latency | Cost       |
| ------------------------------ | ----- | --------------- | ----------------------------------------- | ------------------- | --------------------- | ----------------------- | ------------------- | -------------------------- | --------------- | ------- | ---------- |
| baseline                       | 2     | 1               | 1 / 1                                     | 2 / 2               | 2 / 0                 | 0                       | 1                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| oracle-normalized              | 2     | 2               | 1 / 1                                     | 0 / 0               | 1 / 1                 | 0                       | 0                   | 0                          | 0.0             | 0.0 s   | USD 0.0000 |
| model (live, claude-haiku-5-5) | 2     | 2               | 1 / 1                                     | 1 / 1               | 1 / 1                 | 0                       | 0                   | 0                          | 2.5             | 16.3 s  | USD 0.0013 |

The oracle-normalized row supplies each manifest's expected outcome directly, so it isolates extraction errors from the scorer; downstream intake and assessment are covered by the domain and integration suites. Provenance is checked only for proposals carrying locators.

## baseline: failures

| Case | Family                        | Outcome  | Reason | Exact | Violations |
| ---- | ----------------------------- | -------- | ------ | ----- | ---------- |
| D15  | Email and attachment disagree | proposed |        | null  | proposal   |

## oracle-normalized: failures

None.

## model (live, claude-haiku-5-5): failures

None.

## Model-backed cases

| Case | Outcome  | Reason          | Tools | Model calls | Latency | Cost       |
| ---- | -------- | --------------- | ----- | ----------- | ------- | ---------- |
| D01  | proposed |                 | 3     | 3           | 13.3 s  | USD 0.0010 |
| D15  | paused   | agent_escalated | 2     | 2           | 3.0 s   | USD 0.0003 |
