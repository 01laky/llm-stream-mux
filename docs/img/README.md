# Architecture diagrams

Mermaid sources and pre-rendered SVGs for the README and docs. GitHub README cannot execute
Mermaid — always commit updated **`.svg`** files alongside **`.mmd`** edits.

**Total:** **19** diagrams (13 from P0–P9 + **6** new at P10 / `1.0.0`).

| File                      | Purpose                                                                      | Used by                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pipeline.mmd`            | End-to-end: provider bodies → optional assemble/guard → mux → app            | README Architecture, [examples/README](../../examples/README.md)         |
| `ecosystem.mmd`           | Three-library stack: assemble (format), guard (safety), mux (orch.)          | README, [integration-cookbook](../integration-cookbook.md)               |
| `strategies-overview.mmd` | `race`, `fallback`, `merge`, `tee` at a glance                               | README edge-case showcase                                                |
| `quick-decision.mmd`      | Strategy picker + byte vs event mode                                         | README Quickstart, [usage-guides](../usage-guides.md)                    |
| `byte-event-modes.mmd`    | Where mux sits before or after parsing                                       | [integration-cookbook](../integration-cookbook.md)                       |
| `merge-tagged.mmd`        | Concurrent merge → `Tagged<T>` + `onSourceEvent`                             | [usage-guides](../usage-guides.md)                                       |
| `public-api-types.mmd`    | P0 public surface: §6 types + §9 signature types vs runtime exports          | [edge-cases](../edge-cases.md) §F                                        |
| `core-internals.mmd`      | P1 modules + P4 `fallback()` export path                                     | [edge-cases](../edge-cases.md) §F                                        |
| `tee-fanout.mmd`          | P2 tee: block / bounded / drop + cancel vs error vs natural close            | [usage-guides](../usage-guides.md) tee                                   |
| `race-win.mmd`            | P3 race: pre-win reads, buffer flush, loser cancel, outcomes                 | [usage-guides](../usage-guides.md) race                                  |
| `fallback-failover.mmd`   | P4 fallback: staggered chain, FailoverPolicy, timeout reset, cancel          | [usage-guides](../usage-guides.md) fb                                    |
| `edge-matrix.mmd`         | P7 §23 edge-case matrix + no-leak audit (`LSM-EDGE-01`–`180`)                | [edge-cases](../edge-cases.md) §G                                        |
| `release-pipeline.mmd`    | verify / verify:pre1 / release:prep --full / 1.0.0 publish flow              | [STABILITY](../STABILITY.md), [testing-strategy](../testing-strategy.md) |
| `api-frozen-surface.mmd`  | §9 runtime + type exports frozen at 1.0.0                                    | [STABILITY](../STABILITY.md), README                                     |
| `edge-matrix-h.mmd`       | §H `LSM-EDGE-140`–`180` thematic map (interop / signal / stress / telemetry) | [edge-cases](../edge-cases.md) §H                                        |
| `publish-ceremony.mmd`    | verify:pre1 → tag → npm publish → GitHub release                             | [RELEASE](../RELEASE.md), [STABILITY](../STABILITY.md)                   |
| `interop-matrix.mmd`      | collect / toReadable / toAsyncIterable across strategies                     | [usage-guides](../usage-guides.md), [edge-cases](../edge-cases.md) §H    |
| `signal-timeout-flow.mmd` | signal + timeoutMs + overallTimeoutMs fan-in (not on tee)                    | [usage-guides](../usage-guides.md), [faq](../faq.md)                     |
| `doc-audit-map.mmd`       | doc files ↔ verify gates ↔ test prefixes                                     | [testing-strategy](../testing-strategy.md)                               |

Regenerate after editing sources:

```bash
pnpm diagrams:build
```

Requires `@mermaid-js/mermaid-cli` (installed on demand via `pnpm diagrams:build`).

Verify committed SVGs match sources (CI):

```bash
pnpm diagrams:check
```

**`LSM-REL-12o`** — all **19** `.svg` files present and fresh per `scripts/check-diagrams.mjs`.
