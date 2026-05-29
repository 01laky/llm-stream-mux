import type {
	MuxError,
	MuxErrorCode,
	MuxResult,
	MuxSourceStats,
	MuxStrategy,
	Source,
	SourceEvent,
	SourceEventType,
	Tagged,
} from "../../src/types.js";

export function muxError(code: MuxErrorCode, init: Partial<MuxError> = {}): MuxError {
	return Object.assign(new Error(init.message ?? code), { code, ...init });
}

export function taggedValue<T>(source: string, value: T): Tagged<T> {
	return { source, kind: "value", value };
}

export function taggedError<T>(source: string, error: MuxError): Tagged<T> {
	return { source, kind: "error", error };
}

export function taggedDone<T>(source: string): Tagged<T> {
	return { source, kind: "done" };
}

export function sourceEvent(type: SourceEventType, source = "s", error?: MuxError): SourceEvent {
	const event: SourceEvent = { source, type, timestamp: 0 };
	if (error) return { ...event, error };
	return event;
}

export async function* asyncItems<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}

export function readableFrom<T>(items: T[]): ReadableStream<T> {
	return ReadableStream.from(items);
}

export function lazySource<T>(factory: () => Source<T>): Source<T> {
	return factory;
}

export function muxResult(strategy: MuxStrategy, init: Partial<MuxResult> = {}): MuxResult {
	return {
		strategy,
		perSource: {},
		aborted: false,
		startedAt: 0,
		endedAt: 0,
		...init,
	};
}

export function sourceStats(init: Partial<MuxSourceStats> = {}): MuxSourceStats {
	return {
		items: 0,
		started: false,
		completed: false,
		...init,
	};
}
