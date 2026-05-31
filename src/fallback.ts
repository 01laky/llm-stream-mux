import { muxError } from "./errors.js";
import { createFallbackIterable } from "./internal/fallback-engine.js";
import { normalizeSources } from "./internal/source.js";
import type { FallbackOptions, Sources } from "./types.js";

function isEmptySources(sources: Sources<unknown>): boolean {
	if (Array.isArray(sources)) return sources.length === 0;
	return Object.keys(sources).length === 0;
}

export function fallback<T, U = T>(
	sources: Sources<T>,
	opts?: FallbackOptions<T, U>,
): AsyncIterable<U> {
	if (isEmptySources(sources)) {
		throw muxError({ code: "ALL_FAILED", errors: [] });
	}

	const readers = normalizeSources(sources);
	if (readers.length === 0) {
		throw muxError({ code: "ALL_FAILED", errors: [] });
	}

	return createFallbackIterable(readers, opts);
}
