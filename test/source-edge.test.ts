import { describe, expect, it } from "vitest";
import type { Source } from "../src/types.js";
import { asyncItems, lazySource, readableFrom } from "./helpers/type-fixtures.js";
import { controllableReadable, fromArray, readableFromArray } from "./helpers/streams.js";

/**
 * P0 source-union edge cases — exercises ReadableStream / AsyncIterable / lazy thunks
 * the same way runtime LSM-EDGE-* tests will once strategies land (P1+).
 */
describe("LSM-SRC source fixture edge cases", () => {
	it("LSM-SRC-01 empty ReadableStream yields no values then completes", async () => {
		const chunks = await collect(readableFrom([]));
		expect(chunks).toEqual([]);
	});

	it("LSM-SRC-02 empty AsyncIterable yields no values then completes", async () => {
		const chunks = await collect(asyncItems([]));
		expect(chunks).toEqual([]);
	});

	it("LSM-SRC-03 lazy Source factory invoked on each call produces independent streams", async () => {
		let calls = 0;
		const lazy: Source<number> = lazySource(() => {
			calls += 1;
			return readableFrom([calls]);
		});
		expect(calls).toBe(0);
		expect(await collect(typeof lazy === "function" ? lazy() : lazy)).toEqual([1]);
		expect(await collect(typeof lazy === "function" ? lazy() : lazy)).toEqual([2]);
		expect(calls).toBe(2);
	});

	it("LSM-SRC-04 ReadableStream cancel after partial read stops without throw", async () => {
		const stream = readableFrom([1, 2, 3]);
		const reader = stream.getReader();
		expect((await reader.read()).value).toBe(1);
		await expect(reader.cancel("early")).resolves.toBeUndefined();
	});

	it("LSM-SRC-05 AsyncIterable early break via return stops iteration cleanly", async () => {
		const items: number[] = [];
		const iter = asyncItems([10, 20, 30])[Symbol.asyncIterator]();
		items.push((await iter.next()).value as number);
		await expect(iter.return?.()).resolves.toEqual({ done: true, value: undefined });
		expect(items).toEqual([10]);
	});

	it("LSM-SRC-06 AsyncIterable throw from generator surfaces as rejected iteration", async () => {
		async function* boom(): AsyncIterable<number> {
			yield 1;
			throw new Error("source blew up");
		}
		const iter = boom()[Symbol.asyncIterator]();
		expect((await iter.next()).value).toBe(1);
		await expect(iter.next()).rejects.toThrow("source blew up");
	});

	it("LSM-SRC-07 readableFrom single-chunk pass-through", async () => {
		const chunk = new Uint8Array([0xca, 0xfe]);
		expect(await collect(readableFrom([chunk]))).toEqual([chunk]);
	});

	it("LSM-SRC-08 interleaved multi-source reads preserve per-source order", async () => {
		const a = readableFrom(["a1", "a2"]);
		const b = asyncItems(["b1", "b2"]);
		expect(await collect(a)).toEqual(["a1", "a2"]);
		expect(await collect(b)).toEqual(["b1", "b2"]);
	});

	it("LSM-SRC-09 neverEnd async iterable hangs until return cancels generator", async () => {
		async function* hang(): AsyncGenerator<number> {
			yield 1;
			await new Promise<void>(() => {
				// never resolves until return()
			});
		}
		const iter = hang()[Symbol.asyncIterator]();
		expect((await iter.next()).value).toBe(1);
		await expect(iter.return?.()).resolves.toEqual({ done: true, value: undefined });
	});

	it("LSM-SRC-10 readableFromArray throwAt errors stream consumer at index", async () => {
		const stream = readableFromArray([1, 2, 3], { throwAt: 1 });
		const reader = stream.getReader();
		expect((await reader.read()).value).toBe(1);
		await expect(reader.read()).rejects.toThrow("throwAt 1");
	});

	it("LSM-SRC-11 fromArray delayMs does not reorder items", async () => {
		const { readable, asyncIterable } = fromArray([1, 2, 3], { delayMs: 1 });
		expect(await collect(readable)).toEqual([1, 2, 3]);
		expect(await collect(asyncIterable)).toEqual([1, 2, 3]);
	});

	it("LSM-SRC-12 controllableReadable cancelReason resolves with cancel argument", async () => {
		const ctrl = controllableReadable<number>();
		ctrl.enqueue(9);
		const reader = ctrl.stream.getReader();
		await reader.read();
		await reader.cancel("manual-stop");
		await expect(ctrl.cancelReason).resolves.toBe("manual-stop");
	});
});

async function collect<T>(source: Source<T> | ReadableStream<T> | AsyncIterable<T>): Promise<T[]> {
	const stream = typeof source === "function" ? source() : source;
	const out: T[] = [];
	if (stream instanceof ReadableStream) {
		for await (const item of stream) out.push(item);
		return out;
	}
	for await (const item of stream) out.push(item);
	return out;
}
