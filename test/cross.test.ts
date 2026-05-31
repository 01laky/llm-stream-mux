import { describe, expect, it, vi } from "vitest";
import { collect, ensemble, fallback, merge, race } from "../src/index.js";
import { isMuxCancelled } from "../src/internal/abort.js";
import type {
	FallbackOptions,
	MergeOptions,
	MuxCancelled,
	MuxError,
	MuxResult,
	RaceOptions,
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

function expectAbortedByOverallTimeout(err: unknown): void {
	const muxErr = asMuxError(err);
	expect(muxErr.code).toBe("ABORTED");
	expect(isMuxCancelled(muxErr)).toBe(false);
	const cause = muxErr.cause;
	expect(cause).toBeDefined();
	if (cause && typeof cause === "object" && "code" in cause) {
		expect((cause as MuxError).code).toBe("TIMEOUT");
	}
}

async function collectRace<T, U = T>(sources: Sources<T>, opts?: RaceOptions<T, U>) {
	return collect(race(sources, opts));
}

async function collectFallback<T, U = T>(sources: Sources<T>, opts?: FallbackOptions<T, U>) {
	return collect(fallback(sources, opts));
}

async function collectTagged<T, U = T>(
	sources: Sources<T>,
	opts?: MergeOptions<T, U>,
): Promise<Tagged<U>[]> {
	return collect(merge(sources, opts));
}

function valueTags<T>(tags: Tagged<T>[]) {
	return tags.filter((t): t is Tagged<T> & { kind: "value" } => t.kind === "value");
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

function rrFixture() {
	const a = controllableReadable<number>();
	const b = controllableReadable<number>();
	a.enqueue(1);
	b.enqueue(2);
	a.enqueue(3);
	b.enqueue(4);
	a.close();
	b.close();
	return [a.stream, b.stream] as const;
}

describe("LSM-X cross-cutting CommonOptions", () => {
	// A. Option validation — LSM-X-01–05
	it("LSM-X-01 sync throw when overallTimeoutMs zero on race", () => {
		expect(() => race([fromArray([1]).asyncIterable], { overallTimeoutMs: 0 })).toThrow(RangeError);
	});

	it("LSM-X-02 sync throw when timeoutMs negative on fallback", () => {
		expect(() => fallback([fromArray([1]).asyncIterable], { timeoutMs: -1 })).toThrow(RangeError);
	});

	it("LSM-X-03 sync throw when highWaterMark zero on merge", () => {
		expect(() => merge([fromArray([1]).asyncIterable], { highWaterMark: 0 })).toThrow(RangeError);
	});

	it("LSM-X-04 sync throw when highWaterMark NaN on race", () => {
		expect(() => race([fromArray([1]).asyncIterable], { highWaterMark: Number.NaN })).toThrow(
			RangeError,
		);
	});

	it("LSM-X-05 sync throw when sourceHighWaterMark zero on merge", () => {
		expect(() => merge([fromArray([1]).asyncIterable], { sourceHighWaterMark: 0 })).toThrow(
			RangeError,
		);
	});

	// B. overallTimeoutMs — LSM-X-06–20
	it("LSM-X-06 race slow sources overallTimeoutMs 50 ABORTED cause TIMEOUT", async () => {
		await expect(
			collectRace(
				[
					fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable,
					fromArray([2], { delayMs: 200, neverEnd: true }).asyncIterable,
				],
				{ overallTimeoutMs: 50 },
			),
		).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
	});

	it("LSM-X-07 fallback primary never ends overallTimeoutMs 50 ABORTED backup never opened", async () => {
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const iter = fallback(
			[fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable, backup.source],
			{ overallTimeoutMs: 50 },
		)[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
		expect(backup.openCount).toBe(0);
	});

	it("LSM-X-08 merge two controllable sources slow consumer overallTimeoutMs 50 ABORTED mid-stream", async () => {
		const a = controllableReadable<number>();
		const b = controllableReadable<number>();
		a.enqueue(1);
		b.enqueue(2);
		const iter = merge([a.stream, b.stream], { overallTimeoutMs: 50 })[Symbol.asyncIterator]();
		await iter.next();
		await new Promise<void>((r) => setTimeout(r, 80));
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
	});

	it("LSM-X-09 race completes before overall deadline onFinish aborted false", async () => {
		let result: MuxResult | undefined;
		await collectRace([fromArray([1, 2, 3]).asyncIterable], {
			overallTimeoutMs: 150,
			onFinish: (r) => (result = r),
		});
		expect(result?.aborted).toBe(false);
	});

	it("LSM-X-10 merge completes normally before overall deadline timer disarmed", async () => {
		let result: MuxResult | undefined;
		const tags = await collectTagged([fromArray([1, 2]).asyncIterable], {
			overallTimeoutMs: 150,
			onFinish: (r) => (result = r),
		});
		expect(valueTags(tags).map((t) => t.value)).toEqual([1, 2]);
		expect(result?.aborted).toBe(false);
	});

	it("LSM-X-11 overall timeout isMuxCancelled false on consumer error", async () => {
		const err = await collectRace([fromArray([1], { neverEnd: true }).asyncIterable], {
			overallTimeoutMs: 50,
		}).catch((e: unknown) => e);
		expectAbortedByOverallTimeout(err);
		expect(isMuxCancelled(err)).toBe(false);
	});

	it("LSM-X-12 merge overall timeout two started sources timeout SourceEvent per source", async () => {
		const events: SourceEvent[] = [];
		const a = controllableReadable<number>();
		const b = controllableReadable<number>();
		a.enqueue(1);
		b.enqueue(2);
		const iter = merge([a.stream, b.stream], {
			overallTimeoutMs: 50,
			onSourceEvent: (e) => events.push(e),
		})[Symbol.asyncIterator]();
		await iter.next();
		await iter.next();
		await new Promise<void>((r) => setTimeout(r, 80));
		await iter.next().catch(() => {
			/* expected */
		});
		const timeoutEvents = events.filter((e) => e.type === "timeout");
		expect(timeoutEvents.length).toBeGreaterThanOrEqual(2);
		expect(new Set(timeoutEvents.map((e) => e.source))).toEqual(new Set(["0", "1"]));
		for (const e of timeoutEvents) {
			expect(asMuxError(e.error!).code).toBe("TIMEOUT");
		}
	});

	it("LSM-X-13 race overall timeout at least one timeout SourceEvent with TIMEOUT error", async () => {
		const events: SourceEvent[] = [];
		await collectRace([fromArray([1], { neverEnd: true }).asyncIterable], {
			overallTimeoutMs: 50,
			onSourceEvent: (e) => events.push(e),
		}).catch(() => {
			/* expected */
		});
		expect(
			events.some((e) => e.type === "timeout" && asMuxError(e.error!).code === "TIMEOUT"),
		).toBe(true);
	});

	it("LSM-X-14 opts signal abort before overall fires ABORTED not spurious timeout cascade", async () => {
		const ctrl = new AbortController();
		const events: SourceEvent[] = [];
		const iter = race([fromArray([1], { neverEnd: true }).asyncIterable], {
			overallTimeoutMs: 150,
			signal: ctrl.signal,
			onSourceEvent: (e) => events.push(e),
		})[Symbol.asyncIterator]();
		await iter.next();
		ctrl.abort(new Error("user abort"));
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			expect(muxErr.code).toBe("ABORTED");
			expect(isMuxCancelled(muxErr)).toBe(false);
			return true;
		});
		expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
	});

	it("LSM-X-15 combineSignals parent signal abort disarms overall timer no double fault", async () => {
		const ctrl = new AbortController();
		let finishCalls = 0;
		const iter = merge([fromArray([1], { neverEnd: true }).asyncIterable], {
			overallTimeoutMs: 150,
			signal: ctrl.signal,
			onFinish: () => {
				finishCalls += 1;
			},
		})[Symbol.asyncIterator]();
		await iter.next();
		ctrl.abort(new Error("early"));
		await iter.next().catch(() => {
			/* expected */
		});
		await new Promise<void>((r) => setTimeout(r, 100));
		expect(finishCalls).toBe(1);
	});

	it("LSM-X-16 fallback success path overall timer disarmed endedAt gte startedAt", async () => {
		let result: MuxResult | undefined;
		await collectFallback([fromArray([1, 2]).asyncIterable], {
			overallTimeoutMs: 150,
			onFinish: (r) => (result = r),
		});
		expect(result?.aborted).toBe(false);
		expect(result?.startedAt).toBeDefined();
		expect(result?.endedAt).toBeDefined();
		expect(result!.endedAt! >= result!.startedAt!).toBe(true);
	});

	it("LSM-X-17 fallback overall timeout during primary attempt no failover to backup", async () => {
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		await expect(
			collectFallback(
				[fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable, backup.source],
				{ overallTimeoutMs: 50 },
			),
		).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
		expect(backup.openCount).toBe(0);
	});

	it("LSM-X-18 merge overall timeout after partial Tagged values tags retained then ABORTED", async () => {
		const tags: Tagged<number>[] = [];
		const iter = merge(
			[
				fromArray([1, 2, 3], { neverEnd: true }).asyncIterable,
				fromArray([10], { neverEnd: true }).asyncIterable,
			],
			{ overallTimeoutMs: 50 },
		)[Symbol.asyncIterator]();
		for (let i = 0; i < 2; i += 1) {
			const step = await iter.next();
			if (!step.done) tags.push(step.value);
		}
		await new Promise<void>((r) => setTimeout(r, 80));
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
		expect(tags.filter((t) => t.kind === "value").length).toBeGreaterThanOrEqual(1);
	});

	it("LSM-X-19 overall timeout all started sources cancelled aborted", async () => {
		const a = cancelSpyingReadable<number>();
		const b = cancelSpyingReadable<number>();
		a.enqueue(1);
		b.enqueue(2);
		const iter = merge([a.stream, b.stream], { overallTimeoutMs: 50 })[Symbol.asyncIterator]();
		await iter.next();
		await iter.next();
		await new Promise<void>((r) => setTimeout(r, 80));
		await iter.next().catch(() => {
			/* expected */
		});
		for (const spy of [a, b]) {
			expect(spy.cancelReasons.length).toBeGreaterThanOrEqual(1);
			expect((spy.cancelReasons.at(-1) as MuxCancelled).reason).toBe("aborted");
		}
	});

	it("LSM-X-20 overall timeout onFinish exactly once aborted true", async () => {
		let finishCalls = 0;
		let result: MuxResult | undefined;
		await collectRace([fromArray([1], { neverEnd: true }).asyncIterable], {
			overallTimeoutMs: 50,
			onFinish: (r) => {
				finishCalls += 1;
				result = r;
			},
		}).catch(() => {
			/* expected */
		});
		expect(finishCalls).toBe(1);
		expect(result?.aborted).toBe(true);
	});

	// C. timeoutMs on race — LSM-X-21–29
	it("LSM-X-21 race slow plus fast timeoutMs 50 slow disqualified fast wins", async () => {
		const slow = fromArray([99], { delayMs: 200, neverEnd: true }).asyncIterable;
		const fast = fromArray([1, 2, 3]).asyncIterable;
		expect(await collectRace([slow, fast], { timeoutMs: 50 })).toEqual([1, 2, 3]);
	});

	it("LSM-X-22 race both sources timeout NO_USABLE_SOURCE not ALL_FAILED", async () => {
		await expect(
			collectRace(
				[
					fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable,
					fromArray([2], { delayMs: 200, neverEnd: true }).asyncIterable,
				],
				{ timeoutMs: 50 },
			),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE");
	});

	it("LSM-X-23 race usable item before deadline no timeout event for that source", async () => {
		const events: SourceEvent[] = [];
		await collectRace([fromArray(["ok", "more"]).asyncIterable], {
			timeoutMs: 100,
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
	});

	it("LSM-X-24 race only non-usable items until timeout disqualified timeout event emitted", async () => {
		const events: SourceEvent[] = [];
		await expect(
			collectRace([fromArray(["junk", "junk"], { delayMs: 20, neverEnd: true }).asyncIterable], {
				timeoutMs: 50,
				isUsable: () => false,
				onSourceEvent: (e) => events.push(e),
			}),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE");
		expect(events.some((e) => e.type === "timeout" && e.source === "0")).toBe(true);
	});

	it("LSM-X-25 race isUsable gates TTF usable junk bytes do not disarm timer", async () => {
		const junkThenGood = fromArray(["junk", "good"], { delayMs: 20 }).asyncIterable;
		const slowWinner = fromArray(["win"], { delayMs: 200 }).asyncIterable;
		const out = await collectRace([junkThenGood, slowWinner], {
			timeoutMs: 150,
			isUsable: (item) => item === "good" || item === "win",
		});
		expect(out).toEqual(["junk", "good"]);
	});

	it("LSM-X-26 race timeout on loser after winner declared timer disarmed no post-win disqualify", async () => {
		const winner = fromArray([1, 2, 3]).asyncIterable;
		const loser = fromArray([99], { delayMs: 200, neverEnd: true }).asyncIterable;
		expect(await collectRace([winner, loser], { timeoutMs: 50 })).toEqual([1, 2, 3]);
	});

	it("LSM-X-27 race timeout disqualify loser cancelled race-lost", async () => {
		const spy = cancelSpyingReadable<number>();
		const fast = fromArray([1]).asyncIterable;
		await collectRace([spy.stream, fast], {
			timeoutMs: 50,
			isUsable: () => false,
		}).catch(() => {
			/* NO_USABLE_SOURCE when all candidates disqualified */
		});
		expect(spy.cancelReasons.length).toBeGreaterThanOrEqual(1);
		expect((spy.cancelReasons.at(-1) as MuxCancelled).reason).toBe("race-lost");
	});

	it("LSM-X-28 race per-source timeout onSourceEvent timeout with TIMEOUT code", async () => {
		const events: SourceEvent[] = [];
		await collectRace([fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable], {
			timeoutMs: 50,
			onSourceEvent: (e) => events.push(e),
		}).catch(() => {
			/* expected */
		});
		const te = events.find((e) => e.type === "timeout");
		expect(te?.source).toBe("0");
		expect(asMuxError(te!.error!).code).toBe("TIMEOUT");
	});

	it("LSM-X-29 race timeoutMs timer starts at first next not at race call", async () => {
		const lazy = lazyOpenCounter(
			() => fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable,
		);
		race([lazy.source], { timeoutMs: 50 });
		expect(lazy.openCount).toBe(0);
		const iter = race([lazy.source], { timeoutMs: 50 })[Symbol.asyncIterator]();
		await iter.next().catch(() => {
			/* NO_USABLE_SOURCE after per-source timeout */
		});
		await new Promise<void>((r) => setTimeout(r, 80));
		await iter.next().catch(() => {
			/* timeout path */
		});
		expect(lazy.openCount).toBe(1);
	});

	// D. timeoutMs on merge (negative) — LSM-X-30
	it("LSM-X-30 merge timeoutMs 50 never-ending source no timeout events until consumer abort", async () => {
		const events: SourceEvent[] = [];
		const ctrl = new AbortController();
		const iter = merge([fromArray([1], { neverEnd: true }).asyncIterable], {
			timeoutMs: 50,
			signal: ctrl.signal,
			onSourceEvent: (e) => events.push(e),
		})[Symbol.asyncIterator]();
		await iter.next();
		await new Promise<void>((r) => setTimeout(r, 100));
		expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
		ctrl.abort();
		await iter.next().catch(() => {
			/* expected */
		});
	});

	// E. Fallback timeout audit — LSM-X-31–35
	it("LSM-X-31 ref LSM-FB-07 fallback timeoutMs still fails over regression", async () => {
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

	it("LSM-X-32 ref LSM-FB-78 timer resets on backup attempt regression", async () => {
		const primary = fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable;
		const backup = lazyOpenCounter(() => fromArray(["ok"], { delayMs: 60 }).asyncIterable);
		const out = await collectFallback([primary, backup.source], { timeoutMs: 80 });
		expect(out).toEqual(["ok"]);
		expect(backup.openCount).toBe(1);
	});

	it("LSM-X-33 fallback timeoutMs plus overallTimeoutMs overall wins if shorter", async () => {
		await expect(
			collectFallback([fromArray([1], { neverEnd: true }).asyncIterable], {
				timeoutMs: 200,
				overallTimeoutMs: 50,
			}),
		).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
	});

	it("LSM-X-34 fallback per-attempt timeout errors entry TIMEOUT on total failure", async () => {
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

	it("LSM-X-35 fallback timeout active source cancelled failover reason when advancing", async () => {
		const cancelReasons: unknown[] = [];
		const primary = failingWithCancelSpy(
			() => fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable,
			cancelReasons,
		);
		const backup = fromArray([7]).asyncIterable;
		await collectFallback([primary, backup], { timeoutMs: 50 });
		expect(cancelReasons).toHaveLength(1);
		expect(isMuxCancelled(cancelReasons[0])).toBe(true);
		expect((cancelReasons[0] as MuxCancelled).reason).toBe("failover");
	});

	// F. Cross-strategy timeout edges — LSM-X-36–40
	it("LSM-X-36 sync throw when timeoutMs zero on race", () => {
		expect(() => race([fromArray([1]).asyncIterable], { timeoutMs: 0 })).toThrow(RangeError);
	});

	it("LSM-X-37 race overallTimeoutMs fires before winner onFinish winner undefined aborted true", async () => {
		let result: MuxResult | undefined;
		await collectRace([fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable], {
			overallTimeoutMs: 50,
			onFinish: (r) => (result = r),
		}).catch(() => {
			/* expected */
		});
		expect(result?.winner).toBeUndefined();
		expect(result?.aborted).toBe(true);
	});

	it("LSM-X-38 merge failFast true plus overallTimeoutMs overall fires ABORTED not ALL_FAILED", async () => {
		await expect(
			collectTagged([fromArray([1], { neverEnd: true }).asyncIterable], {
				failFast: true,
				overallTimeoutMs: 50,
			}),
		).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
	});

	it("LSM-X-39 race isError item before timeout disqualify via error path no timeout SourceEvent", async () => {
		const events: SourceEvent[] = [];
		await collectRace(
			[
				fromArray(["ERR"], { delayMs: 30 }).asyncIterable,
				fromArray(["ok"], { delayMs: 100 }).asyncIterable,
			],
			{
				timeoutMs: 150,
				isError: (x) => x === "ERR",
				onSourceEvent: (e) => events.push(e),
			},
		);
		expect(events.some((e) => e.type === "error" && e.source === "0")).toBe(true);
		expect(events.filter((e) => e.type === "timeout" && e.source === "0")).toHaveLength(0);
	});

	it("LSM-X-40 fallback all attempts TIMEOUT ALL_FAILED errors length N each TIMEOUT", async () => {
		await expect(
			collectFallback(
				[
					fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable,
					fromArray([2], { delayMs: 200, neverEnd: true }).asyncIterable,
				],
				{ timeoutMs: 50 },
			),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return (
				muxErr.code === "ALL_FAILED" &&
				muxErr.errors?.length === 2 &&
				muxErr.errors.every((e) => e.code === "TIMEOUT")
			);
		});
	});

	// G. mapEach cross-strategy — LSM-X-41–50
	it("LSM-X-41 race mapEach n to String runtime string chunks", async () => {
		const out = await collectRace<number, string>([fromArray([1, 2]).asyncIterable], {
			mapEach: (n) => String(n),
		});
		expect(out).toEqual(["1", "2"]);
		expect(out.every((v) => typeof v === "string")).toBe(true);
	});

	it("LSM-X-42 fallback mapEach transform on winning path", async () => {
		const out = await collectFallback<number, string>(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2, 3]).asyncIterable],
			{ mapEach: (n) => `v${n}` },
		);
		expect(out).toEqual(["v2", "v3"]);
	});

	it("LSM-X-43 merge mapEach second arg source id correct under highWaterMark 3", async () => {
		const mapEach = vi.fn((item: number, source: string) => `${source}:${item}`);
		await collectTagged(
			[
				{ id: "alpha", source: fromArray([1, 2, 3]).asyncIterable },
				{ id: "beta", source: fromArray([10]).asyncIterable },
			],
			{ highWaterMark: 3, mapEach },
		);
		expect(mapEach).toHaveBeenCalledWith(1, "alpha");
		expect(mapEach).toHaveBeenCalledWith(10, "beta");
	});

	it("LSM-X-44 race mapEach throw disqualify error path no hang", async () => {
		await expect(
			collectRace([fromArray(["bad"]).asyncIterable], {
				mapEach: () => {
					throw new Error("map fail");
				},
			}),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "NO_USABLE_SOURCE" || muxErr.code === "SOURCE_ERROR";
		});
	});

	it("LSM-X-45 fallback mapEach throw attempt fail plus failover", async () => {
		const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		const out = await collectFallback([fromArray([1]).asyncIterable, backup.source], {
			mapEach: (item, source) => {
				if (source === "0") throw new Error("map fail");
				return item;
			},
		});
		expect(out).toEqual([99]);
		expect(backup.openCount).toBe(1);
	});

	it("LSM-X-46 merge mapEach throw failFast false Tagged SOURCE_ERROR continue", async () => {
		const tags = await collectTagged(
			[fromArray([1, 2]).asyncIterable, fromArray([3]).asyncIterable],
			{
				failFast: false,
				mapEach: (item) => {
					if (item === 1) throw new Error("map fail");
					return item;
				},
			},
		);
		expect(
			tags.some((t) => t.kind === "error" && asMuxError(t.error!).code === "SOURCE_ERROR"),
		).toBe(true);
		expect(valueTags(tags).some((t) => t.value === 2)).toBe(true);
		expect(valueTags(tags).some((t) => t.value === 3)).toBe(true);
	});

	it("LSM-X-47 merge mapEach not called for in-band isError frames under HWM gt 1", async () => {
		const mapEach = vi.fn((item: string) => item);
		await collectTagged([fromArray(["good", "ERR", "good2"]).asyncIterable], {
			highWaterMark: 3,
			isError: (x) => x === "ERR",
			mapEach,
		});
		expect(mapEach).not.toHaveBeenCalledWith("ERR", "0");
		expect(mapEach).toHaveBeenCalledWith("good", "0");
		expect(mapEach).toHaveBeenCalledWith("good2", "0");
	});

	it("LSM-X-48 race mapEach not called for disqualified race pre-buffer junk", async () => {
		const mapEach = vi.fn((item: string) => item.toUpperCase());
		const loser = fromArray(["junk", "junk"]).asyncIterable;
		const winner = fromArray(["good"], { delayMs: 30 }).asyncIterable;
		await collectRace([loser, winner], {
			isUsable: (item) => item === "good",
			mapEach,
		});
		expect(mapEach).toHaveBeenCalledTimes(1);
		expect(mapEach).toHaveBeenCalledWith("good", "1");
	});

	it("LSM-X-49 typed race number string compiles and runs", async () => {
		const out = await collectRace<number, string>([fromArray([42]).asyncIterable], {
			mapEach: (n) => `n=${n}`,
		});
		expect(out).toEqual(["n=42"]);
	});

	it("LSM-X-50 mapEach throw message preserved in MuxError cause chain", async () => {
		const msg = "preserved map error";
		try {
			await collectRace([fromArray([1]).asyncIterable], {
				mapEach: () => {
					throw new Error(msg);
				},
			});
		} catch (err) {
			const muxErr = asMuxError(err);
			const cause = muxErr.cause ?? muxErr;
			if (cause instanceof Error) {
				expect(cause.message).toContain(msg);
			} else if (muxErr.cause instanceof Error) {
				expect(muxErr.cause.message).toContain(msg);
			}
			return;
		}
		throw new Error("expected throw");
	});

	// H. SourceEvent lifecycle — LSM-X-51–60
	it("LSM-X-51 race happy path start usable done on winner cancelled on losers", async () => {
		const events: SourceEvent[] = [];
		const loser = cancelSpyingReadable<number>();
		await collectRace([loser.stream, fromArray([1, 2]).asyncIterable], {
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.some((e) => e.type === "start" && e.source === "1")).toBe(true);
		expect(events.some((e) => e.type === "usable" && e.source === "1")).toBe(true);
		expect(events.some((e) => e.type === "done" && e.source === "1")).toBe(true);
		expect(events.some((e) => e.type === "cancelled" && e.source === "0")).toBe(true);
	});

	it("LSM-X-52 fallback failover event present race has zero failover", async () => {
		const fbEvents: SourceEvent[] = [];
		await collectFallback(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2]).asyncIterable],
			{ onSourceEvent: (e) => fbEvents.push(e) },
		);
		expect(fbEvents.some((e) => e.type === "failover")).toBe(true);

		const raceEvents: SourceEvent[] = [];
		await collectRace(
			[fromArray([1]).asyncIterable, fromArray([2], { delayMs: 50 }).asyncIterable],
			{
				onSourceEvent: (e) => raceEvents.push(e),
			},
		);
		expect(raceEvents.filter((e) => e.type === "failover")).toHaveLength(0);
	});

	it("LSM-X-53 merge final event when isFinal set", async () => {
		const events: SourceEvent[] = [];
		await collectTagged([fromArray(["a", "FINAL", "late"]).asyncIterable], {
			isFinal: (x) => x === "FINAL",
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.some((e) => e.type === "final" && e.source === "0")).toBe(true);
	});

	it("LSM-X-54 all strategies timestamp on events is finite number", async () => {
		const allEvents: SourceEvent[] = [];
		await collectRace([fromArray([1]).asyncIterable], {
			onSourceEvent: (e) => allEvents.push(e),
		});
		await collectFallback([fromArray([1]).asyncIterable], {
			onSourceEvent: (e) => allEvents.push(e),
		});
		await collectTagged([fromArray([1]).asyncIterable], {
			onSourceEvent: (e) => allEvents.push(e),
		});
		for (const e of allEvents) {
			expect(Number.isFinite(e.timestamp)).toBe(true);
		}
	});

	it("LSM-X-55 merge happy path no timeout options zero timeout SourceEvents", async () => {
		const events: SourceEvent[] = [];
		await collectTagged([fromArray([1, 2]).asyncIterable], {
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
	});

	it("LSM-X-56 race error event on disqualified source", async () => {
		const events: SourceEvent[] = [];
		await collectRace(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2]).asyncIterable],
			{
				onSourceEvent: (e) => events.push(e),
			},
		);
		expect(events.some((e) => e.type === "error" && e.source === "0")).toBe(true);
	});

	it("LSM-X-57 signal abort cancelled events on started sources race", async () => {
		const ctrl = new AbortController();
		const events: SourceEvent[] = [];
		const a = cancelSpyingReadable<number>();
		const b = cancelSpyingReadable<number>();
		a.enqueue(1);
		b.enqueue(2);
		const iter = race([a.stream, b.stream], {
			signal: ctrl.signal,
			onSourceEvent: (e) => events.push(e),
		})[Symbol.asyncIterator]();
		await iter.next();
		ctrl.abort();
		await iter.next().catch(() => {
			/* expected */
		});
		expect(events.filter((e) => e.type === "cancelled").length).toBeGreaterThanOrEqual(1);
	});

	it("LSM-X-58 merge done SourceEvent aligns with Tagged done tag", async () => {
		const events: SourceEvent[] = [];
		const tags = await collectTagged([fromArray([1]).asyncIterable], {
			onSourceEvent: (e) => events.push(e),
		});
		expect(tags.some((t) => t.kind === "done" && t.source === "0")).toBe(true);
		expect(events.some((e) => e.type === "done" && e.source === "0")).toBe(true);
	});

	it("LSM-X-59 event ordering start before usable for same source", async () => {
		const events: SourceEvent[] = [];
		await collectRace([fromArray([1, 2]).asyncIterable], {
			onSourceEvent: (e) => events.push(e),
		});
		const startIdx = events.findIndex((e) => e.type === "start" && e.source === "0");
		const usableIdx = events.findIndex((e) => e.type === "usable" && e.source === "0");
		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(usableIdx).toBeGreaterThan(startIdx);
	});

	it("LSM-X-60 onSourceEvent never receives Tagged payloads out-of-band only", async () => {
		const events: SourceEvent[] = [];
		await collectTagged([fromArray([1]).asyncIterable], {
			onSourceEvent: (e) => events.push(e),
		});
		for (const e of events) {
			expect(e).not.toHaveProperty("kind");
			expect(e).not.toHaveProperty("value");
		}
	});

	// I. MuxResult / onFinish — LSM-X-61–70
	it("LSM-X-61 race winner set to winning id", async () => {
		let result: MuxResult | undefined;
		await collectRace(
			[fromArray([1]).asyncIterable, fromArray([2], { delayMs: 50 }).asyncIterable],
			{
				onFinish: (r) => (result = r),
			},
		);
		expect(result?.winner).toBe("0");
	});

	it("LSM-X-62 fallback winner set on success", async () => {
		let result: MuxResult | undefined;
		await collectFallback([fromArray([1, 2]).asyncIterable], {
			onFinish: (r) => (result = r),
		});
		expect(result?.winner).toBe("0");
	});

	it("LSM-X-63 merge winner undefined", async () => {
		let result: MuxResult | undefined;
		await collectTagged([fromArray([1]).asyncIterable], {
			onFinish: (r) => (result = r),
		});
		expect(result?.winner).toBeUndefined();
	});

	it("LSM-X-64 overall timeout onFinish once", async () => {
		let finishCalls = 0;
		await collectMergeOverallTimeout(() => {
			finishCalls += 1;
		});
		expect(finishCalls).toBe(1);
	});

	it("LSM-X-65 per-source race timeout failure onFinish still called with accurate perSource", async () => {
		let result: MuxResult | undefined;
		await collectRace([fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable], {
			timeoutMs: 50,
			onFinish: (r) => (result = r),
		}).catch(() => {
			/* expected */
		});
		expect(result).toBeDefined();
		expect(result?.perSource["0"]?.errored?.code).toBe("TIMEOUT");
	});

	it("LSM-X-66 merge perSource items equals value tag count with highWaterMark 2", async () => {
		let result: MuxResult | undefined;
		await collectTagged([fromArray([1, 2, 3]).asyncIterable], {
			highWaterMark: 2,
			onFinish: (r) => (result = r),
		});
		expect(result?.perSource["0"]?.items).toBe(3);
	});

	it("LSM-X-67 aborted true on overall timeout false on clean complete", async () => {
		let timeoutResult: MuxResult | undefined;
		await collectRace([fromArray([1], { neverEnd: true }).asyncIterable], {
			overallTimeoutMs: 50,
			onFinish: (r) => (timeoutResult = r),
		}).catch(() => {
			/* expected */
		});
		expect(timeoutResult?.aborted).toBe(true);

		let cleanResult: MuxResult | undefined;
		await collectRace([fromArray([1]).asyncIterable], {
			overallTimeoutMs: 150,
			onFinish: (r) => (cleanResult = r),
		});
		expect(cleanResult?.aborted).toBe(false);
	});

	it("LSM-X-68 startedAt endedAt populated on all strategies", async () => {
		const check = (r: MuxResult | undefined) => {
			expect(r?.startedAt).toBeDefined();
			expect(r?.endedAt).toBeDefined();
		};
		let raceResult: MuxResult | undefined;
		await collectRace([fromArray([1]).asyncIterable], { onFinish: (r) => (raceResult = r) });
		check(raceResult);

		let fbResult: MuxResult | undefined;
		await collectFallback([fromArray([1]).asyncIterable], { onFinish: (r) => (fbResult = r) });
		check(fbResult);

		let mergeResult: MuxResult | undefined;
		await collectTagged([fromArray([1]).asyncIterable], { onFinish: (r) => (mergeResult = r) });
		check(mergeResult);
	});

	it("LSM-X-69 never-started lazy sources omitted from perSource merge concurrency plus overall timeout", async () => {
		const s0 = lazyOpenCounter(() => fromArray([1], { neverEnd: true }).asyncIterable);
		const s1 = lazyOpenCounter(() => fromArray([2], { neverEnd: true }).asyncIterable);
		const s2 = lazyOpenCounter(() => fromArray([3]).asyncIterable);
		const s3 = lazyOpenCounter(() => fromArray([4]).asyncIterable);
		let result: MuxResult | undefined;
		await collectTagged([s0.source, s1.source, s2.source, s3.source], {
			concurrency: 2,
			overallTimeoutMs: 50,
			onFinish: (r) => (result = r),
		}).catch(() => {
			/* expected */
		});
		expect(s2.openCount).toBe(0);
		expect(s3.openCount).toBe(0);
		expect(result?.perSource["2"]).toBeUndefined();
		expect(result?.perSource["3"]).toBeUndefined();
	});

	it("LSM-X-70 strategy field correct enum literal per strategy", async () => {
		let raceR: MuxResult | undefined;
		await collectRace([fromArray([1]).asyncIterable], { onFinish: (r) => (raceR = r) });
		expect(raceR?.strategy).toBe("race");

		let fbR: MuxResult | undefined;
		await collectFallback([fromArray([1]).asyncIterable], { onFinish: (r) => (fbR = r) });
		expect(fbR?.strategy).toBe("fallback");

		let mergeR: MuxResult | undefined;
		await collectTagged([fromArray([1]).asyncIterable], { onFinish: (r) => (mergeR = r) });
		expect(mergeR?.strategy).toBe("merge");
	});

	// J. highWaterMark / backpressure — LSM-X-71–80
	it("LSM-X-71 merge highWaterMark 3 one source ten items pullCount bounded at plateau", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).asyncIterable);
		const iter = merge([counted.source], { highWaterMark: 3 })[Symbol.asyncIterator]();
		let delivered = 0;
		let maxPull = 0;
		for (let i = 0; i < 11; i += 1) {
			maxPull = Math.max(maxPull, counted.pullCount);
			const step = await iter.next();
			if (step.done) break;
			if (step.value.kind === "value") delivered += 1;
			await Promise.resolve();
		}
		expect(maxPull).toBeLessThanOrEqual(delivered + 3);
	});

	it("LSM-X-72 race highWaterMark 2 slow consumer pump pauses appropriately", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const iter = race([counted.source], { highWaterMark: 2 })[Symbol.asyncIterator]();
		let delivered = 0;
		for (let i = 0; i < 6; i += 1) {
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 2);
			const step = await iter.next();
			if (step.done) break;
			delivered += 1;
			await new Promise<void>((r) => setTimeout(r, 5));
		}
	});

	it("LSM-X-73 fallback highWaterMark 2 slow consumer same backpressure bound", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const iter = fallback([counted.source], { highWaterMark: 2 })[Symbol.asyncIterator]();
		let delivered = 0;
		for (let i = 0; i < 6; i += 1) {
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 2);
			const step = await iter.next();
			if (step.done) break;
			delivered += 1;
			await new Promise<void>((r) => setTimeout(r, 5));
		}
	});

	it("LSM-X-74 default omitted highWaterMark matches LSM-MERGE-50 pull bound regression", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const iter = merge([counted.source])[Symbol.asyncIterator]();
		let delivered = 0;
		for (let i = 0; i < 6; i += 1) {
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 1);
			const step = await iter.next();
			if (step.done) break;
			if (step.value.kind === "value") delivered += 1;
			await Promise.resolve();
		}
	});

	it("LSM-X-75 highWaterMark 5 consumer drains all items eventually delivered", async () => {
		const items = [1, 2, 3, 4, 5, 6, 7, 8];
		const out = await collectRace([fromArray(items).asyncIterable], { highWaterMark: 5 });
		expect(out).toEqual(items);
	});

	it("LSM-X-76 merge round-robin highWaterMark 3 rotation order unchanged vs highWaterMark 1", async () => {
		const [a, b] = rrFixture();
		const hwm1 = await collectTagged([a, b], { order: "round-robin", highWaterMark: 1 });
		const [a2, b2] = rrFixture();
		const hwm3 = await collectTagged([a2, b2], { order: "round-robin", highWaterMark: 3 });
		expect(valueTags(hwm1).map((t) => [t.source, t.value])).toEqual(
			valueTags(hwm3).map((t) => [t.source, t.value]),
		);
	});

	it("LSM-X-77 sourceHighWaterMark 2 on merge ReadableStream countingSource deeper pull before backpressure", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).readable);
		const iter = merge([counted.source], {
			highWaterMark: 1,
			sourceHighWaterMark: 2,
		})[Symbol.asyncIterator]();
		await iter.next();
		await Promise.resolve();
		const withHwm = counted.pullCount;

		const baseline = countingSource(fromArray([1, 2, 3, 4, 5]).readable);
		const iterBase = merge([baseline.source], { highWaterMark: 1 })[Symbol.asyncIterator]();
		await iterBase.next();
		await Promise.resolve();
		expect(withHwm).toBeGreaterThanOrEqual(baseline.pullCount);
	});

	it("LSM-X-78 omitted sourceHighWaterMark on stream source same pull profile as pre-P6", async () => {
		const a = countingSource(fromArray([1, 2, 3]).readable);
		const b = countingSource(fromArray([1, 2, 3]).readable);
		const iterA = merge([a.source], { highWaterMark: 1 })[Symbol.asyncIterator]();
		const iterB = merge([b.source], { highWaterMark: 1 })[Symbol.asyncIterator]();
		await iterA.next();
		await iterB.next();
		await Promise.resolve();
		expect(a.pullCount).toBe(b.pullCount);
	});

	it("LSM-X-79 invalid highWaterMark sync throw on fallback", () => {
		expect(() => fallback([fromArray([1]).asyncIterable], { highWaterMark: 0 })).toThrow(
			RangeError,
		);
	});

	it("LSM-X-80 invalid overallTimeoutMs sync throw on merge onFinish NOT called", () => {
		let finishCalls = 0;
		expect(() =>
			merge([fromArray([1]).asyncIterable], {
				overallTimeoutMs: -5,
				onFinish: () => {
					finishCalls += 1;
				},
			}),
		).toThrow(RangeError);
		expect(finishCalls).toBe(0);
	});

	// K. Extended cross-strategy stress — LSM-X-81–88
	it("LSM-X-81 merge concurrency 2 highWaterMark 3 overallTimeoutMs 200 started timeout queued openCount zero", async () => {
		const events: SourceEvent[] = [];
		const slots = [0, 1, 2, 3].map(() =>
			lazyOpenCounter(() => fromArray([1], { neverEnd: true }).asyncIterable),
		);
		await collectTagged(
			slots.map((s) => s.source),
			{
				concurrency: 2,
				highWaterMark: 3,
				overallTimeoutMs: 200,
				onSourceEvent: (e) => events.push(e),
			},
		).catch(() => {
			/* expected */
		});
		expect(slots[0]!.openCount).toBe(1);
		expect(slots[1]!.openCount).toBe(1);
		expect(slots[2]!.openCount).toBe(0);
		expect(slots[3]!.openCount).toBe(0);
		expect(events.filter((e) => e.type === "timeout").length).toBeGreaterThanOrEqual(2);
	});

	it("LSM-X-82 race five sources timeoutMs 80 only source 4 emits usable in time wins", async () => {
		const events: SourceEvent[] = [];
		const sources = ["0", "1", "2", "3", "4"].map((id) => ({
			id,
			source: fromArray([id === "4" ? "win" : "junk"], {
				delayMs: id === "4" ? 60 : 0,
				neverEnd: id !== "4",
			}).asyncIterable,
		}));
		let result: MuxResult | undefined;
		const out = await collectRace(sources, {
			timeoutMs: 80,
			isUsable: (item) => item === "win",
			onSourceEvent: (e) => events.push(e),
			onFinish: (r) => (result = r),
		});
		expect(out).toEqual(["win"]);
		expect(result?.winner).toBe("4");
		expect(events.some((e) => e.type === "usable" && e.source === "4")).toBe(true);
		expect(
			events.filter((e) => e.type === "cancelled" && e.source !== "4").length,
		).toBeGreaterThanOrEqual(1);
	});

	it("LSM-X-83 overallTimeoutMs 60000 fast completing source drain done onFinish aborted false all strategies", async () => {
		const check = async (
			run: (hooks: {
				onFinish: (r: MuxResult) => void;
				onSourceEvent: (e: SourceEvent) => void;
			}) => Promise<unknown>,
		) => {
			let result: MuxResult | undefined;
			const events: SourceEvent[] = [];
			await run({
				onFinish: (r) => (result = r),
				onSourceEvent: (e) => events.push(e),
			});
			expect(result?.aborted).toBe(false);
			expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
		};

		await check(async ({ onFinish, onSourceEvent }) => {
			await collectRace([fromArray([1, 2]).asyncIterable], {
				overallTimeoutMs: 60_000,
				onFinish,
				onSourceEvent,
			});
		});
		await check(async ({ onFinish, onSourceEvent }) => {
			await collectFallback([fromArray([1, 2]).asyncIterable], {
				overallTimeoutMs: 60_000,
				onFinish,
				onSourceEvent,
			});
		});
		await check(async ({ onFinish, onSourceEvent }) => {
			await collectTagged([fromArray([1, 2]).asyncIterable], {
				overallTimeoutMs: 60_000,
				onFinish,
				onSourceEvent,
			});
		});
	});

	it("LSM-X-84 race default isUsable timeoutMs 100 first item immediately disarms no timeout event", async () => {
		const events: SourceEvent[] = [];
		await collectRace([fromArray(["first", "second"]).asyncIterable], {
			timeoutMs: 100,
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
	});

	it("LSM-X-85 merge failFast false overallTimeoutMs partial tags onFinish perSource only started ids", async () => {
		const s0 = lazyOpenCounter(() => fromArray([1, 2], { neverEnd: true }).asyncIterable);
		const s1 = lazyOpenCounter(() => fromArray([10], { neverEnd: true }).asyncIterable);
		const s2 = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		let result: MuxResult | undefined;
		const tags: Tagged<number>[] = [];
		const iter = merge([s0.source, s1.source, s2.source], {
			concurrency: 2,
			failFast: false,
			overallTimeoutMs: 50,
			onFinish: (r) => (result = r),
		})[Symbol.asyncIterator]();
		for (let i = 0; i < 3; i += 1) {
			const step = await iter.next();
			if (step.done) break;
			tags.push(step.value);
		}
		await new Promise<void>((r) => setTimeout(r, 80));
		await iter.next().catch(() => {
			/* expected */
		});
		expect(tags.some((t) => t.kind === "value")).toBe(true);
		expect(result?.perSource["2"]).toBeUndefined();
		expect(Object.keys(result?.perSource ?? {}).every((id) => id === "0" || id === "1")).toBe(true);
	});

	it("LSM-X-86 ensemble highWaterMark 2 overallTimeoutMs identical behavior to merge", async () => {
		const makeSources = () =>
			[fromArray([1]).asyncIterable, fromArray([2], { delayMs: 10 }).asyncIterable] as const;
		const fromMerge = await collectTagged(makeSources(), {
			highWaterMark: 2,
			overallTimeoutMs: 5000,
		});
		const fromEnsemble = await collect(
			ensemble(makeSources(), { highWaterMark: 2, overallTimeoutMs: 5000 }),
		);
		expect(fromEnsemble).toEqual(fromMerge);
	});

	it("LSM-X-87 sourceHighWaterMark 4 on merge AsyncIterable fromArray no extra pulls vs omitted", async () => {
		const withOpt = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const withoutOpt = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		await collectTagged([withOpt.source], { sourceHighWaterMark: 4, highWaterMark: 1 });
		await collectTagged([withoutOpt.source], { highWaterMark: 1 });
		expect(withOpt.pullCount).toBe(withoutOpt.pullCount);
	});

	it("LSM-X-88 sourceHighWaterMark 3 on merge ReadableStream countingSource pullCount plateau gt default omitted", async () => {
		const withHwm = countingSource(fromArray([1, 2, 3, 4, 5, 6]).readable);
		const withoutHwm = countingSource(fromArray([1, 2, 3, 4, 5, 6]).readable);
		const iterA = merge([withHwm.source], {
			sourceHighWaterMark: 3,
			highWaterMark: 1,
		})[Symbol.asyncIterator]();
		const iterB = merge([withoutHwm.source], { highWaterMark: 1 })[Symbol.asyncIterator]();
		await iterA.next();
		await iterB.next();
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(withHwm.pullCount).toBeGreaterThan(withoutHwm.pullCount);
		await iterA.return();
		await iterB.return();
	});

	// L. Extended edge matrix — LSM-X-89–115 (beyond P6 baseline)
	it("LSM-X-89 race highWaterMark 2 preserves null undefined and object order", async () => {
		const values: (null | { x: number } | undefined)[] = [null, { x: 1 }, undefined];
		const out = await collectRace([fromArray(values).asyncIterable], { highWaterMark: 2 });
		expect(out).toEqual(values);
	});

	it("LSM-X-90 fallback highWaterMark 3 preserves null undefined generic T", async () => {
		const values: (null | string | undefined)[] = [null, "ok", undefined];
		const out = await collectFallback([fromArray(values).asyncIterable], { highWaterMark: 3 });
		expect(out).toEqual(values);
	});

	it("LSM-X-91 merge highWaterMark 2 preserves undefined tagged values", async () => {
		const tags = await collectTagged([fromArray([undefined, 1, undefined]).asyncIterable], {
			highWaterMark: 2,
		});
		expect(valueTags(tags).map((t) => t.value)).toEqual([undefined, 1, undefined]);
	});

	it("LSM-X-92 race timeoutMs plus overallTimeoutMs overall wins when shorter", async () => {
		await expect(
			collectRace([fromArray([1], { neverEnd: true }).asyncIterable], {
				timeoutMs: 500,
				overallTimeoutMs: 50,
			}),
		).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
	});

	it("LSM-X-93 race timeoutMs plus overallTimeoutMs perSource timeout when overall longer", async () => {
		await expect(
			collectRace([fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable], {
				timeoutMs: 50,
				overallTimeoutMs: 500,
			}),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE");
	});

	it("LSM-X-94 race isFinal item disarms timeoutMs no timeout SourceEvent", async () => {
		const events: SourceEvent[] = [];
		await collectRace([fromArray(["meta", "FINAL"], { delayMs: 10 }).asyncIterable], {
			timeoutMs: 100,
			isUsable: () => false,
			isFinal: (x) => x === "FINAL",
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
		expect(events.some((e) => e.type === "usable" && e.source === "0")).toBe(true);
	});

	it("LSM-X-95 fallback isFinal before attempt timeoutMs disarms timer no timeout event", async () => {
		const events: SourceEvent[] = [];
		await collectFallback([fromArray(["junk", "FINAL"], { delayMs: 10 }).asyncIterable], {
			timeoutMs: 100,
			isUsable: () => false,
			isFinal: (x) => x === "FINAL",
			onSourceEvent: (e) => events.push(e),
		});
		expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
	});

	it("LSM-X-96 lazy ReadableStream factory sourceHighWaterMark deferred until first next", async () => {
		const lazy = lazyOpenCounter(() => fromArray([1, 2, 3, 4, 5, 6]).readable);
		merge([lazy.source], { sourceHighWaterMark: 3, highWaterMark: 1 });
		expect(lazy.openCount).toBe(0);
		const iter = merge([lazy.source], { sourceHighWaterMark: 3, highWaterMark: 1 })[
			Symbol.asyncIterator
		]();
		expect((await iter.next()).value.kind).toBe("value");
		expect(lazy.openCount).toBe(1);
		await iter.return();
	});

	it("LSM-X-97 merge timeoutMs zero sync throw at call site even though merge ignores runtime", () => {
		expect(() => merge([fromArray([1]).asyncIterable], { timeoutMs: 0 })).toThrow(RangeError);
	});

	it("LSM-X-98 merge timeoutMs slow source never emits timeout SourceEvents", async () => {
		const events: SourceEvent[] = [];
		const iter = merge([fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable], {
			timeoutMs: 50,
			onSourceEvent: (e) => events.push(e),
		})[Symbol.asyncIterator]();
		await iter.next();
		await new Promise<void>((r) => setTimeout(r, 80));
		expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
		await iter.return();
	});

	it("LSM-X-99 race perSource errored TIMEOUT on disqualified timeout source", async () => {
		let result: MuxResult | undefined;
		await collectRace([fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable], {
			timeoutMs: 50,
			onFinish: (r) => (result = r),
		}).catch(() => {
			/* NO_USABLE_SOURCE */
		});
		expect(result?.perSource["0"]?.errored?.code).toBe("TIMEOUT");
	});

	it("LSM-X-100 consumer return during race overallTimeout onFinish exactly once", async () => {
		let finishCalls = 0;
		const iter = race([fromArray([1], { neverEnd: true }).asyncIterable], {
			overallTimeoutMs: 5000,
			onFinish: () => {
				finishCalls += 1;
			},
		})[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		expect(finishCalls).toBe(1);
	});

	it("LSM-X-101 race highWaterMark 2 plus timeoutMs 50 fast source still wins", async () => {
		const slow = fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable;
		const fast = fromArray([42]).asyncIterable;
		expect(await collectRace([slow, fast], { highWaterMark: 2, timeoutMs: 50 })).toEqual([42]);
	});

	it("LSM-X-102 fallback highWaterMark 2 plus timeoutMs 50 backup wins after primary timeout", async () => {
		const primary = fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable;
		const backup = fromArray([99]).asyncIterable;
		expect(await collectFallback([primary, backup], { highWaterMark: 2, timeoutMs: 50 })).toEqual([
			99,
		]);
	});

	it("LSM-X-103 merge round-robin sourceHighWaterMark 2 highWaterMark 2 rotation matches hwm 1", async () => {
		const orderHwm1 = valueTags(
			await collectTagged(rrFixture(), { order: "round-robin", highWaterMark: 1 }),
		).map((t) => t.value);
		const orderHwm2 = valueTags(
			await collectTagged(rrFixture(), {
				order: "round-robin",
				highWaterMark: 2,
				sourceHighWaterMark: 2,
			}),
		).map((t) => t.value);
		expect(orderHwm2).toEqual(orderHwm1);
	});

	it("LSM-X-104 ensemble invalid highWaterMark sync throw same as merge", () => {
		expect(() => ensemble([fromArray([1]).asyncIterable], { highWaterMark: 0 })).toThrow(
			RangeError,
		);
	});

	it("LSM-X-105 sync throw when timeoutMs NaN on fallback", () => {
		expect(() => fallback([fromArray([1]).asyncIterable], { timeoutMs: Number.NaN })).toThrow(
			RangeError,
		);
	});

	it("LSM-X-106 sync throw when sourceHighWaterMark NaN on merge", () => {
		expect(() =>
			merge([fromArray([1]).asyncIterable], { sourceHighWaterMark: Number.NaN }),
		).toThrow(RangeError);
	});

	it("LSM-X-107 sync throw when overallTimeoutMs non-integer on race", () => {
		expect(() => race([fromArray([1]).asyncIterable], { overallTimeoutMs: 50.5 })).toThrow(
			RangeError,
		);
	});

	it("LSM-X-108 race mapEach throw after winner commit rejects SOURCE_ERROR", async () => {
		let calls = 0;
		await expect(
			collectRace([fromArray([1, 2]).asyncIterable], {
				mapEach: (n) => {
					calls += 1;
					if (calls === 2) throw new Error("map fail post-win");
					return n;
				},
			}),
		).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "SOURCE_ERROR" && asMuxError(err).source === "0",
		);
	});

	it("LSM-X-109 fallback overallTimeoutMs with highWaterMark 2 partial output then ABORTED", async () => {
		const iter = fallback([fromArray([1, 2, 3], { neverEnd: true }).asyncIterable], {
			highWaterMark: 2,
			overallTimeoutMs: 50,
		})[Symbol.asyncIterator]();
		expect((await iter.next()).value).toBe(1);
		expect((await iter.next()).value).toBe(2);
		await new Promise<void>((r) => setTimeout(r, 80));
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
	});

	it("LSM-X-110 lazy AsyncIterable factory sourceHighWaterMark is no-op on pull profile", async () => {
		const withOpt = countingSource(
			lazyOpenCounter(() => fromArray([1, 2, 3, 4]).asyncIterable).source,
		);
		const withoutOpt = countingSource(
			lazyOpenCounter(() => fromArray([1, 2, 3, 4]).asyncIterable).source,
		);
		await collectTagged([withOpt.source], { sourceHighWaterMark: 4, highWaterMark: 1 });
		await collectTagged([withoutOpt.source], { highWaterMark: 1 });
		expect(withOpt.pullCount).toBe(withoutOpt.pullCount);
	});

	it("LSM-X-111 race overall timeout timeout SourceEvent count equals started source count", async () => {
		const events: SourceEvent[] = [];
		await collectRace(
			[
				fromArray([1], { neverEnd: true }).asyncIterable,
				fromArray([2], { neverEnd: true }).asyncIterable,
			],
			{
				overallTimeoutMs: 50,
				onSourceEvent: (e) => events.push(e),
			},
		).catch(() => {
			/* expected */
		});
		const timeoutEvents = events.filter((e) => e.type === "timeout");
		expect(timeoutEvents).toHaveLength(2);
		expect(new Set(timeoutEvents.map((e) => e.source))).toEqual(new Set(["0", "1"]));
	});

	it("LSM-X-112 fallback timeoutMs fresh budget on backup after primary timeout regression", async () => {
		const backup = lazyOpenCounter(() => fromArray(["ok"], { delayMs: 60 }).asyncIterable);
		const out = await collectFallback(
			[fromArray([1], { delayMs: 200, neverEnd: true }).asyncIterable, backup.source],
			{ timeoutMs: 80, highWaterMark: 2 },
		);
		expect(out).toEqual(["ok"]);
		expect(backup.openCount).toBe(1);
	});

	it("LSM-X-113 merge failFast true overallTimeoutMs ABORTED not ALL_FAILED with partial tags", async () => {
		const a = controllableReadable<number>();
		const b = controllableReadable<number>();
		a.enqueue(1);
		b.enqueue(2);
		const tags: Tagged<number>[] = [];
		const iter = merge([a.stream, b.stream], {
			failFast: true,
			overallTimeoutMs: 50,
		})[Symbol.asyncIterator]();
		for (let i = 0; i < 2; i += 1) {
			const step = await iter.next();
			if (!step.done) tags.push(step.value);
		}
		await new Promise<void>((r) => setTimeout(r, 80));
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			expectAbortedByOverallTimeout(err);
			return true;
		});
		expect(tags.filter((t) => t.kind === "value").length).toBeGreaterThanOrEqual(1);
	});

	it("LSM-X-114 race isError item disarms timeoutMs before deadline no timeout event", async () => {
		const events: SourceEvent[] = [];
		await expect(
			collectRace([fromArray(["ERR"]).asyncIterable], {
				timeoutMs: 100,
				isError: () => true,
				onSourceEvent: (e) => events.push(e),
			}),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE");
		expect(events.filter((e) => e.type === "timeout")).toHaveLength(0);
		expect(events.some((e) => e.type === "error" && e.source === "0")).toBe(true);
	});

	it("LSM-X-115 onFinish exactly once on consumer return mid-stream all strategies", async () => {
		let raceFinish = 0;
		const raceIter = race([fromArray([1, 2, 3]).asyncIterable], {
			onFinish: () => {
				raceFinish += 1;
			},
		})[Symbol.asyncIterator]();
		await raceIter.next();
		await raceIter.return();
		expect(raceFinish).toBe(1);

		let fbFinish = 0;
		const fbIter = fallback([fromArray([1, 2, 3]).asyncIterable], {
			onFinish: () => {
				fbFinish += 1;
			},
		})[Symbol.asyncIterator]();
		await fbIter.next();
		await fbIter.return();
		expect(fbFinish).toBe(1);

		let mergeFinish = 0;
		const mergeIter = merge([fromArray([1, 2, 3]).asyncIterable], {
			onFinish: () => {
				mergeFinish += 1;
			},
		})[Symbol.asyncIterator]();
		await mergeIter.next();
		await mergeIter.return();
		expect(mergeFinish).toBe(1);
	});
});

async function collectMergeOverallTimeout(onFinish: () => void): Promise<void> {
	await collectRace([fromArray([1], { neverEnd: true }).asyncIterable], {
		overallTimeoutMs: 50,
		onFinish: () => onFinish(),
	}).catch(() => {
		/* expected */
	});
}
