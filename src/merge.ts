import { createMergeIterable } from "./internal/merge-engine.js";
import { normalizeSources, type NormalizeSourceOptions } from "./internal/source.js";
import { validateMergeOptions } from "./internal/validate-options.js";
import type { MergeOptions, Sources, Tagged } from "./types.js";

export function merge<T, U = T>(
	sources: Sources<T>,
	opts?: MergeOptions<T, U>,
): AsyncIterable<Tagged<U>> {
	validateMergeOptions(opts as MergeOptions<unknown, unknown> | undefined);
	const normalizeOpts: NormalizeSourceOptions = {};
	if (opts?.sourceHighWaterMark !== undefined) {
		normalizeOpts.sourceHighWaterMark = opts.sourceHighWaterMark;
	}
	const readers = normalizeSources(sources, normalizeOpts);
	return createMergeIterable(readers, opts);
}

export const ensemble = merge;
