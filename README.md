# llm-stream-mux

![version](https://img.shields.io/badge/version-0.4.0-lightgrey)
![node](https://img.shields.io/badge/node-%3E%3D18-339933)
![runtime deps](https://img.shields.io/badge/runtime_deps-0-brightgreen)
![status](https://img.shields.io/badge/status-P4_fallback-orange)
[![ci](https://github.com/01laky/llm-stream-mux/actions/workflows/ci.yml/badge.svg)](https://github.com/01laky/llm-stream-mux/actions/workflows/ci.yml)

**Race, fallback, merge, and tee over any stream** — generic over `T`, zero runtime dependencies, Web Streams throughout.

> A standalone TypeScript stream-orchestration layer for LLM pipelines: coordinate multiple `AsyncIterable<T>` or `ReadableStream<T>` sources with race, fallback, ensemble/merge, and bounded tee — raw bytes or parsed events, with no baked-in event model.

Orchestrate streams — **not another hand-rolled `Promise.race` on fetch**.

**Status:** `0.4.0` — P0+P1+P2+P3+P4: core internals, interop helpers, **`tee`**, **`race`**, and **`fallback`**. `merge` lands in P5. Spec: [`docs/proposal.MD`](./docs/proposal.MD).

---

## Contents

- [Positioning](#positioning)
- [Why not hand-roll?](#why-not-hand-roll)
- [Edge-case showcase](#edge-case-showcase)
- [Why use this](#why-use-this)
- [Install](#install)
- [Quickstart](#quickstart)
- [Architecture](#architecture)
- [Strategies at a glance](#strategies-at-a-glance)
- [Documentation](#documentation)
- [Examples](#examples)
- [Non-goals](#non-goals)
- [Development](#development)

---

## Positioning

`llm-stream-mux` is the **N↔1 orchestration layer** only: race, fallback, merge, and tee over streams you already opened. You keep your HTTP client, auth, parsing ([`llm-stream-assemble`](https://github.com/01laky/llm-stream-assemble)), security filters, and UI.

![Ecosystem: assemble · guard · mux](https://raw.githubusercontent.com/01laky/llm-stream-mux/main/docs/img/ecosystem.svg)

| Library                                                                | Shape | Responsibility                                        |
| ---------------------------------------------------------------------- | ----- | ----------------------------------------------------- |
| [`llm-stream-assemble`](https://github.com/01laky/llm-stream-assemble) | 1→1   | Parse one provider stream → typed events (**format**) |
| `llm-stream-guard`                                                     | 1→1   | Redact / tool policy (**safety**)                     |
| **`llm-stream-mux`**                                                   | N↔1   | Race, fallback, merge, tee (**orchestration**)        |

No npm coupling between the three — compose in userland ([cookbook](./docs/integration-cookbook.md)).

---

## Why not hand-roll?

Multi-stream coordination fails in production for predictable reasons:

- **`Promise.race` on fetch** does not cancel losing HTTP bodies or buffer pre-usable frames.
- **Native `ReadableStream.tee()`** grows memory without bound when one branch is slow.
- **Failover after partial output** splices two responses unless you define a commit point.
- **Naïve merge loops** drop settled reads when using `Promise.race` on pending iterators.

Concrete contracts and test IDs: [docs/edge-cases.md](./docs/edge-cases.md).

---

## Edge-case showcase

Three orchestration footguns mux addresses by design:

![Strategies overview](https://raw.githubusercontent.com/01laky/llm-stream-mux/main/docs/img/strategies-overview.svg)

- **Unbounded `tee()`** → mux `tee` with `block` / `bounded` / `drop`.
- **Junk-first race winner** → `isUsable` + ordered pre-usable buffer flush.
- **Merge read loss** → one pending read per source; re-arm after consume.

Walkthrough: [docs/edge-cases.md](./docs/edge-cases.md).

---

## Why use this

- **Zero runtime dependencies**.
- **Generic over `T`** — `Uint8Array` byte mode or any parsed event type.
- **Four strategies** with semantic hooks (`isError`, `isUsable`, `isFinal`, `mapEach`).
- **Observable** — `onSourceEvent`, `MuxResult`, stable `MuxError` codes.
- **Runtime-agnostic** — Node 18+, Bun, Deno, Cloudflare Workers (Web Streams only).

---

## Install

```bash
pnpm add llm-stream-mux
# npm publish planned at 1.0.0 — implementation in progress
```

**Requirements:** Node.js 18+ · see [compatibility matrix](./docs/compatibility.md).

---

## Quickstart

### Byte mode — race two provider bodies

```ts
import { race } from "llm-stream-mux";

const winner = race<Uint8Array>([resA.body!, resB.body!], { signal, timeoutMs: 5000 });

for await (const chunk of winner) {
	// first usable stream wins; losers cancelled
}
```

### Event mode — merge tagged outputs

```ts
import { merge } from "llm-stream-mux";

for await (const tagged of merge<MyEvent>(
	{ gpt: streamA, claude: streamB },
	{
		isError: (e) => e.type === "error",
		onSourceEvent: (s) => log(s),
	},
)) {
	if (tagged.kind === "value") render(tagged.source, tagged.value);
}
```

Strategy picker: [docs/usage-guides.md](./docs/usage-guides.md) · [quick-decision diagram](./docs/img/quick-decision.svg).

---

## Architecture

![End-to-end pipeline](https://raw.githubusercontent.com/01laky/llm-stream-mux/main/docs/img/pipeline.svg)

- Diagram index: [docs/img/README.md](./docs/img/README.md)
- Public API types (P0): [public-api-types.svg](./docs/img/public-api-types.svg)
- Ecosystem stack: [ecosystem.svg](./docs/img/ecosystem.svg)
- Byte vs event placement: [byte-event-modes.svg](./docs/img/byte-event-modes.svg)
- Merge `Tagged<T>` flow: [merge-tagged.svg](./docs/img/merge-tagged.svg)
- Strategy decision tree: [quick-decision.svg](./docs/img/quick-decision.svg)

---

## Strategies at a glance

| Function             | Shape | Use when                                        |
| -------------------- | ----- | ----------------------------------------------- |
| `race(sources)`      | N→1   | Fastest usable stream wins; cancel losers       |
| `fallback(sources)`  | N→1   | Primary → backup; lazy thunks for true failover |
| `merge` / `ensemble` | N→1   | Parallel models; `Tagged<T>` per source         |
| `tee(source, n)`     | 1→N   | Fan-out with bounded backpressure               |

Helpers: `collect`, `toReadable`, `toAsyncIterable`.

Full API: [proposal §9](./docs/proposal.MD#9-public-api-final-shape).

---

## Documentation

- [Proposal & roadmap](./docs/proposal.MD) — normative spec + P0–P8
- [Usage guides](./docs/usage-guides.md) — per-strategy recipes
- [Integration cookbook](./docs/integration-cookbook.md) — pair with assemble/guard (docs only)
- [Edge-case contracts](./docs/edge-cases.md)
- [Runtime compatibility](./docs/compatibility.md)
- [Comparison matrix](./docs/comparison.md)
- [Testing strategy](./docs/testing-strategy.md)
- [FAQ](./docs/faq.md)
- [Performance notes](./docs/performance.md)

---

## Examples

Runnable samples (P8): [examples/README.md](./examples/README.md) — `race`, `fallback`, `merge`, `tee` with `node-fetch`.

For parsing examples see [`llm-stream-assemble/examples`](https://github.com/01laky/llm-stream-assemble/tree/main/examples).

---

## Non-goals

- No HTTP client, auth, or retry of the **same** request.
- No provider parsing ([assemble](https://github.com/01laky/llm-stream-assemble)).
- No content redaction / tool policy (guard).
- No UI, agent loop, or tool execution.

---

## Development

```bash
./scripts/setup-githooks.sh   # once per clone — strip AI co-author trailers
pnpm install
pnpm verify
```

CI runs `pnpm verify` on Node **18, 20, and 22**.

| Command                   | Description                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`             | portability + deps + lint + typecheck + build + test + smoke + docs + diagrams + format                                     |
| `pnpm build`              | tsup → ESM + CJS + declarations in `dist/`                                                                                  |
| `pnpm test`               | Vitest — `LSM-REL-*`, `LSM-TYP-*`, `LSM-CORE-*`, `LSM-TEE-*`, `LSM-RACE-*`, `LSM-FB-01`–`110`, `LSM-EDGE-P0-*`, `LSM-SRC-*` |
| `pnpm verify:portability` | forbid Node-only / ReadableStream.from patterns in `src/`                                                                   |
| `pnpm smoke:package`      | ESM/CJS import from `npm pack` tarball                                                                                      |
| `pnpm verify:deps`        | fail if runtime dependencies added                                                                                          |
| `pnpm diagrams:build`     | render `docs/img/*.mmd` → `.svg`                                                                                            |
| `pnpm diagrams:check`     | SVGs present and newer than `.mmd`                                                                                          |
| `pnpm release:prep`       | pre-tag checks when `dist/` exists                                                                                          |

---

## Author

**Ladislav Kostolny** — 01laky@gmail.com · GitHub [@01laky](https://github.com/01laky)

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 Ladislav Kostolny.
