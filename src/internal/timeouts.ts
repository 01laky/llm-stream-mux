import { muxError } from "../errors.js";
import { timeoutSignal } from "./abort.js";
import type { MuxError } from "../types.js";

/**
 * Arm a one-shot timer off `AbortSignal.timeout(ms)` that fires `onFire` unless
 * disarmed first (by the returned fn or by the op aborting). Disarming removes
 * both listeners so a fast-completing op doesn't leak the timer's closure.
 */
function armTimer(ms: number, opCtrl: AbortController, onFire: () => void): () => void {
	const timer = timeoutSignal(ms);
	let disarmed = false;

	const disarm = () => {
		if (disarmed) return;
		disarmed = true;
		timer.removeEventListener("abort", onTimer);
		opCtrl.signal.removeEventListener("abort", disarm);
	};

	const onTimer = () => {
		if (disarmed || opCtrl.signal.aborted) return;
		disarm();
		onFire();
	};

	timer.addEventListener("abort", onTimer, { once: true });
	opCtrl.signal.addEventListener("abort", disarm, { once: true });

	return disarm;
}

/** Overall (whole-operation) timeout. */
export const wireOverallTimeout = armTimer;

/** Per-source time-to-first-usable timeout. */
export const createTtfUsableTimer = armTimer;

export function timeoutMuxError(source: string): MuxError {
	return muxError({ code: "TIMEOUT", source });
}
