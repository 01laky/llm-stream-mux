# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.0.0]

### Added

- **Design spec** — `docs/proposal.MD` (Part A normative spec + P0–P8 roadmap, decisions D1–D10).
- **Documentation scaffold** — README, usage guides, edge-case matrix (contract), integration cookbook (userland pairing with assemble/guard), compatibility, comparison, FAQ, performance, testing strategy.
- **Architecture diagrams** — seven Mermaid sources + pre-rendered SVGs in `docs/img/` including `public-api-types` for the frozen §6/§9 surface (`pnpm diagrams:build`, `pnpm diagrams:check`).
- **Repo hygiene** — `.githooks` strip AI co-author trailers, `scripts/setup-githooks.sh`, zero-deps verify script, docs verify script, GitHub Actions CI on Node 18/20/22.
- **Git ignore** — `.cursor/` and `prompts/` local only.
- **P0 TypeScript scaffold** — `src/types.ts` exports all proposal §6/§9 types (`Source`, `Tagged`, `MuxError`, options, function signature types, `MuxCancelled`); `src/index.ts` exports `MUX_PKG_VERSION` + `MUX_ERROR_CODES`; comment-only roadmap placeholders in `src/{race,fallback,merge,tee,errors}.ts`.
- **Build pipeline** — `tsup` dual ESM/CJS + d.ts, strict `tsconfig`, Vitest, ESLint TS, `scripts/smoke-package.mjs`.
- **Tests** — `LSM-REL-01`, `LSM-REL-02`, `LSM-TYP-01`–`68`, `LSM-EDGE-P0-01`–`26`, `LSM-SRC-01`–`08` (114 total): release/build contract, exhaustive type edge cases, edge-matrix prelude, source fixture edge cases.

### Notes

- Public strategy functions (`race`, `fallback`, `merge`, `tee`, interop) are **types only** until P1–P5. Version **`0.1.0`** ships after P0+P1 (§26.2).
