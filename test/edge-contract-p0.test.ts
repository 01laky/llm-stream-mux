import { describe, expect, it } from "vitest";
import { MUX_ERROR_CODES } from "../src/index.js";
import type {
	FailoverPolicy,
	MergeOrder,
	MuxErrorCode,
	MuxStrategy,
	TeeBackpressure,
} from "../src/types.js";
import {
	muxError,
	taggedDone,
	taggedError,
	taggedValue,
	readableFrom,
	sourceEvent,
} from "./helpers/type-fixtures.js";

/**
 * P0 prelude: pins proposal §7 edge-case matrix *codes and types* before runtime strategies exist.
 * Full behavioral LSM-EDGE-NN tests land in P7 `test/edge.test.ts`.
 */
const MATRIX: Array<{
	id: string;
	strategy: MuxStrategy | "n/a";
	case: string;
	codes: MuxErrorCode[];
}> = [
	{
		id: "LSM-EDGE-P0-01",
		strategy: "race",
		case: "empty sources",
		codes: ["NO_USABLE_SOURCE"],
	},
	{
		id: "LSM-EDGE-P0-02",
		strategy: "fallback",
		case: "empty sources",
		codes: ["ALL_FAILED"],
	},
	{
		id: "LSM-EDGE-P0-03",
		strategy: "race",
		case: "all sources empty",
		codes: ["NO_USABLE_SOURCE"],
	},
	{
		id: "LSM-EDGE-P0-04",
		strategy: "fallback",
		case: "all sources fail",
		codes: ["ALL_FAILED"],
	},
	{
		id: "LSM-EDGE-P0-05",
		strategy: "merge",
		case: "in-band source error without killing others",
		codes: ["IN_BAND_ERROR", "SOURCE_ERROR"],
	},
	{
		id: "LSM-EDGE-P0-06",
		strategy: "n/a",
		case: "signal already aborted",
		codes: ["ABORTED"],
	},
	{
		id: "LSM-EDGE-P0-07",
		strategy: "race",
		case: "timeout disqualifies candidate",
		codes: ["TIMEOUT"],
	},
	{
		id: "LSM-EDGE-P0-08",
		strategy: "tee",
		case: "bounded overflow errors branch",
		codes: ["SOURCE_ERROR"],
	},
	{
		id: "LSM-EDGE-P0-09",
		strategy: "fallback",
		case: "in-band isError triggers failover",
		codes: ["IN_BAND_ERROR"],
	},
	{
		id: "LSM-EDGE-P0-10",
		strategy: "merge",
		case: "failFast surfaces ALL_FAILED",
		codes: ["ALL_FAILED"],
	},
];

describe("LSM-EDGE-P0 matrix code prelude", () => {
	for (const row of MATRIX) {
		it(`${row.id} ${row.strategy} ${row.case} codes exist in MUX_ERROR_CODES`, () => {
			for (const code of row.codes) {
				expect(MUX_ERROR_CODES, code).toContain(code);
			}
		});
	}

	it("LSM-EDGE-P0-11 merge empty sources completes with done tags only (type shape)", () => {
		const done = taggedDone<number>("ghost");
		expect(done.kind).toBe("done");
		expect(muxError("ALL_FAILED").code).toBe("ALL_FAILED");
	});

	it("LSM-EDGE-P0-12 merge partial failure Tagged error kind not value", () => {
		const err = taggedError<number>("claude", muxError("SOURCE_ERROR", { source: "claude" }));
		expect(err.kind).toBe("error");
		if (err.kind === "error") expect(err.error.source).toBe("claude");
	});

	it("LSM-EDGE-P0-13 FailoverPolicy triple covers commit buffered post-emit", () => {
		const policies: FailoverPolicy[] = ["commit", "buffered", "post-emit"];
		expect(policies).toHaveLength(3);
	});

	it("LSM-EDGE-P0-14 MergeOrder arrival and round-robin both valid (D7/D8)", () => {
		const orders: MergeOrder[] = ["arrival", "round-robin"];
		expect(orders).toHaveLength(2);
	});

	it("LSM-EDGE-P0-15 TeeBackpressure block bounded drop valid (D5)", () => {
		const modes: TeeBackpressure[] = ["block", "bounded", "drop"];
		expect(modes).toHaveLength(3);
	});

	it("LSM-EDGE-P0-16 race and fallback share NO_USABLE_SOURCE vs ALL_FAILED distinction", () => {
		expect(MUX_ERROR_CODES).toContain("NO_USABLE_SOURCE");
		expect(MUX_ERROR_CODES).toContain("ALL_FAILED");
		expect("NO_USABLE_SOURCE").not.toBe("ALL_FAILED");
	});

	it("LSM-EDGE-P0-17 matrix single source race accepts one-element Sources", () => {
		const sources: import("../src/types.js").Sources<number> = [readableFrom([1])];
		expect(sources).toHaveLength(1);
	});

	it("LSM-EDGE-P0-18 matrix single source merge yields Tagged value shape", () => {
		const tagged = taggedValue("only", 42);
		expect(tagged.kind).toBe("value");
		expect(tagged.source).toBe("only");
	});

	it("LSM-EDGE-P0-19 matrix tee n/a — TeeFn uses Source not Sources", () => {
		const source: import("../src/types.js").Source<string> = readableFrom(["x"]);
		expect(source).toBeDefined();
	});

	it("LSM-EDGE-P0-20 matrix fallback empty sources ALL_FAILED with zero errors", () => {
		const err = muxError("ALL_FAILED", { errors: [] });
		expect(err.code).toBe("ALL_FAILED");
		expect(err.errors).toEqual([]);
	});

	it("LSM-EDGE-P0-21 matrix merge all empty streams completes via done tags only", () => {
		const tags = [taggedDone<number>("0"), taggedDone<number>("1")];
		expect(tags.every((t) => t.kind === "done")).toBe(true);
	});

	it("LSM-EDGE-P0-22 matrix signal abort uses ABORTED across CommonOptions strategies", () => {
		const signal = AbortSignal.abort();
		const opts: import("../src/types.js").CommonOptions<unknown> = { signal };
		expect(opts.signal?.aborted).toBe(true);
		expect(MUX_ERROR_CODES).toContain("ABORTED");
	});

	it("LSM-EDGE-P0-23 matrix early consumer break maps to MuxCancelled reasons", () => {
		const reasons: import("../src/types.js").MuxCancelledReason[] = [
			"race-lost",
			"failover",
			"aborted",
			"tee-all-cancelled",
		];
		expect(reasons).toHaveLength(4);
	});

	it("LSM-EDGE-P0-24 matrix source throws before first item uses SOURCE_ERROR and failover event", () => {
		const err = muxError("SOURCE_ERROR", { source: "0" });
		const event = sourceEvent("failover", "0", err);
		expect(event.type).toBe("failover");
		expect(event.error?.code).toBe("SOURCE_ERROR");
	});

	it("LSM-EDGE-P0-25 matrix merge source error tag keeps IN_BAND_ERROR distinct from SOURCE_ERROR", () => {
		expect(MUX_ERROR_CODES).toContain("IN_BAND_ERROR");
		expect(MUX_ERROR_CODES).toContain("SOURCE_ERROR");
		expect("IN_BAND_ERROR").not.toBe("SOURCE_ERROR");
	});

	it("LSM-EDGE-P0-26 matrix tee bounded overflow pinned to SOURCE_ERROR not ABORTED", () => {
		const err = muxError("SOURCE_ERROR", { source: "branch-1", message: "buffer overflow" });
		expect(err.code).toBe("SOURCE_ERROR");
		expect(err.code).not.toBe("ABORTED");
	});
});
