# Runtime compatibility

**Status:** Pre-implementation — targets from proposal §0 and §25.

`llm-stream-mux` is runtime-agnostic via **Web Streams** and `AbortController`. No Node-only APIs in `src/`.

---

## Supported runtimes

| Runtime            | Support        | Notes                                                                    |
| ------------------ | -------------- | ------------------------------------------------------------------------ |
| Node.js 18+        | **Primary CI** | LTS 18, 20, 22 in GitHub Actions                                         |
| Bun                | Expected       | Web Streams globals                                                      |
| Deno               | Expected       | No `node:stream/web` imports                                             |
| Cloudflare Workers | Expected       | `ReadableStream.getReader()` only — no `Symbol.asyncIterator` on streams |

---

## Required globals

Must exist at runtime (proposal §0):

- `ReadableStream`, `WritableStream`, `TransformStream`
- `AbortController`, `AbortSignal.timeout`
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

GitHub Actions runs `pnpm verify` on Node 18, 20, and 22 once implementation lands (P0+). Until then, docs and zero-deps checks run in CI.

---

## Related

- [Proposal §0 hard constraints](./proposal.MD#0-how-to-use-this-document-read-first-implementer)
- [Performance notes](./performance.md)
