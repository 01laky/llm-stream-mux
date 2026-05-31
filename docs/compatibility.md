# Runtime compatibility

**Status:** Stable **`1.0.0`** — **`AbortSignal.timeout`** required when passing **`timeoutMs`** or **`overallTimeoutMs`** (validated at call site; see **`LSM-CORE-65`**).

`llm-stream-mux` is runtime-agnostic via **Web Streams** and `AbortController`. No Node-only APIs in `src/`.

Install: `npm install llm-stream-mux`

---

## Supported runtimes

| Runtime            | Support        | Notes                                                                                                 |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------- |
| Node.js 18+        | **Primary CI** | LTS **18, 20, 22** in GitHub Actions — matches `package.json` `engines.node` (`>=18`)                 |
| Bun                | Smoke-tested   | CI `smoke-runtimes.yml`; Web Streams globals                                                          |
| Deno               | Smoke-tested   | CI `smoke-runtimes.yml`; no `node:stream/web` imports                                                 |
| Cloudflare Workers | Expected       | Fixture [`examples/workers-smoke/`](../examples/workers-smoke/README.md); manual `workerd` / Wrangler |

---

## Required globals

Must exist at runtime (proposal §0):

- `ReadableStream`, `WritableStream`, `TransformStream`
- `AbortController`, `AbortSignal.timeout` (**required** when using **`timeoutMs`** / **`overallTimeoutMs`** on strategies)
- `CountQueuingStrategy`
- `TextEncoder` / `TextDecoder` (interop edge cases)

**Do not use:** `ReadableStream[Symbol.asyncIterator]` — not portable to browsers, Deno, or Workers.

---

## Cancellation semantics

| Source type      | Cancel behavior                                                              |
| ---------------- | ---------------------------------------------------------------------------- |
| `ReadableStream` | Hard cancel — `reader.cancel()` aborts underlying source (e.g. `fetch` body) |
| `AsyncIterable`  | Soft cancel — `return()` only; underlying work may continue                  |

Recommendation: supply `ReadableStream` when loser cancellation must abort HTTP (race/fallback).

---

## CI matrix

GitHub Actions runs **`pnpm verify`** on Node **18, 20, and 22** (includes **`typecheck:examples`** and **`LSM-REL-10*`** / **`LSM-REL-11*`** / **`LSM-REL-12*`**).

**[`smoke-runtimes.yml`](../.github/workflows/smoke-runtimes.yml)** — Bun + Deno tarball import smoke after `pnpm build`.

**`LSM-REL-12s`** — `engines.node`, this document, and `ci.yml` Node matrix stay aligned.

---

## Related

- [Proposal §0 hard constraints](./proposal.MD#0-how-to-use-this-document-read-first-implementer)
- [Performance notes](./performance.md)
- [STABILITY](./STABILITY.md)
