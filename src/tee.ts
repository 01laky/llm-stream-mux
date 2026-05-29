import type { Source, TeeBackpressure, TeeOptions } from "./types.js";
import { createTeeFanout } from "./internal/tee-fanout.js";

function validateTeeArgs(n: number, backpressure: TeeBackpressure, bufferLimit?: number): void {
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`tee: n must be an integer >= 1, got ${String(n)}`);
	}
	if (
		(backpressure === "bounded" || backpressure === "drop") &&
		(bufferLimit === undefined || !Number.isFinite(bufferLimit) || bufferLimit < 1)
	) {
		throw new Error(
			`tee: bufferLimit must be a finite number >= 1 when backpressure is "${backpressure}"`,
		);
	}
}

export function tee<T>(source: Source<T>, n: number, opts?: TeeOptions): ReadableStream<T>[] {
	const backpressure = opts?.backpressure ?? "block";
	validateTeeArgs(n, backpressure, opts?.bufferLimit);
	return createTeeFanout(source, n, backpressure, opts?.bufferLimit);
}
