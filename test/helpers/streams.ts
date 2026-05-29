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
