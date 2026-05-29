import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectTypeOf } from "vitest";
import { MUX_ERROR_CODES } from "../src/index.js";
import type {
	CollectFn,
	CommonOptions,
	FallbackOptions,
	MergeFn,
	MergeOptions,
	MuxError,
	MuxErrorCode,
	MuxCancelledReason,
	RaceFn,
	RaceOptions,
	Source,
	Sources,
	Tagged,
	TeeFn,
	TeeOptions,
	ToAsyncIterableFn,
	ToReadableFn,
} from "../src/types.js";
import {
	asyncItems,
	lazySource,
	muxError,
	muxResult,
	readableFrom,
	sourceEvent,
	sourceStats,
	taggedDone,
	taggedError,
	taggedValue,
} from "./helpers/type-fixtures.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readPkgVersion() {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
}

function handleTagged<T>(tagged: Tagged<T>): "value" | "error" | "done" {
	switch (tagged.kind) {
		case "value":
			return tagged.value === tagged.value ? "value" : "value";
		case "error":
			return tagged.error.code ? "error" : "error";
		case "done":
			return "done";
	}
}

describe("LSM-TYP extended type edge cases", () => {
	for (const [idx, code] of MUX_ERROR_CODES.entries()) {
		it(`LSM-TYP-${16 + idx} MuxErrorCode ${code} is assignable and in MUX_ERROR_CODES`, () => {
			const err = muxError(code);
			expect(err.code).toBe(code);
			expect(MUX_ERROR_CODES).toContain(code);
		});
	}

	it("LSM-TYP-22 Tagged switch exhaustiveness narrows all kinds", () => {
		expect(handleTagged(taggedValue("a", 1))).toBe("value");
		expect(handleTagged(taggedError("a", muxError("SOURCE_ERROR")))).toBe("error");
		expect(handleTagged(taggedDone("a"))).toBe("done");
	});

	it("LSM-TYP-23 byte mode T=Uint8Array through Source and Tagged", () => {
		const src: Source<Uint8Array> = readableFrom([new Uint8Array([1])]);
		const tagged: Tagged<Uint8Array> = taggedValue("raw", new Uint8Array([2]));
		expect(src).toBeDefined();
		expect(tagged.value[0]).toBe(2);
	});

	it("LSM-TYP-24 event mode arbitrary T preserves genericity", () => {
		type Ev = { type: "text.delta"; text: string };
		const tagged: Tagged<Ev> = taggedValue("m", { type: "text.delta", text: "hi" });
		expect(tagged.value.text).toBe("hi");
	});

	it("LSM-TYP-25 Source accepts ReadableStream AsyncIterable and lazy returning either", async () => {
		const rs: Source<number> = readableFrom([1]);
		const ai: Source<number> = asyncItems([2]);
		const lazyRs: Source<number> = lazySource(() => readableFrom([3]));
		const lazyAi: Source<number> = lazySource(() => asyncItems([4]));

		expect(await readOne(rs)).toBe(1);
		expect(await readOne(ai)).toBe(2);
		expect(await readOne(lazyRs())).toBe(3);
		expect(await readOne(lazyAi())).toBe(4);
	});

	it("LSM-TYP-26 lazy Source factory not invoked until call", () => {
		let n = 0;
		const lazy = lazySource<number>(() => {
			n += 1;
			return readableFrom([n]);
		});
		expect(n).toBe(0);
		if (typeof lazy === "function") lazy();
		expect(n).toBe(1);
	});

	it("LSM-TYP-27 Sources positional ids implied as 0..n-1 at runtime type level", () => {
		const sources: Sources<string> = [readableFrom(["a"]), readableFrom(["b"])];
		expect(sources).toHaveLength(2);
	});

	it("LSM-TYP-28 Sources record preserves string keys for merge tags", () => {
		const sources: Sources<number> = { alpha: readableFrom([1]), beta: readableFrom([2]) };
		expect(Object.keys(sources).sort()).toEqual(["alpha", "beta"]);
	});

	it("LSM-TYP-29 Sources labeled array carries explicit id", () => {
		const sources: Sources<number> = [
			{ id: "primary", source: readableFrom([1]) },
			{ id: "backup", source: lazySource(() => readableFrom([2])) },
		];
		expect(sources[1]?.id).toBe("backup");
	});

	it("LSM-TYP-30 CommonOptions all hooks compose without collision", () => {
		const events: string[] = [];
		const opts: CommonOptions<{ v: number; final?: boolean }, string> = {
			signal: new AbortController().signal,
			isError: (item) => item.v < 0,
			isFinal: (item) => item.final === true,
			mapEach: (item, source) => `${source}:${item.v}`,
			onSourceEvent: (e) => events.push(e.type),
			onFinish: (r) => events.push(r.strategy),
			timeoutMs: 1,
			overallTimeoutMs: 2,
			highWaterMark: 1,
			sourceHighWaterMark: 2,
		};
		expect(opts.isError?.({ v: -1 })).toBe(true);
		expect(opts.isFinal?.({ v: 1, final: true })).toBe(true);
		expect(opts.mapEach?.({ v: 3 }, "x")).toBe("x:3");
		opts.onSourceEvent?.(sourceEvent("start"));
		opts.onFinish?.(muxResult("race"));
		expect(events).toEqual(["start", "race"]);
	});

	it("LSM-TYP-31 RaceOptions isUsable gates separately from isError", () => {
		const opts: RaceOptions<{ ok: boolean; err: boolean }> = {
			isUsable: (item) => item.ok,
			isError: (item) => item.err,
		};
		expect(opts.isUsable?.({ ok: false, err: false })).toBe(false);
		expect(opts.isError?.({ ok: true, err: true })).toBe(true);
	});

	it("LSM-TYP-32 FallbackOptions every FailoverPolicy literal accepted", () => {
		for (const policy of ["commit", "buffered", "post-emit"] as const) {
			const opts: FallbackOptions<unknown> = { policy, isUsable: () => true };
			expect(opts.policy).toBe(policy);
		}
	});

	it("LSM-TYP-33 MergeOptions D8 round-robin does not imply extra buffer fields", () => {
		const opts: MergeOptions<unknown> = {
			order: "round-robin",
			concurrency: 4,
			failFast: false,
			highWaterMark: 1,
		};
		expect(Object.keys(opts).sort()).toEqual(["concurrency", "failFast", "highWaterMark", "order"]);
	});

	it("LSM-TYP-34 MergeOptions failFast true pairs with ALL_FAILED code existence", () => {
		const opts: MergeOptions<unknown> = { failFast: true };
		const code: MuxErrorCode = "ALL_FAILED";
		expect(opts.failFast).toBe(true);
		expect(MUX_ERROR_CODES).toContain(code);
	});

	it("LSM-TYP-35 TeeOptions D5 bounded and drop accept bufferLimit", () => {
		const bounded: TeeOptions = { backpressure: "bounded", bufferLimit: 16 };
		const drop: TeeOptions = { backpressure: "drop", bufferLimit: 8 };
		const block: TeeOptions = { backpressure: "block" };
		expect(bounded.bufferLimit).toBe(16);
		expect(drop.backpressure).toBe("drop");
		expect(block.bufferLimit).toBeUndefined();
	});

	it("LSM-TYP-36 SourceEvent error-bearing types allow optional MuxError", () => {
		const err = muxError("IN_BAND_ERROR", { source: "s" });
		for (const type of ["error", "failover", "timeout"] as const) {
			const event = sourceEvent(type, "s", err);
			expect(event.error?.code).toBe("IN_BAND_ERROR");
		}
	});

	it("LSM-TYP-37 SourceEvent lifecycle types omit error by default", () => {
		for (const type of ["start", "usable", "final", "done", "cancelled"] as const) {
			const event = sourceEvent(type);
			expect(event.error).toBeUndefined();
		}
	});

	it("LSM-TYP-38 MuxResult winner optional for merge strategy", () => {
		const merge = muxResult("merge", { winner: undefined, perSource: { a: sourceStats() } });
		const race = muxResult("race", { winner: "0" });
		expect(merge.winner).toBeUndefined();
		expect(race.winner).toBe("0");
	});

	it("LSM-TYP-39 MuxResult aborted flag independent of winner", () => {
		const r = muxResult("fallback", { aborted: true, winner: "backup" });
		expect(r.aborted).toBe(true);
		expect(r.winner).toBe("backup");
	});

	it("LSM-TYP-40 MuxSourceStats errored optional MuxError reference", () => {
		const err = muxError("TIMEOUT", { source: "slow" });
		const stats = sourceStats({ errored: err, started: true, completed: false, items: 0 });
		expect(stats.errored?.code).toBe("TIMEOUT");
	});

	it("LSM-TYP-41 ALL_FAILED requires errors array shape for aggregate telemetry", () => {
		const e1 = muxError("SOURCE_ERROR", { source: "0" });
		const e2 = muxError("TIMEOUT", { source: "1" });
		const agg = muxError("ALL_FAILED", { errors: [e1, e2], cause: e1 });
		expect(agg.errors?.map((e) => e.source)).toEqual(["0", "1"]);
	});

	it("LSM-TYP-42 MuxErrorInit message optional uses Error.message at runtime", () => {
		const init = { code: "NO_USABLE_SOURCE" as const, message: "none usable" };
		const err = muxError(init.code, { message: init.message });
		expect(err.message).toBe("none usable");
	});

	it("LSM-TYP-43 mapEach sync-only contract T to U type change", () => {
		expectTypeOf((item: { n: number }, _source: string) => String(item.n)).returns.toBeString();
		const opts: CommonOptions<{ n: number }, string> = {
			mapEach: (item, source) => `${source}:${item.n}`,
		};
		expect(opts.mapEach?.({ n: 7 }, "s")).toBe("s:7");
	});

	it("LSM-TYP-44 CreateMuxError type accepts factory signature", () => {
		const create = ((init) =>
			muxError(init.code, init)) satisfies import("../src/types.js").CreateMuxError;
		expect(create({ code: "ABORTED" }).code).toBe("ABORTED");
	});

	it("LSM-TYP-45 MUX_ERROR_CODES array order matches proposal §6.3 listing", () => {
		expect([...MUX_ERROR_CODES]).toEqual([
			"SOURCE_ERROR",
			"IN_BAND_ERROR",
			"ALL_FAILED",
			"ABORTED",
			"TIMEOUT",
			"NO_USABLE_SOURCE",
		]);
	});

	it("LSM-TYP-46 Tagged error branch value is MuxError not T at type level", () => {
		const t: Tagged<number> = taggedError("s", muxError("SOURCE_ERROR"));
		if (t.kind === "error") {
			expectTypeOf(t.error).toMatchTypeOf<MuxError>();
			expect(t.error.code).toBe("SOURCE_ERROR");
		}
	});

	it("LSM-TYP-47 race NO_USABLE_SOURCE and fallback ALL_FAILED codes both exported", () => {
		expect(MUX_ERROR_CODES).toContain("NO_USABLE_SOURCE");
		expect(MUX_ERROR_CODES).toContain("ALL_FAILED");
	});

	it("LSM-TYP-48 tee SOURCE_ERROR code exported for bounded overflow D5", () => {
		expect(MUX_ERROR_CODES).toContain("SOURCE_ERROR");
	});

	it("LSM-TYP-49 signal ABORTED code exported for abort path §7.5", () => {
		expect(MUX_ERROR_CODES).toContain("ABORTED");
	});

	it("LSM-TYP-50 IN_BAND_ERROR code exported for isError hook path", () => {
		expect(MUX_ERROR_CODES).toContain("IN_BAND_ERROR");
	});

	it("LSM-TYP-51 dist index.d.ts declares types without strategy runtime exports", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expect(dts).toContain("type Source<T>");
		expect(dts).toContain("declare const MUX_ERROR_CODES");
		expect(dts).toContain(`declare const MUX_PKG_VERSION: "${readPkgVersion()}"`);
		expect(dts).not.toMatch(/export declare function race\b/);
		expect(dts).not.toContain("fromAsyncIterable");
		expect(dts).toMatch(/export \{[^}]*type Source,/);
	});

	it("LSM-TYP-52 dist index.d.ts exposes every signature type alias", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		const typeAliases = [
			"RaceFn",
			"FallbackFn",
			"MergeFn",
			"TeeFn",
			"CollectFn",
			"ToReadableFn",
			"ToAsyncIterableFn",
		];
		for (const name of typeAliases) {
			expect(dts, name).toMatch(new RegExp(`type ${name}[ =<]`));
		}
		expect(dts).toMatch(/interface MuxCancelled\b/);
		expect(dts).toContain("type MuxCancelledReason");
	});

	it("LSM-TYP-53 CJS bundle has no node_modules require paths", () => {
		const body = readFileSync(join(root, "dist/index.cjs"), "utf8");
		expect(body).not.toContain("node_modules");
	});

	it("LSM-TYP-54 ESM bundle re-exports MUX_ERROR_CODES frozen length", () => {
		const body = readFileSync(join(root, "dist/index.js"), "utf8");
		expect(body).toContain("MUX_ERROR_CODES");
		expect(MUX_ERROR_CODES.length).toBe(6);
	});

	it("LSM-TYP-55 RaceFn signature accepts Sources and optional RaceOptions", () => {
		const race: RaceFn = async function* () {} as RaceFn;
		expectTypeOf(race).parameters.toEqualTypeOf<[Sources<unknown>, RaceOptions<unknown>?]>();
		expectTypeOf(race).returns.toEqualTypeOf<AsyncIterable<unknown>>();
	});

	it("LSM-TYP-56 MergeFn returns AsyncIterable of Tagged U not plain T", () => {
		const merge: MergeFn = async function* () {
			yield taggedValue("s", "mapped");
		} as MergeFn;
		expectTypeOf(merge).returns.toEqualTypeOf<AsyncIterable<Tagged<string>>>();
	});

	it("LSM-TYP-57 TeeFn takes single Source and branch count n", () => {
		const tee: TeeFn = ((_source, _n) => []) as TeeFn;
		expectTypeOf(tee).parameters.toEqualTypeOf<[Source<unknown>, number, TeeOptions?]>();
		expectTypeOf(tee).returns.toEqualTypeOf<ReadableStream<unknown>[]>();
	});

	it("LSM-TYP-58 interop Collect ToReadable ToAsyncIterable signatures frozen", () => {
		const collect: CollectFn = async (it) => {
			const out: unknown[] = [];
			for await (const item of it) out.push(item);
			return out;
		};
		const toReadable: ToReadableFn = (it) =>
			new ReadableStream({
				async start(controller) {
					for await (const item of it) controller.enqueue(item);
					controller.close();
				},
			});
		const toAsyncIterable: ToAsyncIterableFn = async function* (rs) {
			yield* rs;
		};
		expectTypeOf(collect).returns.resolves.toEqualTypeOf<unknown[]>();
		expectTypeOf(toReadable).returns.toEqualTypeOf<ReadableStream<unknown>>();
		expectTypeOf(toAsyncIterable).returns.toEqualTypeOf<AsyncIterable<unknown>>();
	});

	it("LSM-TYP-59 TeeOptions omits CommonOptions hooks including signal", () => {
		const opts: TeeOptions = { backpressure: "bounded", bufferLimit: 4 };
		expect("signal" in opts).toBe(false);
		expect("mapEach" in opts).toBe(false);
	});

	it("LSM-TYP-60 empty Sources array is valid typed input", () => {
		const empty: Sources<never> = [];
		expect(empty).toHaveLength(0);
	});

	it("LSM-TYP-61 ALL_FAILED aggregate allows zero nested errors for empty fallback", () => {
		const agg = muxError("ALL_FAILED", { errors: [] });
		expect(agg.errors).toEqual([]);
		expect(agg.code).toBe("ALL_FAILED");
	});

	it("LSM-TYP-62 dist index.d.cts mirrors ESM type exports", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		const dcts = readFileSync(join(root, "dist/index.d.cts"), "utf8");
		for (const needle of ["type Source<T>", "declare const MUX_ERROR_CODES", "type MergeFn"]) {
			expect(dts).toContain(needle);
			expect(dcts).toContain(needle);
		}
	});

	it("LSM-TYP-63 MUX_ERROR_CODES is a readonly tuple at runtime", () => {
		expect(Object.isFrozen(MUX_ERROR_CODES)).toBe(true);
		expect(() => {
			(MUX_ERROR_CODES as unknown as string[]).push("EXTRA");
		}).toThrow();
	});

	it("LSM-TYP-64 MuxError preserves cause chain for nested SOURCE_ERROR", () => {
		const rootErr = new Error("root");
		const cause = muxError("SOURCE_ERROR", { source: "0", cause: rootErr });
		const agg = muxError("ALL_FAILED", { errors: [cause], cause });
		expect(agg.cause).toBe(cause);
		expect((agg.cause as MuxError).cause).toBe(rootErr);
	});

	it("LSM-TYP-65 MuxResult perSource accepts arbitrary string source ids", () => {
		const result = muxResult("merge", {
			perSource: {
				"provider/a": sourceStats({ items: 1 }),
				"provider/b": sourceStats({ items: 2 }),
			},
		});
		expect(Object.keys(result.perSource).sort()).toEqual(["provider/a", "provider/b"]);
	});

	it("LSM-TYP-66 SourceEventType union has exactly eight lifecycle literals", () => {
		const types = [
			"start",
			"usable",
			"final",
			"done",
			"error",
			"failover",
			"cancelled",
			"timeout",
		] as const;
		expect(types).toHaveLength(8);
		for (const type of types) {
			expect(sourceEvent(type).type).toBe(type);
		}
	});

	it("LSM-TYP-67 dist d.ts exports all MuxCancelledReason literals", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		const reasons: MuxCancelledReason[] = ["race-lost", "failover", "aborted", "tee-all-cancelled"];
		for (const reason of reasons) {
			expect(dts).toContain(`"${reason}"`);
		}
	});

	it("LSM-TYP-68 dist bundles expose no importable internal module paths", () => {
		for (const file of ["dist/index.js", "dist/index.cjs"]) {
			const body = readFileSync(join(root, file), "utf8");
			expect(body).not.toMatch(/from\s+["']\.\/types/);
			expect(body).not.toMatch(/require\s*\(\s*["']\.\/types/);
			expect(body).not.toMatch(/node_modules/);
		}
	});
});

async function readOne(source: Source<number> | ReadableStream<number> | AsyncIterable<number>) {
	const stream = typeof source === "function" ? source() : source;
	if (stream instanceof ReadableStream) {
		const reader = stream.getReader();
		const { value } = await reader.read();
		await reader.cancel();
		return value;
	}
	for await (const value of stream) return value;
	return undefined;
}
