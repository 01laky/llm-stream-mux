# Testing strategy

**Status:** P3 active — **≈337** tests in CI via `pnpm verify`. Current release: **`0.3.0`** (P0+P1+P2+P3).

---

## Runner

- **Vitest** — `pnpm test` after `pnpm build` (release tests assert `dist/` artifacts).
- Test IDs in titles: `it("LSM-RACE-03 pre-usable buffer on winner flushed in order", …)`.

---

## Areas

| Prefix        | Scope                                               | Status                         |
| ------------- | --------------------------------------------------- | ------------------------------ |
| `LSM-REL`     | release, build, export map, package smoke           | **P0–P3** — `LSM-REL-01`–`05`  |
| `LSM-TYP`     | public type shapes, hooks, enums, d.ts contract     | **P0+P1** — `LSM-TYP-01`–`69`  |
| `LSM-EDGE-P0` | matrix error-code prelude before runtime            | **P0** — `LSM-EDGE-P0-01`–`26` |
| `LSM-SRC`     | Source union fixture edge cases (pre-runtime)       | **P0** — `LSM-SRC-01`–`12`     |
| `LSM-CORE`    | normalizeSource, abort, interop, telemetry, errors  | **P1** — `LSM-CORE-01`–`60`    |
| `LSM-TEE`     | N-way tee, backpressure policies, cancel            | **P2** — `LSM-TEE-01`–`64`     |
| `LSM-RACE`    | first usable, loser cancel, commit                  | **P3** — `LSM-RACE-01`–`80`    |
| `LSM-FB`      | lazy failover, FailoverPolicy, ALL_FAILED           | P4                             |
| `LSM-MERGE`   | Tagged output, read-loop, concurrency, backpressure | P5                             |
| `LSM-X`       | timeouts, mapEach, onFinish, HWM                    | P6                             |
| `LSM-EDGE`    | full behavioral contract matrix                     | P7                             |

---

## P3 test files

| File                      | IDs                                           | Count |
| ------------------------- | --------------------------------------------- | ----- |
| `test/race.test.ts`       | `LSM-RACE-01`–`80`                            | 80    |
| `test/release.test.ts`    | `LSM-REL-05a/b` (+ prior REL)                 | 12    |
| `test/helpers/streams.ts` | `lazyOpenCounter()`, `cancelSpyingReadable()` | —     |

Prior P0+P2 files unchanged except `LSM-REL-02` now exports `tee` and `race`.

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
- [Race win diagram](./img/race-win.svg)
- [Tee fan-out diagram](./img/tee-fanout.svg)
- [Core internals diagram](./img/core-internals.svg)
- [Public API types diagram](./img/public-api-types.svg)
- [Proposal Part B](./proposal.MD#part-b--implementation-roadmap)
