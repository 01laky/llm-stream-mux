# How this compares

**Status:** Pre-implementation — positioning from proposal §1–§2 and §12.

Where `llm-stream-mux` fits relative to common alternatives. Comparisons are **best-effort** — verify before choosing.

---

## Positioning in one sentence

> A **zero-dependency stream orchestration layer**: race, fallback, merge, and tee over any `AsyncIterable<T>` or `ReadableStream<T>` — generic over `T`, with no baked-in LLM event model.

Sibling: [`llm-stream-assemble`](https://github.com/01laky/llm-stream-assemble) parses **one** provider stream (format). mux coordinates **many** (or splits one to many).

---

## Comparison matrix

| Category                          | Examples                         | What they optimize for       | `llm-stream-mux`                                                              |
| --------------------------------- | -------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| **Full-stack AI SDKs**            | Vercel AI SDK, LangChain.js      | Agents, UI, provider clients | **Lower level** — you own fetch, parsing (assemble), and UI                   |
| **Provider SDKs**                 | `openai`, `@anthropic-ai/sdk`    | Vendor RPC + types           | **Provider-agnostic orchestration** over streams you already opened           |
| **Generic stream utils**          | `p-limit`, manual `Promise.race` | Ad-hoc concurrency           | **Semantics built-in**: commit points, `Tagged<T>`, cancel reasons, telemetry |
| **Native `ReadableStream.tee()`** | Platform API                     | 2-way split                  | **N-way tee** with bounded backpressure policies                              |
| **llm-stream-assemble**           | Same ecosystem                   | Parse bytes → `StreamEvent`  | **Complementary** — mux before or after assemble; no npm coupling             |
| **llm-stream-guard**              | Same ecosystem                   | Security filter 1→1          | **Complementary** — filter after mux in userland                              |

---

## Four differentiators

1. **Generic over `T`** — byte mode and event mode with one API.
2. **Orchestration semantics** — race commit, fallback policies, merge partial failure, tee backpressure.
3. **Zero runtime dependencies** — Web Streams only.
4. **Observable** — `onSourceEvent`, `MuxResult`, stable `MuxError` codes.

---

## When to use this

- Race or fallback across multiple provider endpoints or models
- Ensemble UI merging parallel model outputs with per-source tags
- Fan-out to client + logger without unbounded `tee()` memory
- Byte-mode failover before parsing, or event-mode merge after assemble

---

## When **not** to use this

| You want…                            | Better fit                                                             |
| ------------------------------------ | ---------------------------------------------------------------------- |
| Parse SSE into typed provider events | [`llm-stream-assemble`](https://github.com/01laky/llm-stream-assemble) |
| Redact secrets / tool policy         | `llm-stream-guard`                                                     |
| HTTP client, auth, retries           | Your fetch layer                                                       |
| Agent loop + tool execution          | AI SDK, LangChain                                                      |
| Re-issue the same failed request     | Your retry logic — mux starts the **next** source only                 |

See [FAQ](./faq.md) and proposal [Non-goals](./proposal.MD#12-non-goals).
