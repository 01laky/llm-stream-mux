# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

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
