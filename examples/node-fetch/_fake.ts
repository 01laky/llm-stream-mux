/** Shared fake streams for node-fetch examples — production: fetch(url, { signal }).body! */

export function fakeByteStream(chunks: Uint8Array[], delayMs = 0): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
			controller.enqueue(chunks[i++]!);
		},
	});
}

export function fakeEmptyChunk(): Uint8Array {
	return new Uint8Array(0);
}

export function fakeGoodChunk(n: number): Uint8Array {
	return new Uint8Array([n]);
}

export async function* fakeEvents<T>(items: T[]): AsyncGenerator<T> {
	for (const item of items) yield item;
}

export function fakeThrowingPrimary(): () => AsyncIterable<never> {
	return () => ({
		[Symbol.asyncIterator]() {
			return {
				next() {
					return Promise.reject(new Error("primary failed before first yield"));
				},
				return() {
					return Promise.resolve({ done: true as const, value: undefined });
				},
			};
		},
	});
}

export function fakeLazyBackup<T>(items: T[]): () => AsyncGenerator<T> {
	return () => fakeEvents(items);
}

export function fakeTaggedSources(): Record<string, AsyncIterable<{ type: string; text: string }>> {
	return {
		alpha: fakeEvents([{ type: "text.delta", text: "alpha" }]),
		beta: fakeEvents([{ type: "text.delta", text: "beta" }]),
	};
}

export async function* fakeNumericStream(items: number[]): AsyncGenerator<number> {
	for (const n of items) yield n;
}
