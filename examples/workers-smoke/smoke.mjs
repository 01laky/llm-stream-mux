/**
 * Workers-compatible import smoke — no Node builtins.
 * Run after: npm pack && npm install ./llm-stream-mux-*.tgz
 */
import { MUX_PKG_VERSION, collect, race } from "llm-stream-mux";

const out = await collect(
	race([
		(async function* () {
			yield 1;
		})(),
	]),
);

if (out.length !== 1 || out[0] !== 1) {
	throw new Error("workers-smoke race failed");
}

if (typeof MUX_PKG_VERSION !== "string" || MUX_PKG_VERSION.length === 0) {
	throw new Error("workers-smoke version missing");
}

console.log(`OK: workers-smoke MUX_PKG_VERSION=${MUX_PKG_VERSION}`);
