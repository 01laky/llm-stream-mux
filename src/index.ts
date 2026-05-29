export type {
	Source,
	Sources,
	Tagged,
	MuxError,
	MuxErrorCode,
	MuxErrorInit,
	CreateMuxError,
	SourceEvent,
	SourceEventType,
	MuxResult,
	MuxSourceStats,
	MuxStrategy,
	FailoverPolicy,
	TeeBackpressure,
	MergeOrder,
	CommonOptions,
	RaceOptions,
	FallbackOptions,
	MergeOptions,
	TeeOptions,
	RaceFn,
	FallbackFn,
	MergeFn,
	TeeFn,
	CollectFn,
	ToReadableFn,
	ToAsyncIterableFn,
	MuxCancelled,
	MuxCancelledReason,
} from "./types.js";

export { MUX_ERROR_CODES } from "./types.js";
export { collect, toReadable, toAsyncIterable } from "./internal/interop.js";

/** Synced with package.json version — updated at release boundaries. */
export const MUX_PKG_VERSION = "0.1.0" as const;
