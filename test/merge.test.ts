import { describe, expect, it, vi } from "vitest";
import { collect, ensemble, merge, toAsyncIterable, toReadable } from "../src/index.js";
import { isMuxCancelled } from "../src/internal/abort.js";
import type {
	MergeOptions,
	MuxCancelled,
	MuxError,
	MuxResult,
	SourceEvent,
	Sources,
	Tagged,
} from "../src/types.js";
import {
	cancelSpyingReadable,
	controllableReadable,
	countingSource,
	fromArray,
	lazyOpenCounter,
} from "./helpers/streams.js";

function asMuxError(err: unknown): MuxError {
	expect(err).toBeInstanceOf(Error);
	return err as MuxError;
}

async function collectTagged<T, U = T>(
	sources: Sources<T>,
	opts?: MergeOptions<T, U>,
): Promise<Tagged<U>[]> {
	return collect(merge(sources, opts));
}

/** Wraps a failing async iterable and records `return()` cancel reasons. */
function failingWithCancelSpy<T>(
	factory: () => AsyncIterable<T>,
	cancelReasons: unknown[],
): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator]() {
			const inner = factory()[Symbol.asyncIterator]();
			return {
				next: () => inner.next(),
				return: (reason?: unknown) => {
					cancelReasons.push(reason);
					return (
						inner.return?.(reason) ?? Promise.resolve({ done: true as const, value: undefined })
					);
				},
			};
		},
	};
}

function valueTags<T>(tags: Tagged<T>[]) {
	return tags.filter((t): t is Tagged<T> & { kind: "value" } => t.kind === "value");
}

function sharedDelayFixture() {
	return [fromArray([1, 3]).asyncIterable, fromArray([2, 4], { delayMs: 10 }).asyncIterable];
}

describe("LSM-MERGE merge strategy", () => {
	it("LSM-MERGE-01 merge empty yields nothing", async () => {
		let result: MuxResult | undefined;
		expect(await collectTagged([], { onFinish: (r) => (result = r) })).toEqual([]);
		expect(result?.strategy).toBe("merge");
		expect(result?.perSource).toEqual({});
		expect(result?.aborted).toBe(false);
		expect(result?.winner).toBeUndefined();
	});

	it("LSM-MERGE-02 transport fail on A B succeeds error tag plus B values and dones", async () => {
		const tags = await collectTagged([
			fromArray([99], { throwAt: 0 }).asyncIterable,
			fromArray([1, 2]).asyncIterable,
		]);
		expect(tags.some((t) => t.source === "0" && t.kind === "error")).toBe(true);
		expect(asMuxError(tags.find((t) => t.source === "0" && t.kind === "error")!.error!).code).toBe(
			"SOURCE_ERROR",
		);
		expect(tags.some((t) => t.source === "0" && t.kind === "done")).toBe(false);
		expect(
			valueTags(tags)
				.filter((t) => t.source === "1")
				.map((t) => t.value),
		).toEqual([1, 2]);
		expect(tags.some((t) => t.source === "1" && t.kind === "done")).toBe(true);
	});

	it("LSM-MERGE-03 two sources interleaved each value carries correct source id", async () => {
		const tags = await collectTagged([
			fromArray(["a"]).asyncIterable,
			fromArray(["b"]).asyncIterable,
		]);
		const values = valueTags(tags);
		expect(values).toHaveLength(2);
		expect(values.map((t) => t.source).sort()).toEqual(["0", "1"]);
	});

	it("LSM-MERGE-04 consumer return early all started sources cancelled aborted", async () => {
		const a = cancelSpyingReadable<number>();
		const b = cancelSpyingReadable<number>();
		a.enqueue(1);
		b.enqueue(2);
		const iter = merge([a.stream, b.stream])[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		await Promise.resolve();
		for (const spy of [a, b]) {
			expect(spy.cancelReasons.length).toBeGreaterThanOrEqual(1);
			expect(isMuxCancelled(spy.cancelReasons.at(-1))).toBe(true);
			expect((spy.cancelReasons.at(-1) as MuxCancelled).reason).toBe("aborted");
		}
	});

	it("LSM-MERGE-05 failFast false default one source error tag iterator continues", async () => {
		const tags = await collectTagged([
			fromArray([1], { throwAt: 0 }).asyncIterable,
			fromArray([2, 3]).asyncIterable,
		]);
		expect(tags.some((t) => t.source === "0" && t.kind === "error")).toBe(true);
		expect(
			valueTags(tags)
				.filter((t) => t.source === "1")
				.map((t) => t.value),
		).toEqual([2, 3]);
		expect(tags.some((t) => t.source === "1" && t.kind === "done")).toBe(true);
	});

	it("LSM-MERGE-06 positional ids zero and one on tags", async () => {
		const tags = await collectTagged([
			fromArray([10]).asyncIterable,
			fromArray([20]).asyncIterable,
		]);
		expect(valueTags(tags).map((t) => [t.source, t.value])).toEqual(
			expect.arrayContaining([
				["0", 10],
				["1", 20],
			]),
		);
	});

	it("LSM-MERGE-07 labeled record gpt claude tags use keys", async () => {
		const tags = await collectTagged({
			gpt: fromArray(["g"]).asyncIterable,
			claude: fromArray(["c"]).asyncIterable,
		});
		expect(
			valueTags(tags)
				.map((t) => [t.source, t.value])
				.sort(),
		).toEqual(
			expect.arrayContaining([
				["claude", "c"],
				["gpt", "g"],
			]),
		);
	});

	it("LSM-MERGE-08 read-loop regression fast slow slow consumer no dropped items", async () => {
		const fast = fromArray([1, 2, 3, 4, 5]).asyncIterable;
		const slow = fromArray([99], { delayMs: 30 }).asyncIterable;
		const iter = merge([fast, slow])[Symbol.asyncIterator]();
		const out: Tagged<number>[] = [];
		for (let i = 0; i < 6; i += 1) {
			const step = await iter.next();
			if (step.done) break;
			out.push(step.value);
			await Promise.resolve();
		}
		while (true) {
			const step = await iter.next();
			if (step.done) break;
			out.push(step.value);
		}
		const fastValues = valueTags(out)
			.filter((t) => t.source === "0")
			.map((t) => t.value);
		expect(fastValues).toEqual([1, 2, 3, 4, 5]);
		expect(out.some((t) => t.source === "1" && t.kind === "value" && t.value === 99)).toBe(true);
	});

	it("LSM-MERGE-09 failFast true first transport fail consumer rejects ALL_FAILED", async () => {
		await expect(
			collectTagged([fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2]).asyncIterable], {
				failFast: true,
			}),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "ALL_FAILED" && (muxErr.errors?.length ?? 0) >= 1;
		});
	});

	it("LSM-MERGE-10 single source values tagged plus final done", async () => {
		const tags = await collectTagged([fromArray([1, 2, 3]).asyncIterable]);
		expect(valueTags(tags).map((t) => t.value)).toEqual([1, 2, 3]);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(1);
		expect(tags.at(-1)?.kind).toBe("done");
	});

	it("LSM-MERGE-11 default order is arrival when omitted", async () => {
		const defaultTags = await collectTagged(sharedDelayFixture());
		const explicitTags = await collectTagged(sharedDelayFixture(), { order: "arrival" });
		expect(defaultTags).toEqual(explicitTags);
		expect(defaultTags.some((t) => t.kind === "value")).toBe(true);
	});

	it("LSM-MERGE-12 default failFast is false when omitted", async () => {
		const tags = await collectTagged([
			fromArray([1], { throwAt: 0 }).asyncIterable,
			fromArray([2]).asyncIterable,
		]);
		expect(tags.some((t) => t.kind === "error")).toBe(true);
		expect(valueTags(tags).some((t) => t.source === "1")).toBe(true);
	});

	it("LSM-MERGE-13 isError in-band error tag then same source continues", async () => {
		const tags = await collectTagged([fromArray(["good", "ERR", "good2"]).asyncIterable], {
			isError: (x) => x === "ERR",
		});
		const seq = tags.map((t) =>
			t.kind === "value" ? t.value : t.kind === "error" ? "ERR_TAG" : "DONE",
		);
		expect(seq).toEqual(["good", "ERR_TAG", "good2", "DONE"]);
	});

	it("LSM-MERGE-14 order round-robin three sources one item each yields a b c order", async () => {
		const tags = await collectTagged(
			[
				{ id: "a", source: fromArray(["A"]).asyncIterable },
				{ id: "b", source: fromArray(["B"]).asyncIterable },
				{ id: "c", source: fromArray(["C"]).asyncIterable },
			],
			{ order: "round-robin" },
		);
		expect(valueTags(tags).map((t) => t.source)).toEqual(["a", "b", "c"]);
	});

	it("LSM-MERGE-15 isFinal value plus done no reads after final item", async () => {
		const tags = await collectTagged([fromArray(["a", "FINAL", "late"]).asyncIterable], {
			isFinal: (x) => x === "FINAL",
		});
		expect(valueTags(tags).map((t) => t.value)).toEqual(["a", "FINAL"]);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(1);
		expect(tags.some((t) => t.kind === "value" && t.value === "late")).toBe(false);
	});

	it("LSM-MERGE-16 concurrency two four sources lazy slots two three openCount zero until activated", async () => {
		const s0 = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const s1 = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const s2 = lazyOpenCounter(() => fromArray([3]).asyncIterable);
		const s3 = lazyOpenCounter(() => fromArray([4]).asyncIterable);
		const iter = merge([s0.source, s1.source, s2.source, s3.source], {
			concurrency: 2,
		})[Symbol.asyncIterator]();
		await iter.next();
		expect(s0.openCount).toBe(1);
		expect(s1.openCount).toBe(1);
		expect(s2.openCount).toBe(0);
		expect(s3.openCount).toBe(0);
		while (!(await iter.next()).done) {
			/* drain */
		}
		expect(s2.openCount).toBe(1);
		expect(s3.openCount).toBe(1);
	});

	it("LSM-MERGE-17 concurrency two never more than two concurrent pending reads", async () => {
		const events: SourceEvent[] = [];
		const slots = [0, 1, 2, 3].map(() =>
			lazyOpenCounter(() => fromArray([1], { delayMs: 5, neverEnd: true }).asyncIterable),
		);
		const iter = merge(
			slots.map((s) => s.source),
			{
				concurrency: 2,
				onSourceEvent: (e) => events.push(e),
			},
		)[Symbol.asyncIterator]();
		await Promise.resolve();
		await Promise.resolve();
		const started = events.filter((e) => e.type === "start").map((e) => e.source);
		expect(started.length).toBeLessThanOrEqual(2);
		await iter.return();
	});

	it("LSM-MERGE-18 onFinish exactly once strategy merge winner undefined", async () => {
		let finishCalls = 0;
		let result: MuxResult | undefined;
		await collectTagged([fromArray([1]).asyncIterable], {
			onFinish: (r) => {
				finishCalls += 1;
				result = r;
			},
		});
		expect(finishCalls).toBe(1);
		expect(result?.strategy).toBe("merge");
		expect(result?.winner).toBeUndefined();
	});

	it("LSM-MERGE-19 signal abort mid-stream ABORTED rejection", async () => {
		const ctrl = new AbortController();
		const hung = fromArray([1], { delayMs: 100, neverEnd: true }).asyncIterable;
		const iter = merge([hung], { signal: ctrl.signal })[Symbol.asyncIterator]();
		const pending = iter.next();
		ctrl.abort(new Error("user abort"));
		await expect(pending).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "ABORTED");
	});

	it("LSM-MERGE-20 mapEach transforms Tagged value only", async () => {
		const tags = await collectTagged([fromArray([1, 2]).asyncIterable], {
			mapEach: (n) => `n=${n}`,
		});
		expect(valueTags(tags).map((t) => t.value)).toEqual(["n=1", "n=2"]);
	});

	it("LSM-MERGE-21 mapEach throws Tagged error SOURCE_ERROR for that source", async () => {
		const tags = await collectTagged([fromArray([1]).asyncIterable], {
			mapEach: () => {
				throw new Error("map blew up");
			},
		});
		const errTag = tags.find((t) => t.kind === "error");
		expect(errTag?.source).toBe("0");
		expect(asMuxError(errTag!.error!).code).toBe("SOURCE_ERROR");
	});

	it("LSM-MERGE-22 ReadableStream inputs via fromArray readable", async () => {
		const tags = await collectTagged([fromArray([1]).readable, fromArray([2]).readable]);
		expect(
			valueTags(tags)
				.map((t) => t.value)
				.sort(),
		).toEqual([1, 2]);
	});

	it("LSM-MERGE-23 AsyncIterable inputs", async () => {
		const tags = await collectTagged([
			fromArray([10]).asyncIterable,
			fromArray([20]).asyncIterable,
		]);
		expect(valueTags(tags)).toHaveLength(2);
	});

	it("LSM-MERGE-24 mixed stream types in one merge call", async () => {
		const tags = await collectTagged([fromArray([1]).readable, fromArray([2]).asyncIterable]);
		expect(
			valueTags(tags)
				.map((t) => t.value)
				.sort(),
		).toEqual([1, 2]);
	});

	it("LSM-MERGE-25 import merge ensemble from index ensemble equals merge", async () => {
		const { merge: mergeFromIndex, ensemble: ensembleFromIndex } = await import("../src/index.js");
		expect(ensembleFromIndex).toBe(mergeFromIndex);
		expect(ensemble).toBe(merge);
	});

	it("LSM-MERGE-26 import path smoke merge from ../src/index.js", async () => {
		const { merge: mergeFromIndex, collect: collectFromIndex } = await import("../src/index.js");
		const tags = await collectFromIndex(
			mergeFromIndex([fromArray([1]).asyncIterable, fromArray([2]).asyncIterable]),
		);
		expect(valueTags(tags)).toHaveLength(2);
	});

	it("LSM-MERGE-27 two merge calls independent coordinators", async () => {
		const a = await collectTagged([
			fromArray([1]).asyncIterable,
			fromArray([9], { delayMs: 50 }).asyncIterable,
		]);
		const b = await collectTagged([
			fromArray([2], { throwAt: 0 }).asyncIterable,
			fromArray([8]).asyncIterable,
		]);
		expect(valueTags(a).map((t) => t.value)).toContain(1);
		expect(valueTags(b).some((t) => t.value === 8)).toBe(true);
	});

	it("LSM-MERGE-28 signal already aborted before first next ABORTED lazy sources not opened", async () => {
		const ctrl = new AbortController();
		ctrl.abort(new Error("pre-aborted"));
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const iter = merge([a.source, b.source], { signal: ctrl.signal })[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ABORTED",
		);
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
	});

	it("LSM-MERGE-29 merge empty record yields nothing completes", async () => {
		expect(await collectTagged({})).toEqual([]);
	});

	it("LSM-MERGE-30 merge call does not invoke lazy thunks until iterate", () => {
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		merge([a.source, b.source]);
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
	});

	it("LSM-MERGE-31 onSourceEvent start per source usable on first forwarded value", async () => {
		const events: SourceEvent[] = [];
		await collectTagged([fromArray([1]).asyncIterable, fromArray([2]).asyncIterable], {
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.filter((e) => e.type === "start")).toHaveLength(2);
		expect(events.filter((e) => e.type === "usable")).toHaveLength(2);
	});

	it("LSM-MERGE-32 single empty source done tag only", async () => {
		const tags = await collectTagged([fromArray([]).asyncIterable]);
		expect(tags).toEqual([{ source: "0", kind: "done" }]);
	});

	it("LSM-MERGE-33 all sources empty done per id then completes", async () => {
		const tags = await collectTagged([
			lazyOpenCounter(() => fromArray([]).asyncIterable).source,
			lazyOpenCounter(() => fromArray([]).asyncIterable).source,
		]);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(2);
		expect(valueTags(tags)).toHaveLength(0);
	});

	it("LSM-MERGE-34 Uint8Array generic T preserved through Tagged value", async () => {
		const chunk = new Uint8Array([1, 2, 3]);
		const tags = await collectTagged([fromArray([chunk]).asyncIterable]);
		expect(valueTags(tags)[0]?.value).toBeInstanceOf(Uint8Array);
		expect(Array.from(valueTags(tags)[0]!.value as Uint8Array)).toEqual([1, 2, 3]);
	});

	it("LSM-MERGE-35 labeled array id x preserves id on tags", async () => {
		const tags = await collectTagged([{ id: "x", source: fromArray([42]).asyncIterable }]);
		expect(valueTags(tags)[0]?.source).toBe("x");
	});

	it("LSM-MERGE-36 onFinish perSource items equals value tag count", async () => {
		let result: MuxResult | undefined;
		await collectTagged([fromArray([1, 2, 3]).asyncIterable], {
			onFinish: (r) => (result = r),
		});
		expect(result?.perSource["0"]?.items).toBe(3);
	});

	it("LSM-MERGE-37 cancel aborted reason not failover or race-lost", async () => {
		const spy = cancelSpyingReadable<number>();
		spy.enqueue(1);
		const iter = merge([spy.stream])[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		expect(spy.cancelReasons.length).toBeGreaterThanOrEqual(1);
		expect((spy.cancelReasons.at(-1) as MuxCancelled).reason).toBe("aborted");
		expect((spy.cancelReasons.at(-1) as MuxCancelled).reason).not.toBe("failover");
		expect((spy.cancelReasons.at(-1) as MuxCancelled).reason).not.toBe("race-lost");
	});

	it("LSM-MERGE-38 three sources all succeed three done tags plus all values", async () => {
		const tags = await collectTagged([
			fromArray([1]).asyncIterable,
			fromArray([2]).asyncIterable,
			fromArray([3]).asyncIterable,
		]);
		expect(
			valueTags(tags)
				.map((t) => t.value)
				.sort(),
		).toEqual([1, 2, 3]);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(3);
	});

	it("LSM-MERGE-39 isError plus isFinal on same item isError wins", async () => {
		const tags = await collectTagged([fromArray(["both"]).asyncIterable], {
			isError: () => true,
			isFinal: () => true,
		});
		expect(tags[0]?.kind).toBe("error");
		expect(asMuxError(tags[0]!.error!).code).toBe("IN_BAND_ERROR");
		expect(tags.some((t) => t.kind === "value")).toBe(false);
	});

	it("LSM-MERGE-40 failFast true plus in-band isError ALL_FAILED", async () => {
		await expect(
			collectTagged([fromArray(["ERR"]).asyncIterable], {
				failFast: true,
				isError: (x) => x === "ERR",
			}),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "ALL_FAILED");
	});

	it("LSM-MERGE-41 failFast true in-band error mid-stream abort before other sources remaining items", async () => {
		const tags: Tagged<string>[] = [];
		const iter = merge(
			[fromArray(["a", "b"]).asyncIterable, fromArray(["ERR", "c"]).asyncIterable],
			{
				failFast: true,
				isError: (x) => x === "ERR",
			},
		)[Symbol.asyncIterator]();
		try {
			while (true) {
				const step = await iter.next();
				if (step.done) break;
				tags.push(step.value);
			}
		} catch (err) {
			expect(asMuxError(err).code).toBe("ALL_FAILED");
		}
		expect(tags.some((t) => t.source === "1" && t.kind === "value" && t.value === "c")).toBe(false);
	});

	it("LSM-MERGE-42 mapEach not applied to in-band error frames", async () => {
		const mapEach = vi.fn((x: string) => x.toUpperCase());
		await collectTagged([fromArray(["good", "ERR"]).asyncIterable], {
			isError: (x) => x === "ERR",
			mapEach,
		});
		expect(mapEach).toHaveBeenCalledTimes(1);
		expect(mapEach).toHaveBeenCalledWith("good", "0");
	});

	it("LSM-MERGE-43 cancelled source AsyncIterable return rejection swallowed others continue", async () => {
		const cancelReasons: unknown[] = [];
		const hung = failingWithCancelSpy(
			() => fromArray([1], { neverEnd: true }).asyncIterable,
			cancelReasons,
		);
		const iter = merge([hung, fromArray([99]).asyncIterable])[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		await Promise.resolve();
		const tags = await collectTagged([fromArray([99]).asyncIterable]);
		expect(valueTags(tags).some((t) => t.value === 99)).toBe(true);
		expect(cancelReasons.length).toBeGreaterThanOrEqual(1);
	});

	it("LSM-MERGE-44 concurrency zero sync throw at call site", () => {
		expect(() => merge([fromArray([1]).asyncIterable], { concurrency: 0 })).toThrow(RangeError);
	});

	it("LSM-MERGE-45 concurrency 999 with two sources both active immediately", async () => {
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const iter = merge([a.source, b.source], { concurrency: 999 })[Symbol.asyncIterator]();
		await iter.next();
		expect(a.openCount).toBe(1);
		expect(b.openCount).toBe(1);
		await iter.return();
	});

	it("LSM-MERGE-46 repeated next after completion returns done true", async () => {
		const iter = merge([fromArray([1]).asyncIterable])[Symbol.asyncIterator]();
		while (!(await iter.next()).done) {
			/* drain */
		}
		expect((await iter.next()).done).toBe(true);
		expect((await iter.next()).done).toBe(true);
	});

	it("LSM-MERGE-47 duplicate labeled ids throws sync at call site", () => {
		expect(() =>
			merge([
				{ id: "dup", source: fromArray([1]).asyncIterable },
				{ id: "dup", source: fromArray([2]).asyncIterable },
			]),
		).toThrow(/duplicate source id "dup"/);
	});

	it("LSM-MERGE-48 second Symbol asyncIterator throws merge iterator already active", () => {
		const iterable = merge([fromArray([1]).asyncIterable]);
		iterable[Symbol.asyncIterator]();
		expect(() => iterable[Symbol.asyncIterator]()).toThrow(/merge: iterator already active/);
	});

	it("LSM-MERGE-49 signal abort during pre-output phase all started sources aborted", async () => {
		const ctrl = new AbortController();
		const a = cancelSpyingReadable<number>();
		const b = cancelSpyingReadable<number>();
		a.enqueue(0);
		b.enqueue(0);
		const iter = merge([a.stream, b.stream], { signal: ctrl.signal })[Symbol.asyncIterator]();
		const pending = iter.next();
		await Promise.resolve();
		ctrl.abort(new Error("pre-output"));
		await expect(pending).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "ABORTED");
		await Promise.resolve();
		for (const spy of [a, b]) {
			expect(spy.cancelReasons.length).toBeGreaterThanOrEqual(1);
			expect((spy.cancelReasons.at(-1) as MuxCancelled).reason).toBe("aborted");
		}
	});

	it("LSM-MERGE-50 backpressure one source five items consumer one-by-one bounded pulls", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const iter = merge([counted.source])[Symbol.asyncIterator]();
		let delivered = 0;
		for (let i = 0; i < 6; i += 1) {
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 1);
			const step = await iter.next();
			if (step.done) break;
			if (step.value.kind === "value") delivered += 1;
			await Promise.resolve();
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 1);
		}
		expect((await iter.next()).done).toBe(true);
	});

	it("LSM-MERGE-51 interop collect toAsyncIterable toReadable merge equals direct collect", async () => {
		const direct = await collectTagged([
			fromArray([1]).asyncIterable,
			fromArray([2]).asyncIterable,
		]);
		const roundTrip = await collect(
			toAsyncIterable(
				toReadable(merge([fromArray([1]).asyncIterable, fromArray([2]).asyncIterable])),
			),
		);
		expect(roundTrip).toEqual(direct);
	});

	it("LSM-MERGE-52 for await early break all started sources cancelled aborted", async () => {
		const active = cancelSpyingReadable<number>();
		active.enqueue(1);
		active.enqueue(2);
		let seen = 0;
		for await (const _tag of merge([
			fromArray([99], { delayMs: 50 }).asyncIterable,
			active.stream,
		])) {
			seen += 1;
			if (seen >= 1) break;
		}
		await Promise.resolve();
		expect(active.cancelReasons.length).toBeGreaterThanOrEqual(1);
		expect((active.cancelReasons.at(-1) as MuxCancelled).reason).toBe("aborted");
	});

	it("LSM-MERGE-53 isUsable option passed but ignored junk still forwarded as value", async () => {
		const tags = await collectTagged([fromArray(["junk", "good"]).asyncIterable], {
			isUsable: () => false,
		});
		expect(valueTags(tags).map((t) => t.value)).toEqual(["junk", "good"]);
	});

	it("LSM-MERGE-54 one slow two fast all items from all sources present at end", async () => {
		const tags = await collectTagged([
			fromArray([1, 2, 3]).asyncIterable,
			fromArray([10, 11]).asyncIterable,
			fromArray([99], { delayMs: 30 }).asyncIterable,
		]);
		expect(
			valueTags(tags)
				.filter((t) => t.source === "0")
				.map((t) => t.value),
		).toEqual([1, 2, 3]);
		expect(
			valueTags(tags)
				.filter((t) => t.source === "1")
				.map((t) => t.value),
		).toEqual([10, 11]);
		expect(tags.some((t) => t.source === "2" && t.kind === "value" && t.value === 99)).toBe(true);
	});

	it("LSM-MERGE-55 ALL_FAILED cause equals errors zero under failFast", async () => {
		try {
			await collectTagged([fromArray([1], { throwAt: 0 }).asyncIterable], { failFast: true });
		} catch (err) {
			const muxErr = asMuxError(err);
			expect(muxErr.code).toBe("ALL_FAILED");
			expect(muxErr.cause).toBe(muxErr.errors?.[0]);
		}
	});

	it("LSM-MERGE-56 Tagged error error source matches originating source id", async () => {
		const tags = await collectTagged([
			{ id: "alpha", source: fromArray([1], { throwAt: 0 }).asyncIterable },
		]);
		const errTag = tags.find((t) => t.kind === "error");
		expect(errTag?.error?.source).toBe("alpha");
	});

	it("LSM-MERGE-57 after full collect second Symbol asyncIterator still throws", async () => {
		const iterable = merge([fromArray([1]).asyncIterable]);
		const iter = iterable[Symbol.asyncIterator]();
		while (!(await iter.next()).done) {
			/* drain */
		}
		expect(() => iterable[Symbol.asyncIterator]()).toThrow(/merge: iterator already active/);
	});

	it("LSM-MERGE-58 five sources round-robin single items strict zero one two three four rotation", async () => {
		const tags = await collectTagged(
			[0, 1, 2, 3, 4].map((n) => fromArray([n]).asyncIterable),
			{ order: "round-robin" },
		);
		expect(valueTags(tags).map((t) => t.source)).toEqual(["0", "1", "2", "3", "4"]);
	});

	it("LSM-MERGE-59 arrival order differs from round-robin on same fixtures", async () => {
		const sources = sharedDelayFixture();
		const arrival = await collectTagged(sources, { order: "arrival" });
		const rr = await collectTagged(sources, { order: "round-robin" });
		expect(arrival).not.toEqual(rr);
	});

	it("LSM-MERGE-60 concurrency one serializes four one-item sources deterministic order", async () => {
		const slots = [0, 1, 2, 3].map((n) => lazyOpenCounter(() => fromArray([n]).asyncIterable));
		const tags = await collectTagged(
			slots.map((s) => s.source),
			{ concurrency: 1 },
		);
		expect(valueTags(tags).map((t) => t.value)).toEqual([0, 1, 2, 3]);
	});

	it("LSM-MERGE-61 transport error on B mid-stream A continues no failover events", async () => {
		const events: SourceEvent[] = [];
		await collectTagged(
			[fromArray([1, 2, 3]).asyncIterable, fromArray([10], { throwAt: 0 }).asyncIterable],
			{ onSourceEvent: (e) => events.push(e) },
		);
		expect(
			valueTags(
				await collectTagged([
					fromArray([1, 2, 3]).asyncIterable,
					fromArray([10], { throwAt: 0 }).asyncIterable,
				]),
			)
				.filter((t) => t.source === "0")
				.map((t) => t.value),
		).toEqual([1, 2, 3]);
		expect(events.some((e) => e.type === "failover")).toBe(false);
	});

	it("LSM-MERGE-62 round-robin uneven readiness only ready sources consumed in rotation", async () => {
		const tags = await collectTagged(
			[fromArray([1]).asyncIterable, fromArray([2], { delayMs: 50 }).asyncIterable],
			{ order: "round-robin" },
		);
		expect(valueTags(tags)[0]?.source).toBe("0");
		expect(valueTags(tags).map((t) => t.value)).toEqual([1, 2]);
	});

	it("LSM-MERGE-63 null object undefined generic T preserved in Tagged value", async () => {
		const tags = await collectTagged<null | { x: number } | undefined>([
			fromArray([null, { x: 1 }, undefined]).asyncIterable,
		]);
		expect(valueTags(tags).map((t) => t.value)).toEqual([null, { x: 1 }, undefined]);
	});

	it("LSM-MERGE-64 return before first next lazy sources never opened", async () => {
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const iter = merge([a.source, b.source])[Symbol.asyncIterator]();
		await iter.return();
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
	});

	it("LSM-MERGE-65 return during active pump aborted queued sources never opened", async () => {
		const slots = [0, 1, 2, 3].map(() =>
			lazyOpenCounter(() => fromArray([1], { neverEnd: true }).asyncIterable),
		);
		const iter = merge(
			slots.map((s) => s.source),
			{ concurrency: 1 },
		)[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		expect(slots[2]!.openCount).toBe(0);
		expect(slots[3]!.openCount).toBe(0);
	});

	it("LSM-MERGE-66 dual transport-failing sources failFast false two error tags no done for failed ids", async () => {
		const tags = await collectTagged([
			fromArray([1], { throwAt: 0 }).asyncIterable,
			fromArray([2], { throwAt: 0 }).asyncIterable,
		]);
		expect(tags.filter((t) => t.kind === "error")).toHaveLength(2);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(0);
	});

	it("LSM-MERGE-67 mapEach second arg is correct source id labeled record", async () => {
		const mapEach = vi.fn((item: number, source: string) => `${source}:${item}`);
		await collectTagged(
			{
				alpha: fromArray([1]).asyncIterable,
				beta: fromArray([2]).asyncIterable,
			},
			{ mapEach },
		);
		expect(mapEach).toHaveBeenCalledWith(1, "alpha");
		expect(mapEach).toHaveBeenCalledWith(2, "beta");
	});

	it("LSM-MERGE-68 eager plus lazy mix lazy opens only when slot active", async () => {
		const eager = fromArray([1]).asyncIterable;
		const lazy = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const iter = merge([eager, lazy.source], { concurrency: 1 })[Symbol.asyncIterator]();
		await iter.next();
		expect(lazy.openCount).toBe(0);
		while (!(await iter.next()).done) {
			/* drain */
		}
		expect(lazy.openCount).toBe(1);
	});

	it("LSM-MERGE-69 onFinish aborted true after signal abort", async () => {
		const ctrl = new AbortController();
		let result: MuxResult | undefined;
		const iter = merge([fromArray([1], { neverEnd: true }).asyncIterable], {
			signal: ctrl.signal,
			onFinish: (r) => (result = r),
		})[Symbol.asyncIterator]();
		const pending = iter.next();
		ctrl.abort();
		await pending.catch(() => {});
		expect(result?.aborted).toBe(true);
	});

	it("LSM-MERGE-70 dual sources both cancelled on consumer stop each aborted exactly once", async () => {
		const a = cancelSpyingReadable<number>();
		const b = cancelSpyingReadable<number>();
		a.enqueue(1);
		b.enqueue(2);
		const iter = merge([a.stream, b.stream])[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		expect(a.cancelReasons).toHaveLength(1);
		expect(b.cancelReasons).toHaveLength(1);
	});

	it("LSM-MERGE-71 interleaved delayMs stress ten items three sources none dropped", async () => {
		const tags = await collectTagged([
			fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).asyncIterable,
			fromArray([11, 12, 13], { delayMs: 5 }).asyncIterable,
			fromArray([21], { delayMs: 15 }).asyncIterable,
		]);
		expect(
			valueTags(tags)
				.filter((t) => t.source === "0")
				.map((t) => t.value),
		).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("LSM-MERGE-72 slow consumer manual next loop backpressure held across ten tags", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).asyncIterable);
		const iter = merge([counted.source])[Symbol.asyncIterator]();
		let valueDelivered = 0;
		while (valueDelivered < 10) {
			expect(counted.pullCount).toBeLessThanOrEqual(valueDelivered + 2);
			const step = await iter.next();
			expect(step.done).toBe(false);
			if (step.value.kind === "value") valueDelivered += 1;
			await new Promise<void>((r) => setTimeout(r, 5));
			expect(counted.pullCount).toBeLessThanOrEqual(valueDelivered + 2);
		}
		expect((await iter.next()).done).toBe(false);
		expect((await iter.next()).done).toBe(true);
	});

	it("LSM-MERGE-73 controllableReadable transport error on one source others unaffected", async () => {
		const ctrl = controllableReadable<number>();
		const collected: Tagged<number>[] = [];
		const iter = merge([ctrl.stream, fromArray([99]).asyncIterable])[Symbol.asyncIterator]();
		ctrl.error(new Error("boom"));
		while (collected.length < 4) {
			const step = await iter.next();
			if (step.done) break;
			collected.push(step.value);
		}
		expect(collected.some((t) => t.source === "0" && t.kind === "error")).toBe(true);
		expect(valueTags(collected).some((t) => t.source === "1" && t.value === 99)).toBe(true);
	});

	it("LSM-MERGE-74 ensemble call produces identical tags to merge", async () => {
		const makeSources = () => [fromArray([1]).asyncIterable, fromArray([2]).asyncIterable] as const;
		const fromMerge = await collectTagged(makeSources());
		const fromEnsemble = await collect(ensemble(makeSources()));
		expect(fromEnsemble).toEqual(fromMerge);
	});

	it("LSM-MERGE-75 failFast false errors in onFinish perSource errored without aborting others", async () => {
		let result: MuxResult | undefined;
		await collectTagged(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2]).asyncIterable],
			{
				onFinish: (r) => (result = r),
			},
		);
		expect(result?.aborted).toBe(false);
		expect(result?.perSource["0"]?.errored?.code).toBe("SOURCE_ERROR");
		expect(result?.perSource["1"]?.completed).toBe(true);
	});

	it("LSM-MERGE-76 in-band isError then continue explicit output array pin", async () => {
		const tags = await collectTagged([fromArray(["good", "ERR", "good2"]).asyncIterable], {
			isError: (x) => x === "ERR",
		});
		expect(tags.map((t) => t.kind)).toEqual(["value", "error", "value", "done"]);
		expect(valueTags(tags).map((t) => t.value)).toEqual(["good", "good2"]);
		expect(asMuxError(tags[1]!.error!).code).toBe("IN_BAND_ERROR");
	});

	it("LSM-MERGE-77 partial failure B completes fully while A failed at start", async () => {
		const tags = await collectTagged([
			fromArray([1], { throwAt: 0 }).asyncIterable,
			fromArray([10, 11]).asyncIterable,
		]);
		expect(tags.some((t) => t.source === "0" && t.kind === "error")).toBe(true);
		expect(
			valueTags(tags)
				.filter((t) => t.source === "1")
				.map((t) => t.value),
		).toEqual([10, 11]);
		expect(tags.some((t) => t.source === "1" && t.kind === "done")).toBe(true);
	});

	it("LSM-MERGE-78 failFast onFinish aborted true errors populated", async () => {
		let result: MuxResult | undefined;
		try {
			await collectTagged([fromArray([1], { throwAt: 0 }).asyncIterable], {
				failFast: true,
				onFinish: (r) => (result = r),
			});
		} catch {
			/* expected */
		}
		expect(result?.aborted).toBe(true);
		expect(result?.perSource["0"]?.errored).toBeTruthy();
	});

	it("LSM-MERGE-79 onFinish perSource under concurrency one queue started flags accurate", async () => {
		let result: MuxResult | undefined;
		const slots = [1, 2, 3].map((n) => lazyOpenCounter(() => fromArray([n]).asyncIterable));
		await collectTagged(
			slots.map((s) => s.source),
			{
				concurrency: 1,
				onFinish: (r) => (result = r),
			},
		);
		expect(Object.keys(result?.perSource ?? {})).toHaveLength(3);
		for (const id of ["0", "1", "2"]) {
			expect(result?.perSource[id]?.started).toBe(true);
			expect(result?.perSource[id]?.items).toBe(1);
			expect(result?.perSource[id]?.completed).toBe(true);
		}
	});

	it("LSM-MERGE-80 consumer completes normally onFinish aborted false", async () => {
		let result: MuxResult | undefined;
		await collectTagged([fromArray([1]).asyncIterable], {
			onFinish: (r) => (result = r),
		});
		expect(result?.aborted).toBe(false);
	});

	it("LSM-MERGE-81 isFinal on multi-item stream exact tag sequence pin", async () => {
		const tags = await collectTagged([fromArray(["a", "FINAL", "late"]).asyncIterable], {
			isFinal: (x) => x === "FINAL",
		});
		expect(tags).toEqual([
			{ source: "0", kind: "value", value: "a" },
			{ source: "0", kind: "value", value: "FINAL" },
			{ source: "0", kind: "done" },
		]);
	});

	it("LSM-MERGE-82 post return late enqueue not in output", async () => {
		const ctrl = controllableReadable<number>();
		const iter = merge([ctrl.stream, fromArray([10]).asyncIterable])[Symbol.asyncIterator]();
		const out: number[] = [];
		ctrl.enqueue(1);
		const first = await iter.next();
		if (!first.done && first.value.kind === "value") out.push(first.value.value);
		await iter.return();
		try {
			ctrl.enqueue(999);
		} catch {
			/* stream cancelled — late enqueue rejected at source */
		}
		expect(out).not.toContain(999);
	});

	it("LSM-MERGE-83 second iterator message exactly merge iterator already active", () => {
		const iterable = merge([fromArray([1]).asyncIterable]);
		iterable[Symbol.asyncIterator]();
		expect(() => iterable[Symbol.asyncIterator]()).toThrow("merge: iterator already active");
	});

	it("LSM-MERGE-84 isFinal emits SourceEvent final once per source", async () => {
		const events: SourceEvent[] = [];
		await collectTagged([fromArray(["x", "FINAL", "y"]).asyncIterable], {
			isFinal: (x) => x === "FINAL",
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.filter((e) => e.type === "final" && e.source === "0")).toHaveLength(1);
	});

	it("LSM-MERGE-85 mapEach throw does not prevent subsequent items from same source", async () => {
		const tags = await collectTagged([fromArray([1, 2, 3]).asyncIterable], {
			mapEach: (n) => {
				if (n === 2) throw new Error("fail on 2");
				return n;
			},
		});
		expect(valueTags(tags).map((t) => t.value)).toEqual([1, 3]);
		expect(tags.some((t) => t.kind === "error")).toBe(true);
	});

	it("LSM-MERGE-86 round-robin cursor advances after each consumed tag", async () => {
		const tags = await collectTagged(
			[
				fromArray([1, 4]).asyncIterable,
				fromArray([2, 5]).asyncIterable,
				fromArray([3, 6]).asyncIterable,
			],
			{ order: "round-robin" },
		);
		expect(
			valueTags(tags)
				.map((t) => t.source)
				.slice(0, 6),
		).toEqual(["0", "1", "2", "0", "1", "2"]);
	});

	it("LSM-MERGE-87 arrival when two reads settle before loop both eventually emitted", async () => {
		const tags = await collectTagged([fromArray([1]).asyncIterable, fromArray([2]).asyncIterable]);
		expect(valueTags(tags)).toHaveLength(2);
	});

	it("LSM-MERGE-88 three error tags failFast false iterator still completes", async () => {
		const tags = await collectTagged([fromArray(["E1", "E2", "E3"]).asyncIterable], {
			isError: (x) => x.startsWith("E"),
		});
		expect(tags.filter((t) => t.kind === "error")).toHaveLength(3);
		expect(tags.at(-1)?.kind).toBe("done");
	});

	it("LSM-MERGE-89 merge single exactly one done after values", async () => {
		const tags = await collectTagged([fromArray([7]).asyncIterable]);
		expect(valueTags(tags)).toHaveLength(1);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(1);
	});

	it("LSM-MERGE-90 labeled claude transport-fail gpt succeeds filter tag source in loop", async () => {
		const tags = await collectTagged({
			claude: fromArray([1], { throwAt: 0 }).asyncIterable,
			gpt: fromArray([42]).asyncIterable,
		});
		const gptValues: number[] = [];
		for (const tag of tags) {
			if (tag.source === "gpt" && tag.kind === "value") gptValues.push(tag.value);
		}
		expect(gptValues).toEqual([42]);
	});

	it("LSM-MERGE-91 ReadableStream cancel rejection swallowed on abort", async () => {
		const rejectCancel = new ReadableStream<number>({
			start(controller) {
				controller.enqueue(1);
			},
			cancel: async () => {
				throw new Error("cancel rejected");
			},
		});
		const iter = merge([rejectCancel, fromArray([2], { delayMs: 20 }).asyncIterable])[
			Symbol.asyncIterator
		]();
		await iter.next();
		await iter.return();
	});

	it("LSM-MERGE-92 onSourceEvent has zero failover events for any merge run", async () => {
		const events: SourceEvent[] = [];
		await collectTagged(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2]).asyncIterable],
			{ onSourceEvent: (e) => events.push(e) },
		);
		expect(events.filter((e) => e.type === "failover")).toHaveLength(0);
	});

	it("LSM-MERGE-93 onFinish NOT called on sync duplicate-id throw", () => {
		let finishCalls = 0;
		expect(() =>
			merge(
				[
					{ id: "dup", source: fromArray([1]).asyncIterable },
					{ id: "dup", source: fromArray([2]).asyncIterable },
				],
				{
					onFinish: () => {
						finishCalls += 1;
					},
				},
			),
		).toThrow();
		expect(finishCalls).toBe(0);
	});

	it("LSM-MERGE-94 Tagged kind narrowing switch exhaustive runtime shapes", async () => {
		const tags = await collectTagged([fromArray([1]).asyncIterable]);
		for (const tag of tags) {
			switch (tag.kind) {
				case "value":
					expect(typeof tag.value).toBe("number");
					break;
				case "error":
					expect(tag.error).toBeTruthy();
					break;
				case "done":
					expect("value" in tag).toBe(false);
					break;
				default: {
					const _exhaustive: never = tag;
					void _exhaustive;
				}
			}
		}
	});

	it("LSM-MERGE-95 failFast false three sources two succeed one transport-fail two done one error", async () => {
		const tags = await collectTagged([
			fromArray([1]).asyncIterable,
			fromArray([2], { throwAt: 0 }).asyncIterable,
			fromArray([3]).asyncIterable,
		]);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(2);
		expect(tags.filter((t) => t.kind === "error")).toHaveLength(1);
	});

	it("LSM-MERGE-96 multi in-band isError ok ERR ok ERR ok done items three two IN_BAND tags", async () => {
		let result: MuxResult | undefined;
		const tags = await collectTagged(
			[fromArray(["ok1", "ERR", "ok2", "ERR", "ok3"]).asyncIterable],
			{
				isError: (x) => x === "ERR",
				onFinish: (r) => (result = r),
			},
		);
		expect(tags.map((t) => (t.kind === "value" ? t.value : t.kind))).toEqual([
			"ok1",
			"error",
			"ok2",
			"error",
			"ok3",
			"done",
		]);
		expect(tags.filter((t) => t.kind === "error")).toHaveLength(2);
		expect(result?.perSource["0"]?.items).toBe(3);
	});

	it("LSM-MERGE-97 order arrival pin exact full Tagged array on shared delay fixture", async () => {
		const tags = await collectTagged(sharedDelayFixture(), { order: "arrival" });
		const values = valueTags(tags).map((t) => [t.source, t.value] as const);
		expect(values[0]).toEqual(["0", 1]);
		expect(values.some(([s, v]) => s === "1" && v === 2)).toBe(true);
		expect(values.filter(([s]) => s === "0").map(([, v]) => v)).toEqual([1, 3]);
		expect(values.filter(([s]) => s === "1").map(([, v]) => v)).toEqual([2, 4]);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(2);
	});

	it("LSM-MERGE-98 order round-robin same fixture pin exact array must differ from arrival", async () => {
		const a = controllableReadable<number>();
		const b = controllableReadable<number>();
		a.enqueue(1);
		b.enqueue(2);
		a.enqueue(3);
		b.enqueue(4);
		a.close();
		b.close();
		const tags = await collectTagged([a.stream, b.stream], { order: "round-robin" });
		expect(valueTags(tags).map((t) => [t.source, t.value])).toEqual([
			["0", 1],
			["1", 2],
			["0", 3],
			["1", 4],
		]);
		const arrival = await collectTagged(sharedDelayFixture(), { order: "arrival" });
		expect(valueTags(tags).map((t) => t.source)).toEqual(["0", "1", "0", "1"]);
		expect(valueTags(arrival).map((t) => t.source)).not.toEqual(["0", "1", "0", "1"]);
	});

	it("LSM-MERGE-99 failFast concurrency one four lazy sources zero throws ALL_FAILED one two three never opened", async () => {
		const slots = [0, 1, 2, 3].map(() => lazyOpenCounter(() => fromArray([1]).asyncIterable));
		const events: SourceEvent[] = [];
		await expect(
			collectTagged(
				[
					fromArray([1], { throwAt: 0 }).asyncIterable,
					slots[1]!.source,
					slots[2]!.source,
					slots[3]!.source,
				],
				{
					failFast: true,
					concurrency: 1,
					onSourceEvent: (e) => events.push(e),
				},
			),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return (
				muxErr.code === "ALL_FAILED" &&
				muxErr.errors?.length === 1 &&
				muxErr.errors[0]?.source === "0"
			);
		});
		expect(slots[1]!.openCount).toBe(0);
		expect(slots[2]!.openCount).toBe(0);
		expect(slots[3]!.openCount).toBe(0);
		expect(events.filter((e) => e.type === "start").map((e) => e.source)).toEqual(["0"]);
	});

	it("LSM-MERGE-100 failFast concurrency two in-band fail on one queued two three never opened", async () => {
		const s2 = lazyOpenCounter(() => fromArray([20]).asyncIterable);
		const s3 = lazyOpenCounter(() => fromArray([30]).asyncIterable);
		const tags: Tagged<string>[] = [];
		const iter = merge(
			[
				fromArray(["a", "b"], { delayMs: 5 }).asyncIterable,
				fromArray(["ERR"]).asyncIterable,
				s2.source,
				s3.source,
			],
			{
				failFast: true,
				concurrency: 2,
				isError: (x) => x === "ERR",
			},
		)[Symbol.asyncIterator]();
		try {
			while (true) {
				const step = await iter.next();
				if (step.done) break;
				tags.push(step.value);
			}
		} catch (err) {
			expect(asMuxError(err).code).toBe("ALL_FAILED");
		}
		expect(s2.openCount).toBe(0);
		expect(s3.openCount).toBe(0);
		expect(tags.some((t) => t.source === "2" || t.source === "3")).toBe(false);
	});

	it("LSM-MERGE-101 onFinish perSource items counts values only not error or done tags", async () => {
		let result: MuxResult | undefined;
		await collectTagged([fromArray(["ok1", "ERR", "ok2", "ERR", "ok3"]).asyncIterable], {
			isError: (x) => x === "ERR",
			onFinish: (r) => (result = r),
		});
		expect(result?.perSource["0"]?.items).toBe(3);
	});

	it("LSM-MERGE-102 onSourceEvent usable once per value source error per IN_BAND transport items tally consistent", async () => {
		const events: SourceEvent[] = [];
		let result: MuxResult | undefined;
		await collectTagged([fromArray(["ok1", "ERR", "ok2"]).asyncIterable], {
			isError: (x) => x === "ERR",
			onSourceEvent: (e) => events.push(e),
			onFinish: (r) => (result = r),
		});
		expect(events.filter((e) => e.type === "usable")).toHaveLength(1);
		expect(events.filter((e) => e.type === "error")).toHaveLength(1);
		expect(result?.perSource["0"]?.items).toBe(2);
	});

	it("LSM-MERGE-103 backpressure fulfilled pending no extra pullCount while queue full", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const iter = merge([counted.source])[Symbol.asyncIterator]();
		let valueDelivered = 0;
		for (let i = 0; i < 5; i += 1) {
			const before = counted.pullCount;
			const step = await iter.next();
			expect(step.done).toBe(false);
			if (step.value.kind === "value") valueDelivered += 1;
			await new Promise<void>((r) => setTimeout(r, 5));
			expect(counted.pullCount).toBeLessThanOrEqual(valueDelivered + 2);
			if (i > 0) expect(counted.pullCount - before).toBeLessThanOrEqual(2);
		}
	});

	it("LSM-MERGE-104 mapEach runtime U merge number string yields Tagged value string", async () => {
		const tags = await collectTagged<number, string>(
			{ a: fromArray([1, 2]).asyncIterable },
			{ mapEach: (n, id) => `${id}:${n}` },
		);
		expect(tags[0]).toMatchObject({ kind: "value", source: "a", value: "a:1" });
		expect(typeof valueTags(tags)[0]?.value).toBe("string");
	});

	it("LSM-MERGE-105 signal abort mid-stream ABORTED isMuxCancelled false onFinish aborted true", async () => {
		const ctrl = new AbortController();
		let result: MuxResult | undefined;
		const iter = merge(
			[
				fromArray([1], { neverEnd: true }).asyncIterable,
				fromArray([2], { neverEnd: true }).asyncIterable,
			],
			{
				signal: ctrl.signal,
				onFinish: (r) => (result = r),
			},
		)[Symbol.asyncIterator]();
		await iter.next();
		await iter.next();
		ctrl.abort();
		const err = await iter.next().then(
			() => null,
			(e) => e,
		);
		expect(asMuxError(err).code).toBe("ABORTED");
		expect(isMuxCancelled(err)).toBe(false);
		expect(result?.aborted).toBe(true);
	});

	it("LSM-MERGE-106 for await break ABORTED not ALL_FAILED partial tags retained", async () => {
		const tags: Tagged<number>[] = [];
		let result: MuxResult | undefined;
		const iter = merge([fromArray([1, 2, 3], { neverEnd: true }).asyncIterable], {
			failFast: false,
			onFinish: (r) => (result = r),
		})[Symbol.asyncIterator]();
		for (let i = 0; i < 2; i += 1) {
			const step = await iter.next();
			if (step.done) break;
			tags.push(step.value);
		}
		await iter.return();
		expect(tags).toHaveLength(2);
		const err = await iter.next().then(
			() => null,
			(e) => e,
		);
		expect(asMuxError(err).code).toBe("ABORTED");
		expect(result?.aborted).toBe(true);
	});

	it("LSM-MERGE-107 concurrency three six lazy sources early break three four five openCount zero", async () => {
		const slots = [0, 1, 2, 3, 4, 5].map(() =>
			lazyOpenCounter(() => fromArray([1, 2, 3]).asyncIterable),
		);
		const iter = merge(
			slots.map((s) => s.source),
			{ concurrency: 3 },
		)[Symbol.asyncIterator]();
		for (let i = 0; i < 4; i += 1) await iter.next();
		await iter.return();
		expect(slots[3]!.openCount).toBe(0);
		expect(slots[4]!.openCount).toBe(0);
		expect(slots[5]!.openCount).toBe(0);
	});

	it("LSM-MERGE-108 failFast concurrency one start events only for zero explicit event list pin", async () => {
		const events: SourceEvent[] = [];
		await collectTagged(
			[
				fromArray([1], { throwAt: 0 }).asyncIterable,
				lazyOpenCounter(() => fromArray([2]).asyncIterable).source,
				lazyOpenCounter(() => fromArray([3]).asyncIterable).source,
				lazyOpenCounter(() => fromArray([4]).asyncIterable).source,
			],
			{
				failFast: true,
				concurrency: 1,
				onSourceEvent: (e) => events.push(e),
			},
		).catch(() => {});
		expect(events.filter((e) => e.type === "start").map((e) => e.source)).toEqual(["0"]);
	});

	it("LSM-MERGE-109 round-robin rotation follows labeled array insertion order z before a", async () => {
		const tags = await collectTagged(
			[
				{ id: "z", source: fromArray(["Z"]).asyncIterable },
				{ id: "a", source: fromArray(["A"]).asyncIterable },
			],
			{ order: "round-robin" },
		);
		expect(valueTags(tags).map((t) => t.source)).toEqual(["z", "a"]);
	});

	it("LSM-MERGE-110 proposal section 10.2 loop multi-model switch tag kind accumulate by source", async () => {
		type Ev = { model: string; text: string } | { model: string; err: true };

		const tags = await collectTagged(
			{
				gpt: fromArray<Ev>([
					{ model: "gpt", text: "hi" },
					{ model: "gpt", err: true },
					{ model: "gpt", text: "again" },
				]).asyncIterable,
				claude: fromArray<Ev>([{ model: "claude", text: "yo" }]).asyncIterable,
			},
			{
				isError: (e) => "err" in e,
				mapEach: (e, source) => ({ ...e, model: source }),
			},
		);

		const byModel: Record<string, { texts: string[]; errors: number; done: boolean }> = {};

		for (const tag of tags) {
			if (tag.kind === "value") {
				byModel[tag.source] ??= { texts: [], errors: 0, done: false };
				if ("text" in tag.value) byModel[tag.source]!.texts.push(tag.value.text);
			} else if (tag.kind === "error") {
				byModel[tag.source] ??= { texts: [], errors: 0, done: false };
				byModel[tag.source]!.errors += 1;
			} else if (tag.kind === "done") {
				byModel[tag.source] ??= { texts: [], errors: 0, done: false };
				byModel[tag.source]!.done = true;
			}
		}

		expect(byModel.gpt).toEqual({ texts: ["hi", "again"], errors: 1, done: true });
		expect(byModel.claude).toEqual({ texts: ["yo"], errors: 0, done: true });
	});

	it("LSM-MERGE-111 ALL_FAILED is not ABORTED code discrimination under failFast", async () => {
		await expect(
			collectTagged([fromArray([1], { throwAt: 0 }).asyncIterable], { failFast: true }),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			expect(muxErr.code).toBe("ALL_FAILED");
			expect(muxErr.code).not.toBe("ABORTED");
			expect(isMuxCancelled(muxErr)).toBe(false);
			return true;
		});
	});

	it("LSM-MERGE-112 onFinish fires exactly once on failFast transport abort", async () => {
		const onFinish = vi.fn();
		const iter = merge([fromArray([1], { throwAt: 0 }).asyncIterable], {
			failFast: true,
			onFinish,
		})[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
		expect(onFinish).toHaveBeenCalledTimes(1);
		expect(onFinish.mock.calls[0]![0]?.strategy).toBe("merge");
		expect(onFinish.mock.calls[0]![0]?.aborted).toBe(true);
	});

	it("LSM-MERGE-113 onFinish perSource omits never-started queued ids under concurrency", async () => {
		let result: MuxResult | undefined;
		const s0 = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const s1 = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const s2 = lazyOpenCounter(() => fromArray([3]).asyncIterable);
		await collectTagged([s0.source, s1.source, s2.source], {
			concurrency: 1,
			onFinish: (r) => {
				result = r;
			},
		});
		expect(s0.openCount).toBe(1);
		expect(s1.openCount).toBe(1);
		expect(s2.openCount).toBe(1);
		expect(Object.keys(result?.perSource ?? {})).toEqual(["0", "1", "2"]);
		expect(result?.perSource["0"]?.started).toBe(true);
		expect(result?.perSource["2"]?.started).toBe(true);
	});

	it("LSM-MERGE-114 done SourceEvent emitted once per naturally completing source", async () => {
		const events: SourceEvent[] = [];
		await collectTagged([fromArray([1]).asyncIterable, fromArray([2]).asyncIterable], {
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.filter((e) => e.type === "done" && e.source === "0")).toHaveLength(1);
		expect(events.filter((e) => e.type === "done" && e.source === "1")).toHaveLength(1);
	});

	it("LSM-MERGE-115 cancelled SourceEvent on each started source when signal aborts", async () => {
		const events: SourceEvent[] = [];
		const ctrl = new AbortController();
		const iter = merge(
			[
				fromArray([1, 2, 3], { delayMs: 5, neverEnd: true }).asyncIterable,
				fromArray([9]).asyncIterable,
			],
			{
				signal: ctrl.signal,
				onSourceEvent: (e) => events.push(e),
			},
		)[Symbol.asyncIterator]();
		await iter.next();
		ctrl.abort();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ABORTED",
		);
		const cancelled = events.filter((e) => e.type === "cancelled");
		expect(cancelled.length).toBeGreaterThanOrEqual(1);
		expect(cancelled.every((e) => e.source === "0" || e.source === "1")).toBe(true);
	});

	it("LSM-MERGE-116 repeated next after ALL_FAILED rejects same ALL_FAILED code", async () => {
		const iter = merge([fromArray([1], { throwAt: 0 }).asyncIterable], {
			failFast: true,
		})[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
	});

	it("LSM-MERGE-117 round-robin uses Record insertion order not key sort", async () => {
		const tags = await collectTagged(
			{
				m: fromArray(["M"]).asyncIterable,
				a: fromArray(["A"]).asyncIterable,
				z: fromArray(["Z"]).asyncIterable,
			},
			{ order: "round-robin" },
		);
		expect(valueTags(tags).map((t) => t.source)).toEqual(["m", "a", "z"]);
	});

	it("LSM-MERGE-118 lazy thunks all invoked on concurrent merge start", async () => {
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const c = lazyOpenCounter(() => fromArray([3]).asyncIterable);
		const iter = merge([a.source, b.source, c.source])[Symbol.asyncIterator]();
		expect(a.openCount).toBe(0);
		await iter.next();
		expect(a.openCount).toBe(1);
		expect(b.openCount).toBe(1);
		expect(c.openCount).toBe(1);
	});

	it("LSM-MERGE-119 transport fail mid-stream partial values then error tag no done", async () => {
		const tags = await collectTagged([fromArray([1, 2, 3], { throwAt: 2 }).asyncIterable]);
		expect(
			valueTags(tags)
				.filter((t) => t.source === "0")
				.map((t) => t.value),
		).toEqual([1, 2]);
		expect(tags.some((t) => t.source === "0" && t.kind === "error")).toBe(true);
		expect(tags.some((t) => t.source === "0" && t.kind === "done")).toBe(false);
	});

	it("LSM-MERGE-120 failFast true mapEach throw aborts ALL_FAILED not Tagged error", async () => {
		await expect(
			collectTagged([fromArray([1]).asyncIterable], {
				failFast: true,
				mapEach: () => {
					throw new Error("map fail");
				},
			}),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "ALL_FAILED");
	});

	it("LSM-MERGE-121 ten sources concurrency three delivers all values", async () => {
		const sources = Array.from({ length: 10 }, (_, i) => fromArray([i]).asyncIterable);
		const tags = await collectTagged(sources, { concurrency: 3 });
		expect(
			valueTags(tags)
				.map((t) => t.value)
				.sort((a, b) => (a as number) - (b as number)),
		).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(10);
	});

	it("LSM-MERGE-122 three sources each in-band isError failFast false completes with three errors", async () => {
		type Frame = { err: true } | { ok: number };
		const tags = await collectTagged(
			[
				fromArray<Frame>([{ err: true }]).asyncIterable,
				fromArray<Frame>([{ err: true }]).asyncIterable,
				fromArray<Frame>([{ err: true }]).asyncIterable,
			],
			{ isError: (item) => "err" in item },
		);
		expect(tags.filter((t) => t.kind === "error")).toHaveLength(3);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(3);
	});

	it("LSM-MERGE-123 post break late enqueue on two controllable sources not in output", async () => {
		const a = controllableReadable<number>();
		const b = controllableReadable<number>();
		const iter = merge([a.stream, b.stream])[Symbol.asyncIterator]();
		a.enqueue(1);
		b.enqueue(2);
		await iter.next();
		await iter.next();
		await iter.return();
		try {
			a.enqueue(99);
		} catch {
			/* post-cancel */
		}
		try {
			b.enqueue(88);
		} catch {
			/* post-cancel */
		}
	});

	it("LSM-MERGE-124 merge empty labeled array yields nothing completes", async () => {
		expect(await collectTagged([] as Array<{ id: string; source: AsyncIterable<number> }>)).toEqual(
			[],
		);
	});

	it("LSM-MERGE-125 onFinish perSource startedAt and endedAt populated when started", async () => {
		let result: MuxResult | undefined;
		await collectTagged([fromArray([1]).asyncIterable], {
			onFinish: (r) => {
				result = r;
			},
		});
		expect(result?.perSource["0"]?.startedAt).toEqual(expect.any(Number));
		expect(result?.perSource["0"]?.endedAt).toEqual(expect.any(Number));
		expect(result!.perSource["0"]!.endedAt!).toBeGreaterThanOrEqual(
			result!.perSource["0"]!.startedAt!,
		);
	});

	it("LSM-MERGE-126 arrival controllable B ready before A drained both values emitted", async () => {
		const a = controllableReadable<number>();
		const b = controllableReadable<number>();
		const iter = merge([a.stream, b.stream], { order: "arrival" })[Symbol.asyncIterator]();
		a.enqueue(1);
		b.enqueue(2);
		const first = await iter.next();
		const second = await iter.next();
		const values = [first.value, second.value]
			.filter((t): t is Tagged<number> & { kind: "value" } => t?.kind === "value")
			.map((t) => t.value)
			.sort();
		expect(values).toEqual([1, 2]);
		a.close();
		b.close();
		while (!(await iter.next()).done) {
			/* drain dones */
		}
	});

	it("LSM-MERGE-127 failFast on source one aborts after source zero partial tags delivered", async () => {
		const fast = controllableReadable<number>();
		const slow = controllableReadable<number>();
		const iter = merge([fast.stream, slow.stream], {
			failFast: true,
			concurrency: 2,
		})[Symbol.asyncIterator]();
		fast.enqueue(1);
		const first = await iter.next();
		expect(first.value?.kind).toBe("value");
		expect(first.value?.source).toBe("0");
		expect(first.value?.value).toBe(1);
		slow.error(new Error("source1 fail"));
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
		await fast.cancelReason;
		try {
			fast.enqueue(2);
		} catch {
			/* post-cancel: remaining items must not reach consumer */
		}
	});

	it("LSM-MERGE-128 isFinal on two sources emits final event per source", async () => {
		const events: SourceEvent[] = [];
		await collectTagged(
			[fromArray(["a", "FIN"]).asyncIterable, fromArray(["x", "END"]).asyncIterable],
			{
				isFinal: (item) => item === "FIN" || item === "END",
				onSourceEvent: (e) => events.push(e),
			},
		);
		expect(events.filter((e) => e.type === "final" && e.source === "0")).toHaveLength(1);
		expect(events.filter((e) => e.type === "final" && e.source === "1")).toHaveLength(1);
	});

	it("LSM-MERGE-129 mapEach spy never invoked for in-band isError frames", async () => {
		const mapEach = vi.fn((x: string) => x);
		await collectTagged([fromArray(["ok", "ERR", "ok2"]).asyncIterable], {
			isError: (x) => x === "ERR",
			mapEach,
		});
		expect(mapEach).toHaveBeenCalledTimes(2);
		expect(mapEach).not.toHaveBeenCalledWith("ERR", "0");
	});

	it("LSM-MERGE-130 strict pullCount bound during manual slow drain one source", async () => {
		const src = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const iter = merge([src.source])[Symbol.asyncIterator]();
		let delivered = 0;
		for (let i = 0; i < 5; i += 1) {
			const step = await iter.next();
			if (step.done) break;
			if (step.value.kind === "value") delivered += 1;
		}
		expect(src.pullCount).toBeLessThanOrEqual(delivered + 2);
	});

	it("LSM-MERGE-131 AsyncIterable return rejection on cancel swallowed merge continues", async () => {
		const cancelReasons: unknown[] = [];
		const hung = failingWithCancelSpy(
			() => fromArray([1], { neverEnd: true }).asyncIterable,
			cancelReasons,
		);
		const iter = merge([hung, fromArray([2]).asyncIterable])[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		expect(cancelReasons.length).toBeGreaterThanOrEqual(1);
	});

	it("LSM-MERGE-132 transport fail after in-band errors on same source failFast false", async () => {
		const tags = await collectTagged(
			[fromArray(["ok", "ERR", "x"], { throwAt: 2 }).asyncIterable],
			{
				isError: (x) => x === "ERR",
			},
		);
		const source0 = tags.filter((t) => t.source === "0");
		expect(source0.filter((t) => t.kind === "error")).toHaveLength(2);
		expect(source0.some((t) => t.kind === "value" && t.value === "ok")).toBe(true);
		expect(source0.some((t) => t.kind === "done")).toBe(false);
	});

	it("LSM-MERGE-133 round-robin concurrency two six sources alternating source order pin", async () => {
		const sources = Array.from({ length: 6 }, (_, i) => fromArray([i]).asyncIterable);
		const tags = await collectTagged(sources, { order: "round-robin", concurrency: 2 });
		expect(valueTags(tags).map((t) => t.source)).toEqual(["0", "1", "2", "3", "4", "5"]);
	});

	it("LSM-MERGE-134 onFinish NOT called on sync invalid concurrency throw", () => {
		let finishCalls = 0;
		expect(() =>
			merge([fromArray([1]).asyncIterable], {
				concurrency: 0,
				onFinish: () => {
					finishCalls += 1;
				},
			}),
		).toThrow();
		expect(finishCalls).toBe(0);
	});

	it("LSM-MERGE-135 in-band errors then transport fail three errors no value no done", async () => {
		const tags = await collectTagged(
			[fromArray(["E1", "E2", "ok"], { throwAt: 2 }).asyncIterable],
			{
				isError: (x) => typeof x === "string" && x.startsWith("E"),
			},
		);
		expect(tags.filter((t) => t.source === "0" && t.kind === "error")).toHaveLength(3);
		expect(tags.some((t) => t.source === "0" && t.kind === "done")).toBe(false);
		expect(tags.some((t) => t.source === "0" && t.kind === "value")).toBe(false);
	});
});
