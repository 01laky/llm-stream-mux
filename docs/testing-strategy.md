# Testing strategy

**Status:** P2 active — **≈253** tests in CI via `pnpm verify`. Current release: **`0.2.0`** (P0+P1+P2).

---

## Runner

- **Vitest** — `pnpm test` after `pnpm build` (release tests assert `dist/` artifacts).
- Test IDs in titles: `it("LSM-TEE-03 block backpressure gates source reads", …)`.

---

## Areas

| Prefix        | Scope                                               | Status                         |
| ------------- | --------------------------------------------------- | ------------------------------ |
| `LSM-REL`     | release, build, export map, package smoke           | **P0–P2** — `LSM-REL-01`–`04`  |
| `LSM-TYP`     | public type shapes, hooks, enums, d.ts contract     | **P0+P1** — `LSM-TYP-01`–`69`  |
| `LSM-EDGE-P0` | matrix error-code prelude before runtime            | **P0** — `LSM-EDGE-P0-01`–`26` |
| `LSM-SRC`     | Source union fixture edge cases (pre-runtime)       | **P0** — `LSM-SRC-01`–`12`     |
| `LSM-CORE`    | normalizeSource, abort, interop, telemetry, errors  | **P1** — `LSM-CORE-01`–`60`    |
| `LSM-TEE`     | N-way tee, backpressure policies, cancel            | **P2** — `LSM-TEE-01`–`64`     |
| `LSM-RACE`    | first usable, loser cancel, commit                  | P3                             |
| `LSM-FB`      | lazy failover, FailoverPolicy, ALL_FAILED           | P4                             |
| `LSM-MERGE`   | Tagged output, read-loop, concurrency, backpressure | P5                             |
| `LSM-X`       | timeouts, mapEach, onFinish, HWM                    | P6                             |
| `LSM-EDGE`    | full behavioral contract matrix                     | P7                             |

---

## P2 test files

| File                      | IDs                           | Count |
| ------------------------- | ----------------------------- | ----- |
| `test/tee.test.ts`        | `LSM-TEE-01`–`64`             | 64    |
| `test/release.test.ts`    | `LSM-REL-04a/b` (+ prior REL) | 10    |
| `test/helpers/streams.ts` | `countingSource()` helper     | —     |

Prior P0+P1 files unchanged except `LSM-REL-02` now exports `tee`.

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
- [Tee fan-out diagram](./img/tee-fanout.svg)
- [Core internals diagram](./img/core-internals.svg)
- [Public API types diagram](./img/public-api-types.svg)
- [Proposal Part B](./proposal.MD#part-b--implementation-roadmap)
