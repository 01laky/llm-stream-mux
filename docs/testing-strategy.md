# Testing strategy

**Status:** P6 active — **719** tests in CI via `pnpm verify`. Current release: **`0.6.0`** (P0–P6).

---

## Runner

- **Vitest** — `pnpm test` after `pnpm build` (release tests assert `dist/` artifacts).
- Test IDs in titles: `it("LSM-X-06 race slow sources overallTimeoutMs …", …)`.

---

## Areas

| Prefix        | Scope                                               | Status                         |
| ------------- | --------------------------------------------------- | ------------------------------ |
| `LSM-REL`     | release, build, export map, package smoke           | **P0–P6** — `LSM-REL-01`–`08`  |
| `LSM-TYP`     | public type shapes, hooks, enums, d.ts contract     | **P0+P1** — `LSM-TYP-01`–`69`  |
| `LSM-EDGE-P0` | matrix error-code prelude before runtime            | **P0** — `LSM-EDGE-P0-01`–`26` |
| `LSM-SRC`     | Source union fixture edge cases (pre-runtime)       | **P0** — `LSM-SRC-01`–`12`     |
| `LSM-CORE`    | normalizeSource, abort, interop, telemetry, queue   | **P1+P6** — `LSM-CORE-01`–`65` |
| `LSM-TEE`     | N-way tee, backpressure policies, cancel            | **P2** — `LSM-TEE-01`–`64`     |
| `LSM-RACE`    | first usable, loser cancel, commit                  | **P3** — `LSM-RACE-01`–`80`    |
| `LSM-FB`      | lazy failover, FailoverPolicy, ALL_FAILED           | **P4** — `LSM-FB-01`–`110`     |
| `LSM-MERGE`   | Tagged output, read-loop, concurrency, backpressure | **P5** — `LSM-MERGE-01`–`135`  |
| `LSM-X`       | timeouts, mapEach, onFinish, HWM cross-cutting      | **P6** — `LSM-X-01`–`115`      |
| `LSM-EDGE`    | full behavioral contract matrix                     | P7                             |

---

## P6 test files

| File                   | IDs                          | Count |
| ---------------------- | ---------------------------- | ----- |
| `test/cross.test.ts`   | `LSM-X-01`–`115`             | 115   |
| `test/core.test.ts`    | `LSM-CORE-61`–`70` (+ prior) | 70    |
| `test/release.test.ts` | `LSM-REL-08a/b` (+ prior)    | 18    |

Prior P0–P5 files unchanged except REL d.ts pins for **`CommonOptions`** fields.

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

- [Edge-case matrix](./edge-cases.md)
- [Merge tagged diagram](./img/merge-tagged.svg)
- [Fallback failover diagram](./img/fallback-failover.svg)
- [Race win diagram](./img/race-win.svg)
- [Tee fan-out diagram](./img/tee-fanout.svg)
- [Core internals diagram](./img/core-internals.svg)
- [Public API types diagram](./img/public-api-types.svg)
- [Proposal Part B](./proposal.MD#part-b--implementation-roadmap)
