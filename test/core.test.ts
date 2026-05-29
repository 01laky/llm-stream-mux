import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { muxError as muxErrorFactory } from "../src/errors.js";
import {
	combineSignals,
	isMuxCancelled,
	muxCancelledReason,
	timeoutSignal,
} from "../src/internal/abort.js";
import { collect, toAsyncIterable, toReadable } from "../src/internal/interop.js";
import { normalizeSource, normalizeSources } from "../src/internal/source.js";
import { createTelemetry } from "../src/internal/telemetry.js";
import { MUX_ERROR_CODES } from "../src/index.js";
import type { MuxCancelledReason, MuxResult, SourceEvent } from "../src/types.js";
import {
	asyncIterableFromArray,
	controllableReadable,
	fromArray,
	readableFromArray,
} from "./helpers/streams.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function drain<T>(reader: {
	next(): Promise<{ ok: boolean; value?: T; done?: boolean; error?: unknown }>;
}) {
	const values: T[] = [];
	for (;;) {
		const result = await reader.next();
		if (result.ok) {
			values.push(result.value as T);
			continue;
		}
		if ("error" in result && result.error !== undefined) throw result.error;
		break;
	}
	return values;
}

describe("LSM-CORE internals and interop", () => {
	it("LSM-CORE-01 normalizeSource reads all items from ReadableStream via SourceReadResult", async () => {
		const reader = normalizeSource(readableFromArray([1, 2, 3]), "s");
		expect(await drain(reader)).toEqual([1, 2, 3]);
	});

	it("LSM-CORE-02 normalizeSource reads all items from AsyncIterable", async () => {
		const reader = normalizeSource(asyncIterableFromArray(["a", "b"]), "s");
		expect(await drain(reader)).toEqual(["a", "b"]);
	});

	it("LSM-CORE-03 lazy thunk not invoked until first next; not invoked on cancel before read", async () => {
		let calls = 0;
		const reader = normalizeSource(() => {
			calls += 1;
			return readableFromArray([calls]);
		}, "lazy");

		expect(calls).toBe(0);
		await reader.cancel(muxCancelledReason("aborted"));
		expect(calls).toBe(0);
		const afterCancel = await reader.next();
		expect(calls).toBe(0);
		expect(afterCancel.ok).toBe(false);

		let calls2 = 0;
		const reader2 = normalizeSource(() => {
			calls2 += 1;
			return readableFromArray([42]);
		}, "lazy2");
		const result = await reader2.next();
		expect(calls2).toBe(1);
		expect(result.ok && result.value).toBe(42);
	});

	it("LSM-CORE-04 normalizeSources array record labeled ids and empty array", () => {
		expect(normalizeSources([])).toEqual([]);
		expect(normalizeSources([readableFromArray([1])]).map((r) => r.id)).toEqual(["0"]);
		expect(
			normalizeSources({ alpha: readableFromArray([1]), beta: readableFromArray([2]) }).map(
				(r) => r.id,
			),
		).toEqual(["alpha", "beta"]);
		expect(
			normalizeSources([{ id: "primary", source: readableFromArray([1]) }]).map((r) => r.id),
		).toEqual(["primary"]);
	});

	it("LSM-CORE-05 cancel on normalized ReadableStream calls underlying cancel", async () => {
		const ctrl = controllableReadable<number>();
		const reader = normalizeSource(ctrl.stream, "s");
		ctrl.enqueue(1);
		await reader.cancel(muxCancelledReason("race-lost"));
		await expect(ctrl.cancelReason).resolves.toEqual(
			expect.objectContaining({ name: "MuxCancelled", reason: "race-lost" }),
		);
	});

	it("LSM-CORE-06 cancel on normalized AsyncIterable calls return()", async () => {
		const returnFn = vi.fn(async () => ({ done: true as const, value: undefined }));
		const iterable: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				return {
					next: async () => ({ done: false as const, value: 1 }),
					return: returnFn,
				};
			},
		};
		const reader = normalizeSource(iterable, "s");
		await reader.next();
		await reader.cancel("stop");
		expect(returnFn).toHaveBeenCalledWith("stop");
	});

	it("LSM-CORE-07 cancel rejection swallowed — cancel resolves", async () => {
		const iterable: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				return {
					next: async () => ({ done: false as const, value: 1 }),
					return: async () => {
						throw new Error("return blew up");
					},
				};
			},
		};
		const reader = normalizeSource(iterable, "s");
		await expect(reader.cancel()).resolves.toBeUndefined();
	});

	it("LSM-CORE-08 muxCancelledReason race-lost matches MuxCancelled shape", () => {
		expect(muxCancelledReason("race-lost")).toEqual({
			name: "MuxCancelled",
			reason: "race-lost",
		});
		expect(isMuxCancelled(muxCancelledReason("race-lost"))).toBe(true);
	});

	it("LSM-CORE-09 all four MuxCancelledReason literals valid", () => {
		const reasons: MuxCancelledReason[] = ["race-lost", "failover", "aborted", "tee-all-cancelled"];
		for (const reason of reasons) {
			expect(isMuxCancelled(muxCancelledReason(reason))).toBe(true);
		}
	});

	it("LSM-CORE-10 combineSignals aborts when either input aborts", () => {
		const a = new AbortController();
		const b = new AbortController();
		const combined = combineSignals(a.signal, b.signal);
		expect(combined.aborted).toBe(false);
		b.abort("second");
		expect(combined.aborted).toBe(true);
		expect(combined.reason).toBe("second");

		const c = new AbortController();
		const d = new AbortController();
		const combined2 = combineSignals(c.signal, d.signal);
		c.abort("first");
		expect(combined2.aborted).toBe(true);
	});

	it("LSM-CORE-11 throwy iterator returns error result never rejects", async () => {
		const reader = normalizeSource(asyncIterableFromArray([1, 2, 3], { throwAt: 1 }), "s");
		expect((await reader.next()).ok).toBe(true);
		const failed = await reader.next();
		expect(failed.ok).toBe(false);
		if (!failed.ok && "error" in failed) {
			expect(failed.error).toBeInstanceOf(Error);
		}
	});

	it("LSM-CORE-12 timeoutSignal aborts after deadline", async () => {
		const signal = timeoutSignal(50);
		await new Promise((r) => setTimeout(r, 200));
		expect(signal.aborted).toBe(true);
	});

	it("LSM-CORE-13 collect gathers finite async iterable", async () => {
		expect(await collect(asyncIterableFromArray([1, 2, 3]))).toEqual([1, 2, 3]);
	});

	it("LSM-CORE-14 collect on empty async iterable returns empty array", async () => {
		expect(await collect(asyncIterableFromArray([]))).toEqual([]);
	});

	it("LSM-CORE-15 toReadable toAsyncIterable round-trip number and Uint8Array", async () => {
		const nums = [1, 2, 3];
		expect(await collect(toAsyncIterable(toReadable(asyncIterableFromArray(nums))))).toEqual(nums);

		const bytes = [new Uint8Array([1]), new Uint8Array([2])];
		const round = await collect(toAsyncIterable(toReadable(asyncIterableFromArray(bytes))));
		expect(round).toHaveLength(2);
		expect(round[0]?.[0]).toBe(1);
		expect(round[1]?.[0]).toBe(2);
	});

	it("LSM-CORE-16 src has no forbidden ReadableStream consumption patterns", () => {
		const srcDir = join(root, "src");
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (path.endsWith(".ts")) files.push(path);
			}
		};
		walk(srcDir);
		for (const file of files) {
			const body = readFileSync(file, "utf8");
			expect(body, file).not.toContain("ReadableStream.from");
			expect(body, file).not.toMatch(/from\s+["']node:stream/);
			expect(body, file).not.toContain("ReadableStream[Symbol.asyncIterator]");
		}
	});

	it("LSM-CORE-17 muxError minimal code sets code message instanceof Error stack", () => {
		const err = muxErrorFactory({ code: "ABORTED" });
		expect(err.code).toBe("ABORTED");
		expect(err.message).toBe("ABORTED");
		expect(err).toBeInstanceOf(Error);
		expect(err.stack).toBeTruthy();
	});

	it("LSM-CORE-18 muxError ALL_FAILED preserves errors and cause", () => {
		const inner = muxErrorFactory({ code: "SOURCE_ERROR", source: "0" });
		const agg = muxErrorFactory({ code: "ALL_FAILED", errors: [inner], cause: inner });
		expect(agg.errors).toEqual([inner]);
		expect(agg.cause).toBe(inner);
	});

	it("LSM-CORE-19 telemetry finish produces valid MuxResult", () => {
		const tel = createTelemetry("merge");
		tel.markStarted("a");
		tel.setWinner("a");
		const result = tel.finish();
		expect(result.strategy).toBe("merge");
		expect(result.winner).toBe("a");
		expect(result.aborted).toBe(false);
		expect(result.startedAt).toBeLessThanOrEqual(result.endedAt);
		expect(result.perSource.a?.started).toBe(true);
	});

	it("LSM-CORE-20 telemetry onSourceEvent lifecycle including error", () => {
		const events: string[] = [];
		const err = muxErrorFactory({ code: "SOURCE_ERROR", source: "s" });
		const tel = createTelemetry("race", {
			onSourceEvent: (e) => events.push(e.type),
		});
		tel.emit({ source: "s", type: "start" });
		tel.emit({ source: "s", type: "error", error: err });
		expect(events).toEqual(["start", "error"]);
	});

	it("LSM-CORE-21 combineSignals works on current Node abort fan-in", () => {
		const parent = new AbortController();
		const combined = combineSignals(parent.signal, timeoutSignal(60_000));
		parent.abort("parent");
		expect(combined.aborted).toBe(true);
		expect(combined.reason).toBe("parent");
	});

	it("LSM-CORE-22 toReadable from throwy async iterable errors stream consumer", async () => {
		const stream = toReadable(asyncIterableFromArray([1], { throwAt: 0 }));
		const reader = stream.getReader();
		await expect(reader.read()).rejects.toThrow("throwAt 0");
	});

	it("LSM-CORE-23 after cancel next returns done", async () => {
		const reader = normalizeSource(readableFromArray([1, 2]), "s");
		await reader.cancel();
		const after = await reader.next();
		expect(after.ok).toBe(false);
		if (!after.ok) expect("done" in after && after.done).toBe(true);
	});

	it("LSM-CORE-24 fromArray readable and asyncIterable symmetry", async () => {
		const items = [1, 2, 3];
		const opts = { delayMs: 0 };
		const { readable, asyncIterable } = fromArray(items, opts);
		expect(await drain(normalizeSource(readable, "r"))).toEqual(items);
		expect(await drain(normalizeSource(asyncIterable, "a"))).toEqual(items);

		const bytes = fromArray([new Uint8Array([9])], opts);
		expect(await drain(normalizeSource(bytes.readable, "br"))).toHaveLength(1);
		expect(await drain(normalizeSource(bytes.asyncIterable, "ba"))).toHaveLength(1);
	});

	it("LSM-CORE-25 telemetry incrementItems counts per source", () => {
		const tel = createTelemetry("merge");
		tel.incrementItems("gpt");
		tel.incrementItems("gpt");
		tel.incrementItems("gpt");
		const result = tel.finish();
		expect(result.perSource.gpt?.items).toBe(3);
	});

	it("LSM-CORE-26 normalizeSources duplicate labeled ids throws", () => {
		expect(() =>
			normalizeSources([
				{ id: "dup", source: readableFromArray([1]) },
				{ id: "dup", source: readableFromArray([2]) },
			]),
		).toThrow(/duplicate source id "dup"/);
	});

	it("LSM-CORE-27 telemetry setAborted reflected in finish", () => {
		const tel = createTelemetry("fallback");
		tel.setAborted(true);
		expect(tel.finish().aborted).toBe(true);
		expect(createTelemetry("fallback").finish().aborted).toBe(false);
	});

	it("LSM-CORE-28 normalizeSource empty ReadableStream yields done on first next", async () => {
		const reader = normalizeSource(readableFromArray([]), "empty-rs");
		const result = await reader.next();
		expect(result.ok).toBe(false);
		if (!result.ok) expect("done" in result && result.done).toBe(true);
	});

	it("LSM-CORE-29 normalizeSource empty AsyncIterable yields done on first next", async () => {
		const reader = normalizeSource(asyncIterableFromArray([]), "empty-ai");
		const result = await reader.next();
		expect(result.ok).toBe(false);
		if (!result.ok) expect("done" in result && result.done).toBe(true);
	});

	it("LSM-CORE-30 normalizeSource ReadableStream error returns error result never rejects", async () => {
		const ctrl = controllableReadable<number>();
		const reader = normalizeSource(ctrl.stream, "err-rs");
		ctrl.enqueue(1);
		expect((await reader.next()).ok).toBe(true);
		ctrl.error(new Error("stream broke"));
		const failed = await reader.next();
		expect(failed.ok).toBe(false);
		if (!failed.ok && "error" in failed) {
			expect((failed.error as Error).message).toBe("stream broke");
		}
	});

	it("LSM-CORE-31 double cancel on normalized reader calls underlying cancel once", async () => {
		const cancelFn = vi.fn(async () => {});
		const stream = new ReadableStream<number>({
			start(controller) {
				controller.enqueue(1);
			},
			cancel: cancelFn,
		});
		const reader = normalizeSource(stream, "double-cancel");
		await reader.next();
		await reader.cancel("first");
		await reader.cancel("second");
		expect(cancelFn).toHaveBeenCalledTimes(1);
		expect(cancelFn).toHaveBeenCalledWith("first");
	});

	it("LSM-CORE-32 cancel after natural exhaustion resolves without throw", async () => {
		const reader = normalizeSource(readableFromArray([1]), "done");
		expect(await drain(reader)).toEqual([1]);
		await expect(reader.cancel()).resolves.toBeUndefined();
	});

	it("LSM-CORE-33 lazy factory invoked exactly once across multiple next calls", async () => {
		let calls = 0;
		const reader = normalizeSource(() => {
			calls += 1;
			return readableFromArray([10, 20, 30]);
		}, "lazy-once");
		expect((await reader.next()).ok).toBe(true);
		expect((await reader.next()).ok).toBe(true);
		expect(calls).toBe(1);
	});

	it("LSM-CORE-34 lazy source cancel after first next propagates to underlying stream", async () => {
		const ctrl = controllableReadable<number>();
		const reader = normalizeSource(() => ctrl.stream, "lazy-cancel");
		ctrl.enqueue(1);
		await reader.next();
		await reader.cancel(muxCancelledReason("failover"));
		await expect(ctrl.cancelReason).resolves.toEqual(
			expect.objectContaining({ name: "MuxCancelled", reason: "failover" }),
		);
	});

	it("LSM-CORE-35 NormalizedReader.id matches normalizeSource id argument", () => {
		expect(normalizeSource(readableFromArray([]), "my-id").id).toBe("my-id");
	});

	it("LSM-CORE-36 ReadableStream underlying cancel rejection swallowed", async () => {
		const stream = new ReadableStream<number>({
			cancel() {
				throw new Error("cancel boom");
			},
		});
		const reader = normalizeSource(stream, "cancel-reject");
		await expect(reader.cancel()).resolves.toBeUndefined();
	});

	it("LSM-CORE-37 combineSignals with no inputs returns non-aborted signal", () => {
		expect(combineSignals().aborted).toBe(false);
	});

	it("LSM-CORE-38 combineSignals propagates already-aborted input reason", () => {
		const ctrl = new AbortController();
		ctrl.abort("pre-aborted");
		const combined = combineSignals(ctrl.signal);
		expect(combined.aborted).toBe(true);
		expect(combined.reason).toBe("pre-aborted");
	});

	it("LSM-CORE-39 combineSignals aborts when any of three inputs aborts", () => {
		const a = new AbortController();
		const b = new AbortController();
		const c = new AbortController();
		const combined = combineSignals(a.signal, b.signal, c.signal);
		b.abort("middle");
		expect(combined.aborted).toBe(true);
		expect(combined.reason).toBe("middle");
	});

	it("LSM-CORE-40 isMuxCancelled false for invalid shapes", () => {
		expect(isMuxCancelled(null)).toBe(false);
		expect(isMuxCancelled(undefined)).toBe(false);
		expect(isMuxCancelled({ name: "MuxCancelled", reason: "not-a-reason" })).toBe(false);
		expect(isMuxCancelled({ name: "Other", reason: "race-lost" })).toBe(false);
		expect(isMuxCancelled("race-lost")).toBe(false);
	});

	it("LSM-CORE-41 muxError every MUX_ERROR_CODES entry constructs valid MuxError", () => {
		for (const code of MUX_ERROR_CODES) {
			const err = muxErrorFactory({ code });
			expect(err.code).toBe(code);
			expect(err).toBeInstanceOf(Error);
			expect(err.message).toBeTruthy();
		}
	});

	it("LSM-CORE-42 muxError custom message and source fields", () => {
		const err = muxErrorFactory({
			code: "SOURCE_ERROR",
			source: "gpt",
			message: "provider down",
		});
		expect(err.message).toBe("provider down");
		expect(err.source).toBe("gpt");
	});

	it("LSM-CORE-43 telemetry markCompleted markErrored and onFinish", () => {
		const finished: MuxResult[] = [];
		const tel = createTelemetry("race", { onFinish: (r) => finished.push(r) });
		tel.markStarted("a");
		tel.markCompleted("a");
		tel.markErrored("b");
		const result = tel.finish();
		expect(result.perSource.a?.completed).toBe(true);
		expect(result.perSource.a?.started).toBe(true);
		expect(result.perSource.b?.errored?.code).toBe("SOURCE_ERROR");
		expect(finished).toHaveLength(1);
		expect(finished[0]).toBe(result);
	});

	it("LSM-CORE-44 telemetry emit uses explicit timestamp when provided", () => {
		const events: SourceEvent[] = [];
		const tel = createTelemetry("merge", { onSourceEvent: (e) => events.push(e) });
		tel.emit({ source: "s", type: "start", timestamp: 12_345 });
		expect(events[0]?.timestamp).toBe(12_345);
	});

	it("LSM-CORE-45 collect propagates throw from mid-stream async iterable", async () => {
		await expect(collect(asyncIterableFromArray([1, 2], { throwAt: 1 }))).rejects.toThrow(
			"throwAt 1",
		);
	});

	it("LSM-CORE-46 collect on ReadableStream via public toAsyncIterable", async () => {
		expect(await collect(toAsyncIterable(readableFromArray([4, 5, 6])))).toEqual([4, 5, 6]);
	});

	it("LSM-CORE-47 toReadable cancel calls async iterator return", async () => {
		const returnFn = vi.fn(async () => ({ done: true as const, value: undefined }));
		const iterable: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				return {
					next: async () => ({ done: false as const, value: 1 }),
					return: returnFn,
				};
			},
		};
		await toReadable(iterable).cancel("bye");
		expect(returnFn).toHaveBeenCalledWith("bye");
	});

	it("LSM-CORE-48 toAsyncIterable early return cancels underlying ReadableStream", async () => {
		const ctrl = controllableReadable<number>();
		ctrl.enqueue(1);
		ctrl.enqueue(2);
		const iter = toAsyncIterable(ctrl.stream)[Symbol.asyncIterator]();
		await iter.next();
		await iter.return?.(muxCancelledReason("aborted"));
		await expect(ctrl.cancelReason).resolves.toEqual(
			expect.objectContaining({ name: "MuxCancelled", reason: "aborted" }),
		);
	});

	it("LSM-CORE-49 toReadable from empty async iterable closes without enqueue", async () => {
		const reader = toReadable(asyncIterableFromArray([])).getReader();
		const { done, value } = await reader.read();
		expect(done).toBe(true);
		expect(value).toBeUndefined();
	});

	it("LSM-CORE-50 normalizeSources record form preserves object keys as ids", () => {
		const readers = normalizeSources({
			first: readableFromArray([1]),
			second: readableFromArray([2]),
		});
		expect(readers.map((r) => r.id)).toEqual(["first", "second"]);
	});

	it("LSM-CORE-51 normalizeSources empty record yields no readers", () => {
		expect(normalizeSources({})).toEqual([]);
	});

	it("LSM-CORE-52 consecutive error results from throwy iterator without rejecting next()", async () => {
		const reader = normalizeSource(asyncIterableFromArray([1], { throwAt: 1 }), "throwy");
		expect((await reader.next()).ok).toBe(true);
		const e1 = await reader.next();
		expect(e1.ok).toBe(false);
		if (!e1.ok && "error" in e1) expect(e1.error).toBeInstanceOf(Error);
		const e2 = await reader.next();
		expect(e2.ok).toBe(false);
	});

	it("LSM-CORE-53 async iterable without return — cancel still resolves", async () => {
		const iterable: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				return {
					next: async () => ({ done: false as const, value: 1 }),
				};
			},
		};
		const reader = normalizeSource(iterable, "no-return");
		await expect(reader.cancel()).resolves.toBeUndefined();
	});

	it("LSM-CORE-54 timeoutSignal not aborted before deadline", () => {
		expect(timeoutSignal(60_000).aborted).toBe(false);
	});

	it("LSM-CORE-55 interop empty ReadableStream round-trip via collect", async () => {
		expect(await collect(toAsyncIterable(readableFromArray([])))).toEqual([]);
	});

	it("LSM-CORE-56 toAsyncIterable propagates ReadableStream error to consumer", async () => {
		const ctrl = controllableReadable<number>();
		const iter = toAsyncIterable(ctrl.stream)[Symbol.asyncIterator]();
		ctrl.error(new Error("rs error"));
		await expect(iter.next()).rejects.toThrow("rs error");
	});

	it("LSM-CORE-57 telemetry ensureSource initializes stats independently per id", () => {
		const tel = createTelemetry("merge");
		tel.incrementItems("x");
		tel.markStarted("y");
		const result = tel.finish();
		expect(result.perSource.x?.items).toBe(1);
		expect(result.perSource.x?.started).toBe(false);
		expect(result.perSource.y?.started).toBe(true);
		expect(result.perSource.y?.items).toBe(0);
	});

	it("LSM-CORE-58 normalizeSources record duplicate key assignment keeps last source only", () => {
		const sources: Record<string, ReturnType<typeof readableFromArray<number>>> = {};
		sources.dup = readableFromArray([1]);
		sources.dup = readableFromArray([2]);
		const readers = normalizeSources(sources);
		expect(readers.map((r) => r.id)).toEqual(["dup"]);
	});

	it("LSM-CORE-59 toReadable preserves item order for multi-item iterable", async () => {
		expect(await collect(toReadable(asyncIterableFromArray([1, 2, 3])))).toEqual([1, 2, 3]);
	});

	it("LSM-CORE-60 post-error next on normalized reader returns done when stream closed", async () => {
		const ctrl = controllableReadable<number>();
		const reader = normalizeSource(ctrl.stream, "post-err");
		ctrl.enqueue(1);
		expect((await reader.next()).ok).toBe(true);
		ctrl.error(new Error("fatal"));
		expect((await reader.next()).ok).toBe(false);
		const after = await reader.next();
		expect(after.ok).toBe(false);
	});
});
