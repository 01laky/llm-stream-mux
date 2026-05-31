# API stability policy

> **Public API frozen as of `1.0.0`.** §9 runtime exports and §6.3 `MuxErrorCode` set are stable under semver (see policy below).

Behavioral contracts are pinned by **`LSM-*`** tests — especially [`edge-cases.md` §G](./edge-cases.md#g-contract-matrix-binding-p7-070) (`LSM-EDGE-01`–`139`) and [`§H`](./edge-cases.md#h-ultra-extended-h-100-production-matrix-lsm-edge-140180) (`LSM-EDGE-140`–`180`).

Report security issues per [`SECURITY.md`](../SECURITY.md).

![Frozen public API surface](./img/api-frozen-surface.svg)

---

## Intended runtime exports (§9)

These **value** exports must remain available from the package root:

| Export            | Kind                      |
| ----------------- | ------------------------- |
| `race`            | function                  |
| `fallback`        | function                  |
| `merge`           | function                  |
| `ensemble`        | alias of `merge`          |
| `tee`             | function                  |
| `collect`         | function                  |
| `toReadable`      | function                  |
| `toAsyncIterable` | function                  |
| `MUX_PKG_VERSION` | `string` constant         |
| `MUX_ERROR_CODES` | readonly `MuxErrorCode[]` |

**Must not be exported:** `muxError`, `fromAsyncIterable`, anything under `internal/`.

---

## Intended type exports (§6 / §9)

`Source`, `Sources`, `Tagged`, `MuxError`, `MuxErrorCode`, `MuxErrorInit`, `CreateMuxError`, `SourceEvent`, `SourceEventType`, `MuxResult`, `MuxSourceStats`, `MuxStrategy`, `FailoverPolicy`, `TeeBackpressure`, `MergeOrder`, `CommonOptions`, `RaceOptions`, `FallbackOptions`, `MergeOptions`, `TeeOptions`, `RaceFn`, `FallbackFn`, `MergeFn`, `TeeFn`, `CollectFn`, `ToReadableFn`, `ToAsyncIterableFn`, `MuxCancelled`, `MuxCancelledReason`.

---

## `MuxErrorCode` set (§6.3 — frozen at 1.0.0)

| Code               | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `NO_USABLE_SOURCE` | Race: no source produced a usable item                          |
| `ALL_FAILED`       | Fallback / merge fail-fast: every source failed                 |
| `ABORTED`          | Consumer or parent `signal` aborted the operation               |
| `SOURCE_ERROR`     | Underlying source or sync `mapEach` threw                       |
| `TIMEOUT`          | Per-source or overall deadline exceeded (cause of `ABORTED`)    |
| `IN_BAND_ERROR`    | Item classified as error via `isError` (not synthesized as `T`) |

`MUX_ERROR_CODES` must list exactly these six codes once each (`LSM-REL-02`, `LSM-REL-11b`).

---

## Semver policy (active from 1.0.0)

- **Major** — breaking change to §9 runtime exports or §6.3 `MuxErrorCode` set
- **Minor** — backward-compatible addition (new optional export or strategy opt-in only with explicit proposal amendment)
- **Patch** — bug fix, docs, tests; no export shape change

Patch releases do **not** introduce breaking API changes.

---

## Non-goals (unchanged at 1.0.0)

No HTTP client, no provider parsing, no security filter, no baked-in LLM event model. See [proposal §1](./proposal.MD#1-positioning).

---

## Multi-runtime verification

| Runtime            | Status                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------- |
| Node.js 18+        | Primary CI — `pnpm verify`                                                              |
| Bun                | Smoke-tested — `pnpm smoke:runtimes --ci` (`.github/workflows/smoke-runtimes.yml`)      |
| Deno               | Smoke-tested — same workflow                                                            |
| Cloudflare Workers | **Expected** — fixture [`examples/workers-smoke/`](../examples/workers-smoke/README.md) |

![Release verify pipeline](./img/release-pipeline.svg) · [Publish ceremony](./img/publish-ceremony.svg)

---

## Maintainer publish flow (1.0.0+)

1. Confirm **`1.0.0`** on `main`; CI green (`ci.yml` + `smoke-runtimes.yml`)
2. **`pnpm verify:pre1`** (verify + release:prep + smoke:runtimes + smoke:consumer + smoke:published)
3. **`pnpm smoke:runtimes --ci`**
4. **`pnpm release:prep --full`** (bench-smoke advisory, smoke-published cross-runtime)
5. `git tag v1.0.0 && git push origin v1.0.0`
6. GitHub Release from [`docs/RELEASE.md`](./RELEASE.md) stable template + checklist
7. **`npm publish --provenance --access public`**
8. Post-publish: `npm install llm-stream-mux@1.0.0` smoke in a clean directory

### npm provenance + trusted publishing

Before publish:

1. Enable **npm trusted publishers** (GitHub OIDC) for this repository
2. Maintainer npm account **2FA** enabled
3. Use `npm publish --provenance --access public`
4. Confirm provenance badge on npm package page
5. Optional: `.github/workflows/publish.yml` on tag — document secrets in [`RELEASE.md`](./RELEASE.md)

---

## Historical: 0.9.0 → 1.0.0 migration

Prior to **`1.0.0`**, the banner read:

> **Public API is not semver-frozen until `1.0.0`.** This document lists the **intended** stable surface and the maintainer checklist for the first npm release.

Pre-1.0 (`0.x`): breaking changes were allowed but noted in CHANGELOG. **`0.9.0`** completed §25 audit automation (`LSM-REL-11a`–`11q`) without changing the public export shape vs **`0.8.0`**.

### Archived pre-1.0 maintainer checklist (completed at 1.0.0)

- [x] Confirm **`0.9.0`** on `main`; CI green
- [x] **`pnpm verify:pre1`** green
- [x] Bump **`1.0.0`**, `MUX_PKG_VERSION`, CHANGELOG, REL version pins
- [x] Update banner to “frozen as of 1.0.0”
- [x] Add **`LSM-EDGE-140`–`180`** §H + **`LSM-REL-12a`–`12u`**
- [x] Doc audit + **19** diagrams + `verify-doc-links`
- [ ] `npm publish --provenance --access public` (maintainer, after green gates)
- [ ] GitHub Release **`v1.0.0`** (maintainer)

---

## Related

- [Compatibility matrix](./compatibility.md)
- [Testing strategy](./testing-strategy.md)
- [Release templates](./RELEASE.md)
- [FAQ — 0.9.0 vs 1.0.0](./faq.md)
