import { muxError } from "./errors.js";
import { createRaceIterable } from "./internal/race-engine.js";
import { normalizeSources } from "./internal/source.js";
import { validateRaceOptions } from "./internal/validate-options.js";
import type { RaceOptions, Sources } from "./types.js";

function isEmptySources(sources: Sources<unknown>): boolean {
	if (Array.isArray(sources)) return sources.length === 0;
	return Object.keys(sources).length === 0;
}

export function race<T, U = T>(sources: Sources<T>, opts?: RaceOptions<T, U>): AsyncIterable<U> {
	validateRaceOptions(opts as RaceOptions<unknown, unknown> | undefined);
	if (isEmptySources(sources)) {
		throw muxError({ code: "NO_USABLE_SOURCE" });
	}

	const readers = normalizeSources(sources);
	if (readers.length === 0) {
		throw muxError({ code: "NO_USABLE_SOURCE" });
	}

	return createRaceIterable(readers, opts);
}
