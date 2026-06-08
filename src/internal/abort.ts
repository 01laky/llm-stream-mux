import type { MuxCancelled, MuxCancelledReason } from "../types.js";

const CANCEL_REASONS: ReadonlySet<string> = new Set([
	"race-lost",
	"failover",
	"aborted",
	"tee-all-cancelled",
]);

/** ReadableStream cancel is hard; AsyncIterable return() is soft (proposal §7.5). */
export function combineSignals(...signals: AbortSignal[]): AbortSignal {
	if (signals.length === 0) {
		return new AbortController().signal;
	}

	const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === "function") {
		return anyFn(signals);
	}

	const ctrl = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			ctrl.abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
	}
	return ctrl.signal;
}

export function timeoutSignal(ms: number): AbortSignal {
	return AbortSignal.timeout(ms);
}

/** Fire-and-forget a cancel()/return() promise — rejections must not mask primary results (§7.5). */
export function swallowCancel(promise: Promise<unknown>): void {
	void promise.catch(() => {
		/* §7.5 */
	});
}

/** Forward an upstream AbortSignal onto the per-operation controller (once). */
export function wireAbortSignal(signal: AbortSignal | undefined, opCtrl: AbortController): void {
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

export function muxCancelledReason(reason: MuxCancelledReason): MuxCancelled {
	return { name: "MuxCancelled", reason };
}

export function isMuxCancelled(value: unknown): value is MuxCancelled {
	if (typeof value !== "object" || value === null) return false;
	const v = value as MuxCancelled;
	return v.name === "MuxCancelled" && CANCEL_REASONS.has(v.reason);
}
