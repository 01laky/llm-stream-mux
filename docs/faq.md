# FAQ

**Status:** P10 (`1.0.0`) — stable release; §9 / §6.3 frozen under semver; **945** tests green.

---

## Does mux parse OpenAI or Anthropic SSE?

No. Use [`llm-stream-assemble`](https://github.com/01laky/llm-stream-assemble) for parsing. mux orchestrates streams you hand it — raw bytes or already-parsed events.

---

## Does mux depend on assemble or guard?

**No.** Zero imports, zero peer dependencies. Pair them in your app; see [integration-cookbook](./integration-cookbook.md).

---

## Why not `Promise.race` on fetch calls?

Race/fallback need **stream-level** semantics: cancel losers, buffer pre-usable frames, respect commit points, emit telemetry, and honor `AbortSignal` — not just “first settled promise wins.”

---

## Why not native `ReadableStream.tee()`?

Native tee buffers unboundedly for slow branches. mux `tee()` adds N-way split and `block` / `bounded` / `drop` policies (§8, D5).

---

## Can `mapEach` be async?

No (D9). Async transforms belong in userland (`TransformStream`, manual loops). Keeps merge ordering and commit timing predictable.

---

## What test IDs should I use?

`LSM-<AREA>-NN` — areas: `CORE`, `RACE`, `FB`, `MERGE`, `TEE`, `X`, `EDGE`, `REL`. See [testing-strategy](./testing-strategy.md).

---

## How do I install mux?

```bash
npm install llm-stream-mux
# or pin: npm install llm-stream-mux@1.0.0
```

Requires Node.js **18+** (or Bun/Deno/Workers with Web Streams). See [compatibility](./compatibility.md).

---

## What changed at 1.0.0?

- **First stable npm release** — public API frozen per [STABILITY.md](./STABILITY.md)
- **`LSM-EDGE-140`–`180`** — §H production edge matrix + full-matrix integrity
- **`LSM-REL-12a`–`12u`** — freeze gates (doc links, pack audit, bench baseline, rollback docs)
- **945** tests (was 883 at `0.9.0`)
- **Public API unchanged** vs `0.9.0` (export shape and behavior)

---

## What is 0.9.0 vs 1.0.0?

**`0.9.0`** (P9) — pre-stable RC: §25 audit (`LSM-REL-11a`–`11q`), multi-runtime smoke, consumer smoke. API feature-complete but **not** semver-frozen.

**`1.0.0`** (P10) — stable: npm publish, §9 / §6.3 frozen, §H edge max, doc audit. See [STABILITY.md](./STABILITY.md) and [RELEASE.md](./RELEASE.md).

---

## What is semver after 1.0.0?

Per [STABILITY.md](./STABILITY.md):

- **Major** — breaking §9 exports or §6.3 `MuxErrorCode` set
- **Minor** — backward-compatible addition (proposal amendment required for new exports)
- **Patch** — bug fix, docs, tests; no export shape change

Patch releases do **not** promise breaking changes.

---

## What is `pnpm verify:pre1`?

Maintainer gate before tagging: runs **`pnpm verify`**, **`release:prep`**, **`smoke:runtimes --skip-optional`**, **`smoke:consumer`**, and **`smoke:published`**. CI still runs **`smoke:runtimes --ci`** separately.

---

## Signal and timeout options?

`race`, `fallback`, and `merge` share `timeoutMs`, `overallTimeoutMs`, and `signal`. **`tee()`** has no `signal` or timeout options — only `backpressure` / `bufferLimit`. See [signal-timeout-flow diagram](./img/signal-timeout-flow.svg) and [edge-cases §H](./edge-cases.md#h-ultra-extended-h-100-production-matrix-lsm-edge-140180).

---

## Related

- [Proposal](./proposal.MD)
- [Usage guides](./usage-guides.md)
- [Edge cases](./edge-cases.md)
- [Examples](../examples/README.md)
