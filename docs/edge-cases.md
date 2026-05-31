# Edge-case showcase

**Status:** Contract matrix — P7 (`0.7.0`) + P8 docs (`0.8.0`) — **`LSM-EDGE-01`–`119`** + **`06b`** + **`LSM-REL-09`/`10`** in `test/edge.test.ts` / `test/release.test.ts`.

What breaks when you hand-roll stream orchestration, and how `llm-stream-mux` pins behavior. For positioning vs generic utilities, see [comparison](./comparison.md).

---

## A) Native `ReadableStream.tee()` unbounded memory

If one branch reads slowly, native `tee()` buffers **without limit** for the slow branch while the fast branch races ahead.

**What mux does:** `tee()` with `block`, `bounded`, or `drop` policies (D5). `bounded` errors the lagging branch; `drop` drops oldest queued items.

**Tests:** `LSM-TEE-03`, `LSM-TEE-04` (block), `LSM-TEE-05`–`07` / `LSM-TEE-36` / `LSM-TEE-48`–`51` / `LSM-TEE-62` (bounded), `LSM-TEE-08`–`09` / `LSM-TEE-42` / `LSM-TEE-49` / `LSM-TEE-57` (drop), `LSM-TEE-38` / `LSM-TEE-61` (natural close ≠ cancel), `LSM-TEE-43`–`46` (arg validation), `LSM-TEE-52`–`55` / `LSM-TEE-60` / `LSM-TEE-63`–`64` (cancel semantics).

---

## B) Race without `isUsable` — junk-first wins

A source that emits an empty or metadata frame before real content can win a naive “first emit” race.

**What mux does:** optional `isUsable` gates the winner; pre-usable items are **buffered and flushed in order** once a source wins (§7.3).

**Tests:** `LSM-RACE-02`, `LSM-RACE-03`, `LSM-RACE-04`, `LSM-RACE-48`, `LSM-RACE-58`, `LSM-RACE-79`.

---

## C) Fallback after partial output — commit point

You cannot “un-send” bytes already forwarded. Failover after commit would splice two streams into one incoherent response.

**What mux does:** `FailoverPolicy` — default `"commit"` fails over only **before** the first forwarded (usable) item; post-commit errors propagate. `"buffered"` and `"post-emit"` trade latency for cleanliness (§7.2).

**Tests:** `LSM-FB-03`–`LSM-FB-06`, `LSM-FB-41`, `LSM-FB-76`–`LSM-FB-110`.

---

## D) Merge `Promise.race` naïveté — dropped reads

A naïve merge loop that `Promise.race`s pending reads **loses** settled values from sources that did not win the race.

**What mux does:** one pending read per source in a `Map`; re-arm only after consume (proposal §21 implementation note).

**Tests:** `LSM-MERGE-08`, `LSM-MERGE-71`, `LSM-MERGE-87`, `LSM-MERGE-103`.

---

## E) AsyncIterable “cancel” is soft

Calling `return()` on an async iterator does not guarantee the underlying HTTP request stops.

**What mux does:** documents cancellation honesty (§7.5); recommends `ReadableStream` sources when hard cancel matters; losers get `MuxCancelled` reason objects.

**Tests (planned):** `LSM-CORE-05`–`07`, `LSM-CORE-23` (P1); full strategy cancel in P2+.

---

## F) P0 type surface edge cases (frozen at scaffold)

The public API is **generic over `T`** — errors cannot be synthesized as `T`, so merge uses `Tagged<T>` with explicit `kind` variants. These are pinned at P0 before runtime strategies exist:

| Case                                           | Risk                              | P0 pin                                                                                   |
| ---------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `Tagged` used as plain union without narrowing | Access `value` on `error` branch  | `LSM-TYP-01`–`03` discriminant tests                                                     |
| `ALL_FAILED` without `errors[]`                | Loses per-source diagnostics      | `LSM-TYP-04` aggregate shape                                                             |
| `Sources` labeled vs positional confusion      | Wrong `source` tags in merge      | `LSM-TYP-06` three input forms                                                           |
| Lazy thunk invoked at call site                | Breaks failover cost model        | `LSM-TYP-07` deferred invocation                                                         |
| `fromAsyncIterable` alias creep                | Violates D10                      | `LSM-REL-02` export denial                                                               |
| Premature `merge()` stub in public API         | False semver promise              | `LSM-REL-02` strategy export denial until P5; **`merge` + `ensemble` exported in 0.5.0** |
| `MuxErrorCode` drift vs `MUX_ERROR_CODES`      | Telemetry/SIEM mismatch           | `LSM-REL-02`, `LSM-TYP-16`–`21`, `LSM-TYP-45`                                            |
| `dist/index.d.ts` missing exports / leaks API  | Broken consumers                  | `LSM-TYP-51`, `LSM-TYP-52`                                                               |
| Matrix error codes before runtime exists       | Spec drift vs implementation      | `LSM-EDGE-P0-01`–`26`                                                                    |
| Hook composition / policy literals             | Wrong defaults at call site       | `LSM-TYP-30`–`35`                                                                        |
| Byte vs event generic `T`                      | Accidental event model coupling   | `LSM-TYP-23`, `LSM-TYP-24`                                                               |
| Fn signature types (Race/Merge/Tee/interop)    | Wrong consumer typings at P1      | `LSM-TYP-55`–`58`                                                                        |
| Source union runtime (empty/cancel/lazy)       | Broken edge matrix at P7          | `LSM-SRC-01`–`08`                                                                        |
| `MUX_ERROR_CODES` mutability                   | Telemetry enum drift              | `LSM-TYP-63`                                                                             |
| Cancel honesty / post-cancel lock              | Leaks + double-read in strategies | `LSM-CORE-05`–`07`, `LSM-CORE-23`, `LSM-CORE-31`–`32`, `LSM-CORE-36`, `LSM-CORE-53`      |
| `SourceReadResult` error branch                | Merge read-loop poison            | `LSM-CORE-11`, `LSM-CORE-30`, `LSM-CORE-52`, `LSM-CORE-60`                               |
| Interop round-trip + stream errors             | Broken boundaries                 | `LSM-CORE-15`, `LSM-CORE-22`, `LSM-CORE-45`–`49`, `LSM-CORE-55`–`56`, `LSM-CORE-59`      |
| Duplicate merge source ids                     | Wrong tags in ensemble            | `LSM-CORE-26`, `LSM-CORE-58`                                                             |
| Empty / exhausted sources                      | Premature done or hang            | `LSM-CORE-28`–`29`, `LSM-SRC-01`–`02`, `LSM-CORE-51`, `LSM-CORE-55`                      |
| Abort signal fan-in                            | Missed parent/timeout abort       | `LSM-CORE-10`, `LSM-CORE-21`, `LSM-CORE-37`–`39`, `LSM-CORE-54`                          |
| Telemetry lifecycle gaps                       | Wrong `MuxResult` at `onFinish`   | `LSM-CORE-19`–`20`, `LSM-CORE-25`, `LSM-CORE-27`, `LSM-CORE-43`–`44`, `LSM-CORE-57`      |
| `CreateMuxError` public / `muxError` internal  | API surface drift                 | `LSM-TYP-69`, `LSM-CORE-17`–`18`, `LSM-CORE-41`–`42`                                     |
| Fixture throw / neverEnd / delay               | Flaky strategy tests later        | `LSM-SRC-09`–`12`, `LSM-CORE-24`                                                         |

Diagram: [public-api-types.svg](./img/public-api-types.svg) · [core-internals.svg](./img/core-internals.svg) · [race-win.svg](./img/race-win.svg).

---

## G) Contract matrix (binding — P7 `0.7.0`)

| Case                            | race               | fallback                | merge                        | tee            | Test ID        |
| ------------------------------- | ------------------ | ----------------------- | ---------------------------- | -------------- | -------------- |
| empty `sources` (`[]`)          | `NO_USABLE_SOURCE` | `ALL_FAILED` (0 errors) | yields nothing, completes    | n/a            | `01`/`02`/`03` |
| single source                   | pass-through       | pass-through            | tagged pass-through          | works          | `04`–`07`      |
| all sources empty               | `NO_USABLE_SOURCE` | `ALL_FAILED`            | all `done`, completes        | branches close | `08`–`11`      |
| source throws before first item | disqualified       | failover                | `error` tag, others continue | per policy     | `12`–`15`      |
| consumer breaks early (`break`) | cancel all         | cancel active           | cancel all sources           | branch rules   | `16`–`19`      |
| `signal` already aborted        | `ABORTED`          | `ABORTED`               | `ABORTED`                    | branches error | `20`–`23`      |

**Row 1 supplements:** empty `Record` `{}` → **`LSM-EDGE-52`** (race), **`LSM-EDGE-53`** (fallback); single empty stream in array → **`LSM-EDGE-51`** (async race).

**Authority:** `test/edge.test.ts` — canonical **`LSM-EDGE-*`** pins (strategy tests remain informative cross-refs).

Diagram: [edge-matrix.svg](./img/edge-matrix.svg)

### G.1 Extended + no-leak + supplemental (P7)

| Range                  | Scope                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| **`LSM-EDGE-24`–`45`** | Input forms (`Record`, labeled), `failFast`, ReadableStream break, signal + `onFinish`    |
| **`LSM-EDGE-46`–`50`** | No-leak audit + same-iterator replay (**`LSM-REL-09`**)                                   |
| **`LSM-EDGE-51`–`59`** | Empty-record, `onFinish.aborted`, failover event, signal×throw, doc integrity, early exit |
| **`LSM-EDGE-06b`**     | `ensemble` alias parity                                                                   |

### G.2 Ultra-extended §E (`LSM-EDGE-60`–`99`)

| Range                  | Scope                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| **`LSM-EDGE-60`–`69`** | Duplicate labeled IDs, `isUsable`/`isError`/`isFinal`, fallback policies, merge `round-robin`, empty `{}` |
| **`LSM-EDGE-70`–`79`** | Tee drop/bounded/ReadableStream, cancel-all, signal abort + `onFinish.aborted`, mid-stream merge abort    |
| **`LSM-EDGE-80`–`89`** | `null`/`undefined`/binary pass-through, long empty chains, race lazy open on break, tee no-leak           |
| **`LSM-EDGE-90`–`99`** | Merge lazy concurrency break, sync-throw `onFinish` guard, mixed empty/throw/good chains, array vs Record |

### G.3 Ultra-extended §F cross-cutting (`LSM-EDGE-100`–`119`)

| Range                    | Scope                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **`LSM-EDGE-100`–`102`** | `overallTimeoutMs` → `ABORTED` + `TIMEOUT` cause (race, fallback, merge)                                           |
| **`LSM-EDGE-103`–`106`** | `timeoutMs` disqualify, commit post-commit no failover, merge `mapEach` throw + continue, race `mapEach` transform |
| **`LSM-EDGE-107`–`109`** | Merge `arrival` vs `round-robin`, tee `n=1`, tee `bufferLimit` validation                                          |
| **`LSM-EDGE-110`–`112`** | Race `isUsable` junk disqualify, fallback `post-emit` splice, merge `onSourceEvent` lifecycle                      |
| **`LSM-EDGE-113`–`115`** | Race break + lazy open audit, fallback `buffered` no primary leak, ensemble labeled parity (lazy)                  |
| **`LSM-EDGE-116`–`118`** | ReadableStream byte `isUsable`, commit no failover event, merge concurrency slot audit on break                    |
| **`LSM-EDGE-119`**       | Matrix doc integrity guard for §F IDs                                                                              |

Race cross-refs: `LSM-RACE-05`, `LSM-RACE-09`, `LSM-RACE-19`, `LSM-RACE-28`, `LSM-RACE-43`, `LSM-RACE-57`, `LSM-RACE-62`–`74`, `LSM-RACE-80`.

Merge cross-refs: `LSM-MERGE-01`, `LSM-MERGE-02`, `LSM-MERGE-04`, `LSM-MERGE-09`, `LSM-MERGE-19`, `LSM-MERGE-28`, `LSM-MERGE-52`, `LSM-MERGE-65`, `LSM-MERGE-96`–`135`.

---

## H) Prove it locally (after P1+)

Once helpers land in `test/helpers/streams.ts`:

```ts
import { race } from "llm-stream-mux";
import { fromArray } from "../test/helpers/streams"; // P1

const { asyncIterable: junkFirst } = fromArray([new Uint8Array(0), new Uint8Array([1])], {
	delayMs: 0,
});
const { asyncIterable: slowGood } = fromArray([new Uint8Array([42])], { delayMs: 50 });

for await (const chunk of race([junkFirst, slowGood], {
	isUsable: (c) => c.byteLength > 0,
})) {
	console.log(chunk); // [42] from slowGood after junk buffered on winner
}
```

---

## Cross-cutting options (P6 — `0.6.0`)

Shared **`CommonOptions`** on **`race`**, **`fallback`**, and **`merge`/`ensemble`**.

| Option                    | Scope                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| **`timeoutMs`**           | Per-source **time-to-first-usable** on **`race`** + **`fallback`** only; **`merge` ignores**             |
| **`overallTimeoutMs`**    | Whole-operation deadline on all three async strategies → consumer **`ABORTED`** with **`TIMEOUT`** cause |
| **`highWaterMark`**       | Output coordinator queue depth (default **`1`**)                                                         |
| **`sourceHighWaterMark`** | Per-source input buffering on **`ReadableStream`** adapters only                                         |

Timers start on **first consumer `.next()`**, not at strategy call site.

**Tests:** `LSM-X-01`–`115`, `LSM-CORE-61`–`70`, `LSM-REL-08a/b`.

---

## Related

- [Proposal §7](./proposal.MD#7-error-cancellation--backpressure-semantics)
- [Usage guides](./usage-guides.md)
- [Testing strategy](./testing-strategy.md)
