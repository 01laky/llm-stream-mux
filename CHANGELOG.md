# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.0.0]

### Added

- **Design spec** — `docs/proposal.MD` (Part A normative spec + P0–P8 roadmap, decisions D1–D10).
- **Documentation scaffold** — README, usage guides, edge-case matrix (contract), integration cookbook (userland pairing with assemble/guard), compatibility, comparison, FAQ, performance, testing strategy.
- **Architecture diagrams** — Mermaid sources and pre-rendered SVGs in `docs/img/` (`pnpm diagrams:build`, `pnpm diagrams:check`).
- **Repo hygiene** — `.githooks` strip AI co-author trailers, `scripts/setup-githooks.sh`, zero-deps verify script, docs verify script, GitHub Actions CI (docs phase).
- **Git ignore** — `.cursor/` and `prompts/` local only.

### Notes

- Library implementation not started — follow proposal P0 next. Version ladder §26.2: `0.1.0` after P0+P1.
