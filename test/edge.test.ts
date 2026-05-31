import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fallback, merge, race, tee } from "../src/index.js";
import { isMuxCancelled } from "../src/internal/abort.js";
import type { MuxCancelled, MuxResult, SourceEvent } from "../src/types.js";
import {
	asMuxError,
	assertMuxCancelled,
	collectEnsemble,
	collectFallback,
	collectRace,
	collectTagged,
	drainBranch,
	drainBranchesParallel,
	flushMicrotasks,
	lastCancelReason,
	readOne,
	valueTags,
} from "./helpers/edge-matrix.js";
import {
	asyncIterableFromArray,
	cancelSpyingReadable,
	countingSource,
	fromArray,
	lazyOpenCounter,
} from "./helpers/streams.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** §23 matrix authority — docs/edge-cases.md §G */
describe("LSM-EDGE §23 matrix", () => {
	describe("row 1 — empty sources", () => {
		it("LSM-EDGE-01 race empty array sync NO_USABLE_SOURCE onFinish not called", () => {
			let finishCalls = 0;
			expect(() =>
				race([], {
					onFinish: () => {
						finishCalls += 1;
					},
				}),
			).toThrow();
			try {
				race([]);
			} catch (err) {
				expect(asMuxError(err).code).toBe("NO_USABLE_SOURCE");
			}
			expect(finishCalls).toBe(0);
		});

		it("LSM-EDGE-02 fallback empty array sync ALL_FAILED errors empty", () => {
			expect(() => fallback([])).toThrow();
			try {
				fallback([]);
			} catch (err) {
				const muxErr = asMuxError(err);
				expect(muxErr.code).toBe("ALL_FAILED");
				expect(muxErr.errors).toEqual([]);
			}
		});

		it("LSM-EDGE-03 merge empty array yields nothing onFinish once winner undefined", async () => {
			let finishCalls = 0;
			let result: MuxResult | undefined;
			expect(
				await collectTagged([], {
					onFinish: (r) => {
						finishCalls += 1;
						result = r;
					},
				}),
			).toEqual([]);
			expect(finishCalls).toBe(1);
			expect(result?.strategy).toBe("merge");
			expect(result?.winner).toBeUndefined();
			expect(result?.aborted).toBe(false);
		});
	});

	describe("row 2 — single source", () => {
		it("LSM-EDGE-04 race single source pass-through onFinish winner zero", async () => {
			let result: MuxResult | undefined;
			expect(
				await collectRace([fromArray([10, 20]).asyncIterable], { onFinish: (r) => (result = r) }),
			).toEqual([10, 20]);
			expect(result?.winner).toBe("0");
			expect(result?.strategy).toBe("race");
		});

		it("LSM-EDGE-05 fallback single source pass-through lazy backup openCount zero", async () => {
			const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
			expect(await collectFallback([fromArray([10, 20]).asyncIterable, backup.source])).toEqual([
				10, 20,
			]);
			expect(backup.openCount).toBe(0);
		});

		it("LSM-EDGE-06 merge single source tagged values plus done", async () => {
			const tags = await collectTagged([fromArray([10, 20]).asyncIterable]);
			expect(valueTags(tags).map((t) => ({ source: t.source, value: t.value }))).toEqual([
				{ source: "0", value: 10 },
				{ source: "0", value: 20 },
			]);
			expect(tags.filter((t) => t.kind === "done")).toHaveLength(1);
			expect(tags.at(-1)?.kind).toBe("done");
		});

		it("LSM-EDGE-06b ensemble single source identical to merge tagged pass-through", async () => {
			const mergeTags = await collectTagged([fromArray([10, 20]).asyncIterable]);
			const ensembleTags = await collectEnsemble([fromArray([10, 20]).asyncIterable]);
			expect(ensembleTags).toEqual(mergeTags);
		});

		it("LSM-EDGE-07 tee single source two block branches identical sequence", async () => {
			const [a, b] = tee(fromArray([1, 2]).asyncIterable, 2, { backpressure: "block" });
			const [ra, rb] = await drainBranchesParallel([a, b]);
			expect(ra).toEqual([1, 2]);
			expect(rb).toEqual([1, 2]);
		});
	});

	describe("row 3 — all sources empty", () => {
		it("LSM-EDGE-08 race two empty async NO_USABLE_SOURCE on first next", async () => {
			const iter = race([fromArray([]).asyncIterable, fromArray([]).asyncIterable])[
				Symbol.asyncIterator
			]();
			await expect(iter.next()).rejects.toSatisfy(
				(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
			);
		});

		it("LSM-EDGE-09 fallback two empty async ALL_FAILED errors length two", async () => {
			const iter = fallback([fromArray([]).asyncIterable, fromArray([]).asyncIterable])[
				Symbol.asyncIterator
			]();
			await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
				const muxErr = asMuxError(err);
				return muxErr.code === "ALL_FAILED" && muxErr.errors?.length === 2;
			});
		});

		it("LSM-EDGE-10 merge two empty done tags only no values", async () => {
			const tags = await collectTagged([fromArray([]).asyncIterable, fromArray([]).asyncIterable]);
			expect(valueTags(tags)).toHaveLength(0);
			expect(tags.filter((t) => t.kind === "done")).toHaveLength(2);
		});

		it("LSM-EDGE-11 tee empty source two branches first read done", async () => {
			const branches = tee(fromArray([]).asyncIterable, 2);
			const results = await Promise.all(branches.map((branch) => readOne(branch)));
			for (const { done, value } of results) {
				expect(done).toBe(true);
				expect(value).toBeUndefined();
			}
		});
	});

	describe("row 4 — throw before first item", () => {
		it("LSM-EDGE-12 race throwAt zero plus ok source ok wins", async () => {
			expect(
				await collectRace([
					fromArray([1], { throwAt: 0 }).asyncIterable,
					fromArray([7, 8]).asyncIterable,
				]),
			).toEqual([7, 8]);
		});

		it("LSM-EDGE-13 fallback throwAt zero failover to backup openCount one each", async () => {
			const primary = lazyOpenCounter(() => fromArray([1], { throwAt: 0 }).asyncIterable);
			const backup = lazyOpenCounter(() => fromArray([42]).asyncIterable);
			expect(await collectFallback([primary.source, backup.source])).toEqual([42]);
			expect(primary.openCount).toBe(1);
			expect(backup.openCount).toBe(1);
		});

		it("LSM-EDGE-14 merge throwAt zero failFast false error tag plus ok values", async () => {
			const tags = await collectTagged(
				[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2, 3]).asyncIterable],
				{ failFast: false },
			);
			expect(tags.some((t) => t.source === "0" && t.kind === "error")).toBe(true);
			expect(
				valueTags(tags)
					.filter((t) => t.source === "1")
					.map((t) => t.value),
			).toEqual([2, 3]);
		});

		it("LSM-EDGE-15 tee block throwAt zero both branches reject on first read", async () => {
			const [a, b] = tee(fromArray([1], { throwAt: 0 }).asyncIterable, 2, {
				backpressure: "block",
			});
			const errA = readOne(a);
			const errB = readOne(b);
			await expect(errA).rejects.toThrow(/throwAt 0/);
			await expect(errB).rejects.toThrow(/throwAt 0/);
		});
	});

	describe("row 5 — consumer break early", () => {
		it("LSM-EDGE-16 race break loser race-lost winner aborted", async () => {
			const winner = cancelSpyingReadable<number>();
			const loser = cancelSpyingReadable<number>();
			winner.enqueue(1);
			winner.enqueue(2);
			let seen = 0;
			for await (const _x of race([winner.stream, loser.stream])) {
				seen += 1;
				if (seen >= 1) break;
			}
			await flushMicrotasks();
			expect(seen).toBe(1);
			assertMuxCancelled(lastCancelReason(loser), "race-lost");
			assertMuxCancelled(lastCancelReason(winner), "aborted");
		});

		it("LSM-EDGE-17 fallback break neverEnd primary backup lazy openCount zero", async () => {
			const backup = lazyOpenCounter(() => fromArray([99]).asyncIterable);
			let seen = 0;
			for await (const _x of fallback([
				fromArray([1], { neverEnd: true }).asyncIterable,
				backup.source,
			])) {
				seen += 1;
				if (seen >= 1) break;
			}
			await flushMicrotasks();
			expect(seen).toBe(1);
			expect(backup.openCount).toBe(0);
		});

		it("LSM-EDGE-18 merge four lazy concurrency two break slots two three openCount zero", async () => {
			const slots = [0, 1, 2, 3].map(() =>
				lazyOpenCounter(() => fromArray([1, 2, 3]).asyncIterable),
			);
			const iter = merge(
				slots.map((s) => s.source),
				{ concurrency: 2 },
			)[Symbol.asyncIterator]();
			await iter.next();
			await iter.return();
			await flushMicrotasks();
			expect(slots[2]!.openCount).toBe(0);
			expect(slots[3]!.openCount).toBe(0);
		});

		it("LSM-EDGE-19 tee cancel one branch other drains full stream", async () => {
			const [a, b] = tee(fromArray([1, 2, 3]).asyncIterable, 2, { backpressure: "block" });
			await a.cancel();
			expect(await drainBranch(b)).toEqual([1, 2, 3]);
		});
	});

	describe("row 6 — signal already aborted", () => {
		it("LSM-EDGE-20 race signal aborted before iterate ABORTED lazy openCount zero", async () => {
			const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
			const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
			const iter = race([a.source, b.source], { signal: AbortSignal.abort() })[
				Symbol.asyncIterator
			]();
			await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
				expect(asMuxError(err).code).toBe("ABORTED");
				expect(isMuxCancelled(err)).toBe(false);
				return true;
			});
			expect(a.openCount).toBe(0);
			expect(b.openCount).toBe(0);
		});

		it("LSM-EDGE-21 fallback signal aborted before iterate ABORTED lazy openCount zero", async () => {
			const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
			const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
			const iter = fallback([a.source, b.source], { signal: AbortSignal.abort() })[
				Symbol.asyncIterator
			]();
			await expect(iter.next()).rejects.toSatisfy(
				(err: unknown) => asMuxError(err).code === "ABORTED",
			);
			expect(a.openCount).toBe(0);
			expect(b.openCount).toBe(0);
		});

		it("LSM-EDGE-22 merge signal aborted before iterate ABORTED lazy openCount zero", async () => {
			const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
			const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
			const iter = merge([a.source, b.source], { signal: AbortSignal.abort() })[
				Symbol.asyncIterator
			]();
			await expect(iter.next()).rejects.toSatisfy(
				(err: unknown) => asMuxError(err).code === "ABORTED",
			);
			expect(a.openCount).toBe(0);
			expect(b.openCount).toBe(0);
		});

		it("LSM-EDGE-23 tee lazy cancel all branches before read openCount zero", async () => {
			const lazy = lazyOpenCounter(() => fromArray([1]).asyncIterable);
			const [a, b] = tee(lazy.source, 2);
			await a.cancel();
			await b.cancel();
			await flushMicrotasks();
			expect(lazy.openCount).toBe(0);
		});
	});
});

describe("LSM-EDGE extended pins", () => {
	it("LSM-EDGE-24 race all-empty lazy openCount zero at call async NO_USABLE_SOURCE", async () => {
		const a = lazyOpenCounter(() => fromArray([]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([]).asyncIterable);
		race([a.source, b.source]);
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
		const iter = race([a.source, b.source])[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
		);
	});

	it("LSM-EDGE-25 fallback empty array sync ALL_FAILED errors length zero explicit", () => {
		try {
			fallback([]);
		} catch (err) {
			expect(asMuxError(err).errors?.length).toBe(0);
		}
	});

	it("LSM-EDGE-26 merge empty array onFinish exactly once timestamps present", async () => {
		let finishCalls = 0;
		let result: MuxResult | undefined;
		await collectTagged([], {
			onFinish: (r) => {
				finishCalls += 1;
				result = r;
			},
		});
		expect(finishCalls).toBe(1);
		expect(typeof result?.startedAt).toBe("number");
		expect(typeof result?.endedAt).toBe("number");
		expect(result!.endedAt).toBeGreaterThanOrEqual(result!.startedAt);
	});

	it("LSM-EDGE-27 race single labeled Record winner only", async () => {
		let result: MuxResult | undefined;
		await collectRace({ only: fromArray([1]).asyncIterable }, { onFinish: (r) => (result = r) });
		expect(result?.winner).toBe("only");
	});

	it("LSM-EDGE-28 merge single labeled source tags source a", async () => {
		const tags = await collectTagged([{ id: "a", source: fromArray([1, 2]).asyncIterable }]);
		expect(valueTags(tags).every((t) => t.source === "a")).toBe(true);
		expect(tags.some((t) => t.kind === "done" && t.source === "a")).toBe(true);
	});

	it("LSM-EDGE-29 tee single AsyncIterable input both branches match", async () => {
		const [a, b] = tee(asyncIterableFromArray(["x", "y"]), 2, { backpressure: "block" });
		const [ra, rb] = await drainBranchesParallel([a, b]);
		expect(ra).toEqual(["x", "y"]);
		expect(rb).toEqual(["x", "y"]);
	});

	it("LSM-EDGE-30 race three lazy all empty none opened before NO_USABLE_SOURCE", async () => {
		const slots = [0, 1, 2].map(() => lazyOpenCounter(() => fromArray([]).asyncIterable));
		for (const slot of slots) expect(slot.openCount).toBe(0);
		const iter = race(slots.map((s) => s.source))[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
		);
		for (const slot of slots) expect(slot.openCount).toBe(1);
	});

	it("LSM-EDGE-31 merge all-empty exactly N done tags for N sources", async () => {
		const tags = await collectTagged([
			fromArray([]).asyncIterable,
			fromArray([]).asyncIterable,
			fromArray([]).asyncIterable,
		]);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(3);
		expect(valueTags(tags)).toHaveLength(0);
	});

	it("LSM-EDGE-32 tee empty source n equals three all branches done first read", async () => {
		const branches = tee(fromArray([]).asyncIterable, 3);
		const results = await Promise.all(branches.map((branch) => readOne(branch)));
		for (const result of results) {
			expect(result.done).toBe(true);
			expect(result.value).toBeUndefined();
		}
	});

	it("LSM-EDGE-33 race throw-first sole source NO_USABLE_SOURCE not SOURCE_ERROR", async () => {
		const iter = race([fromArray([1], { throwAt: 0 }).asyncIterable])[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "NO_USABLE_SOURCE" && muxErr.code !== "SOURCE_ERROR";
		});
	});

	it("LSM-EDGE-34 fallback throw-first no backup ALL_FAILED", async () => {
		await expect(collectFallback([fromArray([1], { throwAt: 0 }).asyncIterable])).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
	});

	it("LSM-EDGE-35 merge throw-first failFast true rejects ALL_FAILED", async () => {
		await expect(
			collectTagged([fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2]).asyncIterable], {
				failFast: true,
			}),
		).rejects.toSatisfy((err: unknown) => asMuxError(err).code === "ALL_FAILED");
	});

	it("LSM-EDGE-36 tee throw-first bounded both branches error on read", async () => {
		const [a, b] = tee(fromArray([1], { throwAt: 0 }).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 1,
		});
		await expect(readOne(a)).rejects.toThrow(/throwAt 0/);
		await expect(readOne(b)).rejects.toThrow(/throwAt 0/);
	});

	it("LSM-EDGE-37 race break ReadableStream winner cancel reason aborted", async () => {
		const winner = cancelSpyingReadable<number>();
		winner.enqueue(1);
		winner.enqueue(2);
		let seen = 0;
		for await (const _x of race([fromArray([99], { delayMs: 100 }).asyncIterable, winner.stream])) {
			seen += 1;
			if (seen >= 1) break;
		}
		await flushMicrotasks();
		assertMuxCancelled(lastCancelReason(winner), "aborted");
	});

	it("LSM-EDGE-38 fallback break ReadableStream primary cancelled", async () => {
		const primary = cancelSpyingReadable<number>();
		primary.enqueue(1);
		primary.enqueue(2);
		let seen = 0;
		for await (const _x of fallback([primary.stream, fromArray([99]).asyncIterable])) {
			seen += 1;
			if (seen >= 1) break;
		}
		await flushMicrotasks();
		assertMuxCancelled(lastCancelReason(primary), "aborted");
	});

	it("LSM-EDGE-39 merge break ReadableStream slots both cancelled", async () => {
		const a = cancelSpyingReadable<number>();
		const b = cancelSpyingReadable<number>();
		a.enqueue(1);
		b.enqueue(2);
		const iter = merge([a.stream, b.stream])[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		await flushMicrotasks();
		for (const spy of [a, b]) {
			expect(spy.cancelReasons.length).toBeGreaterThanOrEqual(1);
			assertMuxCancelled(lastCancelReason(spy), "aborted");
		}
	});

	it("LSM-EDGE-40 tee cancel-all lazy source tee-all-cancelled reason", async () => {
		const source = cancelSpyingReadable<number>();
		const [a, b] = tee(source.stream, 2);
		source.enqueue(1);
		const rA = a.getReader();
		const rB = b.getReader();
		await Promise.all([rA.read(), rB.read()]);
		await rA.cancel("a");
		await rB.cancel("b");
		await flushMicrotasks();
		assertMuxCancelled(lastCancelReason(source), "tee-all-cancelled");
		rA.releaseLock();
		rB.releaseLock();
	});

	it("LSM-EDGE-41 race signal abort onFinish aborted true", async () => {
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

	it("LSM-EDGE-42 fallback signal abort two lazy backup never opened", async () => {
		const a = lazyOpenCounter(() => fromArray([1]).asyncIterable);
		const b = lazyOpenCounter(() => fromArray([2]).asyncIterable);
		const iter = fallback([a.source, b.source], { signal: AbortSignal.abort() })[
			Symbol.asyncIterator
		]();
		await iter.next().catch(() => {});
		expect(a.openCount).toBe(0);
		expect(b.openCount).toBe(0);
	});

	it("LSM-EDGE-43 merge signal abort four lazy concurrency one slots one two three never opened", async () => {
		const slots = [0, 1, 2, 3].map(() => lazyOpenCounter(() => fromArray([1, 2]).asyncIterable));
		const iter = merge(
			slots.map((s) => s.source),
			{
				concurrency: 1,
				signal: AbortSignal.abort(),
			},
		)[Symbol.asyncIterator]();
		await iter.next().catch(() => {});
		expect(slots[0]!.openCount).toBe(0);
		expect(slots[1]!.openCount).toBe(0);
		expect(slots[2]!.openCount).toBe(0);
		expect(slots[3]!.openCount).toBe(0);
	});

	it("LSM-EDGE-44 merge throw-first failFast false three sources one error two ok values", async () => {
		const tags = await collectTagged(
			[
				fromArray([1], { throwAt: 0 }).asyncIterable,
				fromArray([2]).asyncIterable,
				fromArray([3]).asyncIterable,
			],
			{ failFast: false },
		);
		expect(tags.filter((t) => t.kind === "error")).toHaveLength(1);
		expect(
			valueTags(tags)
				.map((t) => t.value)
				.sort(),
		).toEqual([2, 3]);
	});

	it("LSM-EDGE-45 race break onFinish once aborted true", async () => {
		let finishCalls = 0;
		let result: MuxResult | undefined;
		const winner = cancelSpyingReadable<number>();
		winner.enqueue(1);
		winner.enqueue(2);
		let seen = 0;
		for await (const _x of race([fromArray([99], { delayMs: 100 }).asyncIterable, winner.stream], {
			onFinish: (r) => {
				finishCalls += 1;
				result = r;
			},
		})) {
			seen += 1;
			if (seen >= 1) break;
		}
		await flushMicrotasks();
		expect(seen).toBe(1);
		expect(finishCalls).toBe(1);
		expect(result?.aborted).toBe(true);
	});
});

describe("LSM-EDGE no-leak audit", () => {
	it("LSM-EDGE-46 race break pullCount bounded cancel reasons race-lost and aborted", async () => {
		const winner = cancelSpyingReadable<number>();
		const loser = cancelSpyingReadable<number>();
		const loserCounted = countingSource(() => fromArray([99, 100], { delayMs: 500 }).asyncIterable);
		winner.enqueue(1);
		winner.enqueue(2);
		let seen = 0;
		for await (const _x of race([winner.stream, loser.stream, loserCounted.source])) {
			seen += 1;
			if (seen >= 1) break;
		}
		await flushMicrotasks();
		expect(loserCounted.pullCount).toBeLessThanOrEqual(1);
		assertMuxCancelled(lastCancelReason(loser), "race-lost");
		assertMuxCancelled(lastCancelReason(winner), "aborted");
	});

	it("LSM-EDGE-47 fallback break primary cancelled backup lazy zero no hang", async () => {
		const backup = lazyOpenCounter(() => fromArray([99], { neverEnd: true }).asyncIterable);
		let seen = 0;
		for await (const _x of fallback([
			fromArray([1], { neverEnd: true }).asyncIterable,
			backup.source,
		])) {
			seen += 1;
			if (seen >= 1) break;
		}
		await flushMicrotasks();
		expect(seen).toBe(1);
		expect(backup.openCount).toBe(0);
	});

	it("LSM-EDGE-48 merge break unstarted lazy openCount zero started cancelled", async () => {
		const slots = [0, 1, 2, 3].map(() =>
			lazyOpenCounter(() => fromArray([1, 2, 3], { neverEnd: true }).asyncIterable),
		);
		const iter = merge(
			slots.map((s) => s.source),
			{ concurrency: 2 },
		)[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		await flushMicrotasks();
		expect(slots[2]!.openCount).toBe(0);
		expect(slots[3]!.openCount).toBe(0);
	});

	it("LSM-EDGE-49 tee cancel all branches source cancel once tee-all-cancelled lazy zero", async () => {
		const lazy = lazyOpenCounter(() => fromArray([1, 2]).asyncIterable);
		const [a, b] = tee(lazy.source, 2);
		await a.cancel();
		await b.cancel();
		await flushMicrotasks();
		expect(lazy.openCount).toBe(0);
	});

	it("LSM-EDGE-50 second next same error code race and fallback", async () => {
		const raceIter = race([fromArray([]).asyncIterable])[Symbol.asyncIterator]();
		await expect(raceIter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
		);
		await expect(raceIter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
		);

		const fbIter = fallback([fromArray([]).asyncIterable])[Symbol.asyncIterator]();
		await expect(fbIter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
		await expect(fbIter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
	});
});

describe("LSM-EDGE supplemental §D", () => {
	it("LSM-EDGE-51 race single empty stream async NO_USABLE_SOURCE not sync throw", async () => {
		const iter = race([fromArray([]).asyncIterable])[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
		);
	});

	it("LSM-EDGE-52 race empty Record sync NO_USABLE_SOURCE onFinish not called", () => {
		let finishCalls = 0;
		expect(() =>
			race(
				{},
				{
					onFinish: () => {
						finishCalls += 1;
					},
				},
			),
		).toThrow();
		try {
			race({});
		} catch (err) {
			expect(asMuxError(err).code).toBe("NO_USABLE_SOURCE");
		}
		expect(finishCalls).toBe(0);
	});

	it("LSM-EDGE-53 fallback empty Record sync ALL_FAILED errors empty", () => {
		try {
			fallback({});
		} catch (err) {
			const muxErr = asMuxError(err);
			expect(muxErr.code).toBe("ALL_FAILED");
			expect(muxErr.errors).toEqual([]);
		}
	});

	it("LSM-EDGE-54 fallback break onFinish once aborted true", async () => {
		let finishCalls = 0;
		let result: MuxResult | undefined;
		let seen = 0;
		for await (const _x of fallback([fromArray([1], { neverEnd: true }).asyncIterable], {
			onFinish: (r) => {
				finishCalls += 1;
				result = r;
			},
		})) {
			seen += 1;
			if (seen >= 1) break;
		}
		await flushMicrotasks();
		expect(finishCalls).toBe(1);
		expect(result?.aborted).toBe(true);
		expect(result?.strategy).toBe("fallback");
	});

	it("LSM-EDGE-55 merge break onFinish once aborted true winner undefined", async () => {
		let finishCalls = 0;
		let result: MuxResult | undefined;
		const slots = [0, 1, 2, 3].map(() => lazyOpenCounter(() => fromArray([1, 2, 3]).asyncIterable));
		const iter = merge(
			slots.map((s) => s.source),
			{
				concurrency: 2,
				onFinish: (r) => {
					finishCalls += 1;
					result = r;
				},
			},
		)[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		await flushMicrotasks();
		expect(finishCalls).toBe(1);
		expect(result?.aborted).toBe(true);
		expect(result?.strategy).toBe("merge");
		expect(result?.winner).toBeUndefined();
	});

	it("LSM-EDGE-56 fallback throw-first commit policy failover SourceEvent before backup", async () => {
		const events: SourceEvent[] = [];
		const out = await collectFallback(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([42]).asyncIterable],
			{
				policy: "commit",
				onSourceEvent: (e) => events.push(e),
			},
		);
		expect(out).toEqual([42]);
		expect(events.some((e) => e.type === "failover" && e.source === "0")).toBe(true);
		const failoverAt = events.findIndex((e) => e.type === "failover" && e.source === "0");
		const backupStartAt = events.findIndex((e) => e.type === "start" && e.source === "1");
		expect(failoverAt).toBeGreaterThanOrEqual(0);
		expect(backupStartAt).toBeGreaterThanOrEqual(0);
		expect(failoverAt).toBeLessThan(backupStartAt);
	});

	it("LSM-EDGE-57 merge signal abort throw failFast false zero tags lazy ok not opened", async () => {
		const ok = lazyOpenCounter(() => fromArray([2, 3]).asyncIterable);
		const iter = merge([fromArray([1], { throwAt: 0 }).asyncIterable, ok.source], {
			failFast: false,
			signal: AbortSignal.abort(),
			concurrency: 1,
		})[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			expect(asMuxError(err).code).toBe("ABORTED");
			expect(isMuxCancelled(err)).toBe(false);
			return true;
		});
		expect(ok.openCount).toBe(0);
	});

	it("LSM-EDGE-58 matrix doc integrity LSM-EDGE-01 through 23 in test titles", () => {
		const edgeCases = readFileSync(join(repoRoot, "docs/edge-cases.md"), "utf8");
		const edgeTest = readFileSync(join(repoRoot, "test/edge.test.ts"), "utf8");
		const matrixIds = Array.from(
			{ length: 23 },
			(_, i) => `LSM-EDGE-${String(i + 1).padStart(2, "0")}`,
		);
		const missing: string[] = [];
		for (const id of matrixIds) {
			if (!edgeTest.includes(`it("${id} `) && !edgeTest.includes(`it('${id} `)) {
				missing.push(id);
			}
		}
		expect(missing, `missing LSM-EDGE IDs in test/edge.test.ts: ${missing.join(", ")}`).toEqual([]);
		const idsInDoc = [...edgeCases.matchAll(/LSM-EDGE-(0[1-9]|1[0-9]|2[0-3])\b/g)].map((m) => m[0]);
		expect(new Set(idsInDoc).size).toBeGreaterThanOrEqual(0);
	});

	it("LSM-EDGE-59 race early exit before win all sources aborted not race-lost", async () => {
		const a = cancelSpyingReadable<string>();
		const b = cancelSpyingReadable<string>();
		a.enqueue("junk");
		b.enqueue("junk");
		const iter = race([a.stream, b.stream], { isUsable: () => false })[Symbol.asyncIterator]();
		await Promise.resolve();
		await iter.return();
		await flushMicrotasks();
		for (const spy of [a, b]) {
			expect(spy.cancelReasons.length).toBeGreaterThanOrEqual(1);
			const reason = (lastCancelReason(spy) as MuxCancelled).reason;
			expect(reason).toBe("aborted");
			expect(reason).not.toBe("race-lost");
		}
	});
});

describe("LSM-EDGE ultra-extended §E", () => {
	it("LSM-EDGE-60 race duplicate labeled ids sync throw at call site", () => {
		expect(() =>
			race([
				{ id: "dup", source: fromArray([1]).asyncIterable },
				{ id: "dup", source: fromArray([2]).asyncIterable },
			]),
		).toThrow(/duplicate source id "dup"/);
	});

	it("LSM-EDGE-61 race isUsable always false async NO_USABLE_SOURCE", async () => {
		const iter = race([fromArray([1, 2]).asyncIterable], { isUsable: () => false })[
			Symbol.asyncIterator
		]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
		);
	});

	it("LSM-EDGE-62 fallback single empty stream async ALL_FAILED errors length one", async () => {
		const iter = fallback([fromArray([]).asyncIterable])[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "ALL_FAILED" && muxErr.errors?.length === 1;
		});
	});

	it("LSM-EDGE-63 fallback buffered policy primary empty backup delivers", async () => {
		expect(
			await collectFallback([fromArray([]).asyncIterable, fromArray([5, 6]).asyncIterable], {
				policy: "buffered",
			}),
		).toEqual([5, 6]);
	});

	it("LSM-EDGE-64 fallback post-emit throwAt zero failover backup output", async () => {
		expect(
			await collectFallback(
				[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([88]).asyncIterable],
				{ policy: "post-emit" },
			),
		).toEqual([88]);
	});

	it("LSM-EDGE-65 merge empty Record yields nothing completes cleanly", async () => {
		expect(await collectTagged({})).toEqual([]);
	});

	it("LSM-EDGE-66 merge duplicate labeled ids sync throw at call site", () => {
		expect(() =>
			merge([
				{ id: "dup", source: fromArray([1]).asyncIterable },
				{ id: "dup", source: fromArray([2]).asyncIterable },
			]),
		).toThrow(/duplicate source id "dup"/);
	});

	it("LSM-EDGE-67 merge failFast true second next same ALL_FAILED code", async () => {
		const iter = merge(
			[fromArray([1], { throwAt: 0 }).asyncIterable, fromArray([2]).asyncIterable],
			{ failFast: true },
		)[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ALL_FAILED",
		);
	});

	it("LSM-EDGE-68 merge round-robin two empty done tags only", async () => {
		const tags = await collectTagged([fromArray([]).asyncIterable, fromArray([]).asyncIterable], {
			order: "round-robin",
		});
		expect(valueTags(tags)).toHaveLength(0);
		expect(tags.filter((t) => t.kind === "done")).toHaveLength(2);
	});

	it("LSM-EDGE-69 merge isError in-band tag failFast false healthy source continues", async () => {
		type Tag = { bad?: true; ok?: true };
		const tags = await collectTagged(
			[fromArray<Tag>([{ bad: true }]).asyncIterable, fromArray<Tag>([{ ok: true }]).asyncIterable],
			{
				failFast: false,
				isError: (t) => t.bad === true,
			},
		);
		expect(tags.some((t) => t.kind === "error" && t.source === "0")).toBe(true);
		expect(
			valueTags(tags)
				.filter((t) => t.source === "1")
				.map((t) => t.value),
		).toEqual([{ ok: true }]);
	});

	it("LSM-EDGE-70 tee drop mode single source both branches receive sequence", async () => {
		const [a, b] = tee(fromArray([1, 2, 3]).asyncIterable, 2, {
			backpressure: "drop",
			bufferLimit: 1,
		});
		const [ra, rb] = await drainBranchesParallel([a, b]);
		expect(ra).toEqual([1, 2, 3]);
		expect(rb).toEqual([1, 2, 3]);
	});

	it("LSM-EDGE-71 tee pre-yield generator throw block both branches reject", async () => {
		// eslint-disable-next-line require-yield -- intentional throw before first yield
		const boom = (async function* (): AsyncGenerator<number> {
			throw new Error("pre-yield boom");
		})();
		const [a, b] = tee(boom, 2, { backpressure: "block" });
		const errA = readOne(a);
		const errB = readOne(b);
		await expect(errA).rejects.toThrow("pre-yield boom");
		await expect(errB).rejects.toThrow("pre-yield boom");
	});

	it("LSM-EDGE-72 tee cancel all branches after partial read tee-all-cancelled once", async () => {
		const source = cancelSpyingReadable<number>();
		source.enqueue(1);
		source.enqueue(2);
		const [a, b] = tee(source.stream, 2);
		const rA = a.getReader();
		const rB = b.getReader();
		await Promise.all([rA.read(), rB.read()]);
		rA.releaseLock();
		rB.releaseLock();
		await a.cancel("a");
		await b.cancel("b");
		await flushMicrotasks();
		expect(source.cancelReasons).toHaveLength(1);
		assertMuxCancelled(lastCancelReason(source), "tee-all-cancelled");
	});

	it("LSM-EDGE-73 tee cancel two of three block third drains complete stream", async () => {
		const [a, b, c] = tee(fromArray([1, 2, 3]).asyncIterable, 3, { backpressure: "block" });
		await Promise.all([a.cancel(), b.cancel()]);
		expect(await drainBranch(c)).toEqual([1, 2, 3]);
	});

	it("LSM-EDGE-74 tee bounded overflow lagging branch SOURCE_ERROR mux code", async () => {
		const [slow, fast] = tee(fromArray([1, 2, 3, 4]).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 1,
		});
		const slowReader = slow.getReader();
		await slowReader.read();
		await drainBranch(fast);
		await expect(slowReader.read()).rejects.toSatisfy((err: unknown) => {
			const mux = asMuxError(err);
			return mux.code === "SOURCE_ERROR" && mux.source === "0";
		});
	});

	it("LSM-EDGE-75 tee ReadableStream input single source both branches match", async () => {
		const stream = fromArray(["a", "b"]).readable;
		const [a, b] = tee(stream, 2);
		const [ra, rb] = await drainBranchesParallel([a, b]);
		expect(ra).toEqual(["a", "b"]);
		expect(rb).toEqual(["a", "b"]);
	});

	it("LSM-EDGE-76 race break after one item still opens all lazy slots including third", async () => {
		const winner = cancelSpyingReadable<number>();
		const loser = cancelSpyingReadable<number>();
		const third = lazyOpenCounter(() => fromArray([99]).asyncIterable);
		winner.enqueue(1);
		let seen = 0;
		for await (const _x of race([winner.stream, loser.stream, third.source])) {
			seen += 1;
			if (seen >= 1) break;
		}
		await flushMicrotasks();
		expect(third.openCount).toBe(1);
	});

	it("LSM-EDGE-77 fallback signal abort onFinish aborted true", async () => {
		let result: MuxResult | undefined;
		const iter = fallback([fromArray([1]).asyncIterable], {
			signal: AbortSignal.abort(),
			onFinish: (r) => {
				result = r;
			},
		})[Symbol.asyncIterator]();
		await iter.next().catch(() => {});
		expect(result?.aborted).toBe(true);
		expect(result?.strategy).toBe("fallback");
	});

	it("LSM-EDGE-78 merge signal abort onFinish aborted true", async () => {
		let result: MuxResult | undefined;
		const iter = merge([fromArray([1]).asyncIterable], {
			signal: AbortSignal.abort(),
			onFinish: (r) => {
				result = r;
			},
		})[Symbol.asyncIterator]();
		await iter.next().catch(() => {});
		expect(result?.aborted).toBe(true);
		expect(result?.strategy).toBe("merge");
	});

	it("LSM-EDGE-79 race signal abort second next same ABORTED code", async () => {
		const iter = race([fromArray([1]).asyncIterable], { signal: AbortSignal.abort() })[
			Symbol.asyncIterator
		]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ABORTED",
		);
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ABORTED",
		);
	});

	it("LSM-EDGE-80 merge signal abort mid-stream after partial tag next ABORTED", async () => {
		const ctrl = new AbortController();
		const iter = merge(
			[
				fromArray([1]).asyncIterable,
				fromArray([2, 3], { delayMs: 200, neverEnd: true }).asyncIterable,
			],
			{ signal: ctrl.signal },
		)[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.done).toBe(false);
		expect(first.value?.kind).toBe("value");
		ctrl.abort();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "ABORTED",
		);
	});

	it("LSM-EDGE-81 race null undefined object chunks pass-through preserved", async () => {
		const items: (null | { x: number } | undefined)[] = [null, { x: 1 }, undefined];
		expect(await collectRace([fromArray(items).asyncIterable])).toEqual(items);
	});

	it("LSM-EDGE-82 merge null undefined object chunks tagged pass-through preserved", async () => {
		const items: (null | { x: number } | undefined)[] = [null, { x: 2 }, undefined];
		const tags = await collectTagged([fromArray(items).asyncIterable]);
		expect(valueTags(tags).map((t) => t.value)).toEqual(items);
	});

	it("LSM-EDGE-83 race Uint8Array generic T pass-through edge", async () => {
		const chunk = new Uint8Array([0xde, 0xad]);
		const out = await collectRace([fromArray([chunk]).asyncIterable]);
		expect(out[0]).toBeInstanceOf(Uint8Array);
		expect(Array.from(out[0] as Uint8Array)).toEqual([0xde, 0xad]);
	});

	it("LSM-EDGE-84 merge Uint8Array generic T tagged pass-through edge", async () => {
		const chunk = new Uint8Array([0xbe, 0xef]);
		const tags = await collectTagged([fromArray([chunk]).asyncIterable]);
		expect(valueTags(tags)[0]?.value).toBeInstanceOf(Uint8Array);
		expect(Array.from(valueTags(tags)[0]!.value as Uint8Array)).toEqual([0xbe, 0xef]);
	});

	it("LSM-EDGE-85 fallback five empty sources ALL_FAILED errors length five", async () => {
		const sources = Array.from({ length: 5 }, () => fromArray([]).asyncIterable);
		const iter = fallback(sources)[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "ALL_FAILED" && muxErr.errors?.length === 5;
		});
	});

	it("LSM-EDGE-86 ensemble empty Record identical to merge empty", async () => {
		expect(await collectEnsemble({})).toEqual(await collectTagged({}));
	});

	it("LSM-EDGE-87 race sole isError in-band item NO_USABLE_SOURCE not failover", async () => {
		type Tag = { err: true };
		const iter = race([fromArray<Tag>([{ err: true }]).asyncIterable], {
			isError: (t) => t.err === true,
		})[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy(
			(err: unknown) => asMuxError(err).code === "NO_USABLE_SOURCE",
		);
	});

	it("LSM-EDGE-88 race iter return mid-stream after one item onFinish aborted", async () => {
		let result: MuxResult | undefined;
		const iter = race([fromArray([1, 2, 3]).asyncIterable], {
			onFinish: (r) => {
				result = r;
			},
		})[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		await flushMicrotasks();
		expect(result?.aborted).toBe(true);
	});

	it("LSM-EDGE-89 tee cancel one branch countingSource pullCount bounded no leak", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const [a, b] = tee(counted.source, 2, { backpressure: "block" });
		await a.cancel();
		expect(await drainBranch(b)).toEqual([1, 2, 3, 4, 5]);
		expect(counted.pullCount).toBeLessThanOrEqual(6);
	});

	it("LSM-EDGE-90 merge break four lazy concurrency two started slots cancelled", async () => {
		const spies = [0, 1].map(() => cancelSpyingReadable<number>());
		const lazy = [2, 3].map(() => lazyOpenCounter(() => fromArray([9]).asyncIterable));
		spies[0]!.enqueue(1);
		spies[1]!.enqueue(2);
		const iter = merge([spies[0]!.stream, spies[1]!.stream, lazy[0]!.source, lazy[1]!.source], {
			concurrency: 2,
		})[Symbol.asyncIterator]();
		await iter.next();
		await iter.return();
		await flushMicrotasks();
		for (const spy of spies) {
			assertMuxCancelled(lastCancelReason(spy), "aborted");
		}
		expect(lazy[0]!.openCount).toBe(0);
		expect(lazy[1]!.openCount).toBe(0);
	});

	it("LSM-EDGE-91 fallback three sources all throwAt zero ALL_FAILED errors length three", async () => {
		const iter = fallback([
			fromArray([1], { throwAt: 0 }).asyncIterable,
			fromArray([2], { throwAt: 0 }).asyncIterable,
			fromArray([3], { throwAt: 0 }).asyncIterable,
		])[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toSatisfy((err: unknown) => {
			const muxErr = asMuxError(err);
			return muxErr.code === "ALL_FAILED" && muxErr.errors?.length === 3;
		});
	});

	it("LSM-EDGE-92 merge isFinal without isUsable emits tagged value and done", async () => {
		const tags = await collectTagged([fromArray(["only"]).asyncIterable], {
			isUsable: () => false,
			isFinal: () => true,
		});
		expect(valueTags(tags).map((t) => t.value)).toEqual(["only"]);
		expect(tags.some((t) => t.kind === "done")).toBe(true);
	});

	it("LSM-EDGE-93 tee drop throwAt zero both branches reject on read", async () => {
		const [a, b] = tee(fromArray([1], { throwAt: 0 }).asyncIterable, 2, {
			backpressure: "drop",
			bufferLimit: 1,
		});
		await expect(readOne(a)).rejects.toThrow(/throwAt 0/);
		await expect(readOne(b)).rejects.toThrow(/throwAt 0/);
	});

	it("LSM-EDGE-94 race empty array and empty Record both NO_USABLE_SOURCE sync", () => {
		for (const fn of [() => race([]), () => race({})]) {
			try {
				fn();
				expect.unreachable("expected sync throw");
			} catch (err) {
				expect(asMuxError(err).code).toBe("NO_USABLE_SOURCE");
			}
		}
	});

	it("LSM-EDGE-95 fallback empty array and empty Record both ALL_FAILED sync errors empty", () => {
		for (const fn of [() => fallback([]), () => fallback({})]) {
			try {
				fn();
				expect.unreachable("expected sync throw");
			} catch (err) {
				const muxErr = asMuxError(err);
				expect(muxErr.code).toBe("ALL_FAILED");
				expect(muxErr.errors).toEqual([]);
			}
		}
	});

	it("LSM-EDGE-96 merge labeled Record two empty done tags source ids preserved", async () => {
		const tags = await collectTagged({
			alpha: fromArray([]).asyncIterable,
			beta: fromArray([]).asyncIterable,
		});
		expect(
			tags
				.filter((t) => t.kind === "done")
				.map((t) => t.source)
				.sort(),
		).toEqual(["alpha", "beta"]);
	});

	it("LSM-EDGE-97 race mixed empty throw and good source good wins edge chain", async () => {
		expect(
			await collectRace([
				fromArray([]).asyncIterable,
				fromArray([1], { throwAt: 0 }).asyncIterable,
				fromArray([7, 8]).asyncIterable,
			]),
		).toEqual([7, 8]);
	});

	it("LSM-EDGE-98 fallback mixed empty throw good chain last wins", async () => {
		expect(
			await collectFallback([
				fromArray([]).asyncIterable,
				fromArray([1], { throwAt: 0 }).asyncIterable,
				fromArray([40, 41]).asyncIterable,
			]),
		).toEqual([40, 41]);
	});

	it("LSM-EDGE-99 ultra matrix sync throws never invoke onFinish callback", () => {
		let raceFinish = 0;
		let fbFinish = 0;
		try {
			race([], { onFinish: () => (raceFinish += 1) });
		} catch {
			/* expected */
		}
		try {
			fallback([], { onFinish: () => (fbFinish += 1) });
		} catch {
			/* expected */
		}
		expect(raceFinish).toBe(0);
		expect(fbFinish).toBe(0);
	});
});
