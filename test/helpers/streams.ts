import type { Source } from "../../src/types.js";

export type FromArrayOptions = {
	delayMs?: number;
	throwAt?: number;
	neverEnd?: boolean;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared item schedule for symmetric readable + asyncIterable variants. */
async function* sharedSchedule<T>(items: T[], opts: FromArrayOptions = {}): AsyncGenerator<T> {
	const { delayMs = 0, throwAt, neverEnd = false } = opts;
	for (let i = 0; i < items.length; i += 1) {
		if (delayMs > 0) await sleep(delayMs);
		if (throwAt === i) throw new Error(`fromArray throwAt ${i}`);
		yield items[i] as T;
	}
	if (neverEnd) {
		await new Promise<void>(() => {
			// hang until cancel/close
		});
	}
}

export function readableFromArray<T>(items: T[], opts: FromArrayOptions = {}): ReadableStream<T> {
	const gen = sharedSchedule(items, opts);
	return new ReadableStream<T>({
		async pull(controller) {
			try {
				const { value, done } = await gen.next();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (err) {
				controller.error(err);
			}
		},
		async cancel() {
			await gen.return(undefined);
		},
	});
}

export function asyncIterableFromArray<T>(
	items: T[],
	opts: FromArrayOptions = {},
): AsyncIterable<T> {
	return sharedSchedule(items, opts);
}

export function fromArray<T>(items: T[], opts: FromArrayOptions = {}) {
	return {
		readable: readableFromArray(items, opts),
		asyncIterable: asyncIterableFromArray(items, opts),
	};
}

export function controllableReadable<T>() {
	let controllerRef: ReadableStreamDefaultController<T> | undefined;
	let cancelResolve: ((reason: unknown) => void) | undefined;
	const cancelReason = new Promise<unknown>((resolve) => {
		cancelResolve = resolve;
	});

	const stream = new ReadableStream<T>({
		start(controller) {
			controllerRef = controller;
		},
		cancel(reason) {
			cancelResolve?.(reason);
		},
	});

	return {
		stream,
		enqueue(item: T) {
			controllerRef?.enqueue(item);
		},
		close() {
			controllerRef?.close();
		},
		error(err: unknown) {
			controllerRef?.error(err);
		},
		cancelReason,
	};
}

function wrapCountable<T>(
	resolved: ReadableStream<T> | AsyncIterable<T>,
	onPull: () => void,
): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator]() {
			const stream = resolved as ReadableStream<T>;
			if (typeof stream.getReader === "function") {
				const reader = stream.getReader();
				return {
					async next() {
						const result = await reader.read();
						if (!result.done) onPull();
						return result;
					},
					async return(reason?: unknown) {
						try {
							await reader.cancel(reason);
						} catch {
							/* swallow */
						}
						try {
							reader.releaseLock();
						} catch {
							/* swallow */
						}
						return { done: true as const, value: undefined };
					},
				};
			}

			const iterator = (resolved as AsyncIterable<T>)[Symbol.asyncIterator]();
			return {
				async next() {
					const result = await iterator.next();
					if (!result.done) onPull();
					return result;
				},
				return: iterator.return?.bind(iterator),
			};
		},
	};
}

/** Increments pullCount on each successful item read from the wrapped source. */
export function countingSource<T>(inner: Source<T> | (() => Source<T>)) {
	let pullCount = 0;
	const bump = () => {
		pullCount += 1;
	};

	const wrapOne = (src: Source<T>): Source<T> => {
		if (typeof src === "function") {
			return () => wrapCountable(src(), bump);
		}
		return wrapCountable(src, bump);
	};

	const source: Source<T> = typeof inner === "function" ? () => wrapOne(inner) : wrapOne(inner);

	return {
		source,
		get pullCount() {
			return pullCount;
		},
		reset() {
			pullCount = 0;
		},
	};
}

/** Wraps a lazy factory; increments openCount when the thunk runs. */
export function lazyOpenCounter<T>(factory: () => Source<T>) {
	let openCount = 0;
	const source: Source<T> = () => {
		openCount += 1;
		return factory();
	};
	return {
		source,
		get openCount() {
			return openCount;
		},
	};
}

/** ReadableStream with cancel reason spy. */
export function cancelSpyingReadable<T>() {
	const cancelReasons: unknown[] = [];
	let controllerRef: ReadableStreamDefaultController<T> | undefined;

	const stream = new ReadableStream<T>({
		start(controller) {
			controllerRef = controller;
		},
		cancel(reason) {
			cancelReasons.push(reason);
		},
	});

	return {
		stream,
		enqueue(item: T) {
			controllerRef?.enqueue(item);
		},
		close() {
			controllerRef?.close();
		},
		get cancelReasons() {
			return cancelReasons;
		},
	};
}
