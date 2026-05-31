# Performance & runtime behavior

**Status:** Stable **`1.0.0`** — design constraints from proposal §7.7 and §8; advisory bench in `scripts/bench-smoke.mjs` gated by **`LSM-REL-12u`**.

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

**`scripts/bench-smoke.mjs`** — advisory micro bench for `race` / `merge` median latency. **`LSM-REL-12u`** enforces `--warn` at **`1.0.0`**.

```bash
pnpm build
node scripts/bench-smoke.mjs          # print medians
node scripts/bench-smoke.mjs --warn   # warn on regression vs baseline
```

Baseline: **`scripts/bench-smoke-baseline.json`**. Invoked with **`--warn`** from **`pnpm release:prep --full`**.

**Baseline refresh policy:** update `bench-smoke-baseline.json` only on intentional performance change in `src/` — document the reason in **`CHANGELOG.md`**. Do not silently widen `regressionWarnRatio` (default **1.2**).

---

## Related

- [Compatibility](./compatibility.md)
- [Edge cases](./edge-cases.md)
