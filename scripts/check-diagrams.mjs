import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const imgDir = join(root, "docs/img");

const diagrams = [
	"pipeline.mmd",
	"ecosystem.mmd",
	"strategies-overview.mmd",
	"quick-decision.mmd",
	"byte-event-modes.mmd",
	"merge-tagged.mmd",
	"public-api-types.mmd",
	"core-internals.mmd",
];

const errors = [];

for (const name of diagrams) {
	const mmd = join(imgDir, name);
	const svg = join(imgDir, name.replace(/\.mmd$/, ".svg"));
	if (!existsSync(svg)) {
		errors.push(
			`missing SVG: docs/img/${name.replace(/\.mmd$/, ".svg")} — run pnpm diagrams:build`,
		);
		continue;
	}
	if (!existsSync(mmd)) {
		errors.push(`missing source: docs/img/${name}`);
		continue;
	}
	if (statSync(svg).mtimeMs < statSync(mmd).mtimeMs) {
		errors.push(`stale SVG for ${name} — run pnpm diagrams:build`);
	}
}

if (errors.length > 0) {
	for (const e of errors) console.error(e);
	process.exit(1);
}

console.log(`OK: ${diagrams.length} diagram SVG(s) present and up to date`);
