# API stability policy

> **Public API is not semver-frozen until `1.0.0`.** This document lists the **intended** stable surface and the maintainer checklist for the first npm release.

Behavioral contracts are pinned by **`LSM-*`** tests — especially [`edge-cases.md` §G](./edge-cases.md#g-contract-matrix-binding--p7-070) (`LSM-EDGE-01`–`139`).

Report security issues per [`SECURITY.md`](../SECURITY.md).

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

## Semver policy (after 1.0.0)

| Bump      | When                                                                               |
| --------- | ---------------------------------------------------------------------------------- |
| **PATCH** | Bug fixes, docs, internal changes — no export shape change                         |
| **MINOR** | Additive options with defaults; new `SourceEvent` types only if telemetry-safe     |
| **MAJOR** | Remove/rename exports, change default strategy behavior, change `MuxErrorCode` set |

Pre-1.0 (`0.x`): breaking changes allowed but should be noted in CHANGELOG.

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

![Release verify pipeline](./img/release-pipeline.svg)

---

## Maintainer checklist (1.0.0 — not executed at 0.9.0)

1. Confirm **`0.9.0`** on `main`; CI green (`ci.yml` + `smoke-runtimes.yml`)
2. **`pnpm verify:pre1`** (verify + release:prep + smoke:runtimes + smoke:consumer)
3. **`pnpm smoke:runtimes --ci`**
4. **`pnpm release:prep --full`** (optional bench-smoke advisory)
5. Bump **`1.0.0`**, `MUX_PKG_VERSION`, CHANGELOG, REL version pins
6. Update **this file** banner to “frozen as of 1.0.0”
7. `git tag v1.0.0 && git push origin v1.0.0`
8. GitHub Release from [`docs/RELEASE.md`](./RELEASE.md) stable template
9. **`npm publish --provenance --access public`**
10. Post-publish: `npm install llm-stream-mux@1.0.0` smoke in a clean directory

### npm provenance + trusted publishing (1.0.0)

Before first publish:

1. Enable **npm trusted publishers** (GitHub OIDC) for this repository
2. Maintainer npm account **2FA** enabled
3. Use `npm publish --provenance --access public`
4. Confirm provenance badge on npm package page
5. Optional later: `.github/workflows/publish.yml` on tag — not required at `0.9.0`

---

## Related

- [Compatibility matrix](./compatibility.md)
- [Testing strategy](./testing-strategy.md)
- [Release templates](./RELEASE.md)
- [FAQ — 0.9.0 vs 1.0.0](./faq.md)
