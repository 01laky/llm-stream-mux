import { muxError } from "../errors.js";
import { muxCancelledReason, swallowCancel, wireAbortSignal } from "./abort.js";
import { createOutputQueue } from "./queue.js";
import type { NormalizedReader, SourceReadResult } from "./source.js";
import { createTelemetryFromOpts } from "./telemetry.js";
import { createTtfUsableTimer, timeoutMuxError, wireOverallTimeout } from "./timeouts.js";
import type { MuxCancelled, RaceOptions } from "../types.js";

type ReadPayload<T> = { id: string; result: SourceReadResult<T> };

function readOne<T>(reader: NormalizedReader<T>): Promise<ReadPayload<T>> {
	return reader.next().then((result) => ({ id: reader.id, result }));
}

export function createRaceIterable<T, U = T>(
	readers: NormalizedReader<T>[],
	opts: RaceOptions<T, U> = {},
): AsyncIterable<U> {
	const readerOrder = readers.map((r) => r.id);
	const isUsable = opts.isUsable ?? (() => true);
	const isError = opts.isError ?? (() => false);
	const isFinal = opts.isFinal ?? (() => false);
	const mapEach = opts.mapEach ?? ((item: T) => item as unknown as U);
	const outputHighWaterMark = opts.highWaterMark ?? 1;
	const timeoutMs = opts.timeoutMs;
	const overallTimeoutMs = opts.overallTimeoutMs;

	let iterableActive = false;

	return {
		[Symbol.asyncIterator]() {
			if (iterableActive) {
				throw new Error("race: iterator already active");
			}
			iterableActive = true;

			const telemetry = createTelemetryFromOpts("race", opts);
			const opCtrl = new AbortController();
			wireAbortSignal(opts.signal, opCtrl);

			let winnerId: string | null = null;
			let raceStarted = false;
			let finished = false;
			let coordinatorDone = false;

			const preBuffers = new Map<string, T[]>();
			const disqualified = new Set<string>();
			const cancelled = new Set<string>();
			const sourceTimerDisarm = new Map<string, () => void>();
			let disarmOverall: (() => void) | undefined;
			const outputQueue = createOutputQueue<U>(outputHighWaterMark);
			const queueFailed = () => outputQueue.error !== null;

			const readerById = (id: string): NormalizedReader<T> => {
				const reader = readers.find((r) => r.id === id);
				if (!reader) throw new Error(`race: unknown source id ${id}`);
				return reader;
			};

			const finishOnce = () => {
				if (finished) return;
				finished = true;
				disarmOverall?.();
				for (const disarm of sourceTimerDisarm.values()) disarm();
				sourceTimerDisarm.clear();
				telemetry.finish();
			};

			const failConsumer = (err: unknown) => {
				outputQueue.fail(err);
			};

			const mapAndEnqueue = (item: T, sourceId: string): boolean => {
				try {
					const mapped = mapEach(item, sourceId);
					telemetry.incrementItems(sourceId);
					outputQueue.push(mapped);
					return true;
				} catch (cause) {
					failConsumer(muxError({ code: "SOURCE_ERROR", source: sourceId, cause }));
					return false;
				}
			};

			const waitQueueSpace = (): Promise<void> => outputQueue.waitForSpace();

			const cancelSource = async (reader: NormalizedReader<T>, reason: MuxCancelled) => {
				if (cancelled.has(reader.id)) return;
				cancelled.add(reader.id);
				telemetry.emit({ source: reader.id, type: "cancelled" });
				swallowCancel(reader.cancel(reason));
			};

			const abortAll = async (reason: MuxCancelled, cause?: unknown) => {
				if (reason.reason === "aborted") telemetry.setAborted(true);
				disarmOverall?.();
				for (const disarm of sourceTimerDisarm.values()) disarm();
				sourceTimerDisarm.clear();
				await Promise.all(readers.map((r) => cancelSource(r, reason)));
				failConsumer(muxError({ code: "ABORTED", cause: cause ?? opCtrl.signal.reason }));
				finishOnce();
				coordinatorDone = true;
			};

			const disarmSourceTimeout = (id: string) => {
				const disarm = sourceTimerDisarm.get(id);
				if (disarm) {
					disarm();
					sourceTimerDisarm.delete(id);
				}
			};

			const armSourceTimeout = (id: string) => {
				if (timeoutMs === undefined) return;
				sourceTimerDisarm.set(
					id,
					createTtfUsableTimer(timeoutMs, opCtrl, () => {
						void disqualifyTimeout(id);
					}),
				);
			};

			const checkNoWinnerLeft = () => {
				if (winnerId !== null || opCtrl.signal.aborted || queueFailed()) return;
				if (readerOrder.every((id) => disqualified.has(id) || cancelled.has(id))) {
					failConsumer(muxError({ code: "NO_USABLE_SOURCE" }));
					finishOnce();
					coordinatorDone = true;
				}
			};

			const disqualifyTimeout = async (id: string) => {
				if (disqualified.has(id) || cancelled.has(id) || winnerId !== null) return;
				disqualified.add(id);
				disarmSourceTimeout(id);
				const err = timeoutMuxError(id);
				telemetry.markErrored(id, err);
				telemetry.emit({ source: id, type: "timeout", error: err });
				await cancelSource(readerById(id), muxCancelledReason("race-lost"));
				checkNoWinnerLeft();
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

			const disqualifyTransport = async (id: string, cause: unknown) => {
				if (disqualified.has(id) || cancelled.has(id)) return;
				disqualified.add(id);
				disarmSourceTimeout(id);
				const err = muxError({ code: "SOURCE_ERROR", source: id, cause });
				telemetry.markErrored(id, err);
				telemetry.emit({ source: id, type: "error", error: err });
				await cancelSource(readerById(id), muxCancelledReason("race-lost"));
				checkNoWinnerLeft();
			};

			const disqualifyInBand = async (id: string) => {
				if (disqualified.has(id) || cancelled.has(id)) return;
				disqualified.add(id);
				disarmSourceTimeout(id);
				const err = muxError({ code: "IN_BAND_ERROR", source: id });
				telemetry.markErrored(id, err);
				telemetry.emit({ source: id, type: "error", error: err });
				await cancelSource(readerById(id), muxCancelledReason("race-lost"));
				checkNoWinnerLeft();
			};

			const disqualifyDone = (id: string) => {
				if (disqualified.has(id) || cancelled.has(id)) return;
				disqualified.add(id);
				disarmSourceTimeout(id);
				telemetry.markCompleted(id);
				checkNoWinnerLeft();
			};

			let usableBatch: { id: string; item: T; final: boolean }[] = [];
			let batchScheduled = false;
			const pendingUsable = new Set<string>();

			const flushUsableBatch = async () => {
				batchScheduled = false;
				if (winnerId !== null || usableBatch.length === 0) {
					for (const id of pendingUsable) pendingUsable.delete(id);
					usableBatch = [];
					return;
				}
				usableBatch.sort((a, b) => readerOrder.indexOf(a.id) - readerOrder.indexOf(b.id));
				const first = usableBatch[0]!;
				for (const id of pendingUsable) pendingUsable.delete(id);
				usableBatch = [];
				await claimWin(first.id, first.item, first.final);
			};

			const scheduleUsableBatch = (id: string, item: T, final: boolean) => {
				pendingUsable.add(id);
				usableBatch.push({ id, item, final });
				if (batchScheduled) return;
				batchScheduled = true;
				queueMicrotask(() => {
					void flushUsableBatch();
				});
			};

			const cancelLosers = async (winId: string) => {
				await Promise.all(
					readers
						.filter((r) => r.id !== winId)
						.map((r) => cancelSource(r, muxCancelledReason("race-lost"))),
				);
			};

			const claimWin = async (id: string, triggerItem: T, final: boolean) => {
				if (winnerId !== null) return;
				winnerId = id;
				telemetry.setWinner(id);
				telemetry.emit({ source: id, type: "usable" });

				const buffer = preBuffers.get(id) ?? [];
				for (const item of buffer) {
					if (queueFailed()) return;
					await waitQueueSpace();
					if (!mapAndEnqueue(item, id)) return;
				}
				preBuffers.set(id, []);

				if (queueFailed()) return;
				await waitQueueSpace();
				if (!mapAndEnqueue(triggerItem, id)) return;

				disarmSourceTimeout(id);

				await cancelLosers(id);

				if (final) {
					telemetry.markCompleted(id);
					telemetry.emit({ source: id, type: "done" });
					outputQueue.close();
					finishOnce();
					coordinatorDone = true;
					return;
				}

				void pumpWinner();
			};

			const processPreWin = async (id: string, result: SourceReadResult<T>): Promise<void> => {
				if (winnerId !== null || disqualified.has(id) || cancelled.has(id)) return;

				if (result.ok) {
					const item = result.value;
					if (isError(item)) {
						await disqualifyInBand(id);
						return;
					}
					const usable = isUsable(item);
					const final = isFinal(item);
					if (usable || final) {
						disarmSourceTimeout(id);
						scheduleUsableBatch(id, item, final);
						return;
					}
					const buf = preBuffers.get(id) ?? [];
					buf.push(item);
					preBuffers.set(id, buf);
					return;
				}

				if ("error" in result && result.error !== undefined) {
					await disqualifyTransport(id, result.error);
					return;
				}

				disqualifyDone(id);
			};

			const pumpWinner = async () => {
				if (winnerId === null) return;
				const reader = readerById(winnerId);

				while (!opCtrl.signal.aborted && !queueFailed() && !outputQueue.closed) {
					await waitQueueSpace();
					if (opCtrl.signal.aborted || queueFailed() || outputQueue.closed) break;

					const result = await reader.next();
					if (result.ok) {
						const item = result.value;
						if (isError(item)) {
							failConsumer(muxError({ code: "IN_BAND_ERROR", source: winnerId }));
							finishOnce();
							return;
						}
						if (!mapAndEnqueue(item, winnerId)) {
							finishOnce();
							return;
						}
						if (isFinal(item)) {
							telemetry.markCompleted(winnerId);
							telemetry.emit({ source: winnerId, type: "done" });
							outputQueue.close();
							finishOnce();
							coordinatorDone = true;
							return;
						}
						continue;
					}

					if ("error" in result && result.error !== undefined) {
						const err =
							result.error instanceof Error
								? result.error
								: muxError({ code: "SOURCE_ERROR", source: winnerId, cause: result.error });
						failConsumer(err);
						finishOnce();
						return;
					}

					telemetry.markCompleted(winnerId);
					telemetry.emit({ source: winnerId, type: "done" });
					outputQueue.close();
					finishOnce();
					coordinatorDone = true;
					return;
				}

				if (opCtrl.signal.aborted) {
					await abortAll(muxCancelledReason("aborted"));
				}
			};

			const runCoordinator = async () => {
				if (opCtrl.signal.aborted) {
					telemetry.setAborted(true);
					failConsumer(muxError({ code: "ABORTED", cause: opCtrl.signal.reason }));
					finishOnce();
					coordinatorDone = true;
					return;
				}

				for (const reader of readers) {
					telemetry.markStarted(reader.id);
					telemetry.emit({ source: reader.id, type: "start" });
					preBuffers.set(reader.id, []);
				}

				if (overallTimeoutMs !== undefined) {
					disarmOverall = wireOverallTimeout(overallTimeoutMs, opCtrl, () => {
						void handleOverallTimeout();
					});
				}
				for (const id of readerOrder) armSourceTimeout(id);

				opCtrl.signal.addEventListener(
					"abort",
					() => {
						void abortAll(muxCancelledReason("aborted"));
					},
					{ once: true },
				);

				const pending = new Map<string, Promise<ReadPayload<T>>>();
				const arm = (id: string) => {
					if (disqualified.has(id) || cancelled.has(id) || winnerId !== null) return;
					pending.set(id, readOne(readerById(id)));
				};

				for (const id of readerOrder) arm(id);

				while (winnerId === null && pending.size > 0 && !opCtrl.signal.aborted) {
					const { id, result } = await Promise.race(pending.values());
					pending.delete(id);
					await processPreWin(id, result);
					if (batchScheduled) {
						await new Promise<void>((resolve) => queueMicrotask(resolve));
					}
					if (usableBatch.length > 0 && winnerId === null) {
						await flushUsableBatch();
					}
					if (winnerId !== null) break;
					if (!disqualified.has(id) && !cancelled.has(id) && !pendingUsable.has(id)) {
						arm(id);
					}
				}

				if (batchScheduled) {
					await new Promise<void>((resolve) => queueMicrotask(resolve));
				}
				if (usableBatch.length > 0 && winnerId === null) {
					await flushUsableBatch();
				}

				if (winnerId !== null) return;

				if (opCtrl.signal.aborted) {
					await abortAll(muxCancelledReason("aborted"));
					coordinatorDone = true;
					return;
				}

				failConsumer(muxError({ code: "NO_USABLE_SOURCE" }));
				finishOnce();
				coordinatorDone = true;
			};

			const ensureStarted = () => {
				if (raceStarted) return;
				raceStarted = true;
				void runCoordinator().finally(() => {
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
