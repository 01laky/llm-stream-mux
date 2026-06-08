# Integration cookbook

**Status:** P8 (`0.8.0`) — **docs-only** pairing; zero npm coupling to sibling libraries.

How to compose `llm-stream-mux` with [`llm-stream-assemble`](https://github.com/01laky/llm-stream-assemble) and `llm-stream-guard` in userland. Install each package separately; no imports between them inside any library.

![Ecosystem stack](./img/ecosystem.svg)

Runnable mux-only examples: [examples/node-fetch/](../examples/node-fetch/).

---

## Prerequisites

- Node.js 22+ (Web Streams, `AbortController`, `AbortSignal.timeout`)
- Your own HTTP client and auth
- Optional: `llm-stream-assemble` for parsing, guard for filtering

---

## Decision table

| I need…                             | Pattern                           | mux strategy                          | Order          |
| ----------------------------------- | --------------------------------- | ------------------------------------- | -------------- |
| Fastest provider wins raw SSE bytes | race bodies, then assemble winner | `race<Uint8Array>` → `assembleStream` | mux → assemble |
| Primary model with backup bytes     | lazy fallback on bodies           | `fallback<Uint8Array>` → assemble     | mux → assemble |
| Primary model with backup events    | lazy fallback thunks              | `fallback`                            | assemble → mux |
| Multi-model panel / ensemble UI     | merge tagged streams              | `merge` / `ensemble` + `Tagged<T>`    | assemble → mux |
| Log + client from one stream        | tee with `bounded` or `drop`      | `tee`                                 | mux only       |
| Parse then orchestrate events       | assemble each source first        | `merge` on event type                 | assemble → mux |
| Orchestrate then filter             | mux then guard transform          | userland pipe                         | mux → guard    |

---

## Byte mode: race → assemble

1. Open two (or more) HTTP streams as `ReadableStream<Uint8Array>`.
2. **`race`** with `isUsable` if providers emit empty keep-alive frames.
3. Pass winner to **`assembleStream(toReadable(winner), adapter)`** in your app.

```ts
import { race, toReadable } from "llm-stream-mux";
import { assembleStream, openaiChatAdapter } from "llm-stream-assemble";

const winner = race<Uint8Array>([resA.body!, resB.body!], {
	signal,
	timeoutMs: 5000,
	isUsable: (c) => c.byteLength > 0,
});

for await (const event of assembleStream(toReadable(winner), openaiChatAdapter())) {
	if (event.type === "text.delta") process.stdout.write(event.text);
}
```

Diagram: [byte-event-modes.svg](./img/byte-event-modes.svg). Example: [race.ts](../examples/node-fetch/race.ts).

---

## Byte mode: fallback → assemble

1. **`fallback<Uint8Array>([() => primary.body!, () => backup.body!], { policy: "commit" })`**
2. Only one body stream is active at a time; losers cancelled on failover.
3. **`assembleStream(toReadable(out), adapter)`** on the surviving byte stream.

```ts
import { fallback, toReadable } from "llm-stream-mux";
import { assembleStream, openaiChatAdapter } from "llm-stream-assemble";

const bytes = fallback<Uint8Array>([() => primary.body!, () => backup.body!], {
	policy: "commit",
	signal,
});

for await (const event of assembleStream(toReadable(bytes), openaiChatAdapter())) {
	handle(event);
}
```

Example: [fallback.ts](../examples/node-fetch/fallback.ts) (event-mode lazy failover; same mux semantics).

---

## Event mode: assemble → merge

Parse each provider separately, then merge tagged event streams. Use **`ensemble`** as an alias of **`merge`** (D4).

```ts
import { merge, ensemble } from "llm-stream-mux";
import { assembleStream, openaiChatAdapter, anthropicAdapter } from "llm-stream-assemble";

const sources = {
	openai: assembleStream(openaiBody, openaiChatAdapter()),
	anthropic: assembleStream(anthropicBody, anthropicAdapter()),
};

for await (const tagged of ensemble(sources, {
	isError: (e) => e.type === "error",
	onSourceEvent: (s) => metrics(s),
	onFinish: (r) => logSummary(r),
})) {
	if (tagged.kind === "value") ui.render(tagged.source, tagged.value);
	else if (tagged.kind === "error") ui.flag(tagged.source, tagged.error);
	else ui.markDone(tagged.source);
}
```

Example: [merge.ts](../examples/node-fetch/merge.ts).

---

## Anti-pattern: assemble → race → assemble

Do **not** race already-parsed event streams and then parse again. Pick one placement:

- **Byte mode:** `race` bodies → **one** `assembleStream` on the winner.
- **Event mode:** `assemble` each source → **`merge`** tagged events.

Double parsing adds latency and breaks commit semantics.

---

## mux → guard (event mode)

Apply guard transforms after mux in userland — guard is a separate 1→1 filter per branch:

```ts
import { merge } from "llm-stream-mux";

for await (const tagged of merge({ a: streamA, b: streamB })) {
	if (tagged.kind !== "value") continue;
	const safe = guardTransform(tagged.value); // llm-stream-guard API
	render(tagged.source, safe);
}
```

For a single merged consumer stream, pipe **`toReadable(merge(...))`** through your guard adapter in the app layer.

---

## Proxy SSE pattern

Forward raw bytes through a proxy without parsing:

```ts
import { race, toReadable } from "llm-stream-mux";

const winner = race<Uint8Array>([primary.body!, backup.body!], { signal });

return new Response(toReadable(winner), {
	headers: { "Content-Type": "text/event-stream" },
});
```

---

## Telemetry across libraries

Wire mux hooks in your app; assemble/guard stay unaware of mux:

```ts
import { fallback } from "llm-stream-mux";

const out = fallback<Uint8Array>([() => primary.body!, () => backup.body!], {
	onSourceEvent: (e) => telemetry.record(e), // failover, error, …
	onFinish: (r) => telemetry.summary(r), // winner, perSource, aborted
});
```

Use **`onSourceEvent`** for per-source failover/error; **`onFinish`** once when the consumer finishes.

---

## Cancellation

| Source type      | When to use with mux                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `ReadableStream` | Race/fallback on **`fetch().body`** — hard cancel on losers            |
| `AsyncIterable`  | OK for tests; soft cancel — see [compatibility.md](./compatibility.md) |

Pass a shared **`AbortSignal`** to mux **`CommonOptions`** to abort all strategies consistently.

---

## Framework notes

| Runtime            | Notes                                                                |
| ------------------ | -------------------------------------------------------------------- |
| Node 22+           | `fetch` Response bodies are `ReadableStream` — ideal for hard cancel |
| Cloudflare Workers | Web Streams native; use `ReadableStream` sources for race/fallback   |
| Deno / Bun         | Same Web Streams surface; no `node:stream` in mux `src/`             |

See [compatibility.md](./compatibility.md).

---

## Related

- [Examples](../examples/README.md)
- [Usage guides](./usage-guides.md)
- [Edge-case matrix](./edge-cases.md)
- [llm-stream-assemble integration cookbook](https://github.com/01laky/llm-stream-assemble/blob/main/docs/integration-cookbook.md)
- [Comparison](./comparison.md)
