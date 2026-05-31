# FAQ

**Status:** P9 (`0.9.0`) — §25 audit, Bun/Deno smoke, `STABILITY.md`; **`1.0.0`** = npm publish + API freeze.

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

## What is 0.9.0 vs 1.0.0?

**`0.9.0`** (P9) — pre-stable RC: §25 Definition of done automated (`LSM-REL-11a`–`11q`), multi-runtime smoke, consumer smoke, [`STABILITY.md`](./STABILITY.md), [`SECURITY.md`](../SECURITY.md). **Public API unchanged vs 0.8.0**; not semver-frozen yet.

**`1.0.0`** — first npm publish + maintainer declares §9 / §6.3 frozen under semver. See [`STABILITY.md`](./STABILITY.md) and [`RELEASE.md`](./RELEASE.md).

---

## What is `pnpm verify:pre1`?

Maintainer gate before tagging: runs **`pnpm verify`**, then **`release:prep`**, **`smoke:runtimes --skip-optional`**, and **`smoke:consumer`**. Does not require Bun/Deno locally. CI still runs **`smoke:runtimes --ci`** separately.

---

## When is 1.0.0?

When §25 is audited, CI is green, and the maintainer publishes to npm and updates STABILITY to “frozen”. **`0.9.0`** completes engineering prep; **`1.0.0`** is ceremony only. See proposal **D13**, **D14**, and §26.2.

---

## Related

- [Proposal](./proposal.MD)
- [Usage guides](./usage-guides.md)
- [Edge cases](./edge-cases.md)
- [Examples](../examples/README.md)
