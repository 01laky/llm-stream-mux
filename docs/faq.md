# FAQ

**Status:** Pre-implementation

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

When proposal §25 Definition of done is met — all `LSM-*` tests green, docs, examples, `release:prep` passing. Version ladder: proposal §26.2.

---

## Related

- [Proposal](./proposal.MD)
- [Usage guides](./usage-guides.md)
- [Edge cases](./edge-cases.md)
