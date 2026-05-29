# Performance & runtime behavior

**Status:** Pre-implementation — design constraints from proposal §7.7 and §8.

---

## Backpressure

- **merge:** single output `ReadableStream`; pull from sources only while `desiredSize > 0`. Slow consumer pauses **all** sources.
- **tee `block`:** slowest branch applies backpressure to the source (default).
- **tee `bounded` / `drop`:** source never blocked; lagging branch errors or drops oldest (D5).

Default output `highWaterMark`: `1` (`CountQueuingStrategy`). Optional `sourceHighWaterMark`.

---

## Memory

- Merge loop: at most **one pending read per active source** (D8 — same for `arrival` and `round-robin`).
- No unbounded buffering under `tee` `block` or `bounded` — enforced by `LSM-TEE-*` and `LSM-MERGE-*` tests.

---

## Lazy execution

`race`, `fallback`, and `merge` return lazy `AsyncIterable`s — no source starts until iteration begins. Timers start at first consumption, not at call site (§9).

---

## Cancellation cost

Hard cancel (`ReadableStream`) aborts HTTP. Soft cancel (`AsyncIterable`) may leave background work — document and test per §7.5.

---

## Benchmarks

No published benchmarks pre-1.0. A smoke bench script may land post-P5 (`scripts/bench-smoke.mjs`, optional).

---

## Related

- [Compatibility](./compatibility.md)
- [Edge cases](./edge-cases.md)
