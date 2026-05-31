#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const imgDir = join(rootDir, "docs/img");

const diagrams = [
	"pipeline.mmd",
	"ecosystem.mmd",
	"strategies-overview.mmd",
	"quick-decision.mmd",
	"byte-event-modes.mmd",
	"merge-tagged.mmd",
	"public-api-types.mmd",
	"core-internals.mmd",
	"tee-fanout.mmd",
	"race-win.mmd",
	"fallback-failover.mmd",
];

for (const name of diagrams) {
	const input = join(imgDir, name);
	const output = join(imgDir, name.replace(/\.mmd$/, ".svg"));
	console.log(`render ${name} → ${name.replace(/\.mmd$/, ".svg")}`);
	execFileSync(
		"npx",
		["--yes", "@mermaid-js/mermaid-cli", "-i", input, "-o", output, "-b", "transparent"],
		{ cwd: rootDir, stdio: "inherit" },
	);
}

console.log(`OK: ${diagrams.length} diagram(s) rendered`);
