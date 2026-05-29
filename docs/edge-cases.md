# Edge-case showcase

**Status:** Contract matrix — implementation tracked in proposal P7 (`LSM-EDGE-*`).

What breaks when you hand-roll stream orchestration, and how `llm-stream-mux` pins behavior. For positioning vs generic utilities, see [comparison](./comparison.md).

---

## A) Native `ReadableStream.tee()` unbounded memory

If one branch reads slowly, native `tee()` buffers **without limit** for the slow branch while the fast branch races ahead.

**What mux does:** `tee()` with `block`, `bounded`, or `drop` policies (D5). `bounded` errors the lagging branch; `drop` drops oldest queued items.

**Tests (planned):** `LSM-TEE-03`, `LSM-TEE-04`.

---

## B) Race without `isUsable` — junk-first wins

A source that emits an empty or metadata frame before real content can win a naive “first emit” race.

**What mux does:** optional `isUsable` gates the winner; pre-usable items are **buffered and flushed in order** once a source wins (§7.3).

**Tests (planned):** `LSM-RACE-02`, `LSM-RACE-03`.

---

## C) Fallback after partial output — commit point

You cannot “un-send” bytes already forwarded. Failover after commit would splice two streams into one incoherent response.

**What mux does:** `FailoverPolicy` — default `"commit"` fails over only **before** the first forwarded (usable) item; post-commit errors propagate. `"buffered"` and `"post-emit"` trade latency for cleanliness (§7.2).

**Tests (planned):** `LSM-FB-03`–`LSM-FB-05`.

---

## D) Merge `Promise.race` naïveté — dropped reads

A naïve merge loop that `Promise.race`s pending reads **loses** settled values from sources that did not win the race.

**What mux does:** one pending read per source in a `Map`; re-arm only after consume (proposal §21 implementation note).

**Tests (planned):** `LSM-MERGE-08`.

---

## E) AsyncIterable “cancel” is soft

Calling `return()` on an async iterator does not guarantee the underlying HTTP request stops.

**What mux does:** documents cancellation honesty (§7.5); recommends `ReadableStream` sources when hard cancel matters; losers get `MuxCancelled` reason objects.

**Tests (planned):** `LSM-CORE-*`, `LSM-RACE-*` cancel assertions.

---

## F) Contract matrix (binding at P7)

| Case                            | race               | fallback                | merge                        | tee            |
| ------------------------------- | ------------------ | ----------------------- | ---------------------------- | -------------- |
| empty `sources` (`[]`)          | `NO_USABLE_SOURCE` | `ALL_FAILED` (0 errors) | yields nothing, completes    | n/a            |
| single source                   | pass-through       | pass-through            | tagged pass-through          | works          |
| all sources empty               | `NO_USABLE_SOURCE` | `ALL_FAILED`            | all `done`, completes        | branches close |
| source throws before first item | disqualified       | failover                | `error` tag, others continue | per policy     |
| consumer breaks early (`break`) | cancel all         | cancel active           | cancel all sources           | branch rules   |
| `signal` already aborted        | `ABORTED`          | `ABORTED`               | `ABORTED`                    | branches error |

Each cell → `LSM-EDGE-NN` in `test/edge.test.ts` (P7).

---

## G) Prove it locally (after P1+)

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

## Related

- [Proposal §7](./proposal.MD#7-error-cancellation--backpressure-semantics)
- [Usage guides](./usage-guides.md)
- [Testing strategy](./testing-strategy.md) (P7)
