# ERPNext live sandbox evidence

Redacted evidence of the final live connector proof against the disposable
ERPNext sandbox described in [ADR 0018](../../adr/0018-erpnext-sandbox-connector.md).
All records are synthetic. This is sandbox evidence, not production,
customer or delivery evidence.

| Fact               | Value                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run                | `09c498e2`, 2026-10-22, all nine live steps passed                                                                                                    |
| Connector revision | An unpublished development revision, no uncommitted change to the connector or contracts package when the run ended (`connectorSourceChanged: false`) |
| Source             | ERPNext 16.52.0 and Frappe 16.52.0 as reported by the site in L01, at `http://127.0.0.1:18082`                                                        |
| Sandbox state      | Reset with the sandbox's documented steps immediately before the run; preparation probes rerun                                                        |
| Command            | `ERPNEXT_EVIDENCE_DIR=docs/evidence/erpnext-sandbox corepack pnpm test:sandbox`, with the base URL and credentials file set                           |

The later connector corrections changed no request the run
sends: they add local refusals the run never triggers, filter marker search
results on the client and change only mapping. After another documented
sandbox reset, the live proof passed again (nine of nine steps) at a later development revision on
2026-10-22, without writing
evidence. The files here stay those of run `09c498e2`, because the
connector's unit-test fixtures are copies of its exchanges and each names
the file it came from.

## Files

| Path                                            | Content                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `L01-identity-*` to `L12-canonical-*`           | One file per HTTP exchange: principal user, method, URL, request body and SHA-256, timing, status and response body. The step prefixes match the table in ADR 0018 |
| `results.json`                                  | Run ID, connector revision, reported versions, C-01 eligible stock read back, the concurrent outcomes and the connector's complete operation journal               |
| `sandbox-probes/probe-results-preparation.json` | Expected, observed and verdict of the first preparation probe run, including the P06b partial state and P06c manual recovery                                       |
| `sandbox-probes/probe-results-after-reset.json` | The same probes after the reset that preceded the final run                                                                                                        |
| `sandbox-probes/permissions.json`               | Role permissions and user permissions of the two API principals                                                                                                    |
| `sandbox-probes/fixture-map.json`               | Synthetic fixture labels mapped to native names, row IDs and seed tokens of the reset sandbox                                                                      |

Exchanges L05, L06 and L11 send no request, so they have only journal entries
in `results.json`. Exchanges through the fault proxy (L07 to L09) record the
client's transport error rather than a response; L07 and L08 record the
read-back that resolved them.

## Redaction

The connector's recorder keeps no request or response headers, so no
`Authorization`, cookie or session value is written, and it replaces every key
and secret of the principal before writing. Frappe tracebacks are replaced by a
marker; `exc_type` and the exception message stay. The deliberately invalid
token of L03 is random and redacted as well. A scan of every file for the
sandbox's current key, secret and password values, authorization and cookie
headers and local paths found none. The preparation probe summary was written
by the sandbox's own redacting recorder under earlier keys, which the reset
replaced.
