import { muxError } from "../errors.js";
import type { MuxError, MuxResult, MuxSourceStats, MuxStrategy, SourceEvent } from "../types.js";

export interface Telemetry {
	ensureSource(id: string): MuxSourceStats;
	emit(event: Omit<SourceEvent, "timestamp"> & { timestamp?: number }): void;
	incrementItems(id: string): void;
	markStarted(id: string): void;
	markCompleted(id: string): void;
	markErrored(id: string, error?: MuxError): void;
	setWinner(id?: string): void;
	setAborted(aborted: boolean): void;
	finish(): MuxResult;
}

/**
 * Build telemetry from a strategy options bag, forwarding only the hooks that
 * are actually set — `exactOptionalPropertyTypes` forbids passing `undefined`
 * through directly, so each engine used to inline this conditional copy.
 */
export function createTelemetryFromOpts(
	strategy: MuxStrategy,
	opts: {
		onSourceEvent?: (e: SourceEvent) => void;
		onFinish?: (result: MuxResult) => void;
	},
): Telemetry {
	const hooks: {
		onSourceEvent?: (e: SourceEvent) => void;
		onFinish?: (result: MuxResult) => void;
	} = {};
	if (opts.onSourceEvent !== undefined) hooks.onSourceEvent = opts.onSourceEvent;
	if (opts.onFinish !== undefined) hooks.onFinish = opts.onFinish;
	return createTelemetry(strategy, hooks);
}

export function createTelemetry(
	strategy: MuxStrategy,
	opts: {
		onSourceEvent?: (e: SourceEvent) => void;
		onFinish?: (result: MuxResult) => void;
	} = {},
): Telemetry {
	const startedAt = Date.now();
	let endedAt = startedAt;
	let winner: string | undefined;
	let aborted = false;
	const perSource: Record<string, MuxSourceStats> = {};

	const ensureSource = (id: string): MuxSourceStats => {
		if (!perSource[id]) {
			perSource[id] = { items: 0, started: false, completed: false };
		}
		return perSource[id];
	};

	return {
		ensureSource,
		emit(event) {
			const full: SourceEvent = {
				...event,
				timestamp: event.timestamp ?? Date.now(),
			};
			opts.onSourceEvent?.(full);
		},
		incrementItems(id) {
			ensureSource(id).items += 1;
		},
		markStarted(id) {
			const stats = ensureSource(id);
			if (!stats.started) {
				stats.started = true;
				stats.startedAt = Date.now();
			}
		},
		markCompleted(id) {
			const stats = ensureSource(id);
			stats.completed = true;
			stats.endedAt = Date.now();
		},
		markErrored(id, error) {
			const stats = ensureSource(id);
			stats.errored = error ?? muxError({ code: "SOURCE_ERROR", source: id });
			stats.endedAt = Date.now();
		},
		setWinner(id) {
			winner = id;
		},
		setAborted(value) {
			aborted = value;
		},
		finish() {
			endedAt = Date.now();
			const startedPerSource: Record<string, MuxSourceStats> = {};
			for (const [id, stats] of Object.entries(perSource)) {
				if (stats.started || stats.items > 0 || stats.completed || stats.errored !== undefined) {
					startedPerSource[id] = stats;
				}
			}
			const result: MuxResult = {
				strategy,
				perSource: startedPerSource,
				aborted,
				startedAt,
				endedAt,
			};
			if (winner !== undefined) result.winner = winner;
			opts.onFinish?.(result);
			return result;
		},
	};
}
