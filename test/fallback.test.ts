import { describe, expect, it, vi } from "vitest";
import { collect, fallback, toAsyncIterable, toReadable } from "../src/index.js";
import { isMuxCancelled } from "../src/internal/abort.js";
import type {
	FallbackOptions,
	MuxCancelled,
	MuxError,
	MuxResult,
	SourceEvent,
	Sources,
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

async function collectFallback<T, U = T>(sources: Sources<T>, opts?: FallbackOptions<T, U>) {
	return collect(fallback(sources, opts));
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

describe("LSM-FB fallback strategy", () => {
	it("LSM-FB-01 lazy backup thunk openCount zero when primary succeeds end-to-end", async () => {
		const primary = lazyOpenCounter(() => fromArray([1, 2, 3]).asyncIterable);
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		expect(await collectFallback([primary.source, backup.source])).toEqual([1, 2, 3]);
		expect(primary.openCount).toBe(1);
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-02 primary transport fail pre-commit throwAt zero backup output", async () => {
		const primary = fromArray([1], { throwAt: 0 }).asyncIterable;
		const backup = fromArray([42]).asyncIterable;
		expect(await collectFallback([primary, backup])).toEqual([42]);
	});

	it("LSM-FB-03 commit policy primary emits usable then transport fail rejects no backup", async () => {
		const primary = fromArray([1, 2], { throwAt: 1 }).asyncIterable;
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const iter = fallback([primary, backup.source])[Symbol.asyncIterator]();
		expect((await iter.next()).value).toBe(1);
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "SOURCE_ERROR" || muxErr.message.includes("throwAt");
		});
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-04 on failover superseded source cancel called with muxCancelledReason failover", async () => {
		const cancelReasons: unknown[] = [];
		const primary = failingWithCancelSpy(
			() => fromArray([1], { throwAt: 0 }).asyncIterable,
			cancelReasons,
		);
		const backup = fromArray([7]).asyncIterable;
		await collectFallback([primary, backup]);
		expect(cancelReasons).toHaveLength(1);
		expect(isMuxCancelled(cancelReasons[0])).toBe(true);
		expect((cancelReasons[0] as MuxCancelled).reason).toBe("failover");
	});

	it("LSM-FB-05 post-emit policy post-commit failure SourceEvent failover plus backup output", async () => {
		const events: SourceEvent[] = [];
		const primary = fromArray([1, 2], { throwAt: 1 }).asyncIterable;
		const backup = fromArray([10, 11]).asyncIterable;
		const out = await collectFallback([primary, backup], {
			policy: "post-emit",
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual([1, 10, 11]);
		expect(events.some((e) => e.type === "failover" && e.source === "0")).toBe(true);
	});

	it("LSM-FB-06 buffered policy primary partial items not seen failover backup only", async () => {
		const primary = fromArray([1, 2], { throwAt: 1 }).asyncIterable;
		const backup = fromArray([9]).asyncIterable;
		expect(
			await collectFallback([primary, backup], {
				policy: "buffered",
			}),
		).toEqual([9]);
	});

	it("LSM-FB-07 timeoutMs slow primary never usable timeout event plus backup wins", async () => {
		const events: SourceEvent[] = [];
		const primary = fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable;
		const backup = fromArray([42]).asyncIterable;
		const out = await collectFallback([primary, backup], {
			timeoutMs: 50,
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual([42]);
		expect(events.some((e) => e.type === "timeout" && e.source === "0")).toBe(true);
	});

	it("LSM-FB-08 all sources fail ALL_FAILED with errors length equals N", async () => {
		const a = fromArray([1], { throwAt: 0 }).asyncIterable;
		const b = fromArray([2], { throwAt: 0 }).asyncIterable;
		const c = fromArray([3], { throwAt: 0 }).asyncIterable;
		await expect(collectFallback([a, b, c])).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "ALL_FAILED" && muxErr.errors?.length === 3;
		});
	});

	it("LSM-FB-09 fallback empty array throws ALL_FAILED synchronously errors empty", () => {
		expect(() => fallback([])).toThrow();
		try {
			fallback([]);
		} catch (err) {
			const muxErr = asMuxError(err);
			expect(muxErr.code).toBe("ALL_FAILED");
			expect(muxErr.errors).toEqual([]);
		}
	});

	it("LSM-FB-10 single source pass-through full sequence", async () => {
		expect(await collectFallback([fromArray([1, 2, 3]).asyncIterable])).toEqual([1, 2, 3]);
	});

	it("LSM-FB-11 default policy is commit when omitted post-commit fail no failover", async () => {
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const iter = fallback([fromArray([1, 2], { throwAt: 1 }).asyncIterable, backup.source])[
			Symbol.asyncIterator
		]();
		expect((await iter.next()).value).toBe(1);
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "SOURCE_ERROR" || asMuxError(err).message.includes("throwAt");
		});
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-12 three-source chain fail fail succeed third sequence only", async () => {
		const a = lazyOpenCounter(() => fromArray([1], { throwAt: 0 }).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2], { throwAt: 0 }).asyncIterable);
		const c = lazyOpenCounter(() => fromArray([30, 31, 32]).asyncIterable);
		expect(await collectFallback([a.source, b.source, c.source])).toEqual([30, 31, 32]);
		expect(a.openCount).toBe(1);
		expect(b.openCount).toBe(1);
		expect(c.openCount).toBe(1);
	});

	it("LSM-FB-13 isError in-band on primary pre-commit backup wins", async () => {
		type Frame = { tag: "ok"; v: number } | { tag: "err" };
		const bad = fromArray<Frame>([{ tag: "err" }]).asyncIterable;
		const good = fromArray<Frame>([{ tag: "ok", v: 42 }]).asyncIterable;
		const out = await collectFallback([bad, good], {
			isError: (item) => item.tag === "err",
		});
		expect(out).toEqual([{ tag: "ok", v: 42 }]);
	});

	it("LSM-FB-14 isUsable commit gate junk buffered until usable primary never usable failover", async () => {
		const junkOnly = fromArray(["x", "y"]).asyncIterable;
		const backup = fromArray(["good"]).asyncIterable;
		expect(
			await collectFallback([junkOnly, backup], {
				isUsable: (item) => item === "good",
			}),
		).toEqual(["good"]);

		const buffered = fromArray(["junk", "junk", "good"]).asyncIterable;
		expect(
			await collectFallback([buffered], {
				isUsable: (item) => item === "good",
			}),
		).toEqual(["junk", "junk", "good"]);
	});

	it("LSM-FB-15 isFinal on primary completes without failover to backup", async () => {
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const out = await collectFallback([fromArray(["a", "b"]).asyncIterable, backup.source], {
			isFinal: (item) => item === "a",
		});
		expect(out).toEqual(["a"]);
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-16 mapEach transforms output", async () => {
		const out = await collectFallback([fromArray([1, 2]).asyncIterable], {
			mapEach: (n) => `n=${n}`,
		});
		expect(out).toEqual(["n=1", "n=2"]);
	});

	it("LSM-FB-17 mapEach throws consumer rejects SOURCE_ERROR with active source id", async () => {
		await expect(
			collectFallback([fromArray([1]).asyncIterable], {
				mapEach: () => {
					throw new Error("map blew up");
				},
			}),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "SOURCE_ERROR" && muxErr.source === "0";
		});
	});

	it("LSM-FB-18 onFinish exactly once strategy fallback winner successful source id", async () => {
		let finishCalls = 0;
		let result: MuxResult | undefined;
		await collectFallback(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2, 3]).asyncIterable],
			{
				onFinish: (r) => {
					finishCalls += 1;
					result = r;
				},
			},
		);
		expect(finishCalls).toBe(1);
		expect(result?.strategy).toBe("fallback");
		expect(result?.winner).toBe("1");
	});

	it("LSM-FB-19 consumer return early started sources cancelled aborted", async () => {
		const active = cancelSpyingReadable<number>();
		active.enqueue(1);
		active.enqueue(2);
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const iter = fallback([active.stream, backup.source])[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		await Promise.resolve();
		expect(active.cancelReasons.length).toBeGreaterThanOrEqual(1);
		expect(isMuxCancelled(active.cancelReasons[active.cancelReasons.length - 1])).toBe(true);
		expect((active.cancelReasons[active.cancelReasons.length - 1] as MuxCancelled).reason).toBe(
			"aborted",
		);
	});

	it("LSM-FB-20 signal abort mid-stream ABORTED isMuxCancelled false on mux error", async () => {
		const ctrl = new AbortController();
		const hung = fromArray([1], { delayMs: 100, neverEnd: true }).asyncIterable;
		const iter = fallback([hung], { signal: ctrl.signal })[Symbol.asyncIterator]();
		const pending = iter.next();
		ctrl.abort(new Error("user abort"));
		await expect(pending).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			expect(muxErr.code).toBe("ABORTED");
			expect(isMuxCancelled(muxErr)).toBe(false);
			return true;
		});
	});

	it("LSM-FB-21 labeled record primary backup winner backup when primary fails", async () => {
		let result: MuxResult | undefined;
		await collectFallback(
			{
				primary: fromArray([1], { throwAt: 0 }).asyncIterable,
				backup: fromArray([7, 8]).asyncIterable,
			},
			{
				onFinish: (r) => {
					result = r;
				},
			},
		);
		expect(result?.winner).toBe("backup");
	});

	it("LSM-FB-22 positional ids zero and one in telemetry MuxResult winner", async () => {
		let result: MuxResult | undefined;
		await collectFallback(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2]).asyncIterable],
			{
				onFinish: (r) => {
					result = r;
				},
			},
		);
		expect(result?.winner).toBe("1");
		expect(result?.perSource["0"]?.started).toBe(true);
		expect(result?.perSource["1"]?.started).toBe(true);
	});

	it("LSM-FB-23 eager streams backup not read until primary fails", async () => {
		const backupCounted = countingSource(fromArray([42, 43]).asyncIterable);
		const primary = fromArray([1], { throwAt: 0 }).asyncIterable;
		expect(await collectFallback([primary, backupCounted.source])).toEqual([42, 43]);
		expect(backupCounted.pullCount).toBe(2);
	});

	it("LSM-FB-24 ALL_FAILED is not NO_USABLE_SOURCE contrast race", async () => {
		const a = fromArray([1], { throwAt: 0 }).asyncIterable;
		const b = fromArray([2], { throwAt: 0 }).asyncIterable;
		await expect(collectFallback([a, b])).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "ALL_FAILED" && muxErr.code !== "NO_USABLE_SOURCE";
		});
	});

	it("LSM-FB-25 import fallback from ../src/index.js public export path", async () => {
		const { fallback: fallbackFromIndex, collect: collectFromIndex } =
			await import("../src/index.js");
		expect(typeof fallbackFromIndex).toBe("function");
		const out = await collectFromIndex(
			fallbackFromIndex([
				fromArray([1], { throwAt: 0 }).asyncIterable,
				fromArray([2]).asyncIterable,
			]),
		);
		expect(out).toEqual([2]);
	});

	it("LSM-FB-26 ReadableStream inputs via fromArray readable", async () => {
		const primary = fromArray([1], { throwAt: 0 }).readable;
		const backup = fromArray([9, 10]).readable;
		expect(await collectFallback([primary, backup])).toEqual([9, 10]);
	});

	it("LSM-FB-27 commit policy never emits failover SourceEvent", async () => {
		const events: SourceEvent[] = [];
		await collectFallback(
			[fromArray([1, 2], { throwAt: 1 }).asyncIterable, fromArray([99]).asyncIterable],
			{
				policy: "commit",
				onSourceEvent: (e) => events.push(e),
			},
		).catch(() => {});
		expect(events.filter((e) => e.type === "failover")).toHaveLength(0);
	});

	it("LSM-FB-28 signal already aborted before first next ABORTED lazy sources not opened", async () => {
		const ctrl = new AbortController();
		ctrl.abort(new Error("pre-aborted"));
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const iter = fallback([a.source, b.source], { signal: ctrl.signal })[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "ABORTED";
		});
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
	});

	it("LSM-FB-29 fallback empty record throws ALL_FAILED synchronously", () => {
		expect(() => fallback({})).toThrow();
		try {
			fallback({});
		} catch (err) {
			expect(asMuxError(err).code).toBe("ALL_FAILED");
			expect(asMuxError(err).errors).toEqual([]);
		}
	});

	it("LSM-FB-30 two fallback calls independent coordinators", async () => {
		const a = await collectFallback([
			fromArray([1]).asyncIterable,
			fromArray([9], { delayMs: 50 }).asyncIterable,
		]);
		const b = await collectFallback([
			fromArray([2], { throwAt: 0 }).asyncIterable,
			fromArray([8]).asyncIterable,
		]);
		expect(a).toEqual([1]);
		expect(b).toEqual([8]);
	});

	it("LSM-FB-31 onSourceEvent start on each activated source error on failed usable on commit", async () => {
		const events: SourceEvent[] = [];
		await collectFallback(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2, 3]).asyncIterable],
			{
				onSourceEvent: (e) => events.push(e),
			},
		);
		expect(events.some((e) => e.type === "start" && e.source === "0")).toBe(true);
		expect(events.some((e) => e.type === "start" && e.source === "1")).toBe(true);
		expect(events.some((e) => e.type === "error" && e.source === "0")).toBe(true);
		expect(events.some((e) => e.type === "usable" && e.source === "1")).toBe(true);
	});

	it("LSM-FB-32 primary empty stream failover backup single source empty async ALL_FAILED", async () => {
		const backup = fromArray([5]).asyncIterable;
		expect(await collectFallback([fromArray([]).asyncIterable, backup])).toEqual([5]);

		const singleEmpty = fallback([fromArray([]).asyncIterable])[Symbol.asyncIterator]();
		await expect(singleEmpty.next()).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "ALL_FAILED" && muxErr.errors?.length === 1;
		});
	});

	it("LSM-FB-33 fallback call does not invoke lazy thunks until iterate", () => {
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		fallback([a.source, b.source]);
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
	});

	it("LSM-FB-34 Uint8Array generic T preserved", async () => {
		const chunk = new Uint8Array([1, 2, 3]);
		const out = await collectFallback([fromArray([chunk]).asyncIterable]);
		expect(out[0]).toBeInstanceOf(Uint8Array);
		expect(Array.from(out[0] as Uint8Array)).toEqual([1, 2, 3]);
	});

	it("LSM-FB-35 labeled array id primary preserves id in winner", async () => {
		let result: MuxResult | undefined;
		await collectFallback(
			[
				{ id: "primary", source: fromArray([1], { throwAt: 0 }).asyncIterable },
				{ id: "secondary", source: fromArray([2]).asyncIterable },
			],
			{
				onFinish: (r) => {
					result = r;
				},
			},
		);
		expect(result?.winner).toBe("secondary");
	});

	it("LSM-FB-36 onFinish perSource winner items equals forwarded count", async () => {
		let result: MuxResult | undefined;
		await collectFallback([fromArray([1, 2, 3]).asyncIterable], {
			onFinish: (r) => {
				result = r;
			},
		});
		expect(result?.perSource["0"]?.items).toBe(3);
	});

	it("LSM-FB-37 superseded source cancel exactly once no double cancel", async () => {
		const cancelReasons: unknown[] = [];
		const primary = failingWithCancelSpy(
			() => fromArray([1], { throwAt: 0 }).asyncIterable,
			cancelReasons,
		);
		const backup = fromArray([1]).asyncIterable;
		await collectFallback([primary, backup]);
		expect(cancelReasons).toHaveLength(1);
		expect((cancelReasons[0] as MuxCancelled).reason).toBe("failover");
	});

	it("LSM-FB-38 backup never started if primary succeeds multi-item stream", async () => {
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		expect(await collectFallback([fromArray([1, 2, 3, 4]).asyncIterable, backup.source])).toEqual([
			1, 2, 3, 4,
		]);
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-39 post-emit consumer receives primary partial output then backup output", async () => {
		const primary = fromArray([1, 2], { throwAt: 1 }).asyncIterable;
		const backup = fromArray([10]).asyncIterable;
		expect(
			await collectFallback([primary, backup], {
				policy: "post-emit",
			}),
		).toEqual([1, 10]);
	});

	it("LSM-FB-40 buffered successful primary flushes full buffered sequence in order", async () => {
		expect(
			await collectFallback([fromArray(["a", "b", "c"]).asyncIterable], {
				policy: "buffered",
			}),
		).toEqual(["a", "b", "c"]);
	});

	it("LSM-FB-41 commit plus isUsable junk-first primary never usable clean backup output", async () => {
		const junk = fromArray(["x", "y"]).asyncIterable;
		const backup = fromArray(["ok"]).asyncIterable;
		expect(
			await collectFallback([junk, backup], {
				isUsable: (item) => item === "ok",
			}),
		).toEqual(["ok"]);
	});

	it("LSM-FB-42 mapEach not applied to discarded primary buffer on buffered failover", async () => {
		const mapEach = vi.fn((item: string) => item.toUpperCase());
		const primary = fromArray(["a", "b"], { throwAt: 1 }).asyncIterable;
		const backup = fromArray(["z"]).asyncIterable;
		await collectFallback([primary, backup], {
			policy: "buffered",
			mapEach,
		});
		expect(mapEach).toHaveBeenCalledTimes(1);
		expect(mapEach).toHaveBeenCalledWith("z", "1");
	});

	it("LSM-FB-43 loser AsyncIterable return rejection on cancel swallowed backup still wins", async () => {
		const rejectReturn: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						throw new Error("primary fail");
					},
					return() {
						return Promise.reject(new Error("return rejected"));
					},
				};
			},
		};
		expect(await collectFallback([rejectReturn, fromArray([42]).asyncIterable])).toEqual([42]);
	});

	it("LSM-FB-44 loser ReadableStream cancel rejection swallowed backup still wins", async () => {
		const rejectCancel = new ReadableStream<number>({
			start(controller) {
				controller.error(new Error("primary fail"));
			},
			cancel() {
				return Promise.reject(new Error("cancel rejected"));
			},
		});
		expect(await collectFallback([rejectCancel, fromArray([42]).asyncIterable])).toEqual([42]);
	});

	it("LSM-FB-45 repeated next after ALL_FAILED rejects same code", async () => {
		const iter = fallback([fromArray([1], { throwAt: 0 }).asyncIterable])[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "ALL_FAILED";
		});
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "ALL_FAILED";
		});
	});

	it("LSM-FB-46 onFinish NOT called on sync fallback empty array throw", () => {
		const onFinish = vi.fn();
		expect(() => fallback([], { onFinish })).toThrow();
		expect(onFinish).not.toHaveBeenCalled();
	});

	it("LSM-FB-47 duplicate labeled ids throws synchronously at call site", () => {
		expect(() =>
			fallback([
				{ id: "dup", source: fromArray([1]).asyncIterable },
				{ id: "dup", source: fromArray([2]).asyncIterable },
			]),
		).toThrow(/duplicate source id "dup"/);
	});

	it("LSM-FB-48 second Symbol.asyncIterator on same fallback throws first still usable", () => {
		const iterable = fallback([fromArray([1]).asyncIterable]);
		iterable[Symbol.asyncIterator]();
		expect(() => iterable[Symbol.asyncIterator]()).toThrow(/fallback: iterator already active/);
	});

	it("LSM-FB-49 signal abort during pre-output phase all started sources aborted not failover", async () => {
		const ctrl = new AbortController();
		const primary = cancelSpyingReadable<number>();
		primary.enqueue(0);
		const backup = cancelSpyingReadable<number>();
		backup.enqueue(0);
		const iter = fallback([primary.stream, backup.stream], {
			signal: ctrl.signal,
			policy: "buffered",
		})[Symbol.asyncIterator]();
		const pending = iter.next();
		await Promise.resolve();
		ctrl.abort(new Error("pre-output abort"));
		await expect(pending).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "ABORTED";
		});
		await Promise.resolve();
		for (const spy of [primary, backup]) {
			if (spy.cancelReasons.length > 0) {
				expect((spy.cancelReasons[spy.cancelReasons.length - 1] as MuxCancelled).reason).toBe(
					"aborted",
				);
			}
		}
	});

	it("LSM-FB-50 backpressure active source pullCount never exceeds delivered plus one", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const iter = fallback([counted.source])[Symbol.asyncIterator]();
		let delivered = 0;
		for (let i = 0; i < 5; i += 1) {
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 1);
			const step = await iter.next();
			expect(step.done).toBe(false);
			delivered += 1;
			await Promise.resolve();
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 1);
		}
		expect((await iter.next()).done).toBe(true);
	});

	it("LSM-FB-51 interop round-trip collect toAsyncIterable toReadable fallback equals direct", async () => {
		const sources = [fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2, 3]).asyncIterable];
		const direct = await collect(fallback(sources));
		const roundTrip = await collect(
			toAsyncIterable(
				toReadable(
					fallback([fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2, 3]).asyncIterable]),
				),
			),
		);
		expect(roundTrip).toEqual(direct);
		expect(direct).toEqual([2, 3]);
	});

	it("LSM-FB-52 for await early break all started sources cancelled aborted", async () => {
		const active = cancelSpyingReadable<number>();
		active.enqueue(1);
		active.enqueue(2);
		let seen = 0;
		for await (const _x of fallback([
			active.stream,
			fromArray([99], { delayMs: 50 }).asyncIterable,
		])) {
			seen += 1;
			if (seen >= 1) break;
		}
		await Promise.resolve();
		expect(seen).toBe(1);
		expect(active.cancelReasons.length).toBeGreaterThanOrEqual(1);
		expect(isMuxCancelled(active.cancelReasons[active.cancelReasons.length - 1])).toBe(true);
		expect((active.cancelReasons[active.cancelReasons.length - 1] as MuxCancelled).reason).toBe(
			"aborted",
		);
	});

	it("LSM-FB-53 isFinal overrides false isUsable same item primary succeeds backup never opened", async () => {
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const out = await collectFallback([fromArray(["only"]).asyncIterable, backup.source], {
			isUsable: () => false,
			isFinal: () => true,
		});
		expect(out).toEqual(["only"]);
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-54 mixed empty throw good chain last source wins after two failures", async () => {
		const empty = fromArray([]).asyncIterable;
		const broken = fromArray([1], { throwAt: 0 }).asyncIterable;
		const good = fromArray([7, 8]).asyncIterable;
		expect(await collectFallback([empty, broken, good])).toEqual([7, 8]);
	});

	it("LSM-FB-55 TIMEOUT code on timed-out source appears in ALL_FAILED errors when no backup", async () => {
		await expect(
			collectFallback([fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable], {
				timeoutMs: 50,
			}),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return (
				muxErr.code === "ALL_FAILED" &&
				muxErr.errors?.length === 1 &&
				muxErr.errors[0]?.code === "TIMEOUT"
			);
		});
	});

	it("LSM-FB-56 post-emit failover event includes failed source id in SourceEvent source", async () => {
		const events: SourceEvent[] = [];
		await collectFallback(
			[fromArray([1, 2], { throwAt: 1 }).asyncIterable, fromArray([9]).asyncIterable],
			{
				policy: "post-emit",
				onSourceEvent: (e) => events.push(e),
			},
		);
		const failover = events.find((e) => e.type === "failover");
		expect(failover?.source).toBe("0");
	});

	it("LSM-FB-57 after full collect second Symbol.asyncIterator still throws", async () => {
		const iterable = fallback([fromArray([1, 2]).asyncIterable]);
		await collect(iterable);
		expect(() => iterable[Symbol.asyncIterator]()).toThrow(/fallback: iterator already active/);
	});

	it("LSM-FB-58 four-source chain fail fail fail succeed", async () => {
		const a = fromArray([1], { throwAt: 0 }).asyncIterable;
		const b = fromArray([2], { throwAt: 0 }).asyncIterable;
		const c = fromArray([3], { throwAt: 0 }).asyncIterable;
		const d = fromArray([40, 41]).asyncIterable;
		expect(await collectFallback([a, b, c, d])).toEqual([40, 41]);
	});

	it("LSM-FB-59 commit backup pullCount bounded after primary fails no stray reads", async () => {
		const backupCounted = countingSource(fromArray([99, 100]).asyncIterable);
		const primary = fromArray([]).asyncIterable;
		expect(await collectFallback([primary, backupCounted.source])).toEqual([99, 100]);
		expect(backupCounted.pullCount).toBeLessThanOrEqual(2);
	});

	it("LSM-FB-60 buffered plus isUsable nothing forwarded until usable item at end of primary", async () => {
		const events: SourceEvent[] = [];
		const out = await collectFallback([fromArray(["junk", "junk", "good"]).asyncIterable], {
			policy: "buffered",
			isUsable: (item) => item === "good",
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual(["junk", "junk", "good"]);
		const usableIdx = events.findIndex((e) => e.type === "usable");
		const startIdx = events.findIndex((e) => e.type === "start");
		expect(usableIdx).toBeGreaterThan(startIdx);
	});

	it("LSM-FB-61 post-emit plus isUsable junk not forwarded until usable then post-commit failover", async () => {
		type Item = string | { bad: true };
		const primary = fromArray<Item>(["junk", "good", { bad: true }]).asyncIterable;
		const backup = fromArray([99]).asyncIterable;
		const out = await collectFallback([primary, backup], {
			policy: "post-emit",
			isUsable: (item) =>
				item === "good" ||
				typeof item === "number" ||
				(typeof item === "object" && item !== null && "bad" in item),
			isError: (item) => typeof item === "object" && item !== null && "bad" in item,
		});
		expect(out).toEqual(["junk", "good", 99]);
	});

	it("LSM-FB-62 onFinish aborted true after signal abort", async () => {
		const ctrl = new AbortController();
		let result: MuxResult | undefined;
		const pending = collectFallback([fromArray([1, 2, 3], { delayMs: 30 }).asyncIterable], {
			signal: ctrl.signal,
			onFinish: (r) => {
				result = r;
			},
		});
		await Promise.resolve();
		ctrl.abort();
		await pending.catch(() => {});
		expect(result?.aborted).toBe(true);
		expect(result?.strategy).toBe("fallback");
	});

	it("LSM-FB-63 onFinish on ALL_FAILED called once winner undefined per-source errors recorded", async () => {
		let finishCalls = 0;
		let result: MuxResult | undefined;
		await collectFallback(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2], { throwAt: 0 }).asyncIterable],
			{
				onFinish: (r) => {
					finishCalls += 1;
					result = r;
				},
			},
		).catch(() => {});
		expect(finishCalls).toBe(1);
		expect(result?.winner).toBeUndefined();
		expect(result?.perSource["0"]?.errored).toBeDefined();
		expect(result?.perSource["1"]?.errored).toBeDefined();
	});

	it("LSM-FB-64 null object undefined generic T preserved", async () => {
		const values: (null | { x: number } | undefined)[] = [null, { x: 1 }, undefined];
		const out = await collectFallback([fromArray(values).asyncIterable]);
		expect(out).toEqual(values);
	});

	it("LSM-FB-65 return before first next lazy sources never opened", async () => {
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const iter = fallback([a.source, b.source])[Symbol.asyncIterator]();
		await iter.return();
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
	});

	it("LSM-FB-66 return during active pump before commit aborted backup not opened", async () => {
		const primary = cancelSpyingReadable<string>();
		primary.enqueue("junk");
		const backup = lazyOpenCounter(() => fromArray(["ok"]).asyncIterable);
		const iter = fallback([primary.stream, backup.source], {
			isUsable: () => false,
		})[Symbol.asyncIterator]();
		const pending = iter.next();
		await Promise.resolve();
		await Promise.resolve();
		await iter.return();
		await pending.catch(() => {});
		await Promise.resolve();
		expect(backup.openCount).toBe(0);
		expect(primary.cancelReasons.length).toBeGreaterThanOrEqual(1);
		expect((primary.cancelReasons[primary.cancelReasons.length - 1] as MuxCancelled).reason).toBe(
			"aborted",
		);
	});

	it("LSM-FB-67 primary IN_BAND_ERROR post-commit under commit propagates backup silent", async () => {
		type Frame = string | { err: true };
		const backup = lazyOpenCounter(() => fromArray(["backup"]).asyncIterable);
		const iter = fallback<Frame>(
			[fromArray<Frame>(["ok", { err: true }]).asyncIterable, backup.source],
			{
				policy: "commit",
				isError: (item) => typeof item === "object" && item !== null && "err" in item,
			},
		)[Symbol.asyncIterator]();
		expect((await iter.next()).value).toBe("ok");
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "IN_BAND_ERROR";
		});
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-68 primary IN_BAND_ERROR post-commit under post-emit failover backup continues", async () => {
		type Frame = string | { err: true };
		const backup = fromArray(["b1"]).asyncIterable;
		const out = await collectFallback<Frame>(
			[fromArray<Frame>(["ok", { err: true }]).asyncIterable, backup],
			{
				policy: "post-emit",
				isError: (item) => typeof item === "object" && item !== null && "err" in item,
			},
		);
		expect(out).toEqual(["ok", "b1"]);
	});

	it("LSM-FB-69 timeoutMs plus isUsable timeout applies to first usable not first byte", async () => {
		const junkThenGood = fromArray(["junk", "good"], { delayMs: 20 }).asyncIterable;
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const out = await collectFallback([junkThenGood, backup.source], {
			timeoutMs: 150,
			isUsable: (item) => item === "good",
		});
		expect(out).toEqual(["junk", "good"]);
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-70 dual superseded sources both cancelled failover exactly once each", async () => {
		const aReasons: unknown[] = [];
		const bReasons: unknown[] = [];
		const a = failingWithCancelSpy(() => fromArray([1], { throwAt: 0 }).asyncIterable, aReasons);
		const b = failingWithCancelSpy(() => fromArray([2], { throwAt: 0 }).asyncIterable, bReasons);
		const good = fromArray([7]).asyncIterable;
		await collectFallback([a, b, good]);
		expect(aReasons).toHaveLength(1);
		expect(bReasons).toHaveLength(1);
		expect((aReasons[0] as MuxCancelled).reason).toBe("failover");
		expect((bReasons[0] as MuxCancelled).reason).toBe("failover");
	});

	it("LSM-FB-71 controllableReadable transport error after first forwarded item under commit", async () => {
		const ctrl = controllableReadable<number>();
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const iter = fallback([ctrl.stream, backup.source])[Symbol.asyncIterator]();
		ctrl.enqueue(7);
		expect((await iter.next()).value).toBe(7);
		ctrl.error(new Error("stream broke"));
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			if (err instanceof Error && err.message === "stream broke") return true;
			const muxErr = asMuxError(err);
			return muxErr.code === "SOURCE_ERROR" && muxErr.source === "0";
		});
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-72 slow consumer manual next loop backpressure held across ten items", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).asyncIterable);
		const iter = fallback([counted.source])[Symbol.asyncIterator]();
		let delivered = 0;
		for (let i = 0; i < 10; i += 1) {
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 1);
			const step = await iter.next();
			expect(step.done).toBe(false);
			delivered += 1;
			await new Promise<void>((r) => setTimeout(r, 5));
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 1);
		}
		expect((await iter.next()).done).toBe(true);
	});

	it("LSM-FB-73 mapEach second arg is active source id labeled record", async () => {
		const mapEach = vi.fn((item: number, source: string) => `${source}:${item}`);
		await collectFallback(
			{
				alpha: fromArray([1], { throwAt: 0 }).asyncIterable,
				beta: fromArray([2], { throwAt: 0 }).asyncIterable,
				gamma: fromArray([3]).asyncIterable,
			},
			{ mapEach },
		);
		expect(mapEach).toHaveBeenCalledWith(3, "gamma");
	});

	it("LSM-FB-74 eager primary plus lazy backup backup thunk not invoked until primary fails", async () => {
		const primary = fromArray([1], { throwAt: 0 }).asyncIterable;
		const backup = lazyOpenCounter(() => fromArray([42]).asyncIterable);
		expect(await collectFallback([primary, backup.source])).toEqual([42]);
		expect(backup.openCount).toBe(1);
	});

	it("LSM-FB-75 ALL_FAILED errors entries preserve per-source source id field", async () => {
		await expect(
			collectFallback([
				{ id: "first", source: fromArray([1], { throwAt: 0 }).asyncIterable },
				{ id: "second", source: fromArray([2], { throwAt: 0 }).asyncIterable },
			]),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return (
				muxErr.code === "ALL_FAILED" &&
				muxErr.errors?.[0]?.source === "first" &&
				muxErr.errors?.[1]?.source === "second"
			);
		});
	});

	it("LSM-FB-76 post-emit pre-commit primary isError pre-commit backup wins zero failover events", async () => {
		const events: SourceEvent[] = [];
		type Frame = { tag: "ok"; v: number } | { tag: "err" };
		const bad = fromArray<Frame>([{ tag: "err" }]).asyncIterable;
		const good = fromArray<Frame>([{ tag: "ok", v: 42 }]).asyncIterable;
		const out = await collectFallback([bad, good], {
			policy: "post-emit",
			isError: (item) => item.tag === "err",
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual([{ tag: "ok", v: 42 }]);
		expect(events.filter((e) => e.type === "failover")).toHaveLength(0);
	});

	it("LSM-FB-77 post-emit post-commit strict event subsequence error cancelled failover start usable", async () => {
		const events: SourceEvent[] = [];
		const primary = fromArray([1, 2], { throwAt: 1, delayMs: 10 }).asyncIterable;
		const backup = fromArray([99], { delayMs: 20 }).asyncIterable;
		await collectFallback([primary, backup], {
			policy: "post-emit",
			onSourceEvent: (e) => events.push(e),
		});

		const types = events.map((e) => `${e.type}:${e.source}`);
		const subsequence = ["error:0", "cancelled:0", "failover:0", "start:1", "usable:1"];
		let cursor = 0;
		for (const entry of types) {
			if (entry === subsequence[cursor]) cursor += 1;
		}
		expect(cursor).toBe(subsequence.length);
	});

	it("LSM-FB-78 timeoutMs reset primary times out backup opens after delay with own budget succeeds", async () => {
		const primary = fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable;
		const backup = lazyOpenCounter(() => fromArray(["ok"], { delayMs: 60 }).asyncIterable);
		const out = await collectFallback([primary, backup.source], {
			timeoutMs: 80,
		});
		expect(out).toEqual(["ok"]);
		expect(backup.openCount).toBe(1);
	});

	it("LSM-FB-79 onFinish perSource superseded primary started items zero errored winner backup stats", async () => {
		let result: MuxResult | undefined;
		await collectFallback(
			{
				primary: fromArray([1], { throwAt: 0 }).asyncIterable,
				backup: fromArray([1, 2]).asyncIterable,
			},
			{
				onFinish: (r) => {
					result = r;
				},
			},
		);
		expect(result?.perSource.primary).toMatchObject({
			started: true,
			items: 0,
			completed: false,
		});
		expect(result?.perSource.primary?.errored?.code).toBeDefined();
		expect(result?.perSource.backup).toMatchObject({
			started: true,
			items: 2,
			completed: true,
		});
		expect(result?.perSource.backup?.errored).toBeUndefined();
		expect(result?.winner).toBe("backup");
	});

	it("LSM-FB-80 ALL_FAILED cause equals errors zero when all sources fail async", async () => {
		const err = await collectFallback([
			fromArray([1], { throwAt: 0 }).asyncIterable,
			fromArray([2], { throwAt: 0 }).asyncIterable,
		]).catch((e: unknown) => e as MuxError);
		expect(err.code).toBe("ALL_FAILED");
		expect(err.errors).toHaveLength(2);
		expect(err.cause).toBe(err.errors![0]);
	});

	it("LSM-FB-81 buffered plus isFinal junk junk FINAL flushes full buffer final event backup never opened", async () => {
		const events: SourceEvent[] = [];
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const out = await collectFallback(
			[fromArray(["junk", "junk", "FINAL"]).asyncIterable, backup.source],
			{
				policy: "buffered",
				isFinal: (x) => x === "FINAL",
				onSourceEvent: (e) => events.push(e),
			},
		);
		expect(out).toEqual(["junk", "junk", "FINAL"]);
		expect(events.some((e) => e.type === "final" && e.source === "0")).toBe(true);
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-82 post-failover enqueue lock late enqueue on primary not in consumer output", async () => {
		const primary = controllableReadable<number>();
		const backup = fromArray([10, 11]).asyncIterable;
		const iter = fallback([primary.stream, backup], {
			policy: "post-emit",
		})[Symbol.asyncIterator]();

		const out: number[] = [];
		primary.enqueue(1);
		out.push((await iter.next()).value as number);
		primary.error(new Error("post-commit fail"));
		await new Promise<void>((r) => setTimeout(r, 20));
		try {
			primary.enqueue(999);
		} catch {
			/* stream already errored/cancelled — late enqueue rejected at source */
		}
		out.push((await iter.next()).value as number);
		out.push((await iter.next()).value as number);
		expect(out).toEqual([1, 10, 11]);
		expect(out).not.toContain(999);
		expect((await iter.next()).done).toBe(true);
	});

	it("LSM-FB-83 second iterator throws Error message exactly fallback iterator already active", () => {
		const iterable = fallback([fromArray([1]).asyncIterable]);
		iterable[Symbol.asyncIterator]();
		expect(() => iterable[Symbol.asyncIterator]()).toThrow("fallback: iterator already active");
	});

	it("LSM-FB-84 isFinal item emits SourceEvent final once source completes without failover", async () => {
		const events: SourceEvent[] = [];
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const out = await collectFallback([fromArray(["x", "y"]).asyncIterable, backup.source], {
			isFinal: (item) => item === "x",
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual(["x"]);
		expect(events.filter((e) => e.type === "final" && e.source === "0")).toHaveLength(1);
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-85 buffered without isUsable no usable event until source completes usable at flush start", async () => {
		const events: SourceEvent[] = [];
		const iter = fallback([fromArray(["a", "b", "c"]).asyncIterable], {
			policy: "buffered",
			onSourceEvent: (e) => events.push(e),
		})[Symbol.asyncIterator]();

		const pendingFirst = iter.next();
		await Promise.resolve();
		await Promise.resolve();
		expect(events.filter((e) => e.type === "usable")).toHaveLength(0);

		const first = await pendingFirst;
		expect(first.value).toBe("a");
		expect(events.some((e) => e.type === "usable")).toBe(true);

		expect((await iter.next()).value).toBe("b");
		expect((await iter.next()).value).toBe("c");
		expect((await iter.next()).done).toBe(true);
	});

	it("LSM-FB-86 AsyncIterable inputs via fromArray asyncIterable", async () => {
		const { asyncIterable } = fromArray([1, 2, 3]);
		expect(await collectFallback([asyncIterable])).toEqual([1, 2, 3]);
	});

	it("LSM-FB-87 partial forwarded output then abort onFinish reflects perSource items", async () => {
		const ctrl = new AbortController();
		let result: MuxResult | undefined;
		const iter = fallback([fromArray([1, 2, 3, 4], { delayMs: 15 }).asyncIterable], {
			signal: ctrl.signal,
			onFinish: (r) => {
				result = r;
			},
		})[Symbol.asyncIterator]();
		expect((await iter.next()).value).toBe(1);
		ctrl.abort();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ABORTED",
		);
		expect(result?.aborted).toBe(true);
		expect(result?.perSource["0"]?.items).toBe(1);
	});

	it("LSM-FB-88 mapEach throw on commit flush buffered junk SOURCE_ERROR active source id", async () => {
		await expect(
			collectFallback([fromArray(["junk", "good"]).asyncIterable], {
				isUsable: (s) => s === "good",
				mapEach: (s) => {
					if (s === "junk") throw new Error("map buffer fail");
					return s;
				},
			}),
		).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "SOURCE_ERROR" && asMuxError(err).source === "0",
		);
	});

	it("LSM-FB-89 post-emit pre-commit transport fail zero failover events backup wins", async () => {
		const events: SourceEvent[] = [];
		const primary = fromArray([1], { throwAt: 0 }).asyncIterable;
		const backup = fromArray([42]).asyncIterable;
		const out = await collectFallback([primary, backup], {
			policy: "post-emit",
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual([42]);
		expect(events.filter((e) => e.type === "failover")).toHaveLength(0);
		expect(events.some((e) => e.type === "error" && e.source === "0")).toBe(true);
	});

	it("LSM-FB-90 superseded primary junk never mapped mapEach only on backup items", async () => {
		const mapEach = vi.fn((item: string) => item);
		const junkPrimary = countingSource(fromArray(["j1", "j2"]).asyncIterable);
		const backup = fromArray(["ok"], { delayMs: 30 }).asyncIterable;
		await collectFallback([junkPrimary.source, backup], {
			isUsable: (s) => s === "ok",
			mapEach,
		});
		expect(mapEach).toHaveBeenCalledTimes(1);
		expect(mapEach).toHaveBeenCalledWith("ok", "1");
	});

	it("LSM-FB-91 ALL_FAILED is not ABORTED code discrimination", async () => {
		await expect(
			collectFallback([
				fromArray([1], { throwAt: 0 }).asyncIterable,
				fromArray([2], { throwAt: 0 }).asyncIterable,
			]),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			expect(muxErr.code).toBe("ALL_FAILED");
			expect(muxErr.code).not.toBe("ABORTED");
			expect(isMuxCancelled(muxErr)).toBe(false);
			return true;
		});
	});

	it("LSM-FB-92 buffered policy never emits failover SourceEvent on mid-stream failover", async () => {
		const events: SourceEvent[] = [];
		const primary = fromArray([1, 2], { throwAt: 1 }).asyncIterable;
		const backup = fromArray([99]).asyncIterable;
		await collectFallback([primary, backup], {
			policy: "buffered",
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.filter((e) => e.type === "failover")).toHaveLength(0);
	});

	it("LSM-FB-93 post-emit pre-commit timeout emits timeout event zero failover events", async () => {
		const events: SourceEvent[] = [];
		const hung = fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable;
		const backup = fromArray([42]).asyncIterable;
		const out = await collectFallback([hung, backup], {
			policy: "post-emit",
			timeoutMs: 50,
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual([42]);
		expect(events.some((e) => e.type === "timeout" && e.source === "0")).toBe(true);
		expect(events.filter((e) => e.type === "failover")).toHaveLength(0);
	});

	it("LSM-FB-94 buffered primary transport fail pre-complete consumer sees nothing backup only", async () => {
		const primary = fromArray([1, 2, 3], { throwAt: 1 }).asyncIterable;
		const backup = fromArray([7, 8]).asyncIterable;
		expect(await collectFallback([primary, backup], { policy: "buffered" })).toEqual([7, 8]);
	});

	it("LSM-FB-95 five-source chain fail fail fail fail succeed", async () => {
		const fail = () => fromArray([1], { throwAt: 0 }).asyncIterable;
		const ok = fromArray([9, 10]).asyncIterable;
		expect(await collectFallback([fail(), fail(), fail(), fail(), ok])).toEqual([9, 10]);
	});

	it("LSM-FB-96 onFinish fires exactly once when active source errors post-commit under commit", async () => {
		const onFinish = vi.fn();
		const iter = fallback([fromArray([1, 2], { throwAt: 1 }).asyncIterable], {
			policy: "commit",
			onFinish,
		})[Symbol.asyncIterator]();
		expect((await iter.next()).value).toBe(1);
		await expect(iter.next()).rejects.toBeTruthy();
		expect(onFinish).toHaveBeenCalledTimes(1);
		expect(onFinish.mock.calls[0]![0]?.strategy).toBe("fallback");
	});

	it("LSM-FB-97 mapEach transforms commit isUsable buffered flush items in order", async () => {
		const out = await collectFallback([fromArray(["a", "b", "c"]).asyncIterable], {
			isUsable: (s) => s === "c",
			mapEach: (s) => s.toUpperCase(),
		});
		expect(out).toEqual(["A", "B", "C"]);
	});

	it("LSM-FB-98 superseded primary pullCount bounded after failover no stray reads", async () => {
		const primary = countingSource(fromArray([1, 2, 3], { neverEnd: true }).asyncIterable);
		const backup = fromArray([99]).asyncIterable;
		const iter = fallback([primary.source, backup])[Symbol.asyncIterator]();
		await iter.return();
		expect(primary.pullCount).toBeLessThanOrEqual(2);
	});

	it("LSM-FB-99 post-emit post-commit controllable transport error failover backup continues", async () => {
		const events: SourceEvent[] = [];
		const ctrl = controllableReadable<number>();
		const backup = fromArray([88]).asyncIterable;
		const iter = fallback([ctrl.stream, backup], {
			policy: "post-emit",
			onSourceEvent: (e) => events.push(e),
		})[Symbol.asyncIterator]();
		ctrl.enqueue(1);
		expect((await iter.next()).value).toBe(1);
		ctrl.error(new Error("post-commit break"));
		expect((await iter.next()).value).toBe(88);
		expect(events.some((e) => e.type === "failover" && e.source === "0")).toBe(true);
		expect((await iter.next()).done).toBe(true);
	});

	it("LSM-FB-100 return after commit aborts active source with aborted not failover", async () => {
		const primary = cancelSpyingReadable<number>();
		const backup = cancelSpyingReadable<number>();
		const iter = fallback([primary.stream, backup.stream])[Symbol.asyncIterator]();
		primary.enqueue(1);
		expect((await iter.next()).value).toBe(1);
		await iter.return();
		expect(primary.cancelReasons.length).toBeGreaterThanOrEqual(1);
		expect((primary.cancelReasons.at(-1) as MuxCancelled).reason).toBe("aborted");
		expect(backup.cancelReasons).toHaveLength(0);
	});

	it("LSM-FB-101 done SourceEvent emitted on successful single-source completion", async () => {
		const events: SourceEvent[] = [];
		await collectFallback([fromArray([1, 2]).asyncIterable], {
			onSourceEvent: (e) => events.push(e),
		});
		expect(
			events.filter((e) => e.type === "done" && e.source === "0").length,
		).toBeGreaterThanOrEqual(1);
	});

	it("LSM-FB-102 post-emit plus buffered policy on primary failover never emits failover event", async () => {
		const events: SourceEvent[] = [];
		await collectFallback(
			[fromArray([1, 2], { throwAt: 1 }).asyncIterable, fromArray([9]).asyncIterable],
			{
				policy: "buffered",
				onSourceEvent: (e) => events.push(e),
			},
		);
		expect(events.filter((e) => e.type === "failover")).toHaveLength(0);
	});

	it("LSM-FB-103 all sources in-band isError only ALL_FAILED when every source fails", async () => {
		type Frame = { err: true } | { ok: true };
		await expect(
			collectFallback(
				[
					fromArray<Frame>([{ err: true }]).asyncIterable,
					fromArray<Frame>([{ err: true }]).asyncIterable,
				],
				{
					isError: (item) => "err" in item,
				},
			),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "ALL_FAILED");
	});

	it("LSM-FB-104 onFinish perSource omits never-started lazy backup when primary succeeds", async () => {
		let result: MuxResult | undefined;
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		await collectFallback([fromArray([1, 2]).asyncIterable, backup.source], {
			onFinish: (r) => {
				result = r;
			},
		});
		expect(result?.winner).toBe("0");
		expect(result?.perSource["1"]).toBeUndefined();
		expect(backup.openCount).toBe(0);
	});

	it("LSM-FB-105 mapEach throw on buffered policy flush SOURCE_ERROR source id", async () => {
		await expect(
			collectFallback([fromArray(["a", "b"]).asyncIterable], {
				policy: "buffered",
				mapEach: (s) => {
					if (s === "a") throw new Error("buffered map fail");
					return s;
				},
			}),
		).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "SOURCE_ERROR" && asMuxError(err).source === "0",
		);
	});

	it("LSM-FB-106 superseded primary late enqueue after post-commit failover not in output", async () => {
		const ctrl = controllableReadable<number>();
		const backup = fromArray([42]).asyncIterable;
		const iter = fallback([ctrl.stream, backup], { policy: "post-emit" })[Symbol.asyncIterator]();
		ctrl.enqueue(1);
		expect((await iter.next()).value).toBe(1);
		ctrl.error(new Error("fail"));
		await Promise.resolve();
		try {
			ctrl.enqueue(999);
		} catch {
			/* late enqueue rejected after error/cancel */
		}
		expect((await iter.next()).value).toBe(42);
		expect((await iter.next()).done).toBe(true);
	});

	it("LSM-FB-107 commit post-commit IN_BAND onFinish once winner undefined errored primary", async () => {
		let result: MuxResult | undefined;
		type Frame = string | { err: true };
		const iter = fallback<Frame>([fromArray<Frame>(["ok", { err: true }]).asyncIterable], {
			policy: "commit",
			isError: (item) => typeof item === "object" && item !== null && "err" in item,
			onFinish: (r) => {
				result = r;
			},
		})[Symbol.asyncIterator]();
		expect((await iter.next()).value).toBe("ok");
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "IN_BAND_ERROR",
		);
		expect(result?.perSource["0"]?.errored?.code).toBe("IN_BAND_ERROR");
		expect(result?.perSource["0"]?.items).toBe(1);
	});

	it("LSM-FB-108 interop toReadable round-trip fallback chain equals direct collect", async () => {
		const makeSources = () =>
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2, 3]).asyncIterable] as const;
		const direct = await collectFallback(makeSources());
		const roundTrip = await collect(toAsyncIterable(toReadable(fallback(makeSources()))));
		expect(roundTrip).toEqual(direct);
	});

	it("LSM-FB-109 single source timeoutMs ALL_FAILED includes TIMEOUT in errors", async () => {
		await expect(
			collectFallback([fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable], {
				timeoutMs: 50,
			}),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return (
				muxErr.code === "ALL_FAILED" &&
				muxErr.errors?.length === 1 &&
				muxErr.errors[0]?.code === "TIMEOUT"
			);
		});
	});

	it("LSM-FB-110 post-emit post-commit failover preserves primary partial then appends backup", async () => {
		const primary = fromArray([10, 20], { throwAt: 1 }).asyncIterable;
		const backup = fromArray([30, 40]).asyncIterable;
		const out = await collectFallback([primary, backup], { policy: "post-emit" });
		expect(out).toEqual([10, 30, 40]);
	});
});
