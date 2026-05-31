#!/usr/bin/env node
/**
 * Downstream consumer smoke — ESM import + CJS require from npm pack tarball.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const temp = mkdtempSync(join(tmpdir(), "llm-stream-mux-consumer-"));

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
		join(temp, "consumer-esm.mjs"),
		`
import { MUX_PKG_VERSION, collect, race, merge } from "llm-stream-mux";
if (MUX_PKG_VERSION !== ${JSON.stringify(version)}) throw new Error("ESM consumer version");
const raceOut = await collect(race([
  (async function* () { yield 1; })(),
  (async function* () { yield 2; })(),
]));
if (raceOut.length !== 1 || raceOut[0] !== 1) throw new Error("ESM consumer race");
const mergeOut = await collect(merge([]));
if (mergeOut.length !== 0) throw new Error("ESM consumer merge empty");
`,
	);

	writeFileSync(
		join(temp, "consumer-cjs.cjs"),
		`
const { MUX_PKG_VERSION, collect, race, merge } = require("llm-stream-mux");
(async () => {
  if (MUX_PKG_VERSION !== ${JSON.stringify(version)}) throw new Error("CJS consumer version");
  const raceOut = await collect(race([
    (async function* () { yield 1; })(),
    (async function* () { yield 2; })(),
  ]));
  if (raceOut.length !== 1 || raceOut[0] !== 1) throw new Error("CJS consumer race");
  const mergeOut = await collect(merge([]));
  if (mergeOut.length !== 0) throw new Error("CJS consumer merge empty");
})();
`,
	);

	execFileSync("node", ["consumer-esm.mjs"], { cwd: temp, stdio: "pipe" });
	execFileSync("node", ["consumer-cjs.cjs"], { cwd: temp, stdio: "pipe" });
	console.log("OK: consumer smoke test passed (ESM + CJS)");
} finally {
	rmSync(temp, { recursive: true, force: true });
}
