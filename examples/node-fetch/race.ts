/**
 * Byte-mode race — production: replace fake bodies with fetch(url, { signal }).body!
 */
import { collect, race } from "llm-stream-mux";
import { fakeByteStream, fakeEmptyChunk, fakeGoodChunk } from "./_fake.js";

export async function main(): Promise<void> {
	const signal = AbortSignal.timeout(5000);
	const slow = fakeByteStream([fakeEmptyChunk(), fakeGoodChunk(99)], 30);
	const fast = fakeByteStream([fakeGoodChunk(42)], 0);

	const winner = race<Uint8Array>([slow, fast], {
		signal,
		timeoutMs: 5000,
		isUsable: (c) => c.byteLength > 0,
	});

	const out = await collect(winner);
	console.log(
		"race winner chunks:",
		out.map((c) => Array.from(c)),
	);
	if (out.length !== 1 || out[0]![0] !== 42) {
		throw new Error("expected fast stream [42]");
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
