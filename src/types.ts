/** Public types for llm-stream-mux — proposal §6 + §9. */

export type Source<T> =
	| ReadableStream<T>
	| AsyncIterable<T>
	| (() => ReadableStream<T> | AsyncIterable<T>);

export type Sources<T> =
	| Source<T>[]
	| Record<string, Source<T>>
	| Array<{ id: string; source: Source<T> }>;

export type Tagged<T> =
	| { source: string; kind: "value"; value: T }
	| { source: string; kind: "error"; error: MuxError }
	| { source: string; kind: "done" };

export type MuxErrorCode =
	| "SOURCE_ERROR"
	| "IN_BAND_ERROR"
	| "ALL_FAILED"
	| "ABORTED"
	| "TIMEOUT"
	| "NO_USABLE_SOURCE";

export const MUX_ERROR_CODES = Object.freeze([
	"SOURCE_ERROR",
	"IN_BAND_ERROR",
	"ALL_FAILED",
	"ABORTED",
	"TIMEOUT",
	"NO_USABLE_SOURCE",
] as const satisfies readonly MuxErrorCode[]);

export interface MuxError extends Error {
	code: MuxErrorCode;
	source?: string;
	cause?: unknown;
	errors?: MuxError[];
}

export interface MuxErrorInit {
	code: MuxErrorCode;
	source?: string;
	cause?: unknown;
	errors?: MuxError[];
	message?: string;
}

export type CreateMuxError = (init: MuxErrorInit) => MuxError;

export type SourceEventType =
	| "start"
	| "usable"
	| "final"
	| "done"
	| "error"
	| "failover"
	| "cancelled"
	| "timeout";

export interface SourceEvent {
	source: string;
	type: SourceEventType;
	timestamp: number;
	error?: MuxError;
}

export type MuxStrategy = "race" | "fallback" | "merge" | "tee";

export interface MuxSourceStats {
	items: number;
	started: boolean;
	completed: boolean;
	errored?: MuxError;
	startedAt?: number;
	endedAt?: number;
}

export interface MuxResult {
	strategy: MuxStrategy;
	winner?: string;
	perSource: Record<string, MuxSourceStats>;
	aborted: boolean;
	startedAt: number;
	endedAt: number;
}

export type FailoverPolicy = "commit" | "buffered" | "post-emit";
export type TeeBackpressure = "block" | "bounded" | "drop";
export type MergeOrder = "arrival" | "round-robin";

export interface CommonOptions<T, U = T> {
	signal?: AbortSignal;
	isError?: (item: T) => boolean;
	isFinal?: (item: T) => boolean;
	mapEach?: (item: T, source: string) => U;
	onSourceEvent?: (e: SourceEvent) => void;
	onFinish?: (result: MuxResult) => void;
	timeoutMs?: number;
	overallTimeoutMs?: number;
	highWaterMark?: number;
	sourceHighWaterMark?: number;
}

export interface RaceOptions<T, U = T> extends CommonOptions<T, U> {
	isUsable?: (item: T) => boolean;
}

export interface FallbackOptions<T, U = T> extends CommonOptions<T, U> {
	policy?: FailoverPolicy;
	isUsable?: (item: T) => boolean;
}

export interface MergeOptions<T, U = T> extends CommonOptions<T, U> {
	failFast?: boolean;
	order?: MergeOrder;
	concurrency?: number;
}

export interface TeeOptions {
	backpressure?: TeeBackpressure;
	bufferLimit?: number;
}

export type RaceFn = <T, U = T>(sources: Sources<T>, opts?: RaceOptions<T, U>) => AsyncIterable<U>;

export type FallbackFn = <T, U = T>(
	sources: Sources<T>,
	opts?: FallbackOptions<T, U>,
) => AsyncIterable<U>;

export type MergeFn = <T, U = T>(
	sources: Sources<T>,
	opts?: MergeOptions<T, U>,
) => AsyncIterable<Tagged<U>>;

export type TeeFn = <T>(source: Source<T>, n: number, opts?: TeeOptions) => ReadableStream<T>[];

export type CollectFn = <T>(it: AsyncIterable<T>) => Promise<T[]>;

export type ToReadableFn = <T>(it: AsyncIterable<T>) => ReadableStream<T>;

export type ToAsyncIterableFn = <T>(rs: ReadableStream<T>) => AsyncIterable<T>;

export type MuxCancelledReason = "race-lost" | "failover" | "aborted" | "tee-all-cancelled";

export interface MuxCancelled {
	name: "MuxCancelled";
	reason: MuxCancelledReason;
}
