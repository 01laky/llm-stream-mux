/**
 * Tee fan-out — production: tee(fetch(...).body!) for client + logger branches.
 */
import { collect, tee, toAsyncIterable } from "llm-stream-mux";
import { fakeNumericStream } from "./_fake.js";

export async function main(): Promise<void> {
	const source = fakeNumericStream([1, 2, 3, 4, 5]);
	const branches = tee(source, 2, { backpressure: "bounded", bufferLimit: 4 });
	const client = branches[0]!;
	const logger = branches[1]!;

	const [a, b] = await Promise.all([
		collect(toAsyncIterable(client)),
		collect(toAsyncIterable(logger)),
	]);

	console.log("tee branches:", a, b);
	if (JSON.stringify(a) !== JSON.stringify(b) || a.length !== 5) {
		throw new Error("expected identical [1..5] on both branches");
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
