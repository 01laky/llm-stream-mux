# Testing strategy

**Status:** Pre-implementation — binding plan in [`proposal.MD`](./proposal.MD) §15 and Part B.

---

## Runner

- **Vitest** — `pnpm test` (from P0).
- Test IDs in titles: `it("LSM-RACE-03 cancels losers on win", …)`.

---

## Areas

| Prefix      | Scope                                                |
| ----------- | ---------------------------------------------------- |
| `LSM-CORE`  | `normalizeSource`, abort, interop, telemetry, errors |
| `LSM-TEE`   | N-way tee, backpressure policies, cancel             |
| `LSM-RACE`  | first usable, loser cancel, commit                   |
| `LSM-FB`    | lazy failover, FailoverPolicy, ALL_FAILED            |
| `LSM-MERGE` | Tagged output, read-loop, concurrency, backpressure  |
| `LSM-X`     | timeouts, mapEach, onFinish, HWM                     |
| `LSM-EDGE`  | contract matrix (`docs/edge-cases.md`)               |
| `LSM-REL`   | release, package smoke, docs gates                   |

---

## Helpers

`test/helpers/streams.ts` (P1):

- `fromArray<T>(items, { delayMs?, throwAt?, neverEnd? })` → `ReadableStream` + `AsyncIterable` variants.

Prefer deterministic ordering via `merge({ order: "round-robin" })` where arrival order is nondeterministic.

---

## Verify pipeline

```bash
pnpm verify          # lint + typecheck + test + build (P0+)
pnpm verify:deps     # empty dependencies
pnpm verify:docs     # required docs / scripts present
pnpm diagrams:check  # SVGs up to date with .mmd
```

---

## Docs regression

Diagram sources live in `docs/img/*.mmd`; CI runs `diagrams:check`. Edge-case matrix cells map 1:1 to `LSM-EDGE-*` (P7).

---

## Related

- [Edge-case matrix](./edge-cases.md#f-contract-matrix-binding-at-p7)
- [Proposal Part B](./proposal.MD#part-b--implementation-roadmap)
