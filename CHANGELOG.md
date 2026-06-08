# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-06-08

> **Scope:** toolchain modernization, Node runtime baseline raised to `>=22`
> (Node 18/20 EOL), internal refactors, and an extended edge-case suite. The
> **public API surface is unchanged** — §9 runtime exports and §6.3 `MuxErrorCode`
> remain frozen as of `1.0.0`, so this ships as a **minor**. Consumers still on
> Node 18/20 must stay on `1.0.x`.

### Changed

- **Toolchain modernized** — ESLint `9 → 10`, TypeScript `5 → 6` (with
  `ignoreDeprecations: "6.0"` for the tsup-injected `baseUrl`), Vitest `3 → 4`,
  `@types/node` `22 → 24`, `globals` `16 → 17`, `tsup`/`prettier` patch bumps.
- **`packageManager`** — pnpm `9.15.9 → 11.5.2`; build-script approvals moved to
  `pnpm-workspace.yaml` (`allowBuilds: esbuild`).
- **Node baseline `>=18` → `>=22`** — `engines`, CI matrix (`[22, 24]`), README
  badge/requirements, `docs/compatibility.md`, `docs/STABILITY.md`,
  `docs/testing-strategy.md`, `docs/integration-cookbook.md`, and
  `scripts/smoke-published.mjs` flags (`--node22` / `--node24`) aligned (`LSM-REL-12s`).
- **GitHub Actions** — `actions/checkout@v6`, `actions/setup-node@v6`,
  `pnpm/action-setup@v6`.

### Added

- **`test/edge-extended.test.ts`** — extended edge-case suite **`LSM-XCOV-01`–`26`**
  (27 tests) targeting branches the frozen §23 matrix left uncovered: post-win
  source timeouts, mid-stream `isFinal` on the pumped winner, buffered/`commit`/
  `post-emit` fallback tails, round-robin merge with `concurrency`, per-source
  `sourceHighWaterMark` wrapping + cancel propagation, block/drop tee branch
  cancellation, `toAsyncIterable` re-entry, the `AbortSignal.any`-absent
  `combineSignals` fallback, and winner-fails-mid-stream paths. Suite total **972**.
- **`@vitest/coverage-v8`** + **`pnpm coverage`** (v8 provider; `src/**`, text + html).

### Refactored (internal, no API change)

- Hoisted the per-engine duplicates `wireAbortSignal` / `swallowCancel` into
  `internal/abort.ts`, the telemetry-hooks builder into
  `createTelemetryFromOpts` (`internal/telemetry.ts`), and `isEmptySources` into
  `internal/source.ts` — removing ~157 lines of copy-paste across race/fallback/merge.
- Collapsed the byte-identical `wireOverallTimeout` / `createTtfUsableTimer` into a
  single `armTimer` that now **removes its abort listeners on disarm** (timer-leak
  fix for fast-completing ops).
- `internal/source.ts` — release the `ReadableStream` reader lock on natural
  completion instead of pinning it for the operation's lifetime.
- Dropped the unused `_postCommitFailover` parameter in the fallback engine.
- Removed dead `abortedByOverallTimeout` helper (`internal/timeouts.ts`) — no caller.

## [1.0.0]

### Added

- **`LSM-EDGE-140`–`180`** — §H 1.0.0 production edge matrix + full-matrix integrity (`LSM-EDGE-179` §H sectional guard; `LSM-EDGE-180` full matrix `01`–`179` + `06b`)
- **`LSM-REL-12a`–`12u`** — stable release freeze gates (semver policy, pack audit, bench baseline, engines sync, rollback docs, doc link+anchor audit, 19 diagrams)
- **`scripts/verify-doc-links.mjs`** — internal markdown file + anchor integrity; wired into `verify:docs` (`LSM-REL-12f`)
- **`scripts/smoke-published.mjs`** + **`pnpm smoke:published`** — post-pack consumer smoke with `--node18`, `--node20`, `--all-runtimes`
- **6 new architecture diagrams** — `api-frozen-surface`, `edge-matrix-h`, `publish-ceremony`, `interop-matrix`, `signal-timeout-flow`, `doc-audit-map` (19 total)

### Changed

- **`docs/STABILITY.md`** — **Public API frozen as of `1.0.0`**; post-freeze major/minor/patch semver policy; pre-1.0 checklist archived under Historical
- **All docs** — stable status, `npm install llm-stream-mux`, test count **945**
- **`README.md`** — stable badge, install from npm, no pre-stable hero caveats
- **`docs/RELEASE.md`** — publish-failure rollback runbook + GitHub Release checklist (stable); `v1.0.0` template with REL-12 gates
- **`docs/edge-cases.md`** — §H table `140`–`180`; matrix authority through **180**
- **`docs/testing-strategy.md`**, **`docs/faq.md`**, **`docs/compatibility.md`**, **`docs/performance.md`**, **`CONTRIBUTING.md`**, **`SECURITY.md`**
- **`docs/proposal.MD` §13** — **D15**; §26.2 **`1.0.0`** P10 row
- **`package.json`** — **`1.0.0`**, `smoke:published`, `verify:pre1` includes smoke-published
- **`src/index.ts`** — `MUX_PKG_VERSION` → **`1.0.0`**
- **`LSM-REL-10f`** / **`LSM-REL-12e`** — edge matrix authority through **`180`** / §H **`179`**

### Notes

- **945** tests green; **§9 runtime exports and §6.3 `MuxErrorCode` set frozen** under semver
- First npm publish: `npm install llm-stream-mux@1.0.0`
- **Public API unchanged** vs **`0.9.0`** (behavior + export shape; `MUX_PKG_VERSION` only)
- Optional: **`v0.9.0`** GitHub pre-release tag for ladder completeness (see `docs/RELEASE.md`)
- **`npm publish --provenance`** — maintainer step after green `pnpm verify:pre1`

## [0.9.0]

### Added

- **`docs/STABILITY.md`** — intended stable API surface, semver policy, npm provenance checklist (API not frozen until `1.0.0`)
- **`SECURITY.md`** — coordinated disclosure + zero-deps audit policy
- **`docs/RELEASE.md`** — GitHub release draft templates for `v0.9.0` and `v1.0.0`
- **`scripts/smoke-runtimes.mjs`** + **`pnpm smoke:runtimes`** — Node/Bun/Deno tarball import smoke (`--ci` / `--skip-optional`)
- **`scripts/smoke-consumer.mjs`** + **`pnpm smoke:consumer`** — downstream ESM + CJS tarball consumer smoke
- **`scripts/bench-smoke.mjs`** — advisory micro bench (soft gate in `release-prep --full`)
- **`examples/workers-smoke/`** — Workers-compatible import fixture
- **`.github/workflows/smoke-runtimes.yml`** — CI Bun + Deno gate
- **`pnpm verify:pre1`** — maintainer alias before tag
- **`docs/img/release-pipeline.mmd`** — verify / pre1 / full release diagram
- **`LSM-REL-11a`–`11q`** — §25 Definition of done + extended audit gates
- **`LSM-EDGE-120`–`139`** — P9 §G deep matrix (triple throw, tee n=4, concurrency break, interop round-trip)

### Changed

- **`scripts/release-prep.mjs`** — STABILITY, SECURITY, RELEASE, workers fixture gates; **`--full`** runs smoke-runtimes, smoke-consumer, bench-smoke
- **`scripts/verify-docs.mjs`** — requires STABILITY, SECURITY, RELEASE, smoke scripts, workers fixture
- **`docs/edge-cases.md`** — §E cancel-honesty cross-refs (no longer “planned”)
- **`docs/proposal.MD` §13** — **D14**; §26.2 **`0.9.0`** row
- **`CONTRIBUTING.md`**, **`README.md`**, **`docs/faq.md`**, **`docs/compatibility.md`**, **`docs/testing-strategy.md`**, **`docs/performance.md`**
- **`package.json`** — **`publishConfig.access`**, **`0.9.0`**, **`verify:pre1`**, **`smoke:consumer`**
- **`src/index.ts`** — `MUX_PKG_VERSION` → **`0.9.0`**

### Notes

- **883** tests green; **public API unchanged** vs **`0.8.0`** (pre-stable RC)
- **`LSM-REL-10f`** / **`LSM-REL-11l`** edge matrix authority extended to **`LSM-EDGE-139`**
- **`1.0.0`** deferred — npm publish + explicit §9/§6.3 freeze per **`docs/STABILITY.md`**

## [0.8.0]

### Added

- **`examples/node-fetch/`** — `_fake.ts`, `race.ts`, `fallback.ts`, `merge.ts`, `tee.ts` (fake streams; typecheck vs `dist/`)
- **`tsconfig.examples.json`** + **`pnpm typecheck:examples`**
- **`LSM-REL-10a`–`10f`** — examples typecheck, npm pack manifest, `release:prep`, README quickstart, runtime smoke, edge integrity (`LSM-EDGE-01`–`119`)
- **`prompts/P9-1.0.0-freeze.md`** — outline stub for **`1.0.0`** follow-up
- **`test/edge.test.ts`** — **`LSM-EDGE-100`–`119`** §F cross-cutting matrix pins (`overallTimeoutMs`, `timeoutMs`, commit/post-emit, `mapEach`, merge order, tee validation, ensemble parity)

### Changed

- **`docs/integration-cookbook.md`** — full assemble/guard pairing guide (docs-only)
- **`README.md`** — P8 status, install, examples links, **`0.8.0`**
- **`docs/usage-guides.md`**, **`CONTRIBUTING.md`**, **`docs/img/README.md`**
- **`scripts/release-prep.mjs`** — version sync + `npm pack` audit + `verify:docs` + examples typecheck
- **`scripts/verify-docs.mjs`** — example paths + `_fake.ts`
- **`docs/faq.md`**, **`docs/compatibility.md`**, **`docs/testing-strategy.md`**
- **`docs/proposal.MD` §13** — **D13**; §26.2 **`0.8.0`** row
- **`src/index.ts`** — `MUX_PKG_VERSION` → **`0.8.0`**

### Notes

- **847** tests green; API unchanged from **`0.7.0`**
- **`1.0.0`** next: npm publish + explicit §9 API freeze per §25

## [0.7.0]

### Added

- **`test/edge.test.ts`** — `LSM-EDGE-01`–`99` + `06b` §23 matrix, extended pins, no-leak audit, supplemental §D, ultra-extended §E
- **`test/helpers/edge-matrix.ts`** — shared EDGE collectors, `flushMicrotasks`, `assertMuxCancelled`
- **`LSM-REL-09a/b`** — dist contract + tarball smoke (`race([])`, `merge([])`)
- **`docs/img/edge-matrix.mmd`** + SVG — P7 contract matrix overview

### Changed

- **`docs/edge-cases.md`** — §G cells pinned to **`LSM-EDGE-*`** with Test ID column
- **`docs/testing-strategy.md`**, **`README.md`** — P7 status, **821** tests
- **`docs/proposal.MD` §13** — **D11** (REL-09 no-leak), **D12** (tee signal cell)
- **`scripts/smoke-package.mjs`** — edge empty-source smoke paths
- **`test/release.test.ts`** — `LSM-REL-08a`/`09a` version **`0.7.0`**
- **`src/index.ts`** — `MUX_PKG_VERSION` → **`0.7.0`**

### Notes

- Proposal §23 **`LSM-REL-02`** no-leak remapped to **`LSM-REL-09`** (export contract keeps **`LSM-REL-02`**)
- **`examples/node-fetch/*`** shipped in **`0.8.0`** (P8)
- **`0.8.0`** = P8 docs/examples; **`1.0.0`** = npm publish + API freeze (**D13**)

## [0.6.0]

### Added

- **`src/internal/queue.ts`** — shared output queue with configurable **`highWaterMark`** (default `1`)
- **`src/internal/validate-options.ts`** — shared validation for **`timeoutMs`**, **`overallTimeoutMs`**, **`highWaterMark`**, **`sourceHighWaterMark`**
- **`src/internal/timeouts.ts`** — **`wireOverallTimeout`**, **`createTtfUsableTimer`**, overall/per-source timeout helpers
- **`test/cross.test.ts`** — `LSM-X-01`–`115` cross-cutting contract tests
- **`test/core.test.ts`** — `LSM-CORE-61`–`70` (`queue.ts` unit tests)
- **`LSM-REL-08a/b`** — dist contract + smoke for cross-cutting options and **`MUX_PKG_VERSION === "0.6.0"`**

### Changed

- **`race`**, **`fallback`**, **`merge`/`ensemble`** — wire **`timeoutMs`** (race + fallback), **`overallTimeoutMs`**, **`highWaterMark`**, **`sourceHighWaterMark`** (ReadableStream only)
- **`src/index.ts`** — `MUX_PKG_VERSION` → **`0.6.0`**
- **`scripts/smoke-package.mjs`** — smoke **`race({ timeoutMs })`** + **`merge({ overallTimeoutMs })`**
- **`test/release.test.ts`** — `LSM-REL-04b`–`07b` assert **`CommonOptions`** timer/HWM fields in d.ts
- **`docs/img/core-internals.mmd`** + SVG — queue, validate-options, timeout wiring
- **Docs** — testing strategy, edge-cases § cross-cutting, usage-guides timer/HWM sections, compatibility **`AbortSignal.timeout`** note

### Notes

- **`timeoutMs`** intentionally ignored on **`merge`** (per §7.6)
- `test/edge.test.ts` full matrix deferred to P7
- Next milestone **`0.7.0`** after P7 (edge matrix)

## [0.5.0]

### Added

- **`merge(sources, opts?)`** — concurrent N→1 **`Tagged<U>`** multiplex (§7.4)
- **`ensemble`** — exported alias of **`merge`** (D4)
- **`src/internal/merge-engine.ts`** — read-loop coordinator with `arrival` / `round-robin`, `concurrency`, `failFast`, global backpressure
- **`test/merge.test.ts`** — `LSM-MERGE-01`–`135`
- **`LSM-REL-07a/b`** — dist + smoke contract for `merge` + `ensemble`

### Changed

- **`src/index.ts`** — exports `merge`, `ensemble`; `MUX_PKG_VERSION` → `0.5.0`
- **`scripts/smoke-package.mjs`** — smoke merge tagged output
- **`docs/img/merge-tagged.mmd`** + SVG — read-loop, concurrency, Tagged kinds
- **`docs/img/core-internals.mmd`** — `merge()` / `ensemble` in public API
- **`test/release.test.ts`** — `LSM-REL-04b` / `05b` / `06b` allow `merge`; `LSM-REL-07`
- **Docs** — testing strategy, edge-case §D, README status, usage-guides merge section

### Notes

- `timeoutMs`, `overallTimeoutMs`, `highWaterMark` on merge deferred to P6
- `test/edge.test.ts` full matrix deferred to P7
- Next milestone **`0.6.0`** after P6 (cross-cutting)

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
