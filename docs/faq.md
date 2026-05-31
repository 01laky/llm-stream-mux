# FAQ

**Status:** P8 (`0.8.0`) — docs, examples, and release prep complete; **`1.0.0`** = npm publish + API freeze.

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

## When is 1.0.0?

**`0.8.0`** (P8) ships docs, examples, cookbook, and **`release:prep`**. **`1.0.0`** is tagged when §25 Definition of done is audited, **`pnpm verify`** is green, and the maintainer **explicitly declares §9 / §6.3 API frozen** for npm publish. See proposal **D13** and §26.2.

---

## Related

- [Proposal](./proposal.MD)
- [Usage guides](./usage-guides.md)
- [Edge cases](./edge-cases.md)
- [Examples](../examples/README.md)
