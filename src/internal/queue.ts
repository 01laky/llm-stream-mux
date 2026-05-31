export interface OutputQueue<U> {
	readonly length: number;
	readonly closed: boolean;
	readonly error: unknown | null;
	push(item: U): void;
	shift(): U | undefined;
	waitForSpace(): Promise<void>;
	waitForItem(): Promise<void>;
	fail(err: unknown): void;
	close(): void;
}

export function createOutputQueue<U>(highWaterMark: number): OutputQueue<U> {
	const items: U[] = [];
	let queueError: unknown | null = null;
	let queueClosed = false;
	let queueWaiters: Array<() => void> = [];
	let queueSpaceWaiters: Array<() => void> = [];

	const notifyConsumer = () => {
		const waiters = queueWaiters;
		queueWaiters = [];
		for (const wake of waiters) wake();
	};

	const notifyQueueSpace = () => {
		if (items.length >= highWaterMark) return;
		const waiters = queueSpaceWaiters;
		queueSpaceWaiters = [];
		for (const wake of waiters) wake();
	};

	return {
		get length() {
			return items.length;
		},
		get closed() {
			return queueClosed;
		},
		get error() {
			return queueError;
		},
		push(item: U) {
			if (queueError) return;
			items.push(item);
			notifyQueueSpace();
			notifyConsumer();
		},
		shift(): U | undefined {
			if (items.length === 0) return undefined;
			const value = items.shift()!;
			notifyQueueSpace();
			return value;
		},
		waitForSpace(): Promise<void> {
			if (items.length < highWaterMark) return Promise.resolve();
			return new Promise((resolve) => {
				queueSpaceWaiters.push(resolve);
			});
		},
		waitForItem(): Promise<void> {
			if (items.length > 0 || queueClosed) return Promise.resolve();
			return new Promise((resolve) => {
				queueWaiters.push(resolve);
			});
		},
		fail(err: unknown) {
			queueError = err;
			queueClosed = true;
			notifyConsumer();
		},
		close() {
			queueClosed = true;
			notifyConsumer();
		},
	};
}
