import { describe, expect, it, vi } from "vitest";
import { collect, race, toAsyncIterable, toReadable } from "../src/index.js";
import { race as raceDirect } from "../src/race.js";
import { isMuxCancelled } from "../src/internal/abort.js";
import type {
	MuxCancelled,
	MuxError,
	MuxResult,
	RaceOptions,
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

async function collectRace<T, U = T>(sources: Sources<T>, opts?: RaceOptions<T, U>) {
	return collect(race(sources, opts));
}

describe("LSM-RACE race strategy", () => {
	it("LSM-RACE-01 two sources first to emit wins collect equals winner full sequence", async () => {
		const fast = fromArray([1, 2, 3]).asyncIterable;
		const slow = fromArray([10, 20], { delayMs: 50 }).asyncIterable;
		expect(await collectRace([fast, slow])).toEqual([1, 2, 3]);
	});

	it("LSM-RACE-02 junk-first slow wins isUsable excludes loser junk", async () => {
		const junkFirst = fromArray([new Uint8Array(0)]).asyncIterable;
		const slowGood = fromArray([new Uint8Array([42])], { delayMs: 50 }).asyncIterable;
		const out = await collectRace([junkFirst, slowGood], {
			isUsable: (c) => c.byteLength > 0,
		});
		expect(out).toEqual([new Uint8Array([42])]);
	});

	it("LSM-RACE-03 pre-usable buffer on winner flushed in order", async () => {
		const source = fromArray(["junk", "junk", "good"]).asyncIterable;
		const out = await collectRace([source], {
			isUsable: (item) => item === "good",
		});
		expect(out).toEqual(["junk", "junk", "good"]);
	});

	it("LSM-RACE-04 on win losers cancel called with race-lost", async () => {
		const loser = cancelSpyingReadable<number>();
		const winner = fromArray([1, 2]).asyncIterable;
		await collectRace([loser.stream, winner]);
		expect(loser.cancelReasons).toHaveLength(1);
		expect(isMuxCancelled(loser.cancelReasons[0])).toBe(true);
		expect((loser.cancelReasons[0] as MuxCancelled).reason).toBe("race-lost");
	});

	it("LSM-RACE-05 non-empty sources all empty async NO_USABLE_SOURCE on first next", async () => {
		const iterable = race([fromArray([]).asyncIterable, fromArray([]).asyncIterable]);
		const iter = iterable[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "NO_USABLE_SOURCE";
		});
	});

	it("LSM-RACE-06 winner errors after commit rejects no failover to loser", async () => {
		const winner = fromArray([0, 1], { throwAt: 1 }).asyncIterable;
		const loser = fromArray([99, 100], { delayMs: 100 }).asyncIterable;
		await expect(collectRace([winner, loser])).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "SOURCE_ERROR" || muxErr.message.includes("throwAt");
		});
	});

	it("LSM-RACE-07 signal abort mid-race ABORTED not MuxCancelled", async () => {
		const ctrl = new AbortController();
		const hung = fromArray([1], { delayMs: 100, neverEnd: true }).asyncIterable;
		const iter = race([hung], { signal: ctrl.signal })[Symbol.asyncIterator]();
		const pending = iter.next();
		ctrl.abort(new Error("user abort"));
		await expect(pending).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			expect(muxErr.code).toBe("ABORTED");
			expect(isMuxCancelled(muxErr)).toBe(false);
			return true;
		});
	});

	it("LSM-RACE-08 onFinish winner equals winning source id strategy race", async () => {
		let result: MuxResult | undefined;
		await collectRace(
			[fromArray([1]).asyncIterable, fromArray([2], { delayMs: 50 }).asyncIterable],
			{
				onFinish: (r) => {
					result = r;
				},
			},
		);
		expect(result?.strategy).toBe("race");
		expect(result?.winner).toBe("0");
	});

	it("LSM-RACE-09 race empty array throws NO_USABLE_SOURCE synchronously", () => {
		expect(() => race([])).toThrow();
		try {
			race([]);
		} catch (err) {
			expect(asMuxError(err).code).toBe("NO_USABLE_SOURCE");
		}
	});

	it("LSM-RACE-10 single source pass-through full sequence via raceDirect", async () => {
		expect(await collect(raceDirect([fromArray([1, 2, 3]).asyncIterable]))).toEqual([1, 2, 3]);
	});

	it("LSM-RACE-11 labeled record slow wins onFinish winner slow", async () => {
		let result: MuxResult | undefined;
		await collectRace(
			{
				fast: fromArray([99], { delayMs: 50 }).asyncIterable,
				slow: fromArray([1, 2], { delayMs: 20 }).asyncIterable,
			},
			{
				onFinish: (r) => {
					result = r;
				},
			},
		);
		expect(result?.winner).toBe("slow");
	});

	it("LSM-RACE-12 lazy thunks openCount zero at call N after first next", async () => {
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const c = lazyOpenCounter(() => fromArray([3]).asyncIterable);
		const iterable = race([a.source, b.source, c.source]);
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
		expect(c.openCount).toBe(0);
		const iter = iterable[Symbol.asyncIterator]();
		await iter.next();
		expect(a.openCount).toBe(1);
		expect(b.openCount).toBe(1);
		expect(c.openCount).toBe(1);
	});

	it("LSM-RACE-13 isError disqualifies source other wins IN_BAND_ERROR event", async () => {
		type Frame = { tag: "ok"; v: number } | { tag: "err" };
		const events: SourceEvent[] = [];
		const bad = fromArray<Frame>([{ tag: "err" }]).asyncIterable;
		const good = fromArray<Frame>([{ tag: "ok", v: 42 }], { delayMs: 10 }).asyncIterable;
		const out = await collectRace([bad, good], {
			isError: (item) => item.tag === "err",
			onSourceEvent: (e) => events.push(e),
		});
		expect(out).toEqual([{ tag: "ok", v: 42 }]);
		const errEvent = events.find((e) => e.type === "error" && e.source === "0");
		expect(errEvent?.error?.code).toBe("IN_BAND_ERROR");
	});

	it("LSM-RACE-14 isFinal on winning item race completes after that item", async () => {
		const source = fromArray(["a", "b", "c"]).asyncIterable;
		const out = await collectRace([source], {
			isFinal: (item) => item === "a",
		});
		expect(out).toEqual(["a"]);
	});

	it("LSM-RACE-15 mapEach transforms T to U output matches", async () => {
		const out = await collectRace([fromArray([1, 2]).asyncIterable], {
			mapEach: (n) => `n=${n}`,
		});
		expect(out).toEqual(["n=1", "n=2"]);
	});

	it("LSM-RACE-16 mapEach throws consumer rejects SOURCE_ERROR with winner id", async () => {
		await expect(
			collectRace([fromArray([1]).asyncIterable], {
				mapEach: () => {
					throw new Error("map blew up");
				},
			}),
		).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "SOURCE_ERROR" && muxErr.source === "0";
		});
	});

	it("LSM-RACE-17 onSourceEvent start on each usable on winner cancelled on losers", async () => {
		const events: SourceEvent[] = [];
		await collectRace(
			[fromArray([1]).asyncIterable, fromArray([2], { delayMs: 50 }).asyncIterable],
			{
				onSourceEvent: (e) => events.push(e),
			},
		);
		expect(
			events
				.filter((e) => e.type === "start")
				.map((e) => e.source)
				.sort(),
		).toEqual(["0", "1"]);
		expect(events.some((e) => e.type === "usable" && e.source === "0")).toBe(true);
		expect(events.some((e) => e.type === "cancelled" && e.source === "1")).toBe(true);
	});

	it("LSM-RACE-18 onFinish called exactly once after normal completion", async () => {
		let finishCalls = 0;
		await collectRace([fromArray([1, 2]).asyncIterable], {
			onFinish: () => {
				finishCalls += 1;
			},
		});
		expect(finishCalls).toBe(1);
	});

	it("LSM-RACE-19 consumer return early all started sources cancelled aborted", async () => {
		const winner = cancelSpyingReadable<number>();
		winner.enqueue(1);
		winner.enqueue(2);
		const iterable = race([fromArray([99], { delayMs: 50 }).asyncIterable, winner.stream]);
		const iter = iterable[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		await Promise.resolve();
		expect(winner.cancelReasons.length).toBeGreaterThanOrEqual(1);
		expect(isMuxCancelled(winner.cancelReasons[winner.cancelReasons.length - 1])).toBe(true);
		expect((winner.cancelReasons[winner.cancelReasons.length - 1] as MuxCancelled).reason).toBe(
			"aborted",
		);
	});

	it("LSM-RACE-20 one source transport error other source wins", async () => {
		const broken = fromArray([1], { throwAt: 0 }).asyncIterable;
		const good = fromArray([42]).asyncIterable;
		expect(await collectRace([broken, good])).toEqual([42]);
	});

	it("LSM-RACE-21 both sources throw before usable item NO_USABLE_SOURCE", async () => {
		const a = fromArray([1], { throwAt: 0 }).asyncIterable;
		const b = fromArray([2], { throwAt: 0 }).asyncIterable;
		await expect(collectRace([a, b])).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "NO_USABLE_SOURCE";
		});
	});

	it("LSM-RACE-22 three sources first usable among three wins other two cancelled", async () => {
		const events: SourceEvent[] = [];
		const a = cancelSpyingReadable<number>();
		const b = cancelSpyingReadable<number>();
		const c = fromArray([7]).asyncIterable;
		a.enqueue(0);
		b.enqueue(0);
		await collectRace([a.stream, b.stream, c], {
			isUsable: (n) => n === 7,
			onSourceEvent: (e) => events.push(e),
		});
		expect(
			events
				.filter((e) => e.type === "cancelled")
				.map((e) => e.source)
				.sort(),
		).toEqual(["0", "1"]);
		for (const spy of [a, b]) {
			expect(spy.cancelReasons).toHaveLength(1);
			expect((spy.cancelReasons[0] as MuxCancelled).reason).toBe("race-lost");
		}
	});

	it("LSM-RACE-23 fast only non-usable until done slow emits usable slow wins", async () => {
		const fast = fromArray(["x", "y"]).asyncIterable;
		const slow = fromArray(["good"], { delayMs: 30 }).asyncIterable;
		const out = await collectRace([fast, slow], {
			isUsable: (item) => item === "good",
		});
		expect(out).toEqual(["good"]);
	});

	it("LSM-RACE-24 exact buffer flush arithmetic first usable at 3 outputs 1 2 3 4", async () => {
		const source = fromArray([1, 2, 3, 4]).asyncIterable;
		const out = await collectRace([source], {
			isUsable: (n) => n === 3,
		});
		expect(out).toEqual([1, 2, 3, 4]);
	});

	it("LSM-RACE-25 import race from ../src/index.js public export path", async () => {
		const { race: raceFromIndex, collect: collectFromIndex } = await import("../src/index.js");
		expect(typeof raceFromIndex).toBe("function");
		const out = await collectFromIndex(
			raceFromIndex([fromArray([1]).asyncIterable, fromArray([2], { delayMs: 50 }).asyncIterable]),
		);
		expect(out).toEqual([1]);
	});

	it("LSM-RACE-26 ReadableStream inputs via fromArray readable", async () => {
		const a = fromArray([1, 2]).readable;
		const b = fromArray([9], { delayMs: 50 }).readable;
		expect(await collectRace([a, b])).toEqual([1, 2]);
	});

	it("LSM-RACE-27 AsyncIterable inputs via fromArray asyncIterable", async () => {
		expect(await collectRace([fromArray([4, 5, 6]).asyncIterable])).toEqual([4, 5, 6]);
	});

	it("LSM-RACE-28 signal already aborted before first next ABORTED sources not opened", async () => {
		const ctrl = new AbortController();
		ctrl.abort(new Error("pre-aborted"));
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const iter = race([a.source, b.source], { signal: ctrl.signal })[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "ABORTED";
		});
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
	});

	it("LSM-RACE-29 each loser cancel exactly once no double cancel", async () => {
		const loser = cancelSpyingReadable<number>();
		const winner = fromArray([1]).asyncIterable;
		await collectRace([winner, loser.stream]);
		expect(loser.cancelReasons).toHaveLength(1);
		expect((loser.cancelReasons[0] as MuxCancelled).reason).toBe("race-lost");
	});

	it("LSM-RACE-30 default isUsable omit option first emitted item wins", async () => {
		expect(
			await collectRace([
				fromArray(["first"]).asyncIterable,
				fromArray(["second"], { delayMs: 50 }).asyncIterable,
			]),
		).toEqual(["first"]);
	});

	it("LSM-RACE-31 positional array ids 0 and 1 in telemetry MuxResult winner", async () => {
		let result: MuxResult | undefined;
		await collectRace(
			[fromArray([1]).asyncIterable, fromArray([2], { delayMs: 50 }).asyncIterable],
			{
				onFinish: (r) => {
					result = r;
				},
			},
		);
		expect(result?.winner).toBe("0");
		expect(result?.perSource["0"]?.started).toBe(true);
		expect(result?.perSource["1"]?.started).toBe(true);
	});

	it("LSM-RACE-32 normal winner completion onFinish perSource winner completed true", async () => {
		let result: MuxResult | undefined;
		await collectRace([fromArray([1, 2]).asyncIterable], {
			onFinish: (r) => {
				result = r;
			},
		});
		expect(result?.winner).toBe("0");
		expect(result?.perSource["0"]?.completed).toBe(true);
		expect(result?.perSource["0"]?.errored).toBeUndefined();
	});

	it("LSM-RACE-33 race call does not invoke sources no next until consumer iterates", () => {
		let pulls = 0;
		const source = () => {
			pulls += 1;
			return fromArray([1]).asyncIterable;
		};
		race([source]);
		expect(pulls).toBe(0);
	});

	it("LSM-RACE-34 without isError normal items never disqualify only transport or isError", async () => {
		type Item = { v: number; bad?: true };
		const a = fromArray<Item>([{ v: 1, bad: true }]).asyncIterable;
		const b = fromArray<Item>([{ v: 2 }], { delayMs: 20 }).asyncIterable;
		expect(await collectRace([a, b])).toEqual([{ v: 1, bad: true }]);
	});

	it("LSM-RACE-35 tie same microtask deterministic lowest index wins", async () => {
		expect(
			await collectRace([fromArray(["a"]).asyncIterable, fromArray(["b"]).asyncIterable]),
		).toEqual(["a"]);
	});

	it("LSM-RACE-36 after win late loser item not forwarded cancel prevents stray enqueue", async () => {
		const loser = cancelSpyingReadable<number>();
		const winner = fromArray([1, 2]).asyncIterable;
		const lateLoser = fromArray([99], { delayMs: 500 }).asyncIterable;
		const out = await collectRace([winner, lateLoser, loser.stream]);
		expect(out).toEqual([1, 2]);
		expect(loser.cancelReasons).toHaveLength(1);
	});

	it("LSM-RACE-37 Uint8Array generic T preserved through race", async () => {
		const chunk = new Uint8Array([1, 2, 3]);
		const out = await collectRace<Uint8Array>([fromArray([chunk]).asyncIterable]);
		expect(out[0]).toBeInstanceOf(Uint8Array);
		expect(Array.from(out[0]!)).toEqual([1, 2, 3]);
	});

	it("LSM-RACE-38 labeled array form primary id preserved", async () => {
		let result: MuxResult | undefined;
		await collectRace([{ id: "primary", source: fromArray([1]).asyncIterable }], {
			onFinish: (r) => {
				result = r;
			},
		});
		expect(result?.winner).toBe("primary");
	});

	it("LSM-RACE-39 onFinish perSource winner items equals forwarded count", async () => {
		let result: MuxResult | undefined;
		await collectRace([fromArray([1, 2, 3]).asyncIterable], {
			onFinish: (r) => {
				result = r;
			},
		});
		expect(result?.perSource["0"]?.items).toBe(3);
	});

	it("LSM-RACE-40 transport failure emits onSourceEvent error for that source", async () => {
		const events: SourceEvent[] = [];
		const broken = fromArray([1], { throwAt: 0 }).asyncIterable;
		const good = fromArray([2]).asyncIterable;
		await collectRace([broken, good], {
			onSourceEvent: (e) => events.push(e),
		});
		const errEvent = events.find((e) => e.type === "error" && e.source === "0");
		expect(errEvent?.error?.code).toBe("SOURCE_ERROR");
	});

	it("LSM-RACE-41 two race calls return independent iterables no shared coordinator", async () => {
		const r1 = race([fromArray([1]).asyncIterable]);
		const r2 = race([fromArray([2]).asyncIterable]);
		expect(await collect(r1)).toEqual([1]);
		expect(await collect(r2)).toEqual([2]);
	});

	it("LSM-RACE-42 three sources one wins two losers get race-lost cancel", async () => {
		const a = cancelSpyingReadable<number>();
		const b = cancelSpyingReadable<number>();
		const c = fromArray([1]).asyncIterable;
		await collectRace([c, a.stream, b.stream]);
		for (const spy of [a, b]) {
			expect(spy.cancelReasons).toHaveLength(1);
			expect(isMuxCancelled(spy.cancelReasons[0])).toBe(true);
			expect((spy.cancelReasons[0] as MuxCancelled).reason).toBe("race-lost");
		}
	});

	it("LSM-RACE-43 NO_USABLE_SOURCE is not ABORTED code discrimination", async () => {
		await expect(collectRace([fromArray([]).asyncIterable])).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			expect(muxErr.code).toBe("NO_USABLE_SOURCE");
			expect(muxErr.code).not.toBe("ABORTED");
			return true;
		});
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(
			collectRace([fromArray([1]).asyncIterable], { signal: ctrl.signal }),
		).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "ABORTED";
		});
	});

	it("LSM-RACE-44 empty record race throws NO_USABLE_SOURCE synchronously", () => {
		expect(() => race({})).toThrow();
		try {
			race({});
		} catch (err) {
			expect(asMuxError(err).code).toBe("NO_USABLE_SOURCE");
		}
	});

	it("LSM-RACE-45 isFinal without prior usable on other source first isFinal wins", async () => {
		const finalSource = fromArray(["done"]).asyncIterable;
		const other = fromArray(["x", "y"], { delayMs: 100 }).asyncIterable;
		const out = await collectRace([finalSource, other], {
			isUsable: () => false,
			isFinal: (item) => item === "done",
		});
		expect(out).toEqual(["done"]);
	});

	it("LSM-RACE-46 winner ReadableStream natural close consumer completes onFinish fires", async () => {
		let finished = false;
		await collectRace([fromArray([1, 2]).readable], {
			onFinish: () => {
				finished = true;
			},
		});
		expect(finished).toBe(true);
	});

	it("LSM-RACE-47 loser cancel rejection swallowed race resolves with winner output", async () => {
		const rejectCancel = new ReadableStream<number>({
			cancel() {
				return Promise.reject(new Error("cancel rejected"));
			},
		});
		expect(await collectRace([fromArray([1]).asyncIterable, rejectCancel])).toEqual([1]);
	});

	it("LSM-RACE-48 mapEach not applied to pre-win non-usable items on losing sources", async () => {
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

	it("LSM-RACE-49 signal abort during pre-win phase all sources cancelled aborted", async () => {
		const ctrl = new AbortController();
		const a = cancelSpyingReadable<number>();
		const b = cancelSpyingReadable<number>();
		a.enqueue(0);
		b.enqueue(0);
		const iter = race([a.stream, b.stream], {
			signal: ctrl.signal,
			isUsable: () => false,
		})[Symbol.asyncIterator]();
		const pending = iter.next();
		await Promise.resolve();
		ctrl.abort(new Error("pre-win abort"));
		await expect(pending).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "ABORTED";
		});
		await Promise.resolve();
		for (const spy of [a, b]) {
			expect(spy.cancelReasons.length).toBeGreaterThanOrEqual(1);
			expect((spy.cancelReasons[spy.cancelReasons.length - 1] as MuxCancelled).reason).toBe(
				"aborted",
			);
		}
		let result: MuxResult | undefined;
		const preAborted = new AbortController();
		preAborted.abort();
		await collectRace(
			[
				lazyOpenCounter(() => fromArray([1], { neverEnd: true }).asyncIterable).source,
				lazyOpenCounter(() => fromArray([2], { neverEnd: true }).asyncIterable).source,
			],
			{
				signal: preAborted.signal,
				onFinish: (r) => {
					result = r;
				},
			},
		).catch(() => {});
		expect(result?.aborted).toBe(true);
	});

	it("LSM-RACE-50 second Symbol.asyncIterator on same race return throws first still usable", () => {
		const iterable = race([fromArray([1]).asyncIterable]);
		iterable[Symbol.asyncIterator]();
		expect(() => iterable[Symbol.asyncIterator]()).toThrow(/iterator already active/);
	});

	it("LSM-RACE-51 winner backpressure pullCount never exceeds itemsDelivered plus one", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const iter = race([counted.source])[Symbol.asyncIterator]();
		let delivered = 0;
		for (let i = 0; i < 5; i += 1) {
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 1);
			const step = await iter.next();
			expect(step.done).toBe(false);
			delivered += 1;
			await Promise.resolve();
			expect(counted.pullCount).toBeLessThanOrEqual(delivered + 1);
		}
		const done = await iter.next();
		expect(done.done).toBe(true);
	});

	it("LSM-RACE-52 single empty stream not sync throw async NO_USABLE_SOURCE distinct from LSM-RACE-09", async () => {
		const iterable = race([fromArray([]).asyncIterable]);
		const iter = iterable[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "NO_USABLE_SOURCE";
		});
	});

	it("LSM-RACE-53 isFinal overrides isUsable same item wins race completes", async () => {
		const out = await collectRace([fromArray(["only"]).asyncIterable], {
			isUsable: () => false,
			isFinal: () => true,
		});
		expect(out).toEqual(["only"]);
	});

	it("LSM-RACE-54 interop round-trip collect toAsyncIterable toReadable race equals direct collect", async () => {
		const sources = [
			fromArray([1, 2]).asyncIterable,
			fromArray([9], { delayMs: 50 }).asyncIterable,
		];
		const direct = await collect(race(sources));
		const roundTrip = await collect(
			toAsyncIterable(
				toReadable(
					race([fromArray([1, 2]).asyncIterable, fromArray([9], { delayMs: 50 }).asyncIterable]),
				),
			),
		);
		expect(roundTrip).toEqual(direct);
		expect(direct).toEqual([1, 2]);
	});

	it("LSM-RACE-55 onFinish NOT called when race empty array throws synchronously", () => {
		let finishCalls = 0;
		expect(() =>
			race([], {
				onFinish: () => {
					finishCalls += 1;
				},
			}),
		).toThrow();
		expect(finishCalls).toBe(0);
	});

	it("LSM-RACE-56 duplicate labeled ids throws synchronously at call site", () => {
		expect(() =>
			race([
				{ id: "dup", source: fromArray([1]).asyncIterable },
				{ id: "dup", source: fromArray([2]).asyncIterable },
			]),
		).toThrow(/duplicate source id "dup"/);
	});

	it("LSM-RACE-57 for await early break all started sources cancelled aborted", async () => {
		const winner = cancelSpyingReadable<number>();
		winner.enqueue(1);
		winner.enqueue(2);
		let seen = 0;
		for await (const _x of race([fromArray([99], { delayMs: 50 }).asyncIterable, winner.stream])) {
			seen += 1;
			if (seen >= 1) break;
		}
		await Promise.resolve();
		expect(seen).toBe(1);
		expect(winner.cancelReasons.length).toBeGreaterThanOrEqual(1);
		expect(isMuxCancelled(winner.cancelReasons[winner.cancelReasons.length - 1])).toBe(true);
		expect((winner.cancelReasons[winner.cancelReasons.length - 1] as MuxCancelled).reason).toBe(
			"aborted",
		);
	});

	it("LSM-RACE-58 loser pullCount bounded after win no stray items appended", async () => {
		const loserCounted = countingSource(() => fromArray([99, 100], { delayMs: 500 }).asyncIterable);
		const winner = fromArray([1, 2]).asyncIterable;
		expect(await collectRace([winner, loserCounted.source])).toEqual([1, 2]);
		expect(loserCounted.pullCount).toBeLessThanOrEqual(1);
	});

	it("LSM-RACE-59 winner IN_BAND_ERROR post-commit rejects consumer no failover", async () => {
		type Frame = { ok?: true; err?: true };
		const winner = fromArray<Frame>([{ ok: true }, { err: true }]).asyncIterable;
		const backup = fromArray<Frame>([{ ok: true }], { delayMs: 50 }).asyncIterable;
		await expect(
			collectRace([winner, backup], { isError: (f) => f.err === true }),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "IN_BAND_ERROR");
	});

	it("LSM-RACE-60 mapEach transforms winner pre-usable buffer items in order", async () => {
		const out = await collectRace([fromArray(["a", "b", "c"]).asyncIterable], {
			isUsable: (s) => s === "c",
			mapEach: (s) => s.toUpperCase(),
		});
		expect(out).toEqual(["A", "B", "C"]);
	});

	it("LSM-RACE-61 mapEach second arg is labeled winner source id", async () => {
		const mapEach = vi.fn((item: number) => item);
		await collectRace(
			{
				alpha: fromArray([1, 2], { delayMs: 50 }).asyncIterable,
				beta: fromArray([9, 10]).asyncIterable,
			},
			{ mapEach },
		);
		expect(mapEach).toHaveBeenCalledWith(9, "beta");
		expect(mapEach).toHaveBeenCalledWith(10, "beta");
	});

	it("LSM-RACE-62 onFinish fires exactly once when winner errors after first item", async () => {
		let finishCalls = 0;
		let result: MuxResult | undefined;
		await collectRace([fromArray([0, 1], { throwAt: 1 }).asyncIterable], {
			onFinish: (r) => {
				finishCalls += 1;
				result = r;
			},
		}).catch(() => {});
		expect(finishCalls).toBe(1);
		expect(result?.winner).toBe("0");
		expect(result?.perSource["0"]?.items).toBe(1);
	});

	it("LSM-RACE-63 onFinish aborted true after signal abort mid-race", async () => {
		const ctrl = new AbortController();
		let result: MuxResult | undefined;
		const pending = collectRace([fromArray([1, 2, 3], { delayMs: 30 }).asyncIterable], {
			signal: ctrl.signal,
			onFinish: (r) => {
				result = r;
			},
		});
		await Promise.resolve();
		ctrl.abort();
		await pending.catch(() => {});
		expect(result?.aborted).toBe(true);
		expect(result?.strategy).toBe("race");
	});

	it("LSM-RACE-64 race never emits failover SourceEvent", async () => {
		const events: SourceEvent[] = [];
		await collectRace(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2]).asyncIterable],
			{ onSourceEvent: (e) => events.push(e) },
		);
		expect(events.some((e) => e.type === "failover")).toBe(false);
	});

	it("LSM-RACE-65 four sources first usable wins three losers race-lost", async () => {
		const spies = [0, 1, 2].map(() => cancelSpyingReadable<number>());
		const winner = fromArray([42]).asyncIterable;
		for (const spy of spies) spy.enqueue(0);
		await collectRace([spies[0]!.stream, spies[1]!.stream, spies[2]!.stream, winner], {
			isUsable: (n) => n === 42,
		});
		for (const spy of spies) {
			expect(spy.cancelReasons).toHaveLength(1);
			expect((spy.cancelReasons[0] as MuxCancelled).reason).toBe("race-lost");
		}
	});

	it("LSM-RACE-66 AsyncIterable return rejection on loser cancel swallowed", async () => {
		const rejectReturn: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				return {
					next: () =>
						new Promise<{ done: false; value: number }>(() => {
							/* hang until cancel */
						}),
					return: async () => {
						throw new Error("return rejected");
					},
				};
			},
		};
		expect(await collectRace([fromArray([1]).asyncIterable, rejectReturn])).toEqual([1]);
	});

	it("LSM-RACE-67 repeated next after NO_USABLE_SOURCE rejects same code", async () => {
		const iter = race([fromArray([]).asyncIterable])[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
		);
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
		);
	});

	it("LSM-RACE-68 mixed empty throw and good source good wins", async () => {
		const empty = fromArray([]).asyncIterable;
		const broken = fromArray([1], { throwAt: 0 }).asyncIterable;
		const good = fromArray([7, 8]).asyncIterable;
		expect(await collectRace([empty, broken, good])).toEqual([7, 8]);
	});

	it("LSM-RACE-69 all sources in-band isError only NO_USABLE_SOURCE", async () => {
		type Tag = { bad: true } | { ok: true };
		await expect(
			collectRace(
				[
					fromArray<Tag>([{ bad: true }]).asyncIterable,
					fromArray<Tag>([{ bad: true }]).asyncIterable,
				],
				{ isError: (t) => "bad" in t },
			),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE");
	});

	it("LSM-RACE-70 all empty sources async NO_USABLE_SOURCE no cancel events", async () => {
		const events: SourceEvent[] = [];
		await collectRace([fromArray([]).asyncIterable, fromArray([]).asyncIterable], {
			onSourceEvent: (e) => events.push(e),
		}).catch(() => {});
		expect(events.filter((e) => e.type === "cancelled")).toHaveLength(0);
		expect(events.filter((e) => e.type === "start")).toHaveLength(2);
	});

	it("LSM-RACE-71 null object and undefined generic T preserved", async () => {
		const out = await collectRace<null | { x: number } | undefined>([
			fromArray([null, { x: 1 }, undefined]).asyncIterable,
		]);
		expect(out).toEqual([null, { x: 1 }, undefined]);
	});

	it("LSM-RACE-72 return before first next lazy sources never opened", async () => {
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const iter = race([a.source, b.source])[Symbol.asyncIterator]();
		await iter.return();
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
	});

	it("LSM-RACE-73 return during pre-win before winner all sources aborted not race-lost", async () => {
		const a = cancelSpyingReadable<string>();
		const b = cancelSpyingReadable<string>();
		a.enqueue("junk");
		b.enqueue("junk");
		const iter = race([a.stream, b.stream], { isUsable: () => false })[Symbol.asyncIterator]();
		await Promise.resolve();
		await iter.return();
		await Promise.resolve();
		for (const spy of [a, b]) {
			expect(spy.cancelReasons.length).toBeGreaterThanOrEqual(1);
			expect((spy.cancelReasons[spy.cancelReasons.length - 1] as MuxCancelled).reason).toBe(
				"aborted",
			);
		}
	});

	it("LSM-RACE-74 partial winner output then abort onFinish reflects forwarded items", async () => {
		const ctrl = new AbortController();
		let result: MuxResult | undefined;
		const iter = race([fromArray([1, 2, 3, 4], { delayMs: 20 }).asyncIterable], {
			signal: ctrl.signal,
			onFinish: (r) => {
				result = r;
			},
		})[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toBe(1);
		ctrl.abort();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ABORTED",
		);
		expect(result?.aborted).toBe(true);
		expect(result?.perSource["0"]?.items).toBe(1);
	});

	it("LSM-RACE-75 mapEach throw on buffered flush item SOURCE_ERROR winner id", async () => {
		await expect(
			collectRace([fromArray(["a", "b"]).asyncIterable], {
				isUsable: (s) => s === "b",
				mapEach: (s) => {
					if (s === "a") throw new Error("map buffer fail");
					return s;
				},
			}),
		).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "SOURCE_ERROR" && asMuxError(err).source === "0",
		);
	});

	it("LSM-RACE-76 dual loser cancel rejection swallowed winner completes", async () => {
		const rejectCancel = () =>
			new ReadableStream<number>({
				cancel() {
					return Promise.reject(new Error("cancel rejected"));
				},
			});
		expect(
			await collectRace([fromArray([1, 2]).asyncIterable, rejectCancel(), rejectCancel()]),
		).toEqual([1, 2]);
	});

	it("LSM-RACE-77 after full collect second Symbol.asyncIterator still throws", async () => {
		const iterable = race([fromArray([1, 2]).asyncIterable]);
		await collect(iterable);
		expect(() => iterable[Symbol.asyncIterator]()).toThrow(/iterator already active/);
	});

	it("LSM-RACE-78 slow consumer manual next winner backpressure across 10 items", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).asyncIterable);
		const iter = race([counted.source])[Symbol.asyncIterator]();
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

	it("LSM-RACE-79 loser counted pre-win junk never mapped mapEach winner only", async () => {
		const mapEach = vi.fn((item: string) => item);
		const junkLoser = countingSource(fromArray(["j1", "j2"]).asyncIterable);
		const winner = fromArray(["ok"], { delayMs: 40 }).asyncIterable;
		await collectRace([junkLoser.source, winner], {
			isUsable: (s) => s === "ok",
			mapEach,
		});
		expect(mapEach).toHaveBeenCalledTimes(1);
		expect(mapEach).toHaveBeenCalledWith("ok", "1");
	});

	it("LSM-RACE-80 winner ReadableStream transport error after item rejects SOURCE_ERROR", async () => {
		const ctrl = controllableReadable<number>();
		const broken = fromArray([1], { delayMs: 100 }).asyncIterable;
		const iter = race([ctrl.stream, broken])[Symbol.asyncIterator]();
		ctrl.enqueue(7);
		expect((await iter.next()).value).toBe(7);
		ctrl.error(new Error("stream broke"));
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			if (err instanceof Error && err.message === "stream broke") return true;
			const muxErr = asMuxError(err);
			return muxErr.code === "SOURCE_ERROR" && muxErr.source === "0";
		});
	});
});
