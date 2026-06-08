import { muxError } from "../errors.js";
import { muxCancelledReason, swallowCancel, wireAbortSignal } from "./abort.js";
import { createOutputQueue } from "./queue.js";
import type { NormalizedReader, SourceReadResult } from "./source.js";
import { createTelemetryFromOpts } from "./telemetry.js";
import { timeoutMuxError, wireOverallTimeout } from "./timeouts.js";
import type { MergeOptions, MuxCancelled, MuxError, Tagged, MergeOrder } from "../types.js";

export function createMergeIterable<T, U = T>(
	readers: NormalizedReader<T>[],
	opts: MergeOptions<T, U> = {},
): AsyncIterable<Tagged<U>> {
	const readerOrder = readers.map((r) => r.id);
	const failFast = opts.failFast ?? false;
	const order: MergeOrder = opts.order ?? "arrival";
	const isError = opts.isError ?? (() => false);
	const isFinal = opts.isFinal ?? (() => false);
	const mapEach = opts.mapEach ?? ((item: T) => item as unknown as U);
	const maxConcurrency = Math.min(opts.concurrency ?? readers.length, Math.max(readers.length, 1));
	const outputHighWaterMark = opts.highWaterMark ?? 1;
	const overallTimeoutMs = opts.overallTimeoutMs;

	let iterableActive = false;

	return {
		[Symbol.asyncIterator]() {
			if (iterableActive) {
				throw new Error("merge: iterator already active");
			}
			iterableActive = true;

			const telemetry = createTelemetryFromOpts("merge", opts);
			const opCtrl = new AbortController();
			wireAbortSignal(opts.signal, opCtrl);

			let mergeStarted = false;
			let finished = false;
			let coordinatorDone = false;
			let rrCursor = 0;

			const dropped = new Set<string>();
			const cancelled = new Set<string>();
			const usableEmitted = new Set<string>();
			const activeOrder: string[] = [];
			const waitingQueue = [...readerOrder];
			const ready = new Map<string, SourceReadResult<T>>();
			let readyWaiters: Array<() => void> = [];
			let disarmOverall: (() => void) | undefined;

			const outputQueue = createOutputQueue<Tagged<U>>(outputHighWaterMark);
			const queueFailed = () => outputQueue.error !== null;

			const readerById = (id: string): NormalizedReader<T> => {
				const reader = readers.find((r) => r.id === id);
				if (!reader) throw new Error(`merge: unknown source id ${id}`);
				return reader;
			};

			const finishOnce = () => {
				if (finished) return;
				finished = true;
				disarmOverall?.();
				telemetry.finish();
			};

			const failConsumer = (err: unknown) => {
				outputQueue.fail(err);
			};

			const pushTag = (tag: Tagged<U>) => {
				outputQueue.push(tag);
			};

			const waitQueueSpace = (): Promise<void> => outputQueue.waitForSpace();

			const notifyReady = () => {
				const waiters = readyWaiters;
				readyWaiters = [];
				for (const wake of waiters) wake();
			};

			const waitReady = (): Promise<void> => {
				if (ready.size > 0) return Promise.resolve();
				return new Promise((resolve) => {
					readyWaiters.push(resolve);
				});
			};

			const cancelSource = async (reader: NormalizedReader<T>, reason: MuxCancelled) => {
				if (cancelled.has(reader.id)) return;
				cancelled.add(reader.id);
				telemetry.emit({ source: reader.id, type: "cancelled" });
				swallowCancel(reader.cancel(reason));
			};

			const abortAll = async (reason: MuxCancelled, cause?: unknown) => {
				if (reason.reason === "aborted") telemetry.setAborted(true);
				disarmOverall?.();
				await Promise.all(
					readers
						.filter((r) => telemetry.ensureSource(r.id).started)
						.map((r) => cancelSource(r, reason)),
				);
				failConsumer(muxError({ code: "ABORTED", cause: cause ?? opCtrl.signal.reason }));
				finishOnce();
				coordinatorDone = true;
			};

			const handleOverallTimeout = async () => {
				if (finished) return;
				telemetry.setAborted(true);
				for (const reader of readers) {
					if (telemetry.ensureSource(reader.id).started) {
						telemetry.emit({
							source: reader.id,
							type: "timeout",
							error: timeoutMuxError(reader.id),
						});
					}
				}
				await abortAll(muxCancelledReason("aborted"), muxError({ code: "TIMEOUT" }));
			};

			const failFastAbort = async (trigger: MuxError) => {
				telemetry.setAborted(true);
				telemetry.markErrored(trigger.source ?? "unknown", trigger);
				await Promise.all(
					readers
						.filter((r) => telemetry.ensureSource(r.id).started)
						.map((r) => cancelSource(r, muxCancelledReason("aborted"))),
				);
				failConsumer(
					muxError({
						code: "ALL_FAILED",
						errors: [trigger],
						cause: trigger,
					}),
				);
				finishOnce();
				coordinatorDone = true;
			};

			const emitValueTag = (id: string, item: T): boolean => {
				try {
					const mapped = mapEach(item, id);
					if (!usableEmitted.has(id)) {
						usableEmitted.add(id);
						telemetry.emit({ source: id, type: "usable" });
					}
					telemetry.incrementItems(id);
					pushTag({ source: id, kind: "value", value: mapped });
					return true;
				} catch (cause) {
					const err = muxError({ code: "SOURCE_ERROR", source: id, cause });
					return emitErrorTag(id, err, true);
				}
			};

			const emitErrorTag = (id: string, err: MuxError, triggerFailFast: boolean): boolean => {
				if (triggerFailFast && failFast) {
					void failFastAbort(err);
					return false;
				}
				telemetry.markErrored(id, err);
				telemetry.emit({ source: id, type: "error", error: err });
				pushTag({ source: id, kind: "error", error: err });
				return true;
			};

			const emitDoneTag = (id: string) => {
				telemetry.markCompleted(id);
				telemetry.emit({ source: id, type: "done" });
				pushTag({ source: id, kind: "done" });
			};

			const removeFromActive = (id: string) => {
				const idx = activeOrder.indexOf(id);
				if (idx >= 0) activeOrder.splice(idx, 1);
				ready.delete(id);
			};

			const dropSource = (id: string) => {
				if (dropped.has(id)) return;
				dropped.add(id);
				removeFromActive(id);
				activateNext();
				maybeClose();
			};

			const maybeClose = () => {
				if (dropped.size === readerOrder.length && ready.size === 0) {
					outputQueue.close();
					finishOnce();
					coordinatorDone = true;
				}
			};

			const activateNext = () => {
				while (activeOrder.length < maxConcurrency && waitingQueue.length > 0) {
					const id = waitingQueue.shift()!;
					activeOrder.push(id);
					telemetry.markStarted(id);
					telemetry.emit({ source: id, type: "start" });
					armRead(id);
				}
			};

			const armRead = (id: string) => {
				if (dropped.has(id) || cancelled.has(id) || queueFailed()) return;
				void readerById(id)
					.next()
					.then((result) => {
						if (dropped.has(id) || cancelled.has(id) || queueFailed()) return;
						ready.set(id, result);
						notifyReady();
					})
					.catch((cause) => {
						if (dropped.has(id) || cancelled.has(id) || queueFailed()) return;
						ready.set(id, { ok: false, error: cause });
						notifyReady();
					});
			};

			const pickNextId = (): string | null => {
				if (ready.size === 0) return null;
				if (order === "arrival") {
					return ready.keys().next().value ?? null;
				}
				for (let i = 0; i < activeOrder.length; i += 1) {
					const id = activeOrder[(rrCursor + i) % activeOrder.length]!;
					if (ready.has(id)) {
						rrCursor = (rrCursor + i + 1) % Math.max(activeOrder.length, 1);
						return id;
					}
				}
				return ready.keys().next().value ?? null;
			};

			const handleTransportError = async (id: string, cause: unknown) => {
				const err = muxError({ code: "SOURCE_ERROR", source: id, cause });
				if (failFast) {
					await failFastAbort(err);
					return;
				}
				emitErrorTag(id, err, false);
				dropSource(id);
			};

			const handleNaturalDone = (id: string) => {
				emitDoneTag(id);
				dropSource(id);
			};

			const handleValue = async (id: string, item: T) => {
				if (isError(item)) {
					const err = muxError({ code: "IN_BAND_ERROR", source: id });
					if (failFast) {
						await failFastAbort(err);
						return;
					}
					emitErrorTag(id, err, false);
					armRead(id);
					return;
				}

				if (isFinal(item)) {
					emitValueTag(id, item);
					if (queueFailed()) return;
					telemetry.emit({ source: id, type: "final" });
					emitDoneTag(id);
					dropSource(id);
					return;
				}

				emitValueTag(id, item);
				if (queueFailed()) return;
				armRead(id);
			};

			const handleResult = async (id: string, result: SourceReadResult<T>) => {
				if (result.ok) {
					await handleValue(id, result.value);
					return;
				}
				if ("error" in result && result.error !== undefined) {
					await handleTransportError(id, result.error);
					return;
				}
				handleNaturalDone(id);
			};

			const pump = async () => {
				while (!queueFailed() && !outputQueue.closed) {
					await waitQueueSpace();
					if (queueFailed() || outputQueue.closed) break;

					if (ready.size === 0) {
						if (dropped.size === readerOrder.length) {
							maybeClose();
							break;
						}
						await waitReady();
						if (queueFailed() || outputQueue.closed) break;
					}

					const id = pickNextId();
					if (id === null) {
						if (dropped.size === readerOrder.length) {
							maybeClose();
							break;
						}
						await waitReady();
						continue;
					}

					const result = ready.get(id);
					if (result === undefined) continue;
					ready.delete(id);

					await handleResult(id, result);
				}
			};

			const runCoordinator = async () => {
				if (readers.length === 0) {
					outputQueue.close();
					finishOnce();
					coordinatorDone = true;
					return;
				}

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

				activateNext();
				await pump();
			};

			const ensureStarted = () => {
				if (mergeStarted) return;
				mergeStarted = true;
				void runCoordinator().finally(() => {
					coordinatorDone = true;
				});
			};

			return {
				async next(): Promise<IteratorResult<Tagged<U>>> {
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

				async return(_reason?: unknown): Promise<IteratorResult<Tagged<U>>> {
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
