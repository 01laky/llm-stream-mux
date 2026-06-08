import type { CommonOptions, MergeOptions } from "../types.js";

export function assertAbortSignalTimeoutAvailable(): void {
	if (typeof AbortSignal.timeout !== "function") {
		throw new RangeError(
			"timeoutMs requires AbortSignal.timeout (Node 22+, Deno, Bun, or Workers)",
		);
	}
}

function positiveInt(strategy: string, name: string, value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`${strategy}: ${name} must be a positive integer, got ${String(value)}`);
	}
}

export function validateCommonOptions(
	strategy: string,
	opts?: Pick<
		CommonOptions<unknown, unknown>,
		"timeoutMs" | "overallTimeoutMs" | "highWaterMark" | "sourceHighWaterMark"
	>,
): void {
	if (!opts) return;
	positiveInt(strategy, "timeoutMs", opts.timeoutMs);
	positiveInt(strategy, "overallTimeoutMs", opts.overallTimeoutMs);
	positiveInt(strategy, "highWaterMark", opts.highWaterMark);
	positiveInt(strategy, "sourceHighWaterMark", opts.sourceHighWaterMark);
	if (opts.timeoutMs !== undefined || opts.overallTimeoutMs !== undefined) {
		assertAbortSignalTimeoutAvailable();
	}
}

export function validateRaceOptions(opts?: CommonOptions<unknown, unknown>): void {
	validateCommonOptions("race", opts);
}

export function validateFallbackOptions(opts?: CommonOptions<unknown, unknown>): void {
	validateCommonOptions("fallback", opts);
}

export function validateMergeOptions(opts?: MergeOptions<unknown, unknown>): void {
	validateCommonOptions("merge", opts);
	if (opts?.concurrency === undefined) return;
	const c = opts.concurrency;
	if (!Number.isInteger(c) || c < 1) {
		throw new RangeError(`merge: concurrency must be a positive integer, got ${String(c)}`);
	}
}
