# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.4.0]

### Added

- **`fallback(sources, opts?)`** — priority failover N→1 strategy with `FailoverPolicy` (`commit`, `buffered`, `post-emit`) (§7.1–§7.2)
- **`src/internal/fallback-engine.ts`** — staggered active-source coordinator with per-attempt `timeoutMs` reset
- **`test/fallback.test.ts`** — `LSM-FB-01`–`110` (extended normative bindings `76`–`85`)
- **`LSM-REL-06a/b`** — dist + smoke contract for `fallback`
- **Diagram** — `docs/img/fallback-failover.mmd` + SVG

### Changed

- **`src/index.ts`** — exports `fallback`; `MUX_PKG_VERSION` → `0.4.0`
- **`scripts/smoke-package.mjs`** — smoke fallback chain after race
- **`scripts/build-diagrams.mjs`** + **`scripts/check-diagrams.mjs`** — 11 diagrams including `fallback-failover`
- **`test/release.test.ts`** — `LSM-REL-04b` / `LSM-REL-05b` allow `fallback` in d.ts
- **Docs** — testing strategy, edge-case matrix §C, README status, usage-guides fallback section

### Notes

- `merge` / `ensemble` still types-only until P5
- `overallTimeoutMs`, `highWaterMark` on strategies deferred to P6
- Next milestone **`0.5.0`** after P5 (`merge`)

## [0.3.0]

### Added

- **`race(sources, opts?)`** — first-usable N→1 strategy (§7.3)
- **`src/internal/race-engine.ts`** — parallel candidate coordinator over `normalizeSources`
- **`src/race.ts`** — empty-source sync guard + `normalizeSources` at call site
- **`test/race.test.ts`** — `LSM-RACE-01`–`80` (extended edge cases `58`–`80`)
- **`test/helpers/streams.ts`** — `lazyOpenCounter()`, `cancelSpyingReadable()`
- **`LSM-REL-05a/b`** — dist + smoke contract for `race`
- **Diagram** — `docs/img/race-win.mmd` + SVG

### Changed

- **`src/index.ts`** — exports `race`; `MUX_PKG_VERSION` → `0.3.0`
- **`scripts/smoke-package.mjs`** — smoke two-way `race`
- **`scripts/build-diagrams.mjs`** + **`scripts/check-diagrams.mjs`** — 10 diagrams including `race-win`
- **Docs** — testing strategy, edge-case matrix, README status, usage-guides race section

### Fixed

- **`race-engine`** — consumer `next()` throws `queueError` when coordinator closes with error (not spurious `{ done: true }`)
- **`race-engine`** — `pumpWinner` scheduled async after win to avoid backpressure deadlock with trigger item

### Notes

- `fallback` / `merge` still types-only until P4–P5
- `timeoutMs`, `overallTimeoutMs`, `highWaterMark` on strategies deferred to P6
- Next milestone **`0.4.0`** after P4 (`fallback`)

## [0.2.0]

### Added

- **`tee(source, n, opts?)`** — first runtime strategy; N-way fan-out with `block` / `bounded` / `drop` (§8, D5)
- **`src/internal/tee-fanout.ts`** — shared pump over `normalizeSource`
- **`test/tee.test.ts`** — `LSM-TEE-01`–`64` (extended edge cases `43`–`64`)
- **`test/helpers/streams.ts`** — `countingSource()` pull-counter helper
- **`LSM-REL-04a/b`** — dist + smoke contract for `tee`
- **Diagram** — `docs/img/tee-fanout.mmd` + SVG

### Changed

- **`src/index.ts`** — exports `tee`; `MUX_PKG_VERSION` → `0.2.0`
- **`scripts/smoke-package.mjs`** — smoke `tee` empty 2-way
- **`scripts/check-portability.mjs`** — forbid native `ReadableStream.tee` in `src/`
- **Docs** — testing strategy, edge-case matrix, README status

### Fixed

- **`tee-fanout`** — errored branch repeats `branchError` on subsequent reads (no hang after first reject)

### Notes

- `race` / `fallback` / `merge` still types-only until P3–P5
- `TeeOptions` hooks (`signal`, telemetry) deferred to P6
- Next milestone **`0.3.0`** after P3 (`race`)

## [0.1.0]

### Added

- **`collect`**, **`toReadable`**, **`toAsyncIterable`** — public interop helpers (§9, D10); symmetric pair, no `fromAsyncIterable` alias.
- **`internal/source.ts`** — `normalizeSource` / `normalizeSources`, `SourceReadResult` (non-rejecting `next()`), lazy deferral, cancel propagation, post-cancel read lock, duplicate id guard.
- **`internal/abort.ts`** — `combineSignals` (Node 18 manual fan-in + Node 20+ `AbortSignal.any`), `timeoutSignal`, `muxCancelledReason`, `isMuxCancelled`.
- **`internal/telemetry.ts`** — `createTelemetry()` with `SourceEvent` emission, `incrementItems`, `setAborted`, `finish()` → `MuxResult`.
- **`errors.ts`** — internal `muxError()` factory (`CreateMuxError`); not exported from public API.
- **`test/helpers/streams.ts`** — `fromArray` (symmetric readable/asyncIterable), `controllableReadable` for cancel spies.
- **`scripts/check-portability.mjs`** — CI gate forbidding `ReadableStream.from`, Node stream imports, ReadableStream asyncIterator in `src/`.
- **Architecture diagram** — `docs/img/core-internals.mmd` + SVG (P1 module graph).
- **Tests (185)** — `LSM-CORE-01`–`60`, `LSM-SRC-01`–`12`, `LSM-REL-03`, `LSM-TYP-69`; prior P0 suite retained.

### Changed

- **`pnpm verify`** — adds `verify:portability` step before lint.
- **`scripts/smoke-package.mjs`** — smoke-tests `collect([])` from tarball (ESM + CJS via `createRequire`).
- **README / docs** — status P0+P1; development table lists core tests and portability gate.
- **Extended P1 edge tests** — `LSM-CORE-28`–`60`, `LSM-SRC-09`–`12` (185 total).

### Notes

- Strategy runtime (`race`, `fallback`, `merge`, `tee`) remains P2–P5; types only until then.
- Next milestone **`0.2.0`** after P2 (`tee`).

## [0.0.1]

### Added

- **P0 TypeScript scaffold** — `src/types.ts` exports all proposal §6/§9 types; `MUX_PKG_VERSION` + frozen `MUX_ERROR_CODES`; comment-only strategy placeholders.
- **Build pipeline** — tsup dual ESM/CJS + `.d.ts`/`.d.cts`, Vitest, ESLint, smoke-package.
- **Tests** — `LSM-REL-*`, `LSM-TYP-*`, `LSM-EDGE-P0-*`, `LSM-SRC-*` (114 total).
- **Architecture diagram** — `public-api-types`.

### Changed

- CI Node 18/20/22 matrix; `Object.freeze(MUX_ERROR_CODES)`.

## [0.0.0]

### Added

- **Design spec** — `docs/proposal.MD` (Part A + P0–P8 roadmap, D1–D10).
- **Documentation scaffold** — README, guides, edge-case matrix, integration cookbook, compatibility, comparison, FAQ, performance, testing strategy.
- **Architecture diagrams** — six Mermaid sources + SVGs; repo hygiene (githooks, CI docs phase).
