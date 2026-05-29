import { describe, expect, it, vi } from "vitest";
import { collect, tee, toAsyncIterable } from "../src/index.js";
import { isMuxCancelled, muxCancelledReason } from "../src/internal/abort.js";
import type { MuxError } from "../src/types.js";
import {
	asyncIterableFromArray,
	controllableReadable,
	countingSource,
	fromArray,
	readableFromArray,
} from "./helpers/streams.js";

async function drainBranch<T>(stream: ReadableStream<T>): Promise<T[]> {
	return collect(toAsyncIterable(stream));
}

async function drainBranchesParallel<T>(streams: ReadableStream<T>[]): Promise<T[][]> {
	return Promise.all(streams.map((stream) => drainBranch(stream)));
}

async function readOne<T>(stream: ReadableStream<T>) {
	const reader = stream.getReader();
	try {
		return await reader.read();
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* released */
		}
	}
}

function asMuxError(err: unknown): MuxError {
	expect(err).toBeInstanceOf(Error);
	return err as MuxError;
}

describe("LSM-TEE tee strategy", () => {
	it("LSM-TEE-01 2-way block both branches receive identical ordered sequence", async () => {
		const [a, b] = tee(fromArray([1, 2, 3]).asyncIterable, 2, { backpressure: "block" });
		const [ra, rb] = await drainBranchesParallel([a, b]);
		expect(ra).toEqual([1, 2, 3]);
		expect(rb).toEqual([1, 2, 3]);
	});

	it("LSM-TEE-02 3-way block all branches receive full sequence", async () => {
		const branches = tee(fromArray([10, 20]).asyncIterable, 3, { backpressure: "block" });
		const results = await drainBranchesParallel(branches);
		for (const result of results) expect(result).toEqual([10, 20]);
	});

	it("LSM-TEE-03 block backpressure stalled branch gates source reads", async () => {
		const counted = countingSource(fromArray([1, 2, 3]).asyncIterable);
		const [fast, slow] = tee(counted.source, 2, { backpressure: "block" });
		const fastReader = fast.getReader();
		const slowReader = slow.getReader();
		await Promise.all([fastReader.read(), slowReader.read()]);
		expect(counted.pullCount).toBe(1);
		const fastSecond = fastReader.read();
		expect(counted.pullCount).toBe(1);
		const [secondFast, secondSlow] = await Promise.all([fastSecond, slowReader.read()]);
		expect(secondFast.value).toBe(2);
		expect(secondSlow.value).toBe(2);
		expect(counted.pullCount).toBe(2);
		fastReader.releaseLock();
		slowReader.releaseLock();
	});

	it("LSM-TEE-04 block default when backpressure omitted", async () => {
		const counted = countingSource(fromArray([1, 2]).asyncIterable);
		const [a, b] = tee(counted.source, 2);
		const readerA = a.getReader();
		const readerB = b.getReader();
		await Promise.all([readerA.read(), readerB.read()]);
		expect(counted.pullCount).toBe(1);
		readerA.releaseLock();
		readerB.releaseLock();
	});

	it("LSM-TEE-05 bounded overflow errors lagging branch with SOURCE_ERROR", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4, 5]).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 2,
		});
		const slowReader = slow.getReader();
		await slowReader.read();
		await drainBranch(fast);
		await expect(slowReader.read()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "SOURCE_ERROR";
		});
	});

	it("LSM-TEE-06 bounded overflow other branch continues", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4]).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 1,
		});
		const slowReader = slow.getReader();
		await slowReader.read();
		expect(await drainBranch(fast)).toEqual([1, 2, 3, 4]);
		await expect(slowReader.read()).rejects.toThrow();
	});

	it("LSM-TEE-07 bounded overflow code is SOURCE_ERROR not ABORTED", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4]).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 1,
		});
		const slowReader = slow.getReader();
		await slowReader.read();
		await drainBranch(fast);
		await expect(slowReader.read()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "SOURCE_ERROR";
		});
	});

	it("LSM-TEE-08 drop lagging branch receives latest items only", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4, 5]).asyncIterable, 2, {
			backpressure: "drop",
			bufferLimit: 2,
		});
		await drainBranch(fast);
		expect(await drainBranch(slow)).toEqual([4, 5]);
	});

	it("LSM-TEE-09 drop source keeps producing while branch never reads", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const [fast, slow] = tee(counted.source, 2, { backpressure: "drop", bufferLimit: 2 });
		await drainBranch(fast);
		expect(counted.pullCount).toBe(5);
		expect(await drainBranch(slow)).toEqual([4, 5]);
	});

	it("LSM-TEE-10 cancel one branch other still receives remaining items", async () => {
		const [a, b] = tee(fromArray([1, 2, 3]).asyncIterable, 2, { backpressure: "block" });
		await a.cancel();
		expect(await drainBranch(b)).toEqual([1, 2, 3]);
	});

	it("LSM-TEE-11 cancel one branch source not cancelled", async () => {
		const ctrl = controllableReadable<number>();
		const [a, b] = tee(ctrl.stream, 2, { backpressure: "block" });
		ctrl.enqueue(1);
		const readerA = a.getReader();
		const readerB = b.getReader();
		const firstB = readerB.read();
		await readerA.read();
		await readerA.cancel("one");
		expect((await firstB).value).toBe(1);
		ctrl.enqueue(2);
		expect((await readerB.read()).value).toBe(2);
		const cancelPromise = ctrl.cancelReason;
		const raced = await Promise.race([
			cancelPromise.then(() => "cancelled"),
			new Promise((r) => setTimeout(() => r("pending"), 50)),
		]);
		expect(raced).toBe("pending");
		readerA.releaseLock();
		readerB.releaseLock();
	});

	it("LSM-TEE-12 cancel all branches source tee-all-cancelled", async () => {
		const ctrl = controllableReadable<number>();
		const [a, b] = tee(ctrl.stream, 2);
		ctrl.enqueue(1);
		const rA = a.getReader();
		const rB = b.getReader();
		await Promise.all([rA.read(), rB.read()]);
		await rA.cancel("a");
		await rB.cancel("b");
		await expect(ctrl.cancelReason).resolves.toEqual(
			expect.objectContaining({ name: "MuxCancelled", reason: "tee-all-cancelled" }),
		);
	});

	it("LSM-TEE-13 cancel all branches before read lazy thunk not invoked", async () => {
		let calls = 0;
		const [a, b] = tee(() => {
			calls += 1;
			return fromArray([1]).asyncIterable;
		}, 2);
		await a.cancel();
		await b.cancel();
		expect(calls).toBe(0);
	});

	it("LSM-TEE-14 empty source all branches close without values", async () => {
		const branches = tee(fromArray([]).asyncIterable, 2);
		const results = await Promise.all(branches.map((branch) => readOne(branch)));
		for (const { done, value } of results) {
			expect(done).toBe(true);
			expect(value).toBeUndefined();
		}
	});

	it("LSM-TEE-15 AsyncIterable input branches receive items", async () => {
		const [a, b] = tee(asyncIterableFromArray(["x", "y"]), 2, { backpressure: "block" });
		const [ra, rb] = await drainBranchesParallel([a, b]);
		expect(ra).toEqual(["x", "y"]);
		expect(rb).toEqual(["x", "y"]);
	});

	it("LSM-TEE-16 ReadableStream input branches receive items", async () => {
		const [a, b] = tee(readableFromArray([7, 8]), 2, { backpressure: "block" });
		const [ra, rb] = await drainBranchesParallel([a, b]);
		expect(ra).toEqual([7, 8]);
		expect(rb).toEqual([7, 8]);
	});

	it("LSM-TEE-17 lazy thunk not called until first branch read", async () => {
		let calls = 0;
		const [branch] = tee(() => {
			calls += 1;
			return fromArray([42]).asyncIterable;
		}, 1);
		expect(calls).toBe(0);
		await drainBranch(branch!);
		expect(calls).toBe(1);
	});

	it("LSM-TEE-18 n===1 pass-through single branch full sequence", async () => {
		const [only] = tee(fromArray([1, 2]).asyncIterable, 1);
		expect(await drainBranch(only!)).toEqual([1, 2]);
	});

	it("LSM-TEE-19 invalid n===0 throws synchronously", () => {
		expect(() => tee(fromArray([1]).asyncIterable, 0)).toThrow(/integer >= 1/);
	});

	it("LSM-TEE-20 invalid n===-1 throws synchronously", () => {
		expect(() => tee(fromArray([1]).asyncIterable, -1)).toThrow(/integer >= 1/);
	});

	it("LSM-TEE-21 invalid n===1.5 throws synchronously", () => {
		expect(() => tee(fromArray([1]).asyncIterable, 1.5)).toThrow(/integer >= 1/);
	});

	it("LSM-TEE-22 bounded without bufferLimit throws synchronously", () => {
		expect(() => tee(fromArray([1]).asyncIterable, 2, { backpressure: "bounded" })).toThrow(
			/bufferLimit/,
		);
	});

	it("LSM-TEE-23 drop without bufferLimit throws synchronously", () => {
		expect(() => tee(fromArray([1]).asyncIterable, 2, { backpressure: "drop" })).toThrow(
			/bufferLimit/,
		);
	});

	it("LSM-TEE-24 bufferLimit 0 throws synchronously", () => {
		expect(() =>
			tee(fromArray([1]).asyncIterable, 2, { backpressure: "bounded", bufferLimit: 0 }),
		).toThrow(/bufferLimit/);
	});

	it("LSM-TEE-25 source error mid-stream all active branches error", async () => {
		async function* boom(): AsyncGenerator<number> {
			yield 1;
			throw new Error("source blew up");
		}
		const [a, b] = tee(boom(), 2, { backpressure: "block" });
		const readerA = a.getReader();
		const readerB = b.getReader();
		await Promise.all([readerA.read(), readerB.read()]);
		const errA = readerA.read();
		const errB = readerB.read();
		await expect(errA).rejects.toThrow("source blew up");
		await expect(errB).rejects.toThrow("source blew up");
	});

	it("LSM-TEE-26 branch cancel rejection swallowed", async () => {
		const stream = new ReadableStream<number>({
			cancel() {
				throw new Error("cancel boom");
			},
		});
		const [branch] = tee(stream, 1);
		await expect(branch!.cancel()).resolves.toBeUndefined();
	});

	it("LSM-TEE-27 Uint8Array chunks generic T preserved", async () => {
		const chunk = new Uint8Array([0xca, 0xfe]);
		const [a, b] = tee(fromArray([chunk]).asyncIterable, 2);
		const [ra, rb] = await drainBranchesParallel([a, b]);
		expect(ra[0]).toEqual(chunk);
		expect(rb[0]).toEqual(chunk);
	});

	it("LSM-TEE-28 after cancelled branch remaining gets complete stream", async () => {
		const [a, b] = tee(fromArray([1, 2, 3, 4]).asyncIterable, 2);
		await a.cancel();
		expect(await drainBranch(b)).toEqual([1, 2, 3, 4]);
	});

	it("LSM-TEE-29 block max one in-flight item per branch", async () => {
		const counted = countingSource(fromArray([1, 2, 3]).asyncIterable);
		const [a, b] = tee(counted.source, 2, { backpressure: "block" });
		const rA = a.getReader();
		const rB = b.getReader();
		await Promise.all([rA.read(), rB.read()]);
		expect(counted.pullCount).toBe(1);
		const secondA = rA.read();
		const secondB = rB.read();
		expect(counted.pullCount).toBe(1);
		await Promise.all([secondA, secondB]);
		expect(counted.pullCount).toBe(2);
		rA.releaseLock();
		rB.releaseLock();
	});

	it("LSM-TEE-30 bounded queue never exceeds bufferLimit", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4, 5]).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 2,
		});
		const slowReader = slow.getReader();
		await slowReader.read();
		await drainBranch(fast);
		await expect(slowReader.read()).rejects.toThrow();
	});

	it("LSM-TEE-31 double-cancel same branch source cancelled once", async () => {
		const cancelFn = vi.fn(async () => {});
		const stream = new ReadableStream<number>({
			start(c) {
				c.enqueue(1);
			},
			cancel: cancelFn,
		});
		const [a, b] = tee(stream, 2, { backpressure: "block" });
		const rA = a.getReader();
		const rB = b.getReader();
		await Promise.all([rA.read(), rB.read()]);
		rA.releaseLock();
		rB.releaseLock();
		await a.cancel("first");
		await a.cancel("second");
		await b.cancel("b");
		expect(cancelFn).toHaveBeenCalledTimes(1);
		expect(cancelFn).toHaveBeenCalledWith(muxCancelledReason("tee-all-cancelled"));
	});

	it("LSM-TEE-32 cancel slow branch fast finishes entire source", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3]).asyncIterable, 2, { backpressure: "block" });
		await slow.cancel();
		expect(await drainBranch(fast)).toEqual([1, 2, 3]);
	});

	it("LSM-TEE-33 tee returns fresh streams each call", async () => {
		const first = tee(fromArray([1]).asyncIterable, 1);
		const second = tee(fromArray([2]).asyncIterable, 1);
		expect(first[0]).not.toBe(second[0]);
		expect(await drainBranch(first[0]!)).toEqual([1]);
		expect(await drainBranch(second[0]!)).toEqual([2]);
	});

	it("LSM-TEE-34 import tee from package root index", async () => {
		const { tee: teeFromIndex } = await import("../src/index.js");
		const [branch] = teeFromIndex(fromArray([9]).asyncIterable, 1);
		expect(await drainBranch(branch!)).toEqual([9]);
	});

	it("LSM-TEE-35 drop bufferLimit 1 at most one queued item on slow branch", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3]).asyncIterable, 2, {
			backpressure: "drop",
			bufferLimit: 1,
		});
		await drainBranch(fast);
		expect(await drainBranch(slow)).toEqual([3]);
	});

	it("LSM-TEE-36 bounded overflow MuxError.source is branch index string", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4]).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 1,
		});
		const slowReader = slow.getReader();
		await slowReader.read();
		await drainBranch(fast);
		await expect(slowReader.read()).rejects.toSatisfy((err: unknown) => {
			const mux = asMuxError(err);
			return mux.code === "SOURCE_ERROR" && mux.source === "1";
		});
	});

	it("LSM-TEE-37 after bounded error on branch 1 branch 0 continues receiving full sequence", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4]).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 1,
		});
		const slowReader = slow.getReader();
		await slowReader.read();
		expect(await drainBranch(fast)).toEqual([1, 2, 3, 4]);
		await expect(slowReader.read()).rejects.toThrow();
	});

	it("LSM-TEE-38 natural completion source cancel not called", async () => {
		const cancelFn = vi.fn(async () => {});
		const stream = new ReadableStream<number>({
			start(controller) {
				controller.enqueue(1);
				controller.close();
			},
			cancel: cancelFn,
		});
		const [a, b] = tee(stream, 2);
		await drainBranchesParallel([a, b]);
		expect(cancelFn).not.toHaveBeenCalled();
	});

	it("LSM-TEE-39 block after branch 0 cancelled branch 1 does not wait", async () => {
		const counted = countingSource(fromArray([1, 2, 3]).asyncIterable);
		const [a, b] = tee(counted.source, 2, { backpressure: "block" });
		await a.cancel();
		const rB = b.getReader();
		await rB.read();
		await rB.read();
		expect(counted.pullCount).toBe(2);
		rB.releaseLock();
	});

	it("LSM-TEE-40 block simultaneous first reads same item before next pull", async () => {
		const counted = countingSource(fromArray([1, 2, 3]).asyncIterable);
		const [a, b] = tee(counted.source, 2, { backpressure: "block" });
		const rA = a.getReader();
		const rB = b.getReader();
		const [firstA, firstB] = await Promise.all([rA.read(), rB.read()]);
		expect(firstA.value).toBe(1);
		expect(firstB.value).toBe(1);
		expect(counted.pullCount).toBe(1);
		rA.releaseLock();
		rB.releaseLock();
	});

	it("LSM-TEE-41 n===1 cancel sole branch tee-all-cancelled", async () => {
		const ctrl = controllableReadable<number>();
		const [only] = tee(ctrl.stream, 1);
		ctrl.enqueue(1);
		const reader = only!.getReader();
		await reader.read();
		await reader.cancel("solo");
		await expect(ctrl.cancelReason).resolves.toEqual(
			expect.objectContaining({ reason: "tee-all-cancelled" }),
		);
		expect(isMuxCancelled(await ctrl.cancelReason)).toBe(true);
	});

	it("LSM-TEE-42 drop bufferLimit 2 slow branch exact tail [4,5]", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4, 5]).asyncIterable, 2, {
			backpressure: "drop",
			bufferLimit: 2,
		});
		await drainBranch(fast);
		expect(await drainBranch(slow)).toEqual([4, 5]);
	});

	it("LSM-TEE-43 n NaN throws synchronously", () => {
		expect(() => tee(fromArray([1]).asyncIterable, Number.NaN)).toThrow(/integer >= 1/);
	});

	it("LSM-TEE-44 negative bufferLimit throws synchronously", () => {
		expect(() =>
			tee(fromArray([1]).asyncIterable, 2, { backpressure: "bounded", bufferLimit: -1 }),
		).toThrow(/bufferLimit/);
	});

	it("LSM-TEE-45 bounded bufferLimit NaN throws synchronously", () => {
		expect(() =>
			tee(fromArray([1]).asyncIterable, 2, { backpressure: "bounded", bufferLimit: Number.NaN }),
		).toThrow(/bufferLimit/);
	});

	it("LSM-TEE-46 bounded bufferLimit Infinity throws synchronously", () => {
		expect(() =>
			tee(fromArray([1]).asyncIterable, 2, {
				backpressure: "bounded",
				bufferLimit: Number.POSITIVE_INFINITY,
			}),
		).toThrow(/bufferLimit/);
	});

	it("LSM-TEE-47 4-way block all branches receive identical sequence", async () => {
		const branches = tee(fromArray([1, 2]).asyncIterable, 4, { backpressure: "block" });
		expect(branches).toHaveLength(4);
		const results = await drainBranchesParallel(branches);
		for (const result of results) expect(result).toEqual([1, 2]);
	});

	it("LSM-TEE-48 3-way bounded middle branch errors others receive full stream", async () => {
		const [b0, b1, b2] = tee(fromArray([1, 2, 3, 4, 5]).asyncIterable, 3, {
			backpressure: "bounded",
			bufferLimit: 1,
		});
		const slowReader = b1.getReader();
		await slowReader.read();
		const [r0, r2] = await Promise.all([drainBranch(b0), drainBranch(b2)]);
		expect(r0).toEqual([1, 2, 3, 4, 5]);
		expect(r2).toEqual([1, 2, 3, 4, 5]);
		await expect(slowReader.read()).rejects.toSatisfy((err: unknown) => {
			const mux = asMuxError(err);
			return mux.code === "SOURCE_ERROR" && mux.source === "1";
		});
	});

	it("LSM-TEE-49 3-way drop never-read branch keeps only tail chunk", async () => {
		const [b0, b1, b2] = tee(fromArray([1, 2, 3, 4, 5]).asyncIterable, 3, {
			backpressure: "drop",
			bufferLimit: 1,
		});
		await Promise.all([drainBranch(b0), drainBranch(b1)]);
		expect(await drainBranch(b2)).toEqual([5]);
	});

	it('LSM-TEE-50 bounded overflow branch 0 MuxError.source is "0"', async () => {
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

	it("LSM-TEE-51 errored branch second read rejects same SOURCE_ERROR", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4]).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 1,
		});
		const slowReader = slow.getReader();
		await slowReader.read();
		await drainBranch(fast);
		await expect(slowReader.read()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "SOURCE_ERROR";
		});
		await expect(slowReader.read()).rejects.toSatisfy((err: unknown) => {
			return asMuxError(err).code === "SOURCE_ERROR";
		});
	});

	it("LSM-TEE-52 cancelled branch subsequent read returns done", async () => {
		const [a, b] = tee(fromArray([1, 2]).asyncIterable, 2);
		await a.cancel();
		const reader = a.getReader();
		const first = await reader.read();
		expect(first.done).toBe(true);
		expect(first.value).toBeUndefined();
		const second = await reader.read();
		expect(second.done).toBe(true);
		expect(await drainBranch(b)).toEqual([1, 2]);
	});

	it("LSM-TEE-53 source error after one branch cancelled remaining branch errors", async () => {
		async function* boom(): AsyncGenerator<number> {
			yield 1;
			throw new Error("source blew up");
		}
		const [a, b] = tee(boom(), 2, { backpressure: "block" });
		await a.cancel();
		const readerB = b.getReader();
		expect((await readerB.read()).value).toBe(1);
		await expect(readerB.read()).rejects.toThrow("source blew up");
	});

	it("LSM-TEE-54 cancel two of three block mode third drains complete stream", async () => {
		const [a, b, c] = tee(fromArray([1, 2, 3]).asyncIterable, 3, { backpressure: "block" });
		await Promise.all([a.cancel(), b.cancel()]);
		expect(await drainBranch(c)).toEqual([1, 2, 3]);
	});

	it("LSM-TEE-55 cancel all branches in parallel tee-all-cancelled once", async () => {
		const cancelFn = vi.fn(async () => {});
		const stream = new ReadableStream<number>({
			start(c) {
				c.enqueue(1);
			},
			cancel: cancelFn,
		});
		const [a, b, c] = tee(stream, 3, { backpressure: "block" });
		const readers = [a, b, c].map((branch) => branch.getReader());
		await Promise.all(readers.map((reader) => reader.read()));
		for (const reader of readers) reader.releaseLock();
		await Promise.all([a.cancel("a"), b.cancel("b"), c.cancel("c")]);
		expect(cancelFn).toHaveBeenCalledTimes(1);
		expect(cancelFn).toHaveBeenCalledWith(muxCancelledReason("tee-all-cancelled"));
	});

	it("LSM-TEE-56 null object and undefined chunk types preserved", async () => {
		const items: (null | { tag: string } | undefined)[] = [null, { tag: "x" }, undefined];
		const [a, b] = tee(fromArray(items).asyncIterable, 2);
		const [ra, rb] = await drainBranchesParallel([a, b]);
		expect(ra).toEqual(items);
		expect(rb).toEqual(items);
	});

	it("LSM-TEE-57 drop mode source never blocked by idle branch", async () => {
		const counted = countingSource(fromArray([1, 2, 3, 4, 5]).asyncIterable);
		const [b0, b1, b2] = tee(counted.source, 3, { backpressure: "drop", bufferLimit: 1 });
		await Promise.all([drainBranch(b0), drainBranch(b1)]);
		expect(await drainBranch(b2)).toEqual([5]);
		expect(counted.pullCount).toBe(5);
	});

	it("LSM-TEE-58 empty source n=3 all branches first read done", async () => {
		const branches = tee(fromArray([]).asyncIterable, 3);
		const results = await Promise.all(branches.map((branch) => readOne(branch)));
		for (const result of results) {
			expect(result.done).toBe(true);
			expect(result.value).toBeUndefined();
		}
	});

	it("LSM-TEE-59 lazy source factory invoked exactly once across branches", async () => {
		let opens = 0;
		const lazy = () => {
			opens += 1;
			return fromArray([1, 2, 3]).asyncIterable;
		};
		const branches = tee(lazy, 2, { backpressure: "block" });
		await drainBranchesParallel(branches);
		expect(opens).toBe(1);
	});

	it("LSM-TEE-60 cancel all branches without getReader lazy source not opened", async () => {
		let opens = 0;
		const lazy = () => {
			opens += 1;
			return fromArray([1]).asyncIterable;
		};
		const [a, b] = tee(lazy, 2);
		await Promise.all([a.cancel(), b.cancel()]);
		expect(opens).toBe(0);
	});

	it("LSM-TEE-61 3-way natural completion source cancel not called", async () => {
		const cancelFn = vi.fn(async () => {});
		const stream = new ReadableStream<number>({
			start(controller) {
				controller.enqueue(1);
				controller.enqueue(2);
				controller.close();
			},
			cancel: cancelFn,
		});
		const branches = tee(stream, 3);
		await drainBranchesParallel(branches);
		expect(cancelFn).not.toHaveBeenCalled();
	});

	it("LSM-TEE-62 bounded overflow error is not mux cancelled", async () => {
		const [fast, slow] = tee(fromArray([1, 2, 3, 4]).asyncIterable, 2, {
			backpressure: "bounded",
			bufferLimit: 1,
		});
		const slowReader = slow.getReader();
		await slowReader.read();
		await drainBranch(fast);
		await expect(slowReader.read()).rejects.toSatisfy((err: unknown) => {
			const mux = asMuxError(err);
			return mux.code === "SOURCE_ERROR" && !isMuxCancelled(mux);
		});
	});

	it("LSM-TEE-63 triple cancel same branch source cancelled once", async () => {
		const cancelFn = vi.fn(async () => {});
		const stream = new ReadableStream<number>({
			start(c) {
				c.enqueue(1);
			},
			cancel: cancelFn,
		});
		const [a, b] = tee(stream, 2, { backpressure: "block" });
		const rA = a.getReader();
		const rB = b.getReader();
		await Promise.all([rA.read(), rB.read()]);
		rA.releaseLock();
		rB.releaseLock();
		await a.cancel("one");
		await a.cancel("two");
		await a.cancel("three");
		await b.cancel("b");
		expect(cancelFn).toHaveBeenCalledTimes(1);
	});

	it("LSM-TEE-64 underlying source cancel rejection swallowed on tee-all-cancelled", async () => {
		const stream = new ReadableStream<number>({
			start(c) {
				c.enqueue(1);
			},
			cancel() {
				throw new Error("source cancel boom");
			},
		});
		const [a, b] = tee(stream, 2);
		await expect(Promise.all([a.cancel(), b.cancel()])).resolves.toEqual([undefined, undefined]);
	});
});
