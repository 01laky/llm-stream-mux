#!/usr/bin/env node
/**
 * Multi-runtime smoke: install from npm pack tarball, import public API on Node (+ Bun/Deno when available).
 * --ci          fail if bun or deno missing (GitHub Actions)
 * --skip-optional  run Node only; warn if bun/deno absent (local dev default when neither flag set)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const ci = args.includes("--ci");
const skipOptional = args.includes("--skip-optional") || (!ci && !args.includes("--require-all"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

if (!existsSync(join(root, "dist/index.js")) || !existsSync(join(root, "dist/index.d.ts"))) {
	console.error("Missing dist/ — run pnpm build first");
	process.exit(1);
}

function which(cmd) {
	try {
		execFileSync("which", [cmd], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function runRuntime(label, command, commandArgs, cwd) {
	try {
		execFileSync(command, commandArgs, { cwd, stdio: "pipe" });
		console.log(`OK: ${label} smoke passed`);
	} catch (err) {
		console.error(`${label} smoke failed`);
		if (err.stderr) process.stderr.write(err.stderr);
		if (err.stdout) process.stdout.write(err.stdout);
		process.exit(1);
	}
}

const temp = mkdtempSync(join(tmpdir(), "llm-stream-mux-runtimes-"));

try {
	execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
	const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
	if (!tarball) throw new Error("npm pack produced no tarball");

	writeFileSync(join(temp, "package.json"), JSON.stringify({ type: "module" }, null, 2));
	execFileSync("npm", ["install", "--ignore-scripts", join(temp, tarball)], {
		cwd: temp,
		stdio: "pipe",
	});

	writeFileSync(
		join(temp, "smoke.mjs"),
		`import { race, merge, collect, MUX_PKG_VERSION } from "llm-stream-mux";
if (MUX_PKG_VERSION !== ${JSON.stringify(version)}) {
  throw new Error(\`version mismatch: \${MUX_PKG_VERSION}\`);
}
const raceOut = await collect(race([
  (async function* () { yield 1; })(),
  (async function* () { yield 2; })(),
]));
if (raceOut.length !== 1 || raceOut[0] !== 1) throw new Error("race smoke");
const mergeEmpty = await collect(merge([]));
if (mergeEmpty.length !== 0) throw new Error("merge empty smoke");
`,
	);

	runRuntime("Node", "node", ["smoke.mjs"], temp);

	const optionalRuntimes = [
		{ label: "Bun", cmd: "bun", args: ["smoke.mjs"] },
		{ label: "Deno", cmd: "deno", args: ["run", "--allow-read", "smoke.mjs"] },
	];

	for (const { label, cmd, args: cmdArgs } of optionalRuntimes) {
		if (which(cmd)) {
			runRuntime(label, cmd, cmdArgs, temp);
		} else if (ci) {
			console.error(`Missing ${cmd} on PATH (--ci requires Node, Bun, and Deno)`);
			process.exit(1);
		} else if (skipOptional) {
			console.warn(`WARN: skipping ${label} smoke (${cmd} not on PATH)`);
		} else {
			console.error(`Missing ${cmd} on PATH`);
			process.exit(1);
		}
	}

	console.log("OK: smoke-runtimes passed");
} finally {
	rmSync(temp, { recursive: true, force: true });
}
