# Extraction evaluation

This directory holds the extraction evaluation runner (`run.mjs`), its report
renderer and PostgreSQL downstream stage, the repository scenario sets, the
recorded replays and the reports. How the runner works, the scoring rules and
earlier results are in [ADR 0011](../docs/adr/0011-extraction-agent.md). All
cases are synthetic and run against fictional fixture data. Results are
prototype evidence, not production accuracy.

## Reports index

| Report                                                                       | Set                                | Kind                                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| [holdout-3](reports/holdout-3-live.md)                                       | Independent external set, 16 cases | First and only live exposure; untouched result                       |
| [holdout-amended-regression-2](reports/holdout-amended-regression-2-live.md) | Repository held-out set, exposed   | Regression only                                                      |
| [dev-3](reports/dev-3-live.md)                                               | Development set                    | Development                                                          |
| [holdout-1](reports/holdout-1-live.md)                                       | Repository held-out set, first run | Untouched result for the original revision: 6/10 outcomes, 5/9 exact |

Earlier development, regression, rescored and smoke runs stay beside these
unchanged.

## holdout-3: independent held-out evaluation

This is the first and only live run of the holdout-3 set. The set was written
independently and frozen outside the repository; the runner read it in place
and nothing from it was used to change the agent.

- Frozen revision: the development revision of the run, before this snapshot.
  The model (`claude-haiku-5-5`), system prompt (SHA-256 `0f2fa624d9ae438b119729b66527e1db79098efd2960990cabb6c5f0da53ad8f`),
  tools, validator and scorer were fixed at this revision before the set was
  exposed.
- Set hash: SHA-256 of `MANIFEST.sha256`,
  `e18dc47b20c27f6935f646e7e3a458fac43031ffe352ef087a577c3da6e1a1c3`. The
  runner verified all 52 listed files, 16 cases, 16 oracles and the case index.
- Arms: deterministic baseline, oracle-normalized declared terms and the live
  model, all on the same email evidence, with every proposal sent through
  intake and assessment on a disposable seeded PostgreSQL database where the
  seeded world allows.
- Spend: USD 0.0085 (8,503 micro-USD) through the project spend ledger,
  committed total 76,500 micro-USD before and 85,003 after; no case had
  unknown usage. One run, so no variance estimate.

### Denominators and results for the live model

| Measure                         | Denominator                                                  | Result                     |
| ------------------------------- | ------------------------------------------------------------ | -------------------------- |
| Outcome correct                 | 16 cases (10 expect a proposal, 6 a pause)                   | 16 / 16                    |
| Exact proposals                 | 10 cases that expect a proposal and allow no pause           | 10 / 10                    |
| Required-field exact extraction | 84 required fields in those 10 cases (the index declares 84) | 84 / 84 (100%)             |
| Semantic provenance             | 84 required fields of every proposal                         | 84 / 84 (100%)             |
| Accepted-plan-field provenance  | 43 fields of the 5 proposals intake accepted on PostgreSQL   | 43 / 43 (100%)             |
| Critical violations             | 16 cases                                                     | 0                          |
| Mean tool calls, latency        | 16 cases                                                     | 2.6 calls, 80.2 s in total |

### Comparison with the targets

| Target                                         | Observed       | Met |
| ---------------------------------------------- | -------------- | --- |
| At least 90% required-field exact extraction   | 84 / 84 (100%) | Met |
| 100% correct accepted-plan-field provenance    | 43 / 43        | Met |
| Zero critical violations in the declared suite | 0              | Met |

### Every miss and critical violation

- Live model: one miss and no critical violation. J13 (mail transport receipt
  without business acceptance) paused before intake, as its manifest expects,
  so the case is `needs_clarification`; the downstream note expects
  `awaiting_acknowledgement`. The oracle-normalized arm misses it identically,
  so the runner flags it as a world or setup gap, not an extraction error.
- Oracle-normalized arm: the same J13 miss.
- Baseline: 10 of 16 outcomes wrong, 58 / 84 required fields, and four
  critical violations (a proposal where none was allowed on J04, J05, J09 and
  J12). It is the comparison arm, not the system under test.

### Limits

- Synthetic emails and fixture data, one model and one run.
- The seeded PostgreSQL world holds only PO-120 and its registered sender.
  Seven cases (J01, J02, J03, J04, J07, J11 and J12) name another order or
  sender. For the live model, J01, J02, J03, J07 and J11 were checked in the
  in-memory evaluation world only, and its six pauses never reach intake, so
  the accepted-plan provenance rests on the five model proposals intake
  accepted on PostgreSQL. The [report](reports/holdout-3-live.md) lists the
  world of every case.
- The evaluation covers extraction, intake and assessment. Approval,
  application, verification and real supplier or ERP integration are not
  exercised.
- This set is now exposed. Any later change to the model, prompt, tools,
  validator or scorer makes it regression evidence only; a new untouched claim
  needs another independent set run once at a frozen revision.
