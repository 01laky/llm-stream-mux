/**
 * Lazy failover — production: replace thunks with () => fetch(...).body!
 */
import { collect, fallback } from "llm-stream-mux";
import type { SourceEvent } from "llm-stream-mux";
import { fakeLazyBackup, fakeThrowingPrimary } from "./_fake.js";

type DemoEvent = { type: string; text?: string };

export async function main(): Promise<void> {
	const events: SourceEvent[] = [];
	const out = await collect(
		fallback<DemoEvent>(
			[fakeThrowingPrimary(), fakeLazyBackup([{ type: "text.delta", text: "backup" }])],
			{
				policy: "commit",
				isError: (e) => e.type === "error",
				onSourceEvent: (e) => events.push(e),
			},
		),
	);

	console.log("fallback output:", out);
	if (out.length !== 1 || out[0]?.text !== "backup") {
		throw new Error("expected backup event");
	}
	const failover = events.find((e) => e.type === "failover");
	if (!failover) {
		throw new Error("expected failover SourceEvent");
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
