# Testing strategy

**Status:** P7 complete — **821** tests in CI via `pnpm verify`. Current release: **`0.7.0`** (P0–P7).

---

## Runner

- **Vitest** — `pnpm test` after `pnpm build` (release tests assert `dist/` artifacts).
- Test IDs in titles: `it("LSM-EDGE-16 race break loser race-lost winner aborted", …)`.

---

## Areas

| Prefix        | Scope                                               | Status                              |
| ------------- | --------------------------------------------------- | ----------------------------------- |
| `LSM-REL`     | release, build, export map, package smoke           | **P0–P7** — `LSM-REL-01`–`09`       |
| `LSM-TYP`     | public type shapes, hooks, enums, d.ts contract     | **P0+P1** — `LSM-TYP-01`–`69`       |
| `LSM-EDGE-P0` | matrix error-code prelude before runtime            | **P0** — `LSM-EDGE-P0-01`–`26`      |
| `LSM-SRC`     | Source union fixture edge cases (pre-runtime)       | **P0** — `LSM-SRC-01`–`12`          |
| `LSM-CORE`    | normalizeSource, abort, interop, telemetry, queue   | **P1+P6** — `LSM-CORE-01`–`70`      |
| `LSM-TEE`     | N-way tee, backpressure policies, cancel            | **P2** — `LSM-TEE-01`–`64`          |
| `LSM-RACE`    | first usable, loser cancel, commit                  | **P3** — `LSM-RACE-01`–`80`         |
| `LSM-FB`      | lazy failover, FailoverPolicy, ALL_FAILED           | **P4** — `LSM-FB-01`–`110`          |
| `LSM-MERGE`   | Tagged output, read-loop, concurrency, backpressure | **P5** — `LSM-MERGE-01`–`135`       |
| `LSM-X`       | timeouts, mapEach, onFinish, HWM cross-cutting      | **P6** — `LSM-X-01`–`115`           |
| `LSM-EDGE`    | full behavioral contract matrix + no-leak audit     | **P7** — `LSM-EDGE-01`–`99` + `06b` |

---

## P7 test files

| File                          | IDs                              | Count |
| ----------------------------- | -------------------------------- | ----- |
| `test/edge.test.ts`           | `LSM-EDGE-01`–`99`, `06b`        | 100   |
| `test/helpers/edge-matrix.ts` | shared collectors + leak helpers | —     |
| `test/release.test.ts`        | `LSM-REL-09a/b` (+ prior)        | 20    |

Prior P0–P6 files unchanged except REL version pins.

---

## Portability gate

`scripts/check-portability.mjs` runs as **`pnpm verify:portability`** — fails if `src/` contains:

- `ReadableStream.from`
- native `.tee(` on ReadableStream
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

- [Edge-case matrix §G](./edge-cases.md#g-contract-matrix-binding--p7-070)
- [Edge matrix diagram](./img/edge-matrix.svg)
- [Merge tagged diagram](./img/merge-tagged.svg)
- [Fallback failover diagram](./img/fallback-failover.svg)
- [Race win diagram](./img/race-win.svg)
- [Tee fan-out diagram](./img/tee-fanout.svg)
- [Core internals diagram](./img/core-internals.svg)
- [Public API types diagram](./img/public-api-types.svg)
- [Proposal Part B](./proposal.MD#part-b--implementation-roadmap)
