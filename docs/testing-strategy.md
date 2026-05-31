# Testing strategy

**Status:** P8 complete — **847** tests in CI via `pnpm verify`. Current release: **`0.8.0`** (P0–P8).

---

## Runner

- **Vitest** — `pnpm test` after `pnpm build` (release tests assert `dist/` artifacts).
- **Examples** — `pnpm typecheck:examples` after build; **`LSM-REL-10a`** in release tests.
- Test IDs in titles: `it("LSM-EDGE-16 race break loser race-lost winner aborted", …)`.

---

## Areas

| Prefix        | Scope                                               | Status                                  |
| ------------- | --------------------------------------------------- | --------------------------------------- |
| `LSM-REL`     | release, build, export map, package smoke           | **P0–P8** — `LSM-REL-01`–`10f`          |
| `LSM-TYP`     | public type shapes, hooks, enums, d.ts contract     | **P0+P1** — `LSM-TYP-01`–`69`           |
| `LSM-EDGE-P0` | matrix error-code prelude before runtime            | **P0** — `LSM-EDGE-P0-01`–`26`          |
| `LSM-SRC`     | Source union fixture edge cases (pre-runtime)       | **P0** — `LSM-SRC-01`–`12`              |
| `LSM-CORE`    | normalizeSource, abort, interop, telemetry, queue   | **P1+P6** — `LSM-CORE-01`–`70`          |
| `LSM-TEE`     | N-way tee, backpressure policies, cancel            | **P2** — `LSM-TEE-01`–`64`              |
| `LSM-RACE`    | first usable, loser cancel, commit                  | **P3** — `LSM-RACE-01`–`80`             |
| `LSM-FB`      | lazy failover, FailoverPolicy, ALL_FAILED           | **P4** — `LSM-FB-01`–`110`              |
| `LSM-MERGE`   | Tagged output, read-loop, concurrency, backpressure | **P5** — `LSM-MERGE-01`–`135`           |
| `LSM-X`       | timeouts, mapEach, onFinish, HWM cross-cutting      | **P6** — `LSM-X-01`–`115`               |
| `LSM-EDGE`    | full behavioral contract matrix + no-leak audit     | **P7+P8** — `LSM-EDGE-01`–`119` + `06b` |

Proposal §24 examples AC satisfied by **`LSM-REL-10a`** (examples typecheck) and **`LSM-REL-10d`** (README quickstart).

---

## P8 test files

| File                     | IDs                           | Count |
| ------------------------ | ----------------------------- | ----- |
| `examples/node-fetch/*`  | typecheck + runtime smoke     | —     |
| `test/release.test.ts`   | `LSM-REL-10a`–`10f` (+ prior) | 26    |
| `tsconfig.examples.json` | `pnpm typecheck:examples`     | —     |

Prior P7 **`test/edge.test.ts`** (100 EDGE tests) unchanged — **`LSM-REL-10f`** guards integrity.

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

Order: `verify:deps` → `verify:portability` → lint → typecheck → build → **`typecheck:examples`** → test → smoke:package → verify:docs → diagrams:check → format

**`release:prep`** runs inside **`LSM-REL-10c`** (not duplicated in verify script).

CI matrix: Node **18, 20, 22**.

---

## Related

- [Edge-case matrix §G](./edge-cases.md#g-contract-matrix-binding--p7-070)
- [Examples](../examples/README.md)
- [Edge matrix diagram](./img/edge-matrix.svg)
- [Proposal Part B](./proposal.MD#part-b--implementation-roadmap)
