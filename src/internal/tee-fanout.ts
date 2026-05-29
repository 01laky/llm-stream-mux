import { muxError } from "../errors.js";
import { muxCancelledReason } from "./abort.js";
import type { NormalizedReader } from "./source.js";
import { normalizeSource } from "./source.js";
import type { Source, TeeBackpressure } from "../types.js";

type BranchState<T> = {
	cancelled: boolean;
	errored: boolean;
	branchError: unknown | null;
	queue: T[];
	waiting: ReadableStreamDefaultController<T> | null;
};

export function createTeeFanout<T>(
	source: Source<T>,
	n: number,
	backpressure: TeeBackpressure,
	bufferLimit?: number,
): ReadableStream<T>[] {
	let reader: NormalizedReader<T> | undefined;
	const getReader = (): NormalizedReader<T> => {
		if (reader === undefined) reader = normalizeSource(source, "0");
		return reader;
	};
	const branches: BranchState<T>[] = Array.from({ length: n }, () => ({
		cancelled: false,
		errored: false,
		branchError: null,
		queue: [],
		waiting: null,
	}));

	let sourceDone = false;
	let sourceCancelled = false;
	let pumpRunning = false;
	let pumpScheduled = false;
	let blockItem: { value: T; acked: Set<number> } | null = null;
	let pendingDemand = 0;
	let liveDemand = false;
	let allowSourceRead = false;

	const activeIndices = (): number[] =>
		branches.map((_, i) => i).filter((i) => !branches[i]!.cancelled && !branches[i]!.errored);

	const allExplicitlyCancelled = (): boolean => branches.every((b) => b.cancelled);

	const anyActiveWaiting = (): boolean =>
		activeIndices().some((i) => branches[i]!.waiting !== null);

	const canReadBlockSource = (): boolean => {
		const active = activeIndices();
		if (active.length === 0) return false;
		if (active.length === 1) return branches[active[0]!]!.waiting !== null;
		return active.every((i) => branches[i]!.waiting !== null);
	};

	const schedulePump = () => {
		pumpScheduled = true;
		if (pumpRunning) return;
		void runPump();
	};

	const maybeCancelSource = async () => {
		if (allExplicitlyCancelled() && !sourceCancelled && !sourceDone) {
			sourceCancelled = true;
			if (reader === undefined) return;
			await getReader().cancel(muxCancelledReason("tee-all-cancelled"));
		}
	};

	const ackBlock = (index: number) => {
		if (!blockItem) return;
		blockItem.acked.add(index);
		const active = activeIndices();
		if (active.length > 0 && active.every((i) => blockItem!.acked.has(i))) {
			blockItem = null;
		}
	};

	const errorBranch = (index: number, err: unknown) => {
		const branch = branches[index]!;
		if (branch.errored || branch.cancelled) return;
		branch.errored = true;
		branch.queue.length = 0;
		branch.branchError = err;
		const waiting = branch.waiting;
		releaseWaiting(branch);
		if (waiting) waiting.error(err);
		if (blockItem) ackBlock(index);
	};

	const closeBranch = (index: number) => {
		const branch = branches[index]!;
		const waiting = branch.waiting;
		releaseWaiting(branch);
		if (waiting) waiting.close();
		if (blockItem) ackBlock(index);
	};

	const pushToBranch = (index: number, value: T) => {
		const branch = branches[index]!;
		if (branch.cancelled || branch.errored) return;

		if (backpressure === "drop") {
			if (branch.queue.length >= bufferLimit!) branch.queue.shift();
			branch.queue.push(value);
			if (branch.waiting && branch.queue.length > 0) {
				const waiting = branch.waiting;
				releaseWaiting(branch);
				waiting.enqueue(branch.queue.shift()!);
			}
			return;
		}

		if (branch.queue.length >= bufferLimit!) {
			errorBranch(index, muxError({ code: "SOURCE_ERROR", source: String(index) }));
			return;
		}

		if (branch.waiting) {
			const waiting = branch.waiting;
			releaseWaiting(branch);
			waiting.enqueue(value);
			return;
		}

		branch.queue.push(value);
	};

	const finishSourceDone = () => {
		sourceDone = true;
		blockItem = null;
		for (let i = 0; i < n; i += 1) {
			if (!branches[i]!.cancelled && !branches[i]!.errored) closeBranch(i);
		}
	};

	const finishSourceError = (err: unknown) => {
		sourceDone = true;
		blockItem = null;
		for (let i = 0; i < n; i += 1) {
			if (!branches[i]!.cancelled && !branches[i]!.errored) errorBranch(i, err);
		}
	};

	const releaseWaiting = (branch: BranchState<T>) => {
		if (branch.waiting !== null) {
			branch.waiting = null;
			pendingDemand = Math.max(0, pendingDemand - 1);
			if (!anyActiveWaiting()) liveDemand = false;
		}
	};

	const readSource = async () => {
		await Promise.resolve();
		if (!allowSourceRead || allExplicitlyCancelled() || !liveDemand || pendingDemand <= 0) {
			return { kind: "noop" as const };
		}
		const result = await getReader().next();
		if (result.ok) return { kind: "value" as const, value: result.value };
		if ("error" in result && result.error !== undefined) {
			return { kind: "error" as const, error: result.error };
		}
		return { kind: "done" as const };
	};

	const deliverBlockItem = (): boolean => {
		const item = blockItem;
		if (!item) return false;

		let progressed = false;
		for (const i of activeIndices()) {
			if (item.acked.has(i)) continue;
			const branch = branches[i]!;
			if (!branch.waiting) continue;
			const waiting = branch.waiting;
			const value = item.value;
			releaseWaiting(branch);
			ackBlock(i);
			waiting.enqueue(value);
			progressed = true;
		}
		return progressed;
	};

	const pumpBlock = async (): Promise<boolean> => {
		if (allExplicitlyCancelled() || sourceDone) return false;
		if (!anyActiveWaiting()) return false;

		if (blockItem && deliverBlockItem()) return true;

		const active = activeIndices();
		if (active.length === 0) return false;
		if (blockItem !== null) return false;
		if (!canReadBlockSource()) return false;
		if (pendingDemand <= 0) return false;

		const next = await readSource();
		if (next.kind === "noop") return false;
		if (next.kind === "done") {
			finishSourceDone();
			return false;
		}
		if (next.kind === "error") {
			finishSourceError(next.error);
			return false;
		}

		blockItem = { value: next.value, acked: new Set() };
		return deliverBlockItem();
	};

	const pumpQueued = async (): Promise<boolean> => {
		if (allExplicitlyCancelled() || sourceDone) return false;

		for (const i of activeIndices()) {
			const branch = branches[i]!;
			if (branch.waiting && branch.queue.length > 0) {
				const waiting = branch.waiting;
				releaseWaiting(branch);
				waiting.enqueue(branch.queue.shift()!);
			}
		}

		const active = activeIndices();
		if (active.length === 0) return false;
		if (backpressure === "bounded" && pendingDemand <= 0) return false;

		const canRead =
			backpressure === "drop" ? true : active.some((i) => branches[i]!.queue.length < bufferLimit!);

		if (!canRead) return false;

		const next = await readSource();
		if (next.kind === "noop") return false;
		if (next.kind === "done") {
			finishSourceDone();
			return false;
		}
		if (next.kind === "error") {
			finishSourceError(next.error);
			return false;
		}

		for (const i of active) pushToBranch(i, next.value);
		return true;
	};

	const runPump = async () => {
		pumpRunning = true;
		try {
			while (pumpScheduled) {
				pumpScheduled = false;
				if (sourceDone || sourceCancelled) break;

				let progressed = true;
				while (progressed) {
					progressed = backpressure === "block" ? await pumpBlock() : await pumpQueued();
				}
			}
		} finally {
			pumpRunning = false;
			if (pumpScheduled) void runPump();
		}
	};

	const handlePull = (index: number, controller: ReadableStreamDefaultController<T>) => {
		const branch = branches[index]!;
		if (branch.cancelled) {
			controller.close();
			return;
		}
		if (branch.errored) {
			if (branch.branchError !== null) controller.error(branch.branchError);
			return;
		}

		if (backpressure !== "block" && branch.queue.length > 0) {
			controller.enqueue(branch.queue.shift()!);
			schedulePump();
			return;
		}

		if (sourceDone) {
			controller.close();
			return;
		}

		branch.waiting = controller;
		pendingDemand += 1;
		liveDemand = true;
		allowSourceRead = true;
		schedulePump();
	};

	const handleCancel = (index: number) => {
		const branch = branches[index]!;
		if (branch.cancelled) return;
		allowSourceRead = false;
		branch.cancelled = true;
		releaseWaiting(branch);
		branch.queue.length = 0;
		if (blockItem) ackBlock(index);
		void maybeCancelSource();
		if (!allExplicitlyCancelled() && anyActiveWaiting()) schedulePump();
	};

	const branchHighWaterMark = 0;

	return branches.map(
		(_, index) =>
			new ReadableStream<T>(
				{
					pull(controller) {
						handlePull(index, controller);
					},
					cancel() {
						handleCancel(index);
						return Promise.resolve();
					},
				},
				{ highWaterMark: branchHighWaterMark, size: () => 1 },
			),
	);
}
