import { muxError } from "../errors.js";
import { muxCancelledReason } from "./abort.js";
import type { NormalizedReader, SourceReadResult } from "./source.js";
import { createTelemetry } from "./telemetry.js";
import type { MuxCancelled, MuxResult, RaceOptions, SourceEvent } from "../types.js";

type ReadPayload<T> = { id: string; result: SourceReadResult<T> };

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

	let iterableActive = false;

	return {
		[Symbol.asyncIterator]() {
			if (iterableActive) {
				throw new Error("race: iterator already active");
			}
			iterableActive = true;

			const telemetryHooks: {
				onSourceEvent?: (e: SourceEvent) => void;
				onFinish?: (result: MuxResult) => void;
			} = {};
			if (opts.onSourceEvent !== undefined) telemetryHooks.onSourceEvent = opts.onSourceEvent;
			if (opts.onFinish !== undefined) telemetryHooks.onFinish = opts.onFinish;
			const telemetry = createTelemetry("race", telemetryHooks);
			const opCtrl = new AbortController();
			wireAbortSignal(opts.signal, opCtrl);

			let winnerId: string | null = null;
			let raceStarted = false;
			let finished = false;
			let coordinatorDone = false;

			const preBuffers = new Map<string, T[]>();
			const disqualified = new Set<string>();
			const cancelled = new Set<string>();

			const queue: U[] = [];
			let queueError: unknown | null = null;
			let queueClosed = false;
			let queueWaiters: Array<() => void> = [];
			let queueSpaceWaiters: Array<() => void> = [];

			const readerById = (id: string): NormalizedReader<T> => {
				const reader = readers.find((r) => r.id === id);
				if (!reader) throw new Error(`race: unknown source id ${id}`);
				return reader;
			};

			const finishOnce = () => {
				if (finished) return;
				finished = true;
				telemetry.finish();
			};

			const notifyConsumer = () => {
				const waiters = queueWaiters;
				queueWaiters = [];
				for (const wake of waiters) wake();
			};

			const notifyQueueSpace = () => {
				if (queue.length >= 1) return;
				const waiters = queueSpaceWaiters;
				queueSpaceWaiters = [];
				for (const wake of waiters) wake();
			};

			const waitQueueSpace = (): Promise<void> => {
				if (queue.length < 1) return Promise.resolve();
				return new Promise((resolve) => {
					queueSpaceWaiters.push(resolve);
				});
			};

			const failConsumer = (err: unknown) => {
				queueError = err;
				queueClosed = true;
				notifyConsumer();
			};

			const mapAndEnqueue = (item: T, sourceId: string): boolean => {
				try {
					const mapped = mapEach(item, sourceId);
					telemetry.incrementItems(sourceId);
					queue.push(mapped);
					notifyQueueSpace();
					notifyConsumer();
					return true;
				} catch (cause) {
					failConsumer(muxError({ code: "SOURCE_ERROR", source: sourceId, cause }));
					return false;
				}
			};

			const cancelSource = async (reader: NormalizedReader<T>, reason: MuxCancelled) => {
				if (cancelled.has(reader.id)) return;
				cancelled.add(reader.id);
				telemetry.emit({ source: reader.id, type: "cancelled" });
				swallowCancel(reader.cancel(reason));
			};

			const abortAll = async (reason: MuxCancelled) => {
				if (reason.reason === "aborted") telemetry.setAborted(true);
				await Promise.all(readers.map((r) => cancelSource(r, reason)));
				failConsumer(muxError({ code: "ABORTED", cause: opCtrl.signal.reason }));
				finishOnce();
			};

			const disqualifyTransport = async (id: string, cause: unknown) => {
				if (disqualified.has(id) || cancelled.has(id)) return;
				disqualified.add(id);
				const err = muxError({ code: "SOURCE_ERROR", source: id, cause });
				telemetry.markErrored(id, err);
				telemetry.emit({ source: id, type: "error", error: err });
				await cancelSource(readerById(id), muxCancelledReason("race-lost"));
			};

			const disqualifyInBand = async (id: string) => {
				if (disqualified.has(id) || cancelled.has(id)) return;
				disqualified.add(id);
				const err = muxError({ code: "IN_BAND_ERROR", source: id });
				telemetry.markErrored(id, err);
				telemetry.emit({ source: id, type: "error", error: err });
				await cancelSource(readerById(id), muxCancelledReason("race-lost"));
			};

			const disqualifyDone = (id: string) => {
				if (disqualified.has(id) || cancelled.has(id)) return;
				disqualified.add(id);
				telemetry.markCompleted(id);
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
					if (queueError) return;
					await waitQueueSpace();
					if (!mapAndEnqueue(item, id)) return;
				}
				preBuffers.set(id, []);

				if (queueError) return;
				await waitQueueSpace();
				if (!mapAndEnqueue(triggerItem, id)) return;

				await cancelLosers(id);

				if (final) {
					telemetry.markCompleted(id);
					queueClosed = true;
					notifyConsumer();
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

				while (!opCtrl.signal.aborted && !queueError && !queueClosed) {
					await waitQueueSpace();
					if (opCtrl.signal.aborted || queueError || queueClosed) break;

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
							queueClosed = true;
							notifyConsumer();
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
					queueClosed = true;
					notifyConsumer();
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
					if (queueError) throw queueError;

					ensureStarted();

					if (queue.length > 0) {
						const value = queue.shift()!;
						notifyQueueSpace();
						return { done: false, value };
					}

					if (queueClosed && coordinatorDone) {
						if (queueError) throw queueError;
						return { done: true, value: undefined };
					}

					await new Promise<void>((resolve) => {
						queueWaiters.push(resolve);
					});

					if (queueError) throw queueError;

					if (queue.length > 0) {
						const value = queue.shift()!;
						notifyQueueSpace();
						return { done: false, value };
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
