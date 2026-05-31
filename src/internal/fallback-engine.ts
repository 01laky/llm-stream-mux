import { muxError } from "../errors.js";
import { muxCancelledReason } from "./abort.js";
import { createOutputQueue } from "./queue.js";
import type { NormalizedReader, SourceReadResult } from "./source.js";
import { createTelemetry } from "./telemetry.js";
import { createTtfUsableTimer, timeoutMuxError, wireOverallTimeout } from "./timeouts.js";
import type {
	FailoverPolicy,
	FallbackOptions,
	MuxCancelled,
	MuxError,
	MuxResult,
	SourceEvent,
} from "../types.js";

function swallowCancel(promise: Promise<unknown>): void {
	void promise.catch(() => {
		/* §7.5 */
	});
}

function wireAbortSignal(signal: AbortSignal | undefined, opCtrl: AbortController): void {
	if (!signal) return;
	if (signal.aborted) {
		opCtrl.abort(signal.reason);
		return;
	}
	signal.addEventListener(
		"abort",
		() => {
			opCtrl.abort(signal.reason);
		},
		{ once: true },
	);
}

export function createFallbackIterable<T, U = T>(
	readers: NormalizedReader<T>[],
	opts: FallbackOptions<T, U> = {},
): AsyncIterable<U> {
	const policy: FailoverPolicy = opts.policy ?? "commit";
	const isUsable = opts.isUsable ?? (() => true);
	const isError = opts.isError ?? (() => false);
	const isFinal = opts.isFinal ?? (() => false);
	const mapEach = opts.mapEach ?? ((item: T) => item as unknown as U);
	const timeoutMs = opts.timeoutMs;
	const overallTimeoutMs = opts.overallTimeoutMs;
	const outputHighWaterMark = opts.highWaterMark ?? 1;

	let iterableActive = false;

	return {
		[Symbol.asyncIterator]() {
			if (iterableActive) {
				throw new Error("fallback: iterator already active");
			}
			iterableActive = true;

			const telemetryHooks: {
				onSourceEvent?: (e: SourceEvent) => void;
				onFinish?: (result: MuxResult) => void;
			} = {};
			if (opts.onSourceEvent !== undefined) telemetryHooks.onSourceEvent = opts.onSourceEvent;
			if (opts.onFinish !== undefined) telemetryHooks.onFinish = opts.onFinish;
			const telemetry = createTelemetry("fallback", telemetryHooks);
			const opCtrl = new AbortController();
			wireAbortSignal(opts.signal, opCtrl);

			let activeIndex = 0;
			let started = false;
			let finished = false;
			let coordinatorDone = false;
			let committed = false;
			let internalBuffer: T[] = [];
			const failedErrors: MuxError[] = [];
			const cancelled = new Set<string>();
			let winnerId: string | undefined;
			let disarmOverall: (() => void) | undefined;
			let attemptTimerDisarm: (() => void) | undefined;

			const outputQueue = createOutputQueue<U>(outputHighWaterMark);
			const queueFailed = () => outputQueue.error !== null;

			const readerAt = (index: number): NormalizedReader<T> => readers[index]!;

			const activeId = (): string => readerAt(activeIndex).id;

			const finishOnce = () => {
				if (finished) return;
				finished = true;
				disarmAttemptTimeout();
				disarmOverall?.();
				telemetry.finish();
			};

			const failConsumer = (err: unknown) => {
				outputQueue.fail(err);
			};

			const waitQueueSpace = (): Promise<void> => outputQueue.waitForSpace();

			const mapAndEnqueue = async (item: T, sourceId: string): Promise<boolean> => {
				await waitQueueSpace();
				if (queueFailed() || opCtrl.signal.aborted) return false;
				try {
					const mapped = mapEach(item, sourceId);
					telemetry.incrementItems(sourceId);
					outputQueue.push(mapped);
					return true;
				} catch (cause) {
					const err = muxError({ code: "SOURCE_ERROR", source: sourceId, cause });
					if (!committed && activeIndex + 1 < readers.length && policy === "commit") {
						await failActiveSource(err, false);
						return false;
					}
					failConsumer(err);
					return false;
				}
			};

			const disarmAttemptTimeout = () => {
				if (attemptTimerDisarm) {
					attemptTimerDisarm();
					attemptTimerDisarm = undefined;
				}
			};

			const armAttemptTimeout = (id: string) => {
				disarmAttemptTimeout();
				if (timeoutMs === undefined) return;
				attemptTimerDisarm = createTtfUsableTimer(timeoutMs, opCtrl, () => {
					if (!opCtrl.signal.aborted && !committed && !cancelled.has(id)) {
						void handleAttemptTimeout(id);
					}
				});
			};

			const handleAttemptTimeout = async (id: string) => {
				if (finished || queueFailed() || cancelled.has(id) || committed) return;
				const err = muxError({ code: "TIMEOUT", source: id });
				telemetry.emit({ source: id, type: "timeout", error: err });
				await failActiveSource(err, false);
			};

			const cancelSource = async (reader: NormalizedReader<T>, reason: MuxCancelled) => {
				if (cancelled.has(reader.id)) return;
				cancelled.add(reader.id);
				telemetry.emit({ source: reader.id, type: "cancelled" });
				swallowCancel(reader.cancel(reason));
			};

			const abortAll = async (reason: MuxCancelled, cause?: unknown) => {
				if (reason.reason === "aborted") telemetry.setAborted(true);
				disarmAttemptTimeout();
				disarmOverall?.();
				await Promise.all(
					readers
						.filter((r) => !cancelled.has(r.id) && telemetry.ensureSource(r.id).started)
						.map((r) => cancelSource(r, reason)),
				);
				failConsumer(muxError({ code: "ABORTED", cause: cause ?? opCtrl.signal.reason }));
				finishOnce();
				coordinatorDone = true;
			};

			const handleOverallTimeout = async () => {
				if (finished) return;
				telemetry.setAborted(true);
				const id = activeId();
				if (telemetry.ensureSource(id).started) {
					telemetry.emit({
						source: id,
						type: "timeout",
						error: timeoutMuxError(id),
					});
				}
				await abortAll(muxCancelledReason("aborted"), muxError({ code: "TIMEOUT" }));
			};

			const recordFailure = (err: MuxError) => {
				failedErrors.push(err);
			};

			const failActiveSource = async (err: MuxError, _postCommitFailover: boolean) => {
				const id = activeId();
				disarmAttemptTimeout();
				recordFailure(err);
				telemetry.markErrored(id, err);
				telemetry.emit({ source: id, type: "error", error: err });
				await cancelSource(readerAt(activeIndex), muxCancelledReason("failover"));
				internalBuffer = [];
				committed = false;
				if (activeIndex + 1 < readers.length && policy === "commit") {
					telemetry.emit({ source: id, type: "failover" });
				}
				await tryFailover();
			};

			const tryFailover = async () => {
				activeIndex += 1;
				if (activeIndex >= readers.length) {
					const agg = muxError({
						code: "ALL_FAILED",
						errors: failedErrors,
						cause: failedErrors[0],
					});
					failConsumer(agg);
					finishOnce();
					coordinatorDone = true;
					return;
				}
				await activateAndPump();
			};

			const flushInternalBuffer = async (
				sourceId: string,
				emitUsable: boolean,
			): Promise<boolean> => {
				if (emitUsable) {
					telemetry.emit({ source: sourceId, type: "usable" });
				}
				for (const item of internalBuffer) {
					if (!(await mapAndEnqueue(item, sourceId))) return false;
				}
				internalBuffer = [];
				return true;
			};

			const reachCommit = async (triggerItem: T, fromFinal: boolean): Promise<boolean> => {
				const id = activeId();
				disarmAttemptTimeout();

				if (policy === "buffered") {
					committed = true;
					telemetry.setWinner(id);
					winnerId = id;
					internalBuffer.push(triggerItem);
					return true;
				}

				internalBuffer.push(triggerItem);

				if (!(await flushInternalBuffer(id, true))) return false;

				committed = true;
				telemetry.setWinner(id);
				winnerId = id;

				if (fromFinal) {
					telemetry.markCompleted(id);
					telemetry.emit({ source: id, type: "done" });
					outputQueue.close();
					finishOnce();
					coordinatorDone = true;
				}
				return true;
			};

			const completeBufferedSource = async (): Promise<boolean> => {
				const id = activeId();
				committed = true;
				disarmAttemptTimeout();
				if (!(await flushInternalBuffer(id, true))) return false;
				telemetry.markCompleted(id);
				telemetry.emit({ source: id, type: "done" });
				telemetry.setWinner(id);
				winnerId = id;
				outputQueue.close();
				finishOnce();
				coordinatorDone = true;
				return true;
			};

			const handlePostCommitError = async (err: MuxError) => {
				const id = activeId();
				disarmAttemptTimeout();
				recordFailure(err);
				telemetry.markErrored(id, err);
				telemetry.emit({ source: id, type: "error", error: err });
				await cancelSource(readerAt(activeIndex), muxCancelledReason("failover"));
				internalBuffer = [];
				committed = false;

				if (policy === "commit") {
					failConsumer(err);
					finishOnce();
					coordinatorDone = true;
					return;
				}
				if (policy === "post-emit") {
					telemetry.emit({ source: id, type: "failover" });
					await tryFailover();
					return;
				}
				await tryFailover();
			};

			const processItem = async (item: T): Promise<"continue" | "done"> => {
				const id = activeId();

				if (isError(item)) {
					const err = muxError({ code: "IN_BAND_ERROR", source: id });
					if (committed) {
						await handlePostCommitError(err);
					} else {
						await failActiveSource(err, false);
					}
					return "done";
				}

				const final = isFinal(item);
				const usable = isUsable(item);

				if (final) {
					telemetry.emit({ source: id, type: "final" });
					if (policy === "buffered") {
						internalBuffer.push(item);
						await completeBufferedSource();
						return "done";
					}
					if (!committed) {
						await reachCommit(item, true);
						return "done";
					}
					if (!(await mapAndEnqueue(item, id))) return "done";
					telemetry.markCompleted(id);
					telemetry.emit({ source: id, type: "done" });
					outputQueue.close();
					finishOnce();
					coordinatorDone = true;
					return "done";
				}

				if (policy === "buffered") {
					internalBuffer.push(item);
					return "continue";
				}

				if (!committed) {
					if (usable) {
						if (!(await reachCommit(item, false))) return "done";
						if (coordinatorDone) return "done";
						return "continue";
					}
					internalBuffer.push(item);
					return "continue";
				}

				if (!(await mapAndEnqueue(item, id))) return "done";
				return "continue";
			};

			const processResult = async (result: SourceReadResult<T>): Promise<"continue" | "done"> => {
				const id = activeId();

				if (result.ok) {
					return processItem(result.value);
				}

				if ("error" in result && result.error !== undefined) {
					const err = muxError({
						code: "SOURCE_ERROR",
						source: id,
						cause: result.error,
					});
					if (committed) {
						await handlePostCommitError(err);
					} else {
						await failActiveSource(err, false);
					}
					return "done";
				}

				// natural done
				if (policy === "buffered" && internalBuffer.length > 0) {
					if (opts.isUsable !== undefined) {
						const hasUsable = internalBuffer.some((item) => isUsable(item));
						if (!hasUsable) {
							await failActiveSource(
								muxError({ code: "SOURCE_ERROR", source: id, message: "no usable item" }),
								false,
							);
							return "done";
						}
					}
					await completeBufferedSource();
					return "done";
				}

				if (!committed) {
					await failActiveSource(
						muxError({ code: "SOURCE_ERROR", source: id, message: "empty without commit" }),
						false,
					);
					return "done";
				}

				telemetry.markCompleted(id);
				telemetry.emit({ source: id, type: "done" });
				if (winnerId === undefined) {
					telemetry.setWinner(id);
					winnerId = id;
				}
				outputQueue.close();
				finishOnce();
				coordinatorDone = true;
				return "done";
			};

			const pumpActive = async (): Promise<void> => {
				const reader = readerAt(activeIndex);
				const id = reader.id;

				while (!opCtrl.signal.aborted && !queueFailed() && !outputQueue.closed) {
					await waitQueueSpace();
					if (opCtrl.signal.aborted || queueFailed() || outputQueue.closed) break;

					const result = await reader.next();
					if (cancelled.has(id)) return;

					const status = await processResult(result);
					if (status === "done" || queueFailed() || outputQueue.closed) return;
				}

				if (opCtrl.signal.aborted) {
					await abortAll(muxCancelledReason("aborted"));
				}
			};

			const activateAndPump = async (): Promise<void> => {
				const reader = readerAt(activeIndex);
				committed = false;
				internalBuffer = [];
				telemetry.markStarted(reader.id);
				telemetry.emit({ source: reader.id, type: "start" });
				armAttemptTimeout(reader.id);
				await pumpActive();
			};

			const runFallback = async () => {
				if (opCtrl.signal.aborted) {
					telemetry.setAborted(true);
					failConsumer(muxError({ code: "ABORTED", cause: opCtrl.signal.reason }));
					finishOnce();
					coordinatorDone = true;
					return;
				}

				if (overallTimeoutMs !== undefined) {
					disarmOverall = wireOverallTimeout(overallTimeoutMs, opCtrl, () => {
						void handleOverallTimeout();
					});
				}

				opCtrl.signal.addEventListener(
					"abort",
					() => {
						void abortAll(muxCancelledReason("aborted"));
					},
					{ once: true },
				);

				await activateAndPump();
			};

			const ensureStarted = () => {
				if (started) return;
				started = true;
				void runFallback().finally(() => {
					coordinatorDone = true;
				});
			};

			return {
				async next(): Promise<IteratorResult<U>> {
					if (outputQueue.error) throw outputQueue.error;

					ensureStarted();

					if (outputQueue.length > 0) {
						return { done: false, value: outputQueue.shift()! };
					}

					if (outputQueue.closed && coordinatorDone) {
						if (outputQueue.error) throw outputQueue.error;
						return { done: true, value: undefined };
					}

					await outputQueue.waitForItem();

					if (outputQueue.error) throw outputQueue.error;

					if (outputQueue.length > 0) {
						return { done: false, value: outputQueue.shift()! };
					}

					return { done: true, value: undefined };
				},

				async return(_reason?: unknown): Promise<IteratorResult<U>> {
					if (!finished) {
						await abortAll(muxCancelledReason("aborted"));
					}
					iterableActive = false;
					return { done: true, value: undefined };
				},
			};
		},
	};
}
