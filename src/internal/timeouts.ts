import { muxError } from "../errors.js";
import { timeoutSignal } from "./abort.js";
import type { MuxError } from "../types.js";

export function wireOverallTimeout(
	ms: number,
	opCtrl: AbortController,
	onFire: () => void,
): () => void {
	const timer = timeoutSignal(ms);
	let disarmed = false;

	const disarm = () => {
		if (disarmed) return;
		disarmed = true;
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

export function createTtfUsableTimer(
	ms: number,
	opCtrl: AbortController,
	onFire: () => void,
): () => void {
	const timer = timeoutSignal(ms);
	let disarmed = false;

	const disarm = () => {
		if (disarmed) return;
		disarmed = true;
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

export function timeoutMuxError(source: string): MuxError {
	return muxError({ code: "TIMEOUT", source });
}

export function abortedByOverallTimeout(): ReturnType<typeof muxError> {
	return muxError({
		code: "ABORTED",
		cause: muxError({ code: "TIMEOUT" }),
	});
}
