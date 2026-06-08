import type { Source, Sources } from "../types.js";

export type SourceReadResult<T> =
	| { ok: true; value: T }
	| { ok: false; done: true }
	| { ok: false; error: unknown };

export interface NormalizedReader<T> {
	readonly id: string;
	next(): Promise<SourceReadResult<T>>;
	cancel(reason?: unknown): Promise<void>;
}

type ResolvedSource<T> = ReadableStream<T> | AsyncIterable<T>;

export interface NormalizeSourceOptions {
	sourceHighWaterMark?: number;
}

function isReadableStream<T>(value: ResolvedSource<T>): value is ReadableStream<T> {
	return typeof (value as ReadableStream<T>).getReader === "function";
}

function wrapReadableStreamWithHwm<T>(stream: ReadableStream<T>, hwm: number): ReadableStream<T> {
	let reader: ReadableStreamDefaultReader<T> | undefined;
	return new ReadableStream<T>(
		{
			async pull(controller) {
				if (!reader) reader = stream.getReader();
				const result = await reader.read();
				if (result.done) {
					controller.close();
					return;
				}
				controller.enqueue(result.value);
			},
			cancel(reason) {
				if (reader) {
					const activeReader = reader;
					reader = undefined;
					return activeReader.cancel(reason);
				}
				return stream.cancel(reason);
			},
		},
		{ highWaterMark: hwm, size: () => 1 },
	);
}

function createReader<T>(
	source: Source<T>,
	id: string,
	normalizeOpts: NormalizeSourceOptions = {},
): NormalizedReader<T> {
	let resolved: ResolvedSource<T> | undefined;
	let lazyFactory: (() => Source<T>) | undefined;
	let cancelled = false;
	let streamReader: ReadableStreamDefaultReader<T> | undefined;
	let asyncIterator: AsyncIterator<T> | undefined;

	const resolveSource = (): ResolvedSource<T> => {
		if (resolved !== undefined) return resolved;
		if (lazyFactory !== undefined) {
			const factory = lazyFactory;
			lazyFactory = undefined;
			let next = factory() as ResolvedSource<T>;
			if (normalizeOpts.sourceHighWaterMark !== undefined && isReadableStream(next)) {
				next = wrapReadableStreamWithHwm(next, normalizeOpts.sourceHighWaterMark);
			}
			resolved = next;
			return resolved;
		}
		throw new Error("normalizeSource: source not initialized");
	};

	if (typeof source === "function") {
		lazyFactory = source;
	} else {
		let resolvedSource = source as ResolvedSource<T>;
		if (normalizeOpts.sourceHighWaterMark !== undefined && isReadableStream(resolvedSource)) {
			resolvedSource = wrapReadableStreamWithHwm(resolvedSource, normalizeOpts.sourceHighWaterMark);
		}
		resolved = resolvedSource;
	}

	const swallow = async (promise: Promise<unknown>) => {
		try {
			await promise;
		} catch {
			// §7.5 — cancel rejections must not mask primary results
		}
	};

	return {
		id,
		async next(): Promise<SourceReadResult<T>> {
			if (cancelled) return { ok: false, done: true };

			try {
				const src = resolveSource();

				if (isReadableStream(src)) {
					if (!streamReader) streamReader = src.getReader();
					const result = await streamReader.read();
					if (result.done) {
						// Release the lock on natural completion so the underlying
						// stream isn't pinned for the rest of the operation.
						streamReader.releaseLock();
						streamReader = undefined;
						return { ok: false, done: true };
					}
					return { ok: true, value: result.value };
				}

				if (!asyncIterator) asyncIterator = src[Symbol.asyncIterator]();
				const result = await asyncIterator.next();
				if (result.done) return { ok: false, done: true };
				return { ok: true, value: result.value };
			} catch (error) {
				return { ok: false, error };
			}
		},
		async cancel(reason?: unknown): Promise<void> {
			if (cancelled) return;
			cancelled = true;

			if (lazyFactory !== undefined) {
				lazyFactory = undefined;
				return;
			}

			const src = resolved;
			if (src === undefined) return;

			if (isReadableStream(src)) {
				const reader = streamReader ?? src.getReader();
				streamReader = undefined;
				await swallow(reader.cancel(reason));
				try {
					reader.releaseLock();
				} catch {
					// already released
				}
				return;
			}

			if (asyncIterator?.return) {
				await swallow(asyncIterator.return(reason));
			}
		},
	};
}

/** True when a `Sources` collection holds no entries (array or record form). */
export function isEmptySources(sources: Sources<unknown>): boolean {
	if (Array.isArray(sources)) return sources.length === 0;
	return Object.keys(sources).length === 0;
}

export function normalizeSource<T>(
	source: Source<T>,
	id: string,
	opts?: NormalizeSourceOptions,
): NormalizedReader<T> {
	return createReader(source, id, opts);
}

export function normalizeSources<T>(
	sources: Sources<T>,
	opts?: NormalizeSourceOptions,
): NormalizedReader<T>[] {
	if (Array.isArray(sources)) {
		if (sources.length === 0) return [];
		if ("id" in sources[0]!) {
			const labeled = sources as Array<{ id: string; source: Source<T> }>;
			const seen = new Set<string>();
			for (const entry of labeled) {
				if (seen.has(entry.id)) {
					throw new Error(`normalizeSources: duplicate source id "${entry.id}"`);
				}
				seen.add(entry.id);
			}
			return labeled.map((entry) => normalizeSource(entry.source, entry.id, opts));
		}
		return (sources as Source<T>[]).map((source, index) =>
			normalizeSource(source, String(index), opts),
		);
	}

	return Object.entries(sources).map(([id, source]) => normalizeSource(source, id, opts));
}
