import { describe, expect, it } from "vitest";
import { collect, merge, race, tee, toAsyncIterable } from "../src/index.js";
import { combineSignals } from "../src/internal/abort.js";
import type { SourceEvent } from "../src/types.js";
import {
	collectFallback,
	collectRace,
	collectTagged,
	drainBranch,
	drainBranchesParallel,
	flushMicrotasks,
	valueTags,
} from "./helpers/edge-matrix.js";
import { cancelSpyingReadable, fromArray } from "./helpers/streams.js";

/**
 * Extended coverage edge cases (LSM-XCOV-*) — targets the reachable branches the
 * frozen §23 matrix (LSM-EDGE-01–180) leaves uncovered: post-win source timeouts,
 * mid-stream finals on the pumped winner, buffered/commit fallback tails,
 * round-robin merge churn, per-source HWM wrapping, drop/block tee cancellation,
 * interop re-entry, and the AbortSignal.any-absent fallback.
 */

describe("LSM-XCOV race extended", () => {
	it("LSM-XCOV-01 source timeout firing after a winner is claimed is ignored", async () => {
		// fast wins; slow's per-source timer fires post-win and must be a no-op.
		const fast = fromArray([1, 2, 3]).asyncIterable;
		const slow = fromArray([99], { delayMs: 200, neverEnd: true }).asyncIterable;
		const out = await collectRace([fast, slow], { timeoutMs: 30 });
		expect(out).toEqual([1, 2, 3]);
	});

	it("LSM-XCOV-02 winner hitting isFinal mid-stream closes via the pump path", async () => {
		const events: SourceEvent[] = [];
		const out = await collectRace([fromArray(["a", "b", "STOP", "c"]).asyncIterable], {
			isFinal: (s) => s === "STOP",
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual(["a", "b", "STOP"]);
		expect(events.some((e) => e.type === "done" && e.source === "0")).toBe(true);
	});

	it("LSM-XCOV-03 two synchronously-usable sources tie — lowest index wins", async () => {
		const out = await collectRace([fromArray(["a"]).asyncIterable, fromArray(["b"]).asyncIterable]);
		expect(out).toEqual(["a"]);
	});

	it("LSM-XCOV-04 abort while a per-source timer is still armed rejects ABORTED", async () => {
		const ctrl = new AbortController();
		const iter = race([fromArray<number>([], { neverEnd: true }).asyncIterable], {
			timeoutMs: 10_000,
			signal: ctrl.signal,
		})[Symbol.asyncIterator]();
		const next = iter.next();
		await flushMicrotasks();
		ctrl.abort();
		await expect(next).rejects.toMatchObject({ code: "ABORTED" });
	});
});

describe("LSM-XCOV fallback extended", () => {
	it("LSM-XCOV-05 buffered policy forwards a fully-buffered emitting primary", async () => {
		const out = await collectFallback([fromArray([1, 2, 3]).asyncIterable], { policy: "buffered" });
		expect(out).toEqual([1, 2, 3]);
	});

	it("LSM-XCOV-06 commit policy emits items then closes on a mid-stream isFinal", async () => {
		const events: SourceEvent[] = [];
		const out = await collectFallback([fromArray(["a", "b", "DONE"]).asyncIterable], {
			policy: "commit",
			isFinal: (s) => s === "DONE",
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual(["a", "b", "DONE"]);
		expect(events.some((e) => e.type === "done")).toBe(true);
	});

	it("LSM-XCOV-07 commit policy forwards post-commit non-usable items", async () => {
		// Only "good" is usable; after commit the later non-usable items still flow.
		const out = await collectFallback([fromArray(["good", "x", "y"]).asyncIterable], {
			policy: "commit",
			isUsable: (s) => s === "good",
		});
		expect(out).toEqual(["good", "x", "y"]);
	});

	it("LSM-XCOV-08 per-attempt timeout before commit fails over to the backup", async () => {
		const events: SourceEvent[] = [];
		const out = await collectFallback(
			[
				fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable,
				fromArray([42]).asyncIterable,
			],
			{ timeoutMs: 30, onSourceEvent: (e) => events.push(e) },
		);
		expect(out).toEqual([42]);
		expect(events.some((e) => e.type === "timeout" && e.source === "0")).toBe(true);
		expect(events.some((e) => e.type === "start" && e.source === "1")).toBe(true);
	});

	it("LSM-XCOV-09 abort while a committed source is blocked on queue space rejects ABORTED", async () => {
		const ctrl = new AbortController();
		const out = collectFallback([fromArray([1, 2, 3, 4, 5], { delayMs: 10 }).asyncIterable], {
			signal: ctrl.signal,
			highWaterMark: 1,
		});
		await flushMicrotasks();
		setTimeout(() => ctrl.abort(), 25);
		await expect(out).rejects.toMatchObject({ code: "ABORTED" });
	});
});

describe("LSM-XCOV merge extended", () => {
	it("LSM-XCOV-10 round-robin with concurrency < sources interleaves all values", async () => {
		const tags = await collectTagged(
			[
				fromArray(["a1", "a2"]).asyncIterable,
				fromArray(["b1", "b2"]).asyncIterable,
				fromArray(["c1", "c2"]).asyncIterable,
			],
			{ order: "round-robin", concurrency: 2 },
		);
		const values = valueTags(tags).map((t) => t.value);
		expect(values.sort()).toEqual(["a1", "a2", "b1", "b2", "c1", "c2"]);
	});

	it("LSM-XCOV-11 failFast in-band error aborts the run", async () => {
		const out = collectTagged(
			[fromArray(["bad"]).asyncIterable, fromArray(["x", "y", "z"], { delayMs: 5 }).asyncIterable],
			{ failFast: true, isError: (s) => s === "bad" },
		);
		await expect(out).rejects.toMatchObject({ code: "ALL_FAILED" });
	});

	it("LSM-XCOV-12 sourceHighWaterMark wraps an eager ReadableStream", async () => {
		const tags = await collectTagged([fromArray([1, 2, 3]).readable], { sourceHighWaterMark: 2 });
		expect(valueTags(tags).map((t) => t.value)).toEqual([1, 2, 3]);
	});

	it("LSM-XCOV-13 sourceHighWaterMark wraps a lazy ReadableStream factory", async () => {
		const tags = await collectTagged([() => fromArray([7, 8, 9]).readable], {
			sourceHighWaterMark: 2,
		});
		expect(valueTags(tags).map((t) => t.value)).toEqual([7, 8, 9]);
	});

	it("LSM-XCOV-14 sourceHighWaterMark propagates cancellation to the wrapped stream", async () => {
		const spy = cancelSpyingReadable<number>();
		const iter = merge([spy.stream], { sourceHighWaterMark: 4 })[Symbol.asyncIterator]();
		const first = iter.next();
		void first.catch(() => undefined);
		spy.enqueue(1);
		expect((await first).value).toMatchObject({ source: "0", kind: "value", value: 1 });
		await iter.return?.();
		await flushMicrotasks();
		expect(spy.cancelReasons.length).toBeGreaterThan(0);
	});
});

describe("LSM-XCOV tee extended", () => {
	it("LSM-XCOV-15 block mode: a branch cancelled before any read lets survivors drain fully", async () => {
		const src = fromArray([1, 2, 3, 4, 5], { delayMs: 3 }).asyncIterable;
		const [a, b, c] = tee(src, 3, { backpressure: "block" });
		await a!.cancel("skip");
		const [rb, rc] = await drainBranchesParallel([b!, c!]);
		expect(rb).toEqual([1, 2, 3, 4, 5]);
		expect(rc).toEqual([1, 2, 3, 4, 5]);
	});

	it("LSM-XCOV-15b block mode: cancelling a branch mid-stream does not stall survivors", async () => {
		const src = fromArray([1, 2, 3, 4, 5], { delayMs: 3 }).asyncIterable;
		const [a, b, c] = tee(src, 3, { backpressure: "block" });
		const ra = a!.getReader();
		const rb = b!.getReader();
		const rc = c!.getReader();
		// lockstep first item across all three, then drop branch a
		await Promise.all([ra.read(), rb.read(), rc.read()]);
		await ra.cancel("mid");
		const drainRest = async (reader: ReadableStreamDefaultReader<number>) => {
			const out: number[] = [];
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return out;
				out.push(value);
			}
		};
		const [restB, restC] = await Promise.all([drainRest(rb), drainRest(rc)]);
		expect(restB).toEqual([2, 3, 4, 5]);
		expect(restC).toEqual([2, 3, 4, 5]);
	});

	it("LSM-XCOV-16 drop mode: cancelling one branch leaves the others receiving", async () => {
		const src = fromArray([1, 2, 3, 4], { delayMs: 5 }).asyncIterable;
		const [a, b] = tee(src, 2, { backpressure: "drop", bufferLimit: 8 });
		const ra = a!.getReader();
		await ra.read();
		await ra.cancel("drop-out");
		const rb = await drainBranch(b!);
		expect(rb).toEqual([1, 2, 3, 4]);
	});
});

describe("LSM-XCOV interop + abort extended", () => {
	it("LSM-XCOV-17 toAsyncIterable next() after return() yields done", async () => {
		const it = toAsyncIterable(fromArray([1, 2, 3]).readable)[Symbol.asyncIterator]();
		expect(await it.next()).toEqual({ done: false, value: 1 });
		await it.return?.();
		expect(await it.next()).toEqual({ done: true, value: undefined });
	});

	it("LSM-XCOV-18 combineSignals manual fallback when AbortSignal.any is unavailable", () => {
		const ref = AbortSignal as unknown as { any?: unknown };
		const orig = ref.any;
		ref.any = undefined;
		try {
			// no inputs → a fresh, non-aborted signal
			expect(combineSignals().aborted).toBe(false);
			// pre-aborted input → combined aborts immediately
			expect(combineSignals(AbortSignal.abort("pre")).aborted).toBe(true);
			// live propagation via the manual listener
			const ctrl = new AbortController();
			const combined = combineSignals(ctrl.signal, new AbortController().signal);
			expect(combined.aborted).toBe(false);
			ctrl.abort("boom");
			expect(combined.aborted).toBe(true);
		} finally {
			ref.any = orig;
		}
	});
});

/** Guard: the merge HWM path actually exercises the wrapper (not a no-op). */
describe("LSM-XCOV regression guards", () => {
	it("LSM-XCOV-19 sourceHighWaterMark preserves ordering across many items", async () => {
		const items = Array.from({ length: 20 }, (_, i) => i);
		const tags = await collectTagged([fromArray(items).readable], { sourceHighWaterMark: 3 });
		expect(valueTags(tags).map((t) => t.value)).toEqual(items);
	});

	it("LSM-XCOV-20 collect over toAsyncIterable round-trips a ReadableStream", async () => {
		const out = await collect(toAsyncIterable(fromArray(["p", "q", "r"]).readable));
		expect(out).toEqual(["p", "q", "r"]);
	});
});

describe("LSM-XCOV behavioral breadth", () => {
	it("LSM-XCOV-21 race where no source ever yields a usable item → NO_USABLE_SOURCE", async () => {
		await expect(
			collectRace([fromArray([1, 2]).asyncIterable, fromArray([3, 4]).asyncIterable], {
				isUsable: () => false,
			}),
		).rejects.toMatchObject({ code: "NO_USABLE_SOURCE" });
	});

	it("LSM-XCOV-22 winner emitting an in-band error mid-stream rejects IN_BAND_ERROR", async () => {
		await expect(
			collectRace([fromArray(["ok", "ok", "ERR", "more"]).asyncIterable], {
				isError: (s) => s === "ERR",
			}),
		).rejects.toMatchObject({ code: "IN_BAND_ERROR" });
	});

	it("LSM-XCOV-23 winner whose source throws mid-stream surfaces the transport error", async () => {
		await expect(
			collectRace([fromArray(["a", "b", "c"], { throwAt: 2 }).asyncIterable]),
		).rejects.toBeInstanceOf(Error);
	});

	it("LSM-XCOV-24 race mapEach transforms the winner output type", async () => {
		const out = await collectRace<number, string>([fromArray([1, 2, 3]).asyncIterable], {
			mapEach: (n) => `v${n}`,
		});
		expect(out).toEqual(["v1", "v2", "v3"]);
	});

	it("LSM-XCOV-25 merge mapEach transforms tagged values", async () => {
		const tags = await collectTagged<number, string>([fromArray([1, 2]).asyncIterable], {
			mapEach: (n) => `m${n}`,
		});
		expect(valueTags(tags).map((t) => t.value)).toEqual(["m1", "m2"]);
	});

	it("LSM-XCOV-26 fallback post-emit policy streams the primary to completion", async () => {
		const out = await collectFallback([fromArray([1, 2, 3]).asyncIterable], {
			policy: "post-emit",
		});
		expect(out).toEqual([1, 2, 3]);
	});
});
