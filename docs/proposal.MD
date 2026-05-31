# llm-stream-mux — Proposal & Implementation Roadmap

> **Status:** Design locked, ready to implement. No code yet.
> **Audience:** This document is written so that **another AI/engineer can implement the library
> end-to-end without further clarification.** It is both the design spec (Part A) and a phased,
> testable build plan (Part B).
> **Author:** Ladislav Kostolny — 01laky@gmail.com · GitHub @01laky
> **License (intended):** MIT

---

## 0. How to use this document (read first, implementer)

- **Part A (§1–§14)** is the normative spec. Treat every "MUST / MUST NOT" as binding.
- **Part B (§15–§24)** is the build roadmap: phases `P0`–`P8`, each with concrete tasks, file
  paths, test IDs, and acceptance criteria. Implement phases **in order**. Do not start a phase
  until the previous phase's acceptance criteria pass.
- **Hard constraints (never violate):**
  1. **Zero runtime dependencies.** `package.json` `dependencies` MUST stay empty. Dev-deps only.
  2. **No imports from `llm-stream-assemble` or `llm-stream-guard`** (no deps, no peer deps, no
     type imports). Any pairing lives only in cookbook docs.
  3. **Generic over `T`.** mux MUST NOT define or assume any LLM event model. The only types it
     introduces are in §6.
  4. **Runtime-agnostic via Web Streams.** Must run on Node 18+, Bun, Deno, Cloudflare Workers.
     No Node-only APIs (`stream`, `events`, `Buffer`) in `src/`. Use `globalThis` Web Streams,
     `AbortController`, `TextEncoder/Decoder`.
  5. **Web Streams portability trap:** do NOT rely on `ReadableStream[Symbol.asyncIterator]` — it
     exists on Node 18+ but NOT in browsers, Deno, or Cloudflare Workers. Always consume a
     `ReadableStream` via `getReader()` (centralize this in `internal/source.ts` /
     `internal/interop.ts`). Required globals: `ReadableStream`, `WritableStream`,
     `TransformStream`, `AbortController`, `AbortSignal.timeout` (Node ≥ 17.3 / all target runtimes),
     `CountQueuingStrategy`. Do not import from `node:stream/web`.
- **When in doubt**, prefer the simpler, more standard Web Streams behavior and write a test that
  pins the decision. Record any new decision in §13 (Decisions log).

---

# PART A — Specification

## 1. Positioning

`llm-stream-mux` is a standalone, zero-dependency TypeScript library that **coordinates multiple
LLM/data streams**. It is the **"N→1 and 1→N" layer**: race, fallback, ensemble/merge, and
tee/fan-out over streams.

It is **NOT a parser** and **NOT a security filter** — it only **orchestrates** streams handed to it.

One-line pitch:

> A standalone, zero-dependency TypeScript stream-orchestration layer for LLM pipelines:
> race, fallback, ensemble/merge, and tee/fan-out over any `AsyncIterable<T>` or `ReadableStream<T>`
> — generic over `T`, with no baked-in event model. Works on raw bytes or parsed events, from any
> provider, with zero coupling to any parser or filter.

## 2. Ecosystem context (intent only — NOT a dependency)

| Library                 | Shape | Responsibility                                                                                                                                                   |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm-stream-assemble`   | 1→1   | Parse ONE raw provider stream (bytes/SSE) into a unified typed event stream. About **FORMAT**.                                                                   |
| `llm-stream-guard`      | 1→1   | Security filter: redact secrets/PII, tool allow/deny, sanitize errors. Own event model; works with any parser; no hard dependency on assemble. About **SAFETY**. |
| `llm-stream-mux` (this) | N↔1   | Coordinate multiple streams: race, fallback, ensemble/merge, tee. About **ORCHESTRATION**.                                                                       |

### Shared DNA (all three must follow)

- Zero RUNTIME dependencies.
- Standalone npm package, ZERO coupling to assemble/guard (no imports, no peer deps). Combination
  only in userland/cookbook docs.
- Runtime-agnostic via Web Streams (Node 18+, Bun, Deno, Cloudflare Workers).
- One sharp responsibility, composable, TypeScript-first.

## 3. Core insight (the key design decision)

> **mux is GENERIC OVER `T` and MUST NOT define or assume any event model.**

- Operates on `AsyncIterable<T>` and/or `ReadableStream<T>` where `T` is anything: raw bytes
  (**byte mode**), assemble `StreamEvent`s, guard `GuardEvent`s, or plain strings (**event mode**).
  One generic design covers byte mode AND event mode for free, with zero imports.
- mux defines only the tiny OWN types in §6. Nothing imported from other libraries.

This is the single most important constraint. Every API decision preserves it.

## 4. Strategies (the public surface)

1. **race** — start N streams; forward the FIRST usable one; cancel/abort the losers.
2. **fallback / failover** — try sources in priority order; on error (transport OR in-band) fail
   over to the next; commit-point policy governs post-emission failover (§7.2).
3. **merge / ensemble** — run N streams concurrently, merge into ONE output, tagging each item with
   its source (`Tagged<T>`); report per-source lifecycle.
4. **tee / fan-out (1→N)** — split one stream into N independent consumers with bounded buffering.

## 5. Semantic hooks (staying generic without an event model)

Optional predicates injected by the user (mirroring how guard accepts a mapper). Defaults work
purely at stream level (ended / threw):

| Hook       | Signature                        | Purpose                                                      | Default                      |
| ---------- | -------------------------------- | ------------------------------------------------------------ | ---------------------------- |
| `isError`  | `(item: T) => boolean`           | Detect IN-BAND error frames. Transport errors auto-detected. | Only transport errors count. |
| `isUsable` | `(item: T) => boolean`           | "first usable" for race; commit gate for fallback.           | First emitted item.          |
| `isFinal`  | `(item: T) => boolean`           | Logical completion signal.                                   | Underlying stream end.       |
| `mapEach`  | `(item: T, source: string) => U` | Per-source transform applied before output/merge (T→U).      | Identity.                    |

**Where each hook takes effect:**

- `isError` — `fallback`: triggers failover (subject to §7.2). `merge`: surfaced as `Tagged`
  `kind:"error"` for that source (source may continue unless it also ends). `race`: disqualifies
  that candidate.
- `isUsable` — `race`: gates the "first usable" winner (§7.3). `fallback`: gates the commit point —
  output buffered until the first usable item, so a junk-only source can still fail over (§7.2).
  Ignored by `merge`.
- `isFinal` — marks a source's **logical** completion even if the underlying stream stays open.
  `fallback`: a final item = success → no further failover. `merge`: triggers the source's
  `kind:"done"` tag and stops pulling it. `race`: treated as "usable + complete".
- `mapEach` — pure, **synchronous-only** transform run on each forwarded item (D9). MUST NOT
  throw for control flow; throwing is treated as a `SOURCE_ERROR` for that source. Lets users
  normalize/relabel without chaining another transform. Async transforms belong in userland
  composition (`TransformStream`, a manual loop). (`U` defaults to `T` when omitted.)

**Evaluation order (binding):** the predicates `isError` / `isUsable` / `isFinal` are evaluated on
the **raw `T`** item, BEFORE `mapEach`. `mapEach` is applied only to items that are actually
forwarded to the output (i.e. after a source has won / committed and the item passed any gating).
So: receive `T` → run predicates on `T` → if forwarded, `mapEach(T) → U` → emit `U`. `mapEach`
never runs on items that are buffered-then-discarded (e.g. losing race candidates, discarded
`buffered`-policy buffers).

These are **opt-in**; without them mux uses stream-level signals only.

## 6. Own types (core data types mux introduces)

mux introduces only the data types below; the only other types are the options interfaces in §9.
Nothing is imported from any other library.

### 6.1 `Source<T>`

```text
Source<T> =
  | ReadableStream<T>
  | AsyncIterable<T>
  | (() => ReadableStream<T> | AsyncIterable<T>)   // lazy / deferred form
```

- **Eager forms** are already-started streams.
- **Lazy form** (thunk) is invoked only when the strategy needs the source — the mechanism that
  makes `fallback` a true failover (see §7.1).

Sources may be supplied **positionally** (array → ids `"0"`, `"1"`, …) or **labeled**
(`Record<string, Source<T>>` or `Array<{ id: string; source: Source<T> }>`). Labels matter most for
`merge`/`Tagged<T>`.

### 6.2 `Tagged<T>`

```text
Tagged<T> = { source: string } & (
    | { kind: "value"; value: T }
    | { kind: "error"; error: MuxError }
    | { kind: "done" }
)
```

Because `T` is generic, mux **cannot synthesize an "error item of type `T`"**. So per-source errors
and lifecycle in `merge` are carried **in-band** via this wrapper — readable directly in a
`for await` loop — while staying fully generic.

### 6.3 `MuxError`

```text
MuxError = Error & {
  code:
    | "SOURCE_ERROR"        // a source threw a transport/runtime error
    | "IN_BAND_ERROR"       // isError(item) matched
    | "ALL_FAILED"          // every source failed (fallback / merge failFast)
    | "ABORTED"             // options.signal aborted, or a timeout fired
    | "TIMEOUT"             // a per-source or overall deadline elapsed
    | "NO_USABLE_SOURCE";   // race: all sources ended without a usable item
  source?: string;          // which source (when applicable)
  cause?: unknown;          // original error (native ES2022 Error.cause)
  errors?: MuxError[];      // aggregate: populated for ALL_FAILED (one per source)
}
```

Stable, enumerated codes for SIEM/telemetry — same spirit as guard's frozen rule IDs.
`ALL_FAILED` MUST populate `errors[]` with one `MuxError` per failed source (AggregateError-style);
`cause` then references the same array's first entry for convenience.

### 6.4 `SourceEvent` — out-of-band lifecycle / telemetry

```text
SourceEvent = {
  source: string;
  type: "start" | "usable" | "final" | "done" | "error" | "failover" | "cancelled" | "timeout";
  timestamp: number;        // Date.now() at emit
  error?: MuxError;
}
```

Delivered only via the `onSourceEvent` callback (never in-band), so it works identically in byte
and event mode without polluting the `T` stream. This is mux's single observability surface
(replacing any guard-style `block | warn | audit` mode — see D3).

### 6.5 `MuxResult` — final summary (for `onFinish`)

```text
MuxResult = {
  strategy: "race" | "fallback" | "merge" | "tee";
  winner?: string;                 // race/fallback: the source that produced output
  perSource: Record<string, {
    items: number;                 // count forwarded from this source
    started: boolean;
    completed: boolean;
    errored?: MuxError;
    startedAt?: number;
    endedAt?: number;
  }>;
  aborted: boolean;
  startedAt: number;
  endedAt: number;
}
```

Delivered once, after the output stream settles, via the optional `onFinish` callback. Parity with
guard's `onFinish` stream summaries.

### 6.6 Strategy / policy enums

- `FailoverPolicy = "commit" | "buffered" | "post-emit"` (see §7.2).
- `TeeBackpressure = "block" | "bounded" | "drop"` (see §8).
- `MergeOrder = "arrival" | "round-robin"` (see §7.4).

## 7. Error, cancellation & backpressure semantics

### 7.1 fallback: eager vs lazy (D1, locked)

`fallback` accepts **both forms** — lazy thunks (`() => Source<T>`) and eager streams. With lazy
thunks, source _N+1_ starts only when source _N_ fails (true cost-saving failover). With eager
streams it still works but loses the cost-saving property. The non-goal is reworded:

> No automatic retry of the **same** source. Starting the **next, distinct** source is the entire
> point of fallback and is allowed.

`race` and `merge` accept eager sources (they all run anyway). For `fallback`, the lazy form is
**recommended**.

### 7.2 fallback: the "commit point" model (D2, locked)

You cannot "un-send" already-yielded items, so the real decision is **whether mux buffers before
flushing**, expressed as `FailoverPolicy`:

| Policy                   | Behavior                                                                                                                                                                                                                                                 | Trade-off                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `"commit"` **(default)** | Failover automatic **only before the commit point**. Commit point = first forwarded item; if `isUsable` given, items buffer until the first usable one and _that_ is the commit point. After commit, a later error **propagates** — mux does not splice. | Streams immediately; clean; consistent with `race`.                       |
| `"buffered"`             | Hold all output until the source completes/commits, then flush. On failover, discard the failed buffer and start the next clean.                                                                                                                         | Perfectly clean failover, but kills streaming (latency = full response).  |
| `"post-emit"`            | Stream eagerly; on a post-commit failure switch to the next source and emit an **out-of-band** `failover` `SourceEvent` so the UI can reset.                                                                                                             | Real streaming + resilience, consumer must handle a reset. Never in-band. |

### 7.3 race semantics

- Default winner = first source to yield its first item. With `isUsable`, first whose item passes.
- Items emitted **before** the `isUsable` trigger are **buffered and flushed in order** once the
  source wins — no data loss.
- On a win, **all losers are cancelled** (§7.5).
- A source that ends without a (usable) item does **not** win. If **all** end without one →
  `MuxError{ code:"NO_USABLE_SOURCE" }`.
- race **commits**: if the winner later errors, that error propagates. race is not fallback.

### 7.4 merge / ensemble semantics

- One source failing **MUST NOT** kill others.
- Failures/lifecycle surfaced **in-band** as `Tagged` (`kind:"error"` / `"done"`) and out-of-band
  via `onSourceEvent`.
- Merged stream completes when **all** sources have ended (success or failure).
- `failFast?: boolean` (default `false`): when `true`, merged stream errors out (`ALL_FAILED` or
  first error) instead of degrading gracefully.
- `order?: MergeOrder` (default `"arrival"`): `arrival` forwards items as they settle
  (non-deterministic across sources); `round-robin` pulls one ready item per source in rotation
  for fairness/determinism. `round-robin` is primarily for testability and fairness, not strict
  ordering of unready sources. **Buffering:** `round-robin` uses the same backpressure model as
  `arrival` — §7.7 output `highWaterMark` / `sourceHighWaterMark` plus at most one pending read
  per active source in the merge loop (D8). No separate per-source buffer for `round-robin`.
- `concurrency?: number` (default = all): start at most `k` sources at once; queue the rest and
  start the next when one ends. Useful for large N ensembles.

### 7.5 Cancellation (no leaks)

- `options.signal?: AbortSignal` aborts the whole operation → `ABORTED`.
- Internally, race/fallback hold an `AbortController` to cancel sources no longer needed.
- **Cancellation honesty (document prominently):**
  - `ReadableStream`: `reader.cancel(reason)` → `underlyingSource.cancel()`; for a `fetch` body this
    **aborts the HTTP request**. True hard-cancel.
  - `AsyncIterable`: mux can only call `iterator.return()`, running the generator's `finally` but
    **not guaranteeing** underlying work stops unless the source cooperates. **Soft-cancel.**
- Recommendation surfaced to users: for guaranteed loser-cancellation supply `ReadableStream`
  sources. mux is built **internally on Web Streams**; `AsyncIterable` is adapted at the edge.
- `cancel()` / `return()` rejections are swallowed so they never mask the real result.
- **Cancel reason:** losers are cancelled with a reason object
  `{ name: "MuxCancelled", reason: "race-lost" | "failover" | "aborted" | "tee-all-cancelled" }`.

### 7.6 Timeouts / deadlines

- `timeoutMs?: number` (per-source, time-to-first-**usable**-item): if a source produces no usable
  item within the window it is treated as failed/disqualified (`TIMEOUT`). Applies to `race`
  (disqualify candidate) and `fallback` (trigger failover). Implemented via `AbortSignal.timeout`
  composed with the operation signal.
- `overallTimeoutMs?: number`: hard deadline for the whole operation → `ABORTED` with a
  `TIMEOUT`-coded cause if exceeded.
- Timeouts emit a `timeout` `SourceEvent`.

### 7.7 Backpressure & queuing

- Backpressure MUST be respected across **all** sources.
- `merge`: a single output `ReadableStream` with a queuing strategy; pull from sources only while
  output `desiredSize > 0`. When the consumer is slow, pause pulling from **all** sources.
- Implementation note (merge): keep one pending read promise per source, `Promise.race` them; on
  output backpressure await the writer becoming ready before resuming — without losing an
  already-settled read.
- `highWaterMark?: number` (default `1`): configurable output queuing strategy
  (`CountQueuingStrategy`). Optional per-source HWM via `sourceHighWaterMark?: number`.
- `tee`: see §8.

## 8. tee / fan-out — value over native `ReadableStream.tee()`

Native `tee()` footgun: if one branch reads slowly, chunks buffer **unboundedly** for it while the
other races ahead → memory growth. mux's `tee` adds:

- **N-way** split (not just 2-way).
- **Per-consumer backpressure policy** `TeeBackpressure`:
  - `block` (default): slowest consumer applies backpressure to the source.
  - `bounded`: per-branch buffer capped at `bufferLimit`; on overflow → error the lagging branch
    with `MuxError{ code:"SOURCE_ERROR" }` (decided: **error**, not silent drop, for `bounded`).
  - `drop`: never block the source; for a lagging branch **drop oldest** queued item (decided:
    drop-oldest, so the slow consumer still gets the freshest data).
- **Independent cancellation:** cancelling one branch does NOT cancel the source until **all**
  branches are cancelled (then source is cancelled with reason `tee-all-cancelled`).
- Works on `AsyncIterable` sources too (adapted to Web Streams internally).

## 9. Public API (final shape)

```ts
// race / fallback return AsyncIterable<U>; merge returns AsyncIterable<Tagged<U>>;
// tee returns an array of ReadableStream. All built internally on Web Streams.
// U defaults to T (mapEach can change it).

function race<T, U = T>(sources: Sources<T>, opts?: RaceOptions<T, U>): AsyncIterable<U>;
function fallback<T, U = T>(sources: Sources<T>, opts?: FallbackOptions<T, U>): AsyncIterable<U>;
function merge<T, U = T>(sources: Sources<T>, opts?: MergeOptions<T, U>): AsyncIterable<Tagged<U>>;
function tee<T>(source: Source<T>, n: number, opts?: TeeOptions): ReadableStream<T>[];

// ensemble is an exported alias of merge (D4).
const ensemble = merge;

// Interop helpers (zero-dep, ergonomic). Symmetric pair only (D10).
function collect<T>(it: AsyncIterable<T>): Promise<T[]>;
function toReadable<T>(it: AsyncIterable<T>): ReadableStream<T>;
function toAsyncIterable<T>(rs: ReadableStream<T>): AsyncIterable<T>;

type Sources<T> =
	| Source<T>[]
	| Record<string, Source<T>>
	| Array<{ id: string; source: Source<T> }>;

interface CommonOptions<T, U = T> {
	signal?: AbortSignal;
	isError?: (item: T) => boolean;
	isFinal?: (item: T) => boolean;
	mapEach?: (item: T, source: string) => U;
	onSourceEvent?: (e: SourceEvent) => void; // out-of-band telemetry
	onFinish?: (result: MuxResult) => void; // final summary
	timeoutMs?: number; // per-source TTF-usable
	overallTimeoutMs?: number; // whole-operation deadline
	highWaterMark?: number; // output queuing strategy (default 1)
	sourceHighWaterMark?: number; // per-source queuing strategy
}

interface RaceOptions<T, U = T> extends CommonOptions<T, U> {
	isUsable?: (item: T) => boolean;
}

interface FallbackOptions<T, U = T> extends CommonOptions<T, U> {
	policy?: FailoverPolicy; // default "commit"
	isUsable?: (item: T) => boolean; // gates commit point (§7.2)
}

interface MergeOptions<T, U = T> extends CommonOptions<T, U> {
	failFast?: boolean; // default false
	order?: MergeOrder; // default "arrival"
	concurrency?: number; // default = all sources
}

interface TeeOptions {
	backpressure?: TeeBackpressure; // default "block"
	bufferLimit?: number; // for "bounded" / "drop"
}
```

**Execution timing (binding).** `race` / `fallback` / `merge` return a **lazy** `AsyncIterable`:
sources are NOT started (and lazy thunks NOT invoked) until the consumer begins iterating
(first `for await` / `.next()`). All timers (`timeoutMs`, `overallTimeoutMs`) start at that moment,
not at the call site. `tee` is also lazy: the source is not pulled until at least one branch is
read. Rationale: predictable resource usage and no work for an iterable that is never consumed.

## 10. Usage examples (both modes, no imports from assemble/guard)

### 10.1 Byte mode (`T = Uint8Array`) — race two raw provider bodies

```ts
import { race } from "llm-stream-mux";

const winner = race<Uint8Array>([resA.body!, resB.body!], { signal, timeoutMs: 5000 });

return new Response(
	new ReadableStream<Uint8Array>({
		async start(controller) {
			for await (const chunk of winner) controller.enqueue(chunk);
			controller.close();
		},
	}),
	{ headers: { "Content-Type": "text/event-stream" } },
);
```

### 10.2 Event mode — merge two parsed model outputs

```ts
import { merge } from "llm-stream-mux";

for await (const tagged of merge<MyEvent>(
	{ gpt: modelA, claude: modelB },
	{
		isError: (e) => e.type === "error",
		onSourceEvent: (s) => log(s),
		onFinish: (r) => metrics(r),
	},
)) {
	if (tagged.kind === "value") render(tagged.source, tagged.value);
	else if (tagged.kind === "error") flag(tagged.source, tagged.error);
	else markDone(tagged.source);
}
```

### 10.3 Event mode — fallback (lazy) primary → backup

```ts
import { fallback } from "llm-stream-mux";

const out = fallback<MyEvent>([() => primaryModel(), () => backupModel()], {
	policy: "commit",
	isError: (e) => e.type === "error",
	timeoutMs: 8000,
});
for await (const ev of out) handle(ev);
```

## 11. Where mux sits in a pipeline

mux is **layer-agnostic**:

- **Before parsing (byte mode):** race/fallback raw provider bodies, hand the winner to `assemble`.
- **After parsing (event mode):** `assemble` each source, then `merge` typed events with tags.

This dual placement is a key differentiator vs. a generic async-iterator utility.

## 12. Non-goals

- No HTTP client, auth, or retries that **re-issue the same request** (mux is handed
  already-created streams; lazy thunks start the **next** source, allowed).
- No parsing/format knowledge of any provider (assemble's job).
- No content redaction/security policy (guard's job).
- No UI components, agent loop, or tool execution.
- No hard dependency on assemble, guard, AI SDK, or LangChain.

## 13. Decisions log (locked)

- **D1 — fallback accepts BOTH forms** (lazy recommended, eager supported). §7.1.
- **D2 — `FailoverPolicy` default `"commit"`.** §7.2.
- **D3 — Drop guard's `block | warn | audit`.** Observability via `onSourceEvent` only; no `mode`.
- **D4 — `merge` is canonical; `ensemble` is an exported alias.** §9.
- **D5 — `tee` `bounded` overflow = error; `drop` = drop-oldest.** §8.
- **D6 — `ALL_FAILED` aggregates `errors[]` (AggregateError-style).** §6.3.
- **D7 — `merge.order` default `"arrival"`; `round-robin` opt-in for fairness/determinism.** §7.4.
- **D8 — `round-robin` merge: no extra per-source buffering.** Same §7.7 HWM + one pending read
  per active source as `arrival`. Round-robin changes _selection order_, not backpressure.
- **D9 — `mapEach` is sync-only, permanently.** Async transforms stay in userland; keeps merge
  ordering, race/fallback commit timing, and error semantics predictable.
- **D10 — Interop naming: `toReadable` + `toAsyncIterable` only.** Symmetric pair; no
  `fromAsyncIterable` alias (one name per direction for a clean 1.0.0 API freeze).
- **D11 — P7 no-leak audit ID.** Proposal §23 `LSM-REL-02` no-leak remapped to **`LSM-REL-09`**
  - **`LSM-EDGE-46`–`50`**; **`LSM-REL-02`** reserved for public export contract in
    `test/types-contract.test.ts`.
- **D12 — Tee §23 “signal aborted” cell.** No **`TeeOptions.signal`**; operational equivalent =
  all-branch-cancel-before-read + lazy source never opened (**`LSM-EDGE-23`**).
- **D13 — P8 ships as `0.8.0`; `1.0.0` = publish + API freeze.** P8 scope (§24) lands at
  **`0.8.0`**. **`1.0.0`** is tagged only when §25 Definition of done is audited and §9/§6.3
  are explicitly frozen for npm publish.
- **D14 — P9 ships as `0.9.0`; `1.0.0` = publish + freeze only.** P9 scope is §25 audit
  automation (`LSM-REL-11a`–`11q`), multi-runtime smoke (Bun/Deno), consumer smoke (ESM+CJS),
  Workers fixture, `SECURITY.md`, `docs/RELEASE.md`, `pnpm verify:pre1`, and **`docs/STABILITY.md`**
  (incl. npm provenance checklist). No new public API. **`1.0.0`** is tagged when the maintainer publishes
  to npm and declares §9/§6.3 frozen under semver.
- **D15 — `1.0.0` = publish + freeze + §H max gate.** Beyond npm/tag/freeze, P10 adds
  `LSM-EDGE-140`–`180`, `LSM-REL-12a`–`12u`, full doc cross-ref + anchor audit, expanded diagram
  suite, post-publish tarball smoke (cross-runtime), npm pack audit, bench-smoke baseline gate, semver
  policy pins, and publish rollback runbook. No new public API vs `0.9.0`.

## 14. Open questions

All resolved — see **D8–D10** in §13.

---

# PART B — Implementation Roadmap

> Build phases `P0`–`P8` in order. Each phase lists **tasks**, **files**, **test IDs**, and
> **acceptance criteria (AC)**. A phase is "done" only when its AC pass under `pnpm verify`.

## 15. Conventions

- **Language/build:** TypeScript (strict), ESM + CJS + d.ts via `tsup`. Target ES2022.
- **Tests:** Vitest. Test ID scheme: `LSM-<AREA>-NN`, areas:
  `CORE` (internals/interop), `RACE`, `FB` (fallback), `MERGE`, `TEE`, `X` (cross-cutting:
  timeouts/concurrency/telemetry/summary/mapEach), `EDGE` (edge cases), `REL` (release/contract).
  Put the ID in the test title, e.g. `it("LSM-RACE-03 cancels losers on win", …)`.
- **No runtime deps.** `pnpm verify:deps` MUST fail if `dependencies` is non-empty.
- **File layout:**

```
src/
  index.ts            // public exports only
  types.ts            // Source, Tagged, MuxError, SourceEvent, MuxResult, enums, options
  errors.ts           // muxError() factory + code constants
  internal/
    source.ts         // normalize Source<T> -> { iterator/reader, cancel(reason) }
    abort.ts          // combineSignals(), timeoutSignal(), MuxCancelled reason
    interop.ts        // collect, toReadable, toAsyncIterable
    telemetry.ts      // emit SourceEvent + accumulate MuxResult
    queue.ts          // output queuing strategy helpers
  race.ts
  fallback.ts
  merge.ts
  tee.ts
test/
  core.test.ts  race.test.ts  fallback.test.ts  merge.test.ts  tee.test.ts
  cross.test.ts  edge.test.ts  helpers/streams.ts  (fixtures/fakes)
docs/
  proposal.MD  edge-cases.md  integration-cookbook.md  (P8)
examples/
  node-fetch/  (P8)
```

- **Test helpers (`test/helpers/streams.ts`):** factories for fake sources —
  `fromArray<T>(items, { delayMs?, throwAt?, neverEnd? })` returning both a `ReadableStream<T>` and
  an `AsyncIterable<T>` variant; a controllable clock isn't required (use real short delays), but
  prefer deterministic ordering tests via `round-robin` where possible.

## 16. P0 — Project scaffolding

**Tasks**

- `package.json`: name `llm-stream-mux`, `type: module`, empty `dependencies`, dev-deps:
  `typescript`, `tsup`, `vitest`, `eslint` + config, `prettier`. Scripts:
  `build` (tsup), `test` (vitest run), `typecheck` (tsc --noEmit), `lint`, `format`,
  `verify` (lint + typecheck + test + build), `verify:deps` (script asserting empty `dependencies`).
  - `engines`: `"node": ">=18"`.
  - `files`: `["dist"]` (publish `dist/` only; exclude `test/`, `examples/`, `docs/`).
  - Dual ESM/CJS `exports` map (tsup emits both), e.g.:

```jsonc
{
	"main": "./dist/index.cjs",
	"module": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"sideEffects": false,
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js",
			"require": "./dist/index.cjs",
		},
	},
}
```

- `tsconfig.json` (strict, ES2022, `lib: ["ES2022","DOM"]` for Web Streams types), `tsup.config.ts`
  (esm+cjs+dts), `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.gitignore`,
  `.editorconfig`, `LICENSE` (MIT), minimal `README.md` stub, `CHANGELOG.md` (Unreleased).
- `src/index.ts` empty placeholder export; `src/types.ts` with all types from §6 + options from §9.

**AC** — `LSM-REL-01`: `pnpm verify` runs (build emits ESM+CJS+d.ts); `pnpm verify:deps` passes
with empty deps; `types.ts` compiles and exports every §6/§9 type.

## 17. P1 — Core internals & interop

**Tasks**

- `internal/source.ts`: `normalizeSource(src, id)` → a uniform async reader with `next()`,
  `cancel(reason)`, and lazy-thunk invocation. Must handle all three `Source<T>` forms and adapt
  `AsyncIterable` ↔ `ReadableStream` internally. Cancel propagation per §7.5; swallow cancel errors.
- `internal/abort.ts`: `combineSignals(...signals)`, `timeoutSignal(ms)` (via `AbortSignal.timeout`),
  and the `MuxCancelled` reason object.
- `internal/interop.ts`: `collect`, `toReadable`, `toAsyncIterable` (D10 — no alias).
- `errors.ts`: `muxError(code, { source?, cause?, errors? })` factory; codes as const.
- `internal/telemetry.ts`: emitter wrapper around `onSourceEvent` + a `MuxResult` accumulator with
  `start/usable/final/done/error/cancelled/timeout` transitions and `finish()` → `onFinish`.

**Test IDs** `LSM-CORE-01..` — normalize each Source form; lazy thunk not invoked until `.next()`;
cancel propagates to ReadableStream (assert underlying cancel called) and calls `return()` on async
iterables; `collect`/`toReadable`/`toAsyncIterable` round-trip; `combineSignals` aborts when any
input aborts; telemetry accumulator produces a correct `MuxResult`.

**AC** — all `LSM-CORE-*` pass; no public API yet beyond interop helpers exported from `index.ts`.

## 18. P2 — tee (simplest strategy first)

**Tasks** — implement `tee<T>(source, n, opts)` per §8: N-way; `block`/`bounded`/`drop`
(drop-oldest) policies; independent cancellation (source cancelled only when all branches
cancelled); works on AsyncIterable + ReadableStream sources.

**Test IDs** `LSM-TEE-01..` — 2-way and 3-way correctness; `block` applies backpressure (slow
branch slows source); `bounded` errors lagging branch on overflow (`SOURCE_ERROR`); `drop` keeps
freshest (drops oldest) and never blocks source; cancel one branch → source keeps flowing; cancel
all → source cancelled (assert reason `tee-all-cancelled`); empty source → all branches close.

**AC** — all `LSM-TEE-*` pass; no unbounded buffering under `block`/`bounded`.

## 19. P3 — race

**Tasks** — implement `race` per §7.3: eager start all (invoke thunks immediately); winner = first
usable; pre-usable buffering + in-order flush; cancel losers (reason `race-lost`); `NO_USABLE_SOURCE`
when all end unusable; commit (winner error propagates); `mapEach`, telemetry, `onFinish`, `signal`.

**Test IDs** `LSM-RACE-01..` — first-to-emit wins; `isUsable` gates winner; buffered pre-usable
items flushed in order; losers cancelled (assert cancel called on each loser); all-empty →
`NO_USABLE_SOURCE`; winner errors after commit → error propagates (no failover); `signal` abort →
`ABORTED`; `MuxResult.winner` correct.

**AC** — all `LSM-RACE-*` pass; no leaked readers (losers cancelled).

## 20. P4 — fallback

**Tasks** — implement `fallback` per §7.1–§7.2: priority order; lazy thunks start next only on
failure; eager supported; `FailoverPolicy` (`commit` default, `buffered`, `post-emit`); `isUsable`
commit gate; `isError` in-band failover; `timeoutMs` per attempt; `ALL_FAILED` with `errors[]`.

**Test IDs** `LSM-FB-01..` — lazy: backup thunk NOT invoked when primary succeeds; primary fails
pre-commit → failover to backup (clean); `commit`: primary fails post-commit → error propagates
(no failover); `buffered`: clean failover after partial output, buffer discarded; `post-emit`:
failover after commit emits `failover` SourceEvent + switches; in-band `isError` triggers failover;
`timeoutMs` triggers failover (`TIMEOUT`); all fail → `ALL_FAILED` with `errors.length === N`.

**AC** — all `LSM-FB-*` pass.

## 21. P5 — merge / ensemble

**Tasks** — implement `merge` per §7.4 + §7.7: concurrent, `Tagged<T>` output with
`value`/`error`/`done`; one source failing doesn't kill others; completes when all end; `failFast`;
`order` (`arrival` default, `round-robin`); `concurrency` cap; backpressure across all; export
`ensemble` alias.

**Implementation note (merge read-loop — the trickiest correctness bit).** Do NOT
`Promise.race(reads)` naïvely: the losing read promises stay pending and their resolved values are
lost on the next loop. Tag each pending read with its source and keep a stable map so settled-but-
not-consumed reads are not dropped:

```text
pending = Map<source, Promise<{ source, result }>>   // result = IteratorResult-like
for each active source s: pending.set(s, read(s))     // read wraps reader.read()/it.next()

while pending.size > 0:
  await output.ready                                   // backpressure: wait for desiredSize > 0
  const { source, result } = await Promise.race(pending.values())
  pending.delete(source)
  if result.error:        emit Tagged{source, kind:"error", error}; (drop source)  // others live
  else if result.done:    emit Tagged{source, kind:"done"}                          // (drop source)
  else:
    if isError(result.value): emit Tagged error; (failFast? abort all : drop source)
    else: emit Tagged{source, kind:"value", value: mapEach(value)}
          if !isFinal(value): pending.set(source, read(source))   // re-arm same source
          else: emit Tagged done; (drop source)
// concurrency: keep at most k entries in `pending`; when one is dropped, start the next queued source
```

Each `read(source)` MUST resolve (never reject) by catching errors into `{ error }`, so a rejected
read can't poison `Promise.race`. `round-robin` replaces `Promise.race` with a rotating cursor that
awaits sources in fixed order.

**Test IDs** `LSM-MERGE-01..` — items tagged with correct source; in-band error per source +
others continue; `done` per source + final completion when all done; `failFast` true → errors out;
`round-robin` deterministic rotation; `concurrency=k` starts at most k, then next on completion;
backpressure: slow consumer pauses all sources (assert sources not over-pulled); `ensemble === merge`;
no dropped items under interleaved fast/slow sources (regression for the read-loop above).

**AC** — all `LSM-MERGE-*` pass; bounded memory under slow consumer.

## 22. P6 — cross-cutting features

**Tasks** — finalize across all strategies: `timeoutMs` + `overallTimeoutMs` (§7.6); `mapEach`
(sync-only per D9, throw → `SOURCE_ERROR`); `onSourceEvent` full lifecycle coverage;
`onFinish`/`MuxResult` correctness per strategy; `MuxError` shape + `errors[]` aggregation;
`highWaterMark` / `sourceHighWaterMark` wiring (D8: same for `arrival` and `round-robin`).

**Test IDs** `LSM-X-01..` — `overallTimeoutMs` aborts whole op (`ABORTED`); `mapEach` transforms
T→U (type-level + runtime) and throwing maps to `SOURCE_ERROR`; SourceEvent sequence matches spec
for each strategy; `MuxResult` fields accurate (winner, perSource counts, aborted); `highWaterMark`
changes output buffering behavior.

**AC** — all `LSM-X-*` pass; D8–D10 applied in spec.

## 23. P7 — edge cases & contract tests

**Tasks** — write `docs/edge-cases.md` + `test/edge.test.ts` covering the matrix below; treat each
as a binding contract.

| Case                                           | race                      | fallback                       | merge                        | tee                      |
| ---------------------------------------------- | ------------------------- | ------------------------------ | ---------------------------- | ------------------------ |
| empty `sources` (`[]`)                         | throws `NO_USABLE_SOURCE` | throws `ALL_FAILED` (0 errors) | yields nothing, completes    | n/a                      |
| single source                                  | pass-through              | pass-through                   | tagged pass-through          | works                    |
| all sources empty                              | `NO_USABLE_SOURCE`        | `ALL_FAILED`                   | completes (all `done`)       | branches close           |
| source throws before first item                | disqualified              | failover                       | `error` tag, others continue | branch errors per policy |
| consumer breaks early (`break` in `for await`) | losers + winner cancelled | active source cancelled        | all sources cancelled        | branch cancel rules      |
| `signal` already aborted                       | `ABORTED` immediately     | `ABORTED`                      | `ABORTED`                    | branches error           |

**Test IDs** `LSM-EDGE-01..` (one per cell). Also `LSM-REL-02`: early `break` leaks nothing
(all readers cancelled).

**AC** — all `LSM-EDGE-*` + `LSM-REL-02` pass.

## 24. P8 — docs, examples, release prep

**Tasks**

- `README.md`: positioning, install, quickstart (byte + event), strategy table, link to proposal.
- `docs/integration-cookbook.md`: userland pairing with assemble (parse→mux, mux→parse) and guard
  (mux→guard) — **docs only, no npm coupling**.
- `examples/node-fetch/`: `race.ts`, `fallback.ts`, `merge.ts`, `tee.ts` (typecheck against `dist/`).
- `CHANGELOG.md` → `1.0.0` entry; `release:prep` script (version/CHANGELOG/dist/`npm pack` checks).
- Optional: Mermaid diagrams (pipeline, strategy decision) + `diagrams:build`.

**AC** — `LSM-REL-03`: examples typecheck against built `dist/`; README quickstart compiles;
`pnpm verify` green; `npm pack` contains `dist/` + types, excludes `test/`/`examples/`.

## 25. Definition of done (whole library)

- All `LSM-*` tests green; `pnpm verify` and `pnpm verify:deps` pass.
- Zero runtime dependencies; no imports from assemble/guard.
- Runs on Node 18+, Bun, Deno, Workers (smoke at least Node; document others).
- Public API matches §9 exactly; types match §6.
- `docs/proposal.MD` (this file), `README.md`, `edge-cases.md`, cookbook, examples present.

## 26. Working agreement & version progression to 1.0.0

This proposal is the **single source of truth**. The implementing AI builds the library
**incrementally, phase by phase**, and treats each phase as a shippable checkpoint on the road to a
stable `1.0.0`. There is no separate rules file; everything binding is in this document (hard
constraints in §0, spec in Part A, phases in Part B).

### 26.1 Per-phase loop (repeat for P0 → P8)

1. **Read** the phase (§16–§24) plus every §-reference it points to.
2. **Implement** only that phase's scope. Do not pull work forward from later phases.
3. **Write the phase's `LSM-*` tests** alongside the code (test-first where practical).
4. **Self-verify:** run `pnpm verify` (+ `pnpm verify:deps`). The phase is done only when ALL of its
   AC pass AND no hard constraint in §0 is violated.
5. **Record** any decision made under ambiguity in §13 (Decisions log) and resolve relevant §14
   items as you reach them (mainly P6).
6. **Bump version + CHANGELOG** per the ladder below, then proceed to the next phase.

If a phase reveals the spec is wrong or underspecified, update this document (Part A and/or §13)
**first**, then implement — never silently diverge from the proposal.

### 26.2 Version ladder (semver pre-1.0 → 1.0.0)

Each phase maps to a `0.x` release so progress is visible and bisectable. `1.0.0` is tagged ONLY
when §25 Definition of done is fully satisfied.

| Version | Reached after | Functional capability at this version                                                                                               |
| ------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `0.1.0` | P0 + P1       | Scaffolding + core internals + interop helpers (`collect`, `toReadable`, `toAsyncIterable`). No strategies yet.                     |
| `0.2.0` | P2            | `tee` works (N-way, all backpressure policies, independent cancel).                                                                 |
| `0.3.0` | P3            | `race` works (first-usable, loser cancel, commit, `NO_USABLE_SOURCE`).                                                              |
| `0.4.0` | P4            | `fallback` works (lazy/eager, all `FailoverPolicy`, in-band failover, `ALL_FAILED`).                                                |
| `0.5.0` | P5            | `merge`/`ensemble` works (tagging, partial-failure, `order`, `concurrency`, backpressure).                                          |
| `0.6.0` | P6            | Cross-cutting complete (timeouts, `mapEach`, `SourceEvent`, `MuxResult`/`onFinish`, HWM). Full API per §9.                          |
| `0.7.0` | P7            | Edge-case matrix + contract tests all green; no-leak guarantees verified.                                                           |
| `0.8.0` | P8            | Docs, examples, cookbook, README; `release:prep` green; examples typecheck vs `dist/`.                                              |
| `0.9.0` | P9            | §25 audit; Bun/Deno + consumer smoke; STABILITY, SECURITY, RELEASE; REL-11a–11q; verify:pre1.                                       |
| `1.0.0` | P10           | npm publish; §9/§6.3 frozen; `LSM-EDGE-140`–`180`; REL-12a–12u; doc+diagram audit; post-publish smoke; pack audit; rollback runbook |

### 26.3 Definition of "functional 1.0.0"

`1.0.0` means: every public function in §9 behaves exactly as specified in Part A, every `LSM-*`
test (CORE, TEE, RACE, FB, MERGE, X, EDGE, REL) is green, zero runtime deps, runs on the target
runtimes, and the package installs and imports cleanly (ESM + CJS) from the published tarball. At
that point the public API surface (§9) and `MuxError` codes (§6.3) are **frozen** under semver —
later changes follow the same stability discipline the sibling libraries use.
