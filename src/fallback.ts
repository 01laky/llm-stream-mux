import { muxError } from "./errors.js";
import { createFallbackIterable } from "./internal/fallback-engine.js";
import { isEmptySources, normalizeSources } from "./internal/source.js";
import { validateFallbackOptions } from "./internal/validate-options.js";
import type { FallbackOptions, Sources } from "./types.js";

export function fallback<T, U = T>(
	sources: Sources<T>,
	opts?: FallbackOptions<T, U>,
): AsyncIterable<U> {
	validateFallbackOptions(opts as FallbackOptions<unknown, unknown> | undefined);
	if (isEmptySources(sources)) {
		throw muxError({ code: "ALL_FAILED", errors: [] });
	}

	const readers = normalizeSources(sources);
	if (readers.length === 0) {
		throw muxError({ code: "ALL_FAILED", errors: [] });
	}

	return createFallbackIterable(readers, opts);
}
