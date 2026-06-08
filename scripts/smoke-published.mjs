#!/usr/bin/env node
/**
 * Post-pack publish simulation — npm install from tarball (ESM + CJS).
 * Flags: --node22, --node24, --all-runtimes (skip missing with warn).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const args = process.argv.slice(2);
const allRuntimes = args.includes("--all-runtimes");
const nodeFlags = allRuntimes
	? ["--node22", "--node24"]
	: args.filter((a) => a === "--node22" || a === "--node24");

function findNode(flag) {
	const major = flag === "--node22" ? "22" : "24";
	for (const bin of [`node${major}`, `node-v${major}`, `node`]) {
		try {
			const out = execFileSync(bin, ["-v"], { encoding: "utf8", stdio: "pipe" }).trim();
			if (out.startsWith(`v${major}.`)) return bin;
		} catch {
			/* try next */
		}
	}
	return null;
}

function runConsumer(nodeBin) {
	const temp = mkdtempSync(join(tmpdir(), "llm-stream-mux-published-"));
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
if (MUX_PKG_VERSION !== ${JSON.stringify(version)}) throw new Error("published smoke version");
const raceOut = await collect(race([
  (async function* () { yield 1; })(),
  (async function* () { yield 2; })(),
]));
if (raceOut.length !== 1 || raceOut[0] !== 1) throw new Error("published smoke race");
const mergeOut = await collect(merge([]));
if (mergeOut.length !== 0) throw new Error("published smoke merge empty");
`,
		);

		writeFileSync(
			join(temp, "consumer-cjs.cjs"),
			`
const { MUX_PKG_VERSION, collect, race, merge } = require("llm-stream-mux");
(async () => {
  if (MUX_PKG_VERSION !== ${JSON.stringify(version)}) throw new Error("published smoke CJS version");
  const raceOut = await collect(race([
    (async function* () { yield 1; })(),
    (async function* () { yield 2; })(),
  ]));
  if (raceOut.length !== 1 || raceOut[0] !== 1) throw new Error("published smoke CJS race");
})();
`,
		);

		execFileSync(nodeBin, ["consumer-esm.mjs"], { cwd: temp, stdio: "pipe" });
		execFileSync(nodeBin, ["consumer-cjs.cjs"], { cwd: temp, stdio: "pipe" });
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

const runners = nodeFlags.length > 0 ? nodeFlags : [null];

for (const flag of runners) {
	const nodeBin = flag ? findNode(flag) : process.execPath;
	if (flag && !nodeBin) {
		if (allRuntimes) {
			console.warn(`WARN: skip smoke-published ${flag} — Node not on PATH`);
			continue;
		}
		throw new Error(`${flag} requested but Node binary not found`);
	}
	runConsumer(nodeBin ?? process.execPath);
	console.log(`OK: smoke-published passed (${flag ?? "default"})`);
}
