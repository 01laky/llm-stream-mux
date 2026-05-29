export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of it) out.push(item);
	return out;
}

export function toReadable<T>(it: AsyncIterable<T>): ReadableStream<T> {
	const iterator = it[Symbol.asyncIterator]();
	let reading = false;

	return new ReadableStream<T>({
		async pull(controller) {
			if (reading) return;
			reading = true;
			try {
				const { value, done } = await iterator.next();
				reading = false;
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (err) {
				reading = false;
				controller.error(err);
			}
		},
		async cancel(reason) {
			if (iterator.return) {
				try {
					await iterator.return(reason);
				} catch {
					// swallow cancel errors §7.5
				}
			}
		},
	});
}

export function toAsyncIterable<T>(rs: ReadableStream<T>): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator]() {
			const reader = rs.getReader();
			let cancelled = false;

			return {
				async next() {
					if (cancelled) return { done: true as const, value: undefined };
					const result = await reader.read();
					if (result.done) return { done: true as const, value: undefined };
					return { done: false as const, value: result.value };
				},
				async return(reason?: unknown) {
					cancelled = true;
					try {
						await reader.cancel(reason);
					} catch {
						// swallow
					}
					try {
						reader.releaseLock();
					} catch {
						// already released
					}
					return { done: true as const, value: undefined };
				},
			};
		},
	};
}
