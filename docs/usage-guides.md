# Usage guides

**Status:** P5 — **`merge`/`ensemble`** implemented in **`0.5.0`**; `race` and **`fallback`** in **`0.3.0`** / **`0.4.0`**. API frozen in [`proposal.MD`](./proposal.MD) §9.

Strategy-focused guides for `llm-stream-mux`. For ecosystem pairing with [`llm-stream-assemble`](https://github.com/01laky/llm-stream-assemble) and guard, see [integration-cookbook](./integration-cookbook.md).

---

## Core concepts

- **Generic over `T`** — mux never defines an LLM event model. `T` can be `Uint8Array`, your parsed events, or anything else.
- **Lazy start** — sources (and lazy thunks) begin only when the consumer starts iterating.
- **Web Streams internally** — strategies return `AsyncIterable`; `tee` returns `ReadableStream[]`. Use `toReadable` / `toAsyncIterable` at boundaries.

Hooks (all optional): `isError`, `isUsable`, `isFinal`, `mapEach` — evaluated on raw `T` before `mapEach`. See proposal §5.

---

## race

Start N sources; forward the **first usable** stream; cancel losers. **Implemented in `0.3.0`.**

```ts
import { race } from "llm-stream-mux";

const winner = race<Uint8Array>([resA.body!, resB.body!], {
	signal,
	timeoutMs: 5000,
	isUsable: (chunk) => chunk.byteLength > 0,
});

for await (const chunk of winner) {
	// first provider to emit usable bytes wins; losers aborted
}
```

**When to use:** latency competition between providers or regions. **Not** failover — use `fallback` if you need the next source after failure.

See [edge-cases](./edge-cases.md#race) and proposal §7.3.

---

## fallback

Try sources in **priority order**. Lazy thunks `() => source` start the next source only when the active one fails. **Implemented in `0.4.0`.**

```ts
import { fallback } from "llm-stream-mux";

const out = fallback<MyEvent>([() => primary(), () => backup()], {
	policy: "commit",
	isError: (e) => e.type === "error",
	isUsable: (e) => e.type === "text.delta",
	timeoutMs: 8000,
});
```

**FailoverPolicy:** `commit` (default), `buffered`, `post-emit` — see proposal §7.2.

---

## merge / ensemble

Run sources **concurrently**; output is `Tagged<T>` with `kind: "value" | "error" | "done"`. **Implemented in `0.5.0`.**

```ts
import { merge } from "llm-stream-mux";

for await (const tagged of merge<MyEvent>(
	{ gpt: streamA, claude: streamB },
	{
		isError: (e) => e.type === "error",
		onSourceEvent: (e) => log(e),
	},
)) {
	if (tagged.kind === "value") render(tagged.source, tagged.value);
}
```

Options: `failFast`, `order: "arrival" | "round-robin"`, `concurrency`. Diagram: [merge-tagged.svg](./img/merge-tagged.svg).

---

## tee

Split **one** stream into N independent consumers with bounded backpressure (unlike native `ReadableStream.tee()`). **Implemented in `0.2.0`.**

```ts
import { tee } from "llm-stream-mux";

const [toClient, toLogger] = tee(source, 2, {
	backpressure: "bounded",
	bufferLimit: 64,
});
```

Policies: `block` (default), `bounded` (overflow → error branch), `drop` (drop-oldest on lagging branch).

---

## Interop helpers

```ts
import { collect, toReadable, toAsyncIterable } from "llm-stream-mux";

const all = await collect(race([a, b]));
const rs = toReadable(fallback([() => primary()]));
for await (const x of toAsyncIterable(rs)) {
	/* ... */
}
```

---

## Telemetry

- **`onSourceEvent`** — out-of-band lifecycle (`start`, `usable`, `final`, `done`, `error`, `failover`, `cancelled`, `timeout`).
- **`onFinish`** — final `MuxResult` summary after the output stream settles.

Works identically in byte mode and event mode.

---

## Further reading

- [Quick decision diagram](./img/quick-decision.svg)
- [Byte vs event modes](./img/byte-event-modes.svg)
- [Proposal §9 API](./proposal.MD#9-public-api-final-shape)
