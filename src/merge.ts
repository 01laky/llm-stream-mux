import { createMergeIterable, validateMergeOptions } from "./internal/merge-engine.js";
import { normalizeSources } from "./internal/source.js";
import type { MergeOptions, Sources, Tagged } from "./types.js";

export function merge<T, U = T>(
	sources: Sources<T>,
	opts?: MergeOptions<T, U>,
): AsyncIterable<Tagged<U>> {
	validateMergeOptions(opts as MergeOptions<unknown, unknown> | undefined);
	const readers = normalizeSources(sources);
	return createMergeIterable(readers, opts);
}

export const ensemble = merge;
