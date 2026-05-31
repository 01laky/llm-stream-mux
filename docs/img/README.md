# Architecture diagrams

Mermaid sources and pre-rendered SVGs for the README and docs. GitHub README cannot execute
Mermaid — always commit updated **`.svg`** files alongside **`.mmd`** edits.

| File                      | Purpose                                                             | Used by                                                                            |
| ------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pipeline.mmd`            | End-to-end: provider bodies → optional assemble/guard → mux → app   | README Architecture, [examples/README](../examples/README.md)                      |
| `ecosystem.mmd`           | Three-library stack: assemble (format), guard (safety), mux (orch.) | README, [integration-cookbook](../docs/integration-cookbook.md)                    |
| `strategies-overview.mmd` | `race`, `fallback`, `merge`, `tee` at a glance                      | README edge-case showcase                                                          |
| `quick-decision.mmd`      | Strategy picker + byte vs event mode                                | README Quickstart, [usage-guides](../docs/usage-guides.md)                         |
| `byte-event-modes.mmd`    | Where mux sits before or after parsing                              | [integration-cookbook](../docs/integration-cookbook.md)                            |
| `merge-tagged.mmd`        | Concurrent merge → `Tagged<T>` + `onSourceEvent`                    | [usage-guides](../docs/usage-guides.md)                                            |
| `public-api-types.mmd`    | P0 public surface: §6 types + §9 signature types vs runtime exports | [edge-cases](../docs/edge-cases.md) §F                                             |
| `core-internals.mmd`      | P1 modules + P4 `fallback()` export path                            | [edge-cases](../docs/edge-cases.md) §F                                             |
| `tee-fanout.mmd`          | P2 tee: block / bounded / drop + cancel vs error vs natural close   | [usage-guides](../docs/usage-guides.md) tee                                        |
| `race-win.mmd`            | P3 race: pre-win reads, buffer flush, loser cancel, outcomes        | [usage-guides](../docs/usage-guides.md) race                                       |
| `fallback-failover.mmd`   | P4 fallback: staggered chain, FailoverPolicy, timeout reset, cancel | [usage-guides](../docs/usage-guides.md) fb                                         |
| `edge-matrix.mmd`         | P7 §23 edge-case matrix + no-leak audit (`LSM-EDGE-*`)              | [edge-cases](../docs/edge-cases.md) §G                                             |
| `release-pipeline.mmd`    | P9 verify / verify:pre1 / release:prep --full flow                  | [STABILITY](../docs/STABILITY.md), [testing-strategy](../docs/testing-strategy.md) |

Regenerate after editing sources:

```bash
pnpm diagrams:build
```

Requires `@mermaid-js/mermaid-cli` (installed on demand via `pnpm diagrams:build`).

Verify committed SVGs match sources (CI):

```bash
pnpm diagrams:check
```
