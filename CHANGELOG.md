# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.0.1]

### Added

- **P0 TypeScript scaffold** — `src/types.ts` exports all proposal §6/§9 types (`Source`, `Sources`, `Tagged`, `MuxError`, options, function signature types, `MuxCancelled`); `src/index.ts` exports `MUX_PKG_VERSION` + frozen `MUX_ERROR_CODES`; comment-only roadmap placeholders in `src/{race,fallback,merge,tee,errors}.ts`.
- **Build pipeline** — `tsup` dual ESM/CJS + `.d.ts`/`.d.cts`, strict `tsconfig`, Vitest, ESLint + typescript-eslint, `scripts/smoke-package.mjs` (ESM/CJS import from `npm pack` tarball).
- **Tests (114)** — `LSM-REL-01`/`LSM-REL-02` release contract; `LSM-TYP-01`–`68` exhaustive public type surface; `LSM-EDGE-P0-01`–`26` §7 matrix code prelude; `LSM-SRC-01`–`08` Source union fixture edge cases (empty streams, lazy re-invoke, cancel, throw).
- **Architecture diagram** — `docs/img/public-api-types` (Mermaid + SVG) for frozen §6/§9 surface.

### Changed

- **CI** — Node **18 / 20 / 22** matrix, `pnpm install --frozen-lockfile`, 15-minute job timeout.
- **README** — status reflects P0 complete (types + build); development table lists full `pnpm verify` pipeline.
- **`MUX_ERROR_CODES`** — runtime `Object.freeze()` so error enum cannot be mutated at runtime (`LSM-TYP-63`).

### Notes

- Public strategy functions (`race`, `fallback`, `merge`, `tee`, interop) remain **types only** until P1–P5.
- Next semver milestone **`0.1.0`** after **P1** (core internals + `collect`/`toReadable`/`toAsyncIterable`) per proposal §26.2.

## [0.0.0]

### Added

- **Design spec** — `docs/proposal.MD` (Part A normative spec + P0–P8 roadmap, decisions D1–D10).
- **Documentation scaffold** — README, usage guides, edge-case matrix (contract), integration cookbook (userland pairing with assemble/guard), compatibility, comparison, FAQ, performance, testing strategy.
- **Architecture diagrams** — six Mermaid sources + pre-rendered SVGs in `docs/img/` (`pnpm diagrams:build`, `pnpm diagrams:check`).
- **Repo hygiene** — `.githooks` strip AI co-author trailers, `scripts/setup-githooks.sh`, zero-deps verify script, docs verify script, GitHub Actions CI (docs phase).
- **Git ignore** — `.cursor/` and `prompts/` local only.
