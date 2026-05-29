import { describe, expect, it } from "vitest";
import * as mux from "../src/index.js";
import {
	MUX_ERROR_CODES,
	type CollectFn,
	type CommonOptions,
	type CreateMuxError,
	type FallbackFn,
	type FallbackOptions,
	type FailoverPolicy,
	type MergeFn,
	type MergeOptions,
	type MergeOrder,
	type MuxCancelled,
	type MuxCancelledReason,
	type MuxError,
	type MuxErrorCode,
	type MuxErrorInit,
	type MuxResult,
	type MuxSourceStats,
	type MuxStrategy,
	type RaceFn,
	type RaceOptions,
	type Source,
	type SourceEvent,
	type SourceEventType,
	type Sources,
	type Tagged,
	type TeeBackpressure,
	type TeeFn,
	type TeeOptions,
	type ToAsyncIterableFn,
	type ToReadableFn,
} from "../src/index.js";
import { readableFrom } from "./helpers/type-fixtures.js";

const PUBLIC_RUNTIME_EXPORTS = [
	"MUX_ERROR_CODES",
	"MUX_PKG_VERSION",
	"collect",
	"toReadable",
	"toAsyncIterable",
] as const;

const ALL_MUX_ERROR_CODES: MuxErrorCode[] = [
	"SOURCE_ERROR",
	"IN_BAND_ERROR",
	"ALL_FAILED",
	"ABORTED",
	"TIMEOUT",
	"NO_USABLE_SOURCE",
];

const SOURCE_EVENT_TYPES: SourceEventType[] = [
	"start",
	"usable",
	"final",
	"done",
	"error",
	"failover",
	"cancelled",
	"timeout",
];

const FAILOVER_POLICIES: FailoverPolicy[] = ["commit", "buffered", "post-emit"];
const TEE_BACKPRESSURE: TeeBackpressure[] = ["block", "bounded", "drop"];
const MERGE_ORDERS: MergeOrder[] = ["arrival", "round-robin"];
const MUX_STRATEGIES: MuxStrategy[] = ["race", "fallback", "merge", "tee"];
const CANCEL_REASONS: MuxCancelledReason[] = [
	"race-lost",
	"failover",
	"aborted",
	"tee-all-cancelled",
];

/** Compile-time import smoke — unused type params prove exports resolve. */
type _TypeExportSmoke = [
	Source<number>,
	Sources<string>,
	Tagged<{ x: number }>,
	MuxError,
	MuxErrorInit,
	CreateMuxError,
	SourceEvent,
	MuxResult,
	MuxSourceStats,
	CommonOptions<unknown>,
	RaceOptions<unknown>,
	FallbackOptions<unknown>,
	MergeOptions<unknown>,
	TeeOptions,
	RaceFn,
	FallbackFn,
	MergeFn,
	TeeFn,
	CollectFn,
	ToReadableFn,
	ToAsyncIterableFn,
	MuxCancelled,
];

type _MuxErrorCodeExhaustive = MuxErrorCode extends (typeof MUX_ERROR_CODES)[number] ? true : never;
type _CodesCoverUnion = (typeof MUX_ERROR_CODES)[number] extends MuxErrorCode ? true : never;

describe("LSM-REL-02 public export contract", () => {
	for (const name of PUBLIC_RUNTIME_EXPORTS) {
		it(`LSM-REL-02 exports runtime ${name}`, () => {
			expect(name in mux).toBe(true);
		});
	}

	it("LSM-REL-02 forbids fromAsyncIterable export (D10)", () => {
		expect("fromAsyncIterable" in mux).toBe(false);
	});

	it("LSM-REL-02 forbids premature strategy runtime exports", () => {
		for (const name of [
			"race",
			"fallback",
			"merge",
			"tee",
			"ensemble",
			"muxError",
			"fromAsyncIterable",
		]) {
			expect(name in mux, name).toBe(false);
		}
	});

	it("LSM-REL-02 interop helpers are functions", () => {
		expect(typeof mux.collect).toBe("function");
		expect(typeof mux.toReadable).toBe("function");
		expect(typeof mux.toAsyncIterable).toBe("function");
	});

	it("LSM-REL-02 MUX_ERROR_CODES lists every MuxErrorCode exactly once", () => {
		expect(MUX_ERROR_CODES).toHaveLength(ALL_MUX_ERROR_CODES.length);
		expect(new Set(MUX_ERROR_CODES).size).toBe(ALL_MUX_ERROR_CODES.length);
		for (const code of ALL_MUX_ERROR_CODES) {
			expect(MUX_ERROR_CODES).toContain(code);
		}
	});

	it("LSM-REL-02 MUX_PKG_VERSION is a non-empty semver-like string", () => {
		expect(mux.MUX_PKG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("LSM-TYP edge cases for frozen public types", () => {
	it("LSM-TYP-01 Tagged value variant carries source and value", () => {
		const tagged: Tagged<number> = { source: "gpt", kind: "value", value: 42 };
		expect(tagged.kind).toBe("value");
		if (tagged.kind === "value") expect(tagged.value).toBe(42);
	});

	it("LSM-TYP-02 Tagged error variant uses MuxError not T", () => {
		const err = Object.assign(new Error("fail"), { code: "SOURCE_ERROR" as const }) as MuxError;
		const tagged: Tagged<never> = { source: "a", kind: "error", error: err };
		expect(tagged.kind).toBe("error");
	});

	it("LSM-TYP-03 Tagged done variant has no value field", () => {
		const tagged: Tagged<string> = { source: "b", kind: "done" };
		expect(tagged.kind).toBe("done");
		expect("value" in tagged).toBe(false);
	});

	it("LSM-TYP-04 MuxError supports ALL_FAILED aggregate errors[]", () => {
		const inner = Object.assign(new Error("s1"), {
			code: "SOURCE_ERROR" as const,
			source: "0",
		}) as MuxError;
		const agg = Object.assign(new Error("all failed"), {
			code: "ALL_FAILED" as const,
			errors: [inner],
			cause: inner,
		}) as MuxError;
		expect(agg.errors).toHaveLength(1);
		expect(agg.cause).toBe(inner);
	});

	it("LSM-TYP-05 MuxErrorInit accepts minimal and full shapes", () => {
		const minimal: MuxErrorInit = { code: "ABORTED" };
		const full: MuxErrorInit = {
			code: "TIMEOUT",
			source: "primary",
			message: "deadline",
			cause: new Error("timeout"),
		};
		expect(minimal.code).toBe("ABORTED");
		expect(full.source).toBe("primary");
	});

	it("LSM-TYP-06 Sources accepts array, record, and labeled array", () => {
		const array: Sources<number> = [readableFrom([1])];
		const record: Sources<number> = { a: readableFrom([2]) };
		const labeled: Sources<number> = [{ id: "x", source: readableFrom([3]) }];
		expect(array).toHaveLength(1);
		expect(Object.keys(record)).toEqual(["a"]);
		expect(labeled[0]?.id).toBe("x");
	});

	it("LSM-TYP-07 Source lazy thunk defers invocation", () => {
		let invoked = false;
		const lazy: Source<number> = () => {
			invoked = true;
			return readableFrom([1]);
		};
		expect(invoked).toBe(false);
		const _stream = typeof lazy === "function" ? lazy() : lazy;
		expect(invoked).toBe(true);
		expect(_stream).toBeDefined();
	});

	it("LSM-TYP-08 CommonOptions hooks are optional predicates", () => {
		const opts: CommonOptions<{ type: string }, string> = {
			isError: (item) => item.type === "error",
			mapEach: (item, source) => `${source}:${item.type}`,
		};
		const clean: CommonOptions<{ type: string }> = {
			isError: (item) => item.type === "error",
		};
		expect(opts.isError?.({ type: "error" })).toBe(true);
		expect(opts.mapEach?.({ type: "ok" }, "s")).toBe("s:ok");
		expect(clean.isError?.({ type: "ok" })).toBe(false);
	});

	it("LSM-TYP-09 FallbackOptions default policy is commit at type level", () => {
		const opts: FallbackOptions<unknown> = {};
		expect(opts.policy).toBeUndefined();
		const explicit: FallbackOptions<unknown> = { policy: "buffered" };
		expect(explicit.policy).toBe("buffered");
	});

	it("LSM-TYP-10 MergeOptions order and failFast are optional", () => {
		const arrival: MergeOptions<number> = { order: "arrival", failFast: false };
		const rr: MergeOptions<number> = { order: "round-robin", concurrency: 2 };
		expect(arrival.order).toBe("arrival");
		expect(rr.concurrency).toBe(2);
	});

	it("LSM-TYP-11 TeeOptions backpressure literals match D5", () => {
		for (const mode of TEE_BACKPRESSURE) {
			const opts: TeeOptions = { backpressure: mode, bufferLimit: 8 };
			expect(opts.backpressure).toBe(mode);
		}
	});

	it("LSM-TYP-12 SourceEvent covers full telemetry union", () => {
		for (const type of SOURCE_EVENT_TYPES) {
			const event: SourceEvent = { source: "s", type, timestamp: Date.now() };
			expect(event.type).toBe(type);
		}
	});

	it("LSM-TYP-13 MuxResult perSource stats shape", () => {
		const result: MuxResult = {
			strategy: "merge",
			perSource: {
				gpt: { items: 3, started: true, completed: true, startedAt: 1, endedAt: 2 },
			},
			aborted: false,
			startedAt: 0,
			endedAt: 2,
		};
		expect(result.perSource.gpt?.items).toBe(3);
	});

	it("LSM-TYP-14 MuxCancelled reason union frozen for §7.5", () => {
		for (const reason of CANCEL_REASONS) {
			const payload: MuxCancelled = { name: "MuxCancelled", reason };
			expect(payload.name).toBe("MuxCancelled");
		}
	});

	it("LSM-TYP-15 policy enum literals are exhaustive at runtime lists", () => {
		expect(FAILOVER_POLICIES).toHaveLength(3);
		expect(MERGE_ORDERS).toHaveLength(2);
		expect(MUX_STRATEGIES).toHaveLength(4);
	});
});
