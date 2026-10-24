# Current screenshots

These captures show the packaged application in its no-key demonstration mode,
driven through part 1 of the [walkthrough](../README.md). All records are
synthetic, the roles are simulated and the business clock is fixed at
2026-10-21 07:00 UTC. The structured C-01 message is used, so no extraction or
model call takes part. The earlier PNG files in [docs/demo](..) are historical
captures from an earlier development revision and are not current.

## Regenerate

From a checkout whose application sources match `HEAD`, with Docker, port 3102
free and Playwright's Chromium headless shell installed:

```sh
corepack pnpm screenshots
```

The command starts `corepack pnpm demo` (which replaces earlier demonstration
data), drives the workflow in Chromium, writes every file below and removes the
demonstration with `demo:down`. Add `--keep` to leave it running. It refuses to
run when `apps/`, `packages/` or `infra/` differ from `HEAD`, because the
manifest names `HEAD` as the captured revision.

## Files

| Framed export                                                    | What it shows                                                                            | Capture                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| [01-exception-queue.png](01-exception-queue.png)                 | Queue with CASE-1 awaiting the manager's approval, under the demonstration notices       | 1280 px viewport, page top       |
| [02-case-assessment.png](02-case-assessment.png)                 | Case summary and deterministic demand impact: 70 EA covered, 50 EA short, 50 EA transfer | Element clip                     |
| [03-approval-refused.png](03-approval-refused.png)               | Cited proposal fields beside the buyer's refused approval of the EUR 160 plan            | Element clip, cut at 1000 CSS px |
| [04-recovery-verified.png](04-recovery-verified.png)             | Every action confirmed by receipt and read-back; physical delivery not recorded          | Element clip                     |
| [05-uncertain-write-history.png](05-uncertain-write-history.png) | Case history through ACT-2's unknown outcome, its reconciliation and resumed application | Element clip                     |
| [06-case-narrow.png](06-case-narrow.png)                         | The demand impact panel at phone width: stacked totals and scrolling tables              | 390 px viewport, element clip    |

Raw captures with the same names are in [raw/](raw/). The editable frame is
[frame.html](frame.html): Chromium renders each raw capture inside it at the same
device pixel ratio, adding a title bar with the actual local address, padding
and a shadow. [manifest.json](manifest.json) records the implementation revision,
image identity, route, scenario, viewport, device pixel ratio, clip rectangle,
capture time, tool versions and the SHA-256 of every raw and framed file.

## Fidelity check

A one-off comparison with Sharp, run outside the repository on 2026-10-24,
located each raw capture in its framed export (offset 58, 132 device pixels) and
compared every pixel's RGB channels. The only differences are 170 to 174 pixels
(506 to 522 channel values) masked by the window's 10 px rounded bottom corners:
all lie in the last 18 pixel rows of the capture, within 20 pixels of its left
or right edge. No redaction was applied; the
application content was not edited.
