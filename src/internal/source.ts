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

function isReadableStream<T>(value: ResolvedSource<T>): value is ReadableStream<T> {
	return typeof (value as ReadableStream<T>).getReader === "function";
}

function createReader<T>(source: Source<T>, id: string): NormalizedReader<T> {
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
			resolved = factory() as ResolvedSource<T>;
			return resolved;
		}
		throw new Error("normalizeSource: source not initialized");
	};

	if (typeof source === "function") {
		lazyFactory = source;
	} else {
		resolved = source as ResolvedSource<T>;
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
					if (result.done) return { ok: false, done: true };
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

export function normalizeSource<T>(source: Source<T>, id: string): NormalizedReader<T> {
	return createReader(source, id);
}

export function normalizeSources<T>(sources: Sources<T>): NormalizedReader<T>[] {
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
			return labeled.map((entry) => normalizeSource(entry.source, entry.id));
		}
		return (sources as Source<T>[]).map((source, index) => normalizeSource(source, String(index)));
	}

	return Object.entries(sources).map(([id, source]) => normalizeSource(source, id));
}
