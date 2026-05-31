#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const temp = mkdtempSync(join(tmpdir(), "llm-stream-mux-smoke-"));

try {
	execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
	const tarball = readdirSync(temp).find((file) => file.endsWith(".tgz"));
	if (!tarball) throw new Error("npm pack did not produce a tarball");

	writeFileSync(
		join(temp, "package.json"),
		JSON.stringify({ type: "module", dependencies: {} }, null, 2),
	);

	execFileSync("npm", ["install", "--ignore-scripts", join(temp, tarball)], {
		cwd: temp,
		stdio: "pipe",
	});

	writeFileSync(
		join(temp, "esm.mjs"),
		`
import { MUX_PKG_VERSION, MUX_ERROR_CODES, collect, race, tee, fallback, merge, ensemble, toAsyncIterable } from "llm-stream-mux";
if (MUX_PKG_VERSION !== ${JSON.stringify(version)}) throw new Error("ESM version mismatch");
if (!Array.isArray(MUX_ERROR_CODES) || MUX_ERROR_CODES.length !== 6) throw new Error("ESM codes");
const empty = await collect((async function* () {})());
if (empty.length !== 0) throw new Error("ESM collect");
const teeBranches = tee((async function* () {})(), 2);
if (teeBranches.length !== 2) throw new Error("ESM tee");
await teeBranches[1].cancel();
const teeEmpty = await collect(toAsyncIterable(teeBranches[0]));
if (teeEmpty.length !== 0) throw new Error("ESM tee drain");
const raceOut = await collect(race([
  (async function* () { yield 1; })(),
  (async function* () { yield 2; })(),
]));
if (raceOut.length !== 1 || raceOut[0] !== 1) throw new Error("ESM race");
const fbOut = await collect(fallback([
  (async function* () { throw new Error("fail"); })(),
  (async function* () { yield 42; })(),
]));
if (fbOut.length !== 1 || fbOut[0] !== 42) throw new Error("ESM fallback");
if (ensemble !== merge) throw new Error("ESM ensemble");
const mergeTags = await collect(merge([
  (async function* () { yield 1; })(),
  (async function* () { yield 2; })(),
]));
if (mergeTags.filter((t) => t.kind === "value").length !== 2) throw new Error("ESM merge");
const raceTimeoutOut = await collect(race([
  (async function* () { yield 1; })(),
], { timeoutMs: 60000 }));
if (raceTimeoutOut[0] !== 1) throw new Error("ESM race timeoutMs");
const mergeTimeoutIter = merge([
  (async function* () { yield 1; })(),
], { overallTimeoutMs: 60000 })[Symbol.asyncIterator]();
const mergeTimeoutStep = await mergeTimeoutIter.next();
if (mergeTimeoutStep.done || mergeTimeoutStep.value.kind !== "value") throw new Error("ESM merge overallTimeoutMs");
await mergeTimeoutIter.return();
`,
	);

	writeFileSync(
		join(temp, "cjs.mjs"),
		`
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { MUX_PKG_VERSION, MUX_ERROR_CODES, collect, race, tee, fallback, merge, ensemble, toAsyncIterable } = require("llm-stream-mux");
if (MUX_PKG_VERSION !== ${JSON.stringify(version)}) throw new Error("CJS version mismatch");
if (!Array.isArray(MUX_ERROR_CODES) || MUX_ERROR_CODES.length !== 6) throw new Error("CJS codes");
const empty = await collect((async function* () {})());
if (empty.length !== 0) throw new Error("CJS collect");
const teeBranches = tee((async function* () {})(), 2);
if (teeBranches.length !== 2) throw new Error("CJS tee");
await teeBranches[1].cancel();
const teeEmpty = await collect(toAsyncIterable(teeBranches[0]));
if (teeEmpty.length !== 0) throw new Error("CJS tee drain");
const raceOut = await collect(race([
  (async function* () { yield 1; })(),
  (async function* () { yield 2; })(),
]));
if (raceOut.length !== 1 || raceOut[0] !== 1) throw new Error("CJS race");
const fbOut = await collect(fallback([
  (async function* () { throw new Error("fail"); })(),
  (async function* () { yield 42; })(),
]));
if (fbOut.length !== 1 || fbOut[0] !== 42) throw new Error("CJS fallback");
if (ensemble !== merge) throw new Error("CJS ensemble");
const mergeTags = await collect(merge([
  (async function* () { yield 1; })(),
  (async function* () { yield 2; })(),
]));
if (mergeTags.filter((t) => t.kind === "value").length !== 2) throw new Error("CJS merge");
const raceTimeoutOut = await collect(race([
  (async function* () { yield 1; })(),
], { timeoutMs: 60000 }));
if (raceTimeoutOut[0] !== 1) throw new Error("CJS race timeoutMs");
const mergeTimeoutIter = merge([
  (async function* () { yield 1; })(),
], { overallTimeoutMs: 60000 })[Symbol.asyncIterator]();
const mergeTimeoutStep = await mergeTimeoutIter.next();
if (mergeTimeoutStep.done || mergeTimeoutStep.value.kind !== "value") throw new Error("CJS merge overallTimeoutMs");
await mergeTimeoutIter.return();
`,
	);

	execFileSync("node", ["esm.mjs"], { cwd: temp, stdio: "pipe" });
	execFileSync("node", ["cjs.mjs"], { cwd: temp, stdio: "pipe" });
	console.log("OK: package smoke test passed");
} finally {
	rmSync(temp, { recursive: true, force: true });
}
