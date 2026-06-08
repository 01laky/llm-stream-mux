import { muxError } from "./errors.js";
import { createRaceIterable } from "./internal/race-engine.js";
import { isEmptySources, normalizeSources } from "./internal/source.js";
import { validateRaceOptions } from "./internal/validate-options.js";
import type { RaceOptions, Sources } from "./types.js";

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
