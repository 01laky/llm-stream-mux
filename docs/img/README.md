# Architecture diagrams

Mermaid sources and pre-rendered SVGs for the README and docs. GitHub README cannot execute
Mermaid — always commit updated **`.svg`** files alongside **`.mmd`** edits.

| File                      | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `pipeline.mmd`            | End-to-end: provider bodies → optional assemble/guard → mux → app   |
| `ecosystem.mmd`           | Three-library stack: assemble (format), guard (safety), mux (orch.) |
| `strategies-overview.mmd` | `race`, `fallback`, `merge`, `tee` at a glance                      |
| `quick-decision.mmd`      | Strategy picker + byte vs event mode                                |
| `byte-event-modes.mmd`    | Where mux sits before or after parsing                              |
| `merge-tagged.mmd`        | Concurrent merge → `Tagged<T>` + `onSourceEvent`                    |
| `public-api-types.mmd`    | P0 public surface: §6 types + §9 signature types vs runtime exports |

Regenerate after editing sources:

```bash
pnpm diagrams:build
```

Requires `@mermaid-js/mermaid-cli` (installed on demand via `pnpm diagrams:build`).

Verify committed SVGs match sources (CI):

```bash
pnpm diagrams:check
```
