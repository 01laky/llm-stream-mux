# Testing strategy

**Status:** P0 active — **114** tests in CI via `pnpm verify`. Current release: **`0.0.1`** (P0 scaffold); **`0.1.0`** after P1 per §26.2.

---

## Runner

- **Vitest** — `pnpm test` after `pnpm build` (release tests assert `dist/` artifacts).
- Test IDs in titles: `it("LSM-RACE-03 cancels losers on win", …)`.

---

## Areas

| Prefix        | Scope                                                | Status                              |
| ------------- | ---------------------------------------------------- | ----------------------------------- |
| `LSM-REL`     | release, build, export map, package smoke            | **P0** — `LSM-REL-01`, `LSM-REL-02` |
| `LSM-TYP`     | public type shapes, hooks, enums, d.ts contract      | **P0** — `LSM-TYP-01`–`68`          |
| `LSM-EDGE-P0` | matrix error-code prelude before runtime             | **P0** — `LSM-EDGE-P0-01`–`26`      |
| `LSM-SRC`     | Source union fixture edge cases (pre-runtime)        | **P0** — `LSM-SRC-01`–`08`          |
| `LSM-CORE`    | `normalizeSource`, abort, interop, telemetry, errors | P1                                  |
| `LSM-TEE`     | N-way tee, backpressure policies, cancel             | P2                                  |
| `LSM-RACE`    | first usable, loser cancel, commit                   | P3                                  |
| `LSM-FB`      | lazy failover, FailoverPolicy, ALL_FAILED            | P4                                  |
| `LSM-MERGE`   | Tagged output, read-loop, concurrency, backpressure  | P5                                  |
| `LSM-X`       | timeouts, mapEach, onFinish, HWM                     | P6                                  |
| `LSM-EDGE`    | full behavioral contract matrix                      | P7                                  |

---

## P0 test files

| File                            | IDs                                 | Count |
| ------------------------------- | ----------------------------------- | ----- |
| `test/release.test.ts`          | `LSM-REL-01`                        | 6     |
| `test/types-contract.test.ts`   | `LSM-REL-02`, `LSM-TYP-01`–`15`     | 21    |
| `test/types-edge.test.ts`       | `LSM-TYP-16`–`68`                   | 53    |
| `test/edge-contract-p0.test.ts` | `LSM-EDGE-P0-01`–`26`               | 26    |
| `test/source-edge.test.ts`      | `LSM-SRC-01`–`08`                   | 8     |
| `test/helpers/type-fixtures.ts` | factories for type-level edge cases | —     |

---

## Helpers

- **P0:** `test/helpers/type-fixtures.ts` — `muxError`, `taggedValue`, `readableFrom`, `asyncItems`, `lazySource`
- **P1:** `test/helpers/streams.ts` — runtime fake sources (`fromArray`, …)

---

## Verify pipeline

```bash
pnpm verify
```

Order: `verify:deps` → `lint` → `typecheck` → `build` → `test` → `smoke:package` → `verify:docs` → `diagrams:check` → `format`

CI matrix: Node **18, 20, 22**.

---

## Related

- [Edge-case matrix](./edge-cases.md)
- [Public API types diagram](./img/public-api-types.svg)
- [Proposal Part B](./proposal.MD#part-b--implementation-roadmap)
