/**
 * Tagged merge — production: use parsed event streams from assemble per source.
 */
import { merge } from "llm-stream-mux";
import type { SourceEvent } from "llm-stream-mux";
import { fakeEvents, fakeTaggedSources } from "./_fake.js";

type DemoEvent = { type: string; text?: string };

export async function main(): Promise<void> {
	const events: SourceEvent[] = [];
	const bad = fakeEvents<DemoEvent>([{ type: "error" }]);
	const good = fakeTaggedSources();

	const tags = [];
	for await (const tagged of merge(
		{ bad: bad, ...good },
		{
			failFast: false,
			isError: (e) => e.type === "error",
			onSourceEvent: (e) => events.push(e),
		},
	)) {
		tags.push(tagged);
	}

	const values = tags.filter((t) => t.kind === "value");
	const errors = tags.filter((t) => t.kind === "error");
	console.log("merge values:", values.length, "errors:", errors.length);
	if (values.length < 2 || errors.length < 1) {
		throw new Error("expected 2 value tags and 1 error tag");
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
