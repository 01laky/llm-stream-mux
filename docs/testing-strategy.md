# Testing strategy

**Status:** P1 active — **185** tests in CI via `pnpm verify`. Current release: **`0.1.0`** (P0+P1).

---

## Runner

- **Vitest** — `pnpm test` after `pnpm build` (release tests assert `dist/` artifacts).
- Test IDs in titles: `it("LSM-CORE-03 lazy defer until next", …)`.

---

## Areas

| Prefix        | Scope                                               | Status                         |
| ------------- | --------------------------------------------------- | ------------------------------ |
| `LSM-REL`     | release, build, export map, package smoke           | **P0+P1** — `LSM-REL-01`–`03`  |
| `LSM-TYP`     | public type shapes, hooks, enums, d.ts contract     | **P0+P1** — `LSM-TYP-01`–`69`  |
| `LSM-EDGE-P0` | matrix error-code prelude before runtime            | **P0** — `LSM-EDGE-P0-01`–`26` |
| `LSM-SRC`     | Source union fixture edge cases (pre-runtime)       | **P0** — `LSM-SRC-01`–`12`     |
| `LSM-CORE`    | normalizeSource, abort, interop, telemetry, errors  | **P1** — `LSM-CORE-01`–`60`    |
| `LSM-TEE`     | N-way tee, backpressure policies, cancel            | P2                             |
| `LSM-RACE`    | first usable, loser cancel, commit                  | P3                             |
| `LSM-FB`      | lazy failover, FailoverPolicy, ALL_FAILED           | P4                             |
| `LSM-MERGE`   | Tagged output, read-loop, concurrency, backpressure | P5                             |
| `LSM-X`       | timeouts, mapEach, onFinish, HWM                    | P6                             |
| `LSM-EDGE`    | full behavioral contract matrix                     | P7                             |

---

## P1 test files

| File                            | IDs                             | Count |
| ------------------------------- | ------------------------------- | ----- |
| `test/release.test.ts`          | `LSM-REL-01`, `LSM-REL-03`      | 8     |
| `test/types-contract.test.ts`   | `LSM-REL-02`, `LSM-TYP-01`–`15` | 25    |
| `test/types-edge.test.ts`       | `LSM-TYP-16`–`69`               | 54    |
| `test/edge-contract-p0.test.ts` | `LSM-EDGE-P0-01`–`26`           | 26    |
| `test/source-edge.test.ts`      | `LSM-SRC-01`–`12`               | 12    |
| `test/core.test.ts`             | `LSM-CORE-01`–`60`              | 60    |
| `test/helpers/streams.ts`       | runtime fake sources            | —     |
| `test/helpers/type-fixtures.ts` | type-level factories            | —     |

---

## Portability gate

`scripts/check-portability.mjs` runs as **`pnpm verify:portability`** — fails if `src/` contains:

- `ReadableStream.from`
- `node:stream` / `node:events` / `node:buffer` imports
- `ReadableStream[Symbol.asyncIterator]`

---

## Verify pipeline

```bash
pnpm verify
```

Order: `verify:deps` → `verify:portability` → lint → typecheck → build → test → smoke:package → verify:docs → diagrams:check → format

CI matrix: Node **18, 20, 22**.

---

## Related

- [Edge-case matrix](./edge-cases.md)
- [Core internals diagram](./img/core-internals.svg)
- [Public API types diagram](./img/public-api-types.svg)
- [Proposal Part B](./proposal.MD#part-b--implementation-roadmap)
