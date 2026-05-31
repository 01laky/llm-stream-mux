import { expect } from "vitest";
import { collect, ensemble, fallback, merge, race, toAsyncIterable } from "../../src/index.js";
import { isMuxCancelled } from "../../src/internal/abort.js";
import type {
	FallbackOptions,
	MergeOptions,
	MuxCancelled,
	MuxCancelledReason,
	MuxError,
	MuxResult,
	RaceOptions,
	Sources,
	Tagged,
} from "../../src/types.js";

/** Flush microtasks so cancel/teardown assertions are stable (no setTimeout). */
export async function flushMicrotasks(rounds = 4): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

export function asMuxError(err: unknown): MuxError {
	expect(err).toBeInstanceOf(Error);
	return err as MuxError;
}

export function lastCancelReason(spy: { cancelReasons: unknown[] }): unknown {
	return spy.cancelReasons[spy.cancelReasons.length - 1];
}

export function assertMuxCancelled(reason: unknown, expected: MuxCancelledReason): void {
	if (!isMuxCancelled(reason)) throw new Error(`expected MuxCancelled, got ${String(reason)}`);
	expect((reason as MuxCancelled).reason).toBe(expected);
}

export async function collectRace<T, U = T>(sources: Sources<T>, opts?: RaceOptions<T, U>) {
	return collect(race(sources, opts));
}

export async function collectFallback<T, U = T>(sources: Sources<T>, opts?: FallbackOptions<T, U>) {
	return collect(fallback(sources, opts));
}

export async function collectTagged<T, U = T>(
	sources: Sources<T>,
	opts?: MergeOptions<T, U>,
): Promise<Tagged<U>[]> {
	return collect(merge(sources, opts));
}

export async function collectEnsemble<T, U = T>(
	sources: Sources<T>,
	opts?: MergeOptions<T, U>,
): Promise<Tagged<U>[]> {
	return collect(ensemble(sources, opts));
}

export function valueTags<T>(tags: Tagged<T>[]) {
	return tags.filter((t): t is Tagged<T> & { kind: "value" } => t.kind === "value");
}

export async function drainBranch<T>(stream: ReadableStream<T>): Promise<T[]> {
	return collect(toAsyncIterable(stream));
}

export async function drainBranchesParallel<T>(streams: ReadableStream<T>[]): Promise<T[][]> {
	return Promise.all(streams.map((stream) => drainBranch(stream)));
}

export async function readOne<T>(stream: ReadableStream<T>) {
	const reader = stream.getReader();
	try {
		return await reader.read();
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* released */
		}
	}
}

export type { MuxResult };
