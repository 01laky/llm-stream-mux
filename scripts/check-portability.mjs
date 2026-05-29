#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const srcDir = join(root, "src");

const forbidden = [
	{ pattern: /ReadableStream\.from\b/, reason: "ReadableStream.from (Node 20+)" },
	{ pattern: /from\s+["']node:stream/, reason: "node:stream import" },
	{ pattern: /from\s+["']node:events/, reason: "node:events import" },
	{ pattern: /from\s+["']node:buffer/, reason: "node:buffer import" },
	{
		pattern: /ReadableStream\[Symbol\.asyncIterator\]/,
		reason: "ReadableStream asyncIterator trap",
	},
];

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (path.endsWith(".ts")) out.push(path);
	}
	return out;
}

const errors = [];
for (const file of walk(srcDir)) {
	const body = readFileSync(file, "utf8");
	const rel = file.slice(root.length + 1);
	for (const rule of forbidden) {
		if (rule.pattern.test(body)) {
			errors.push(`${rel}: forbidden ${rule.reason}`);
		}
	}
}

if (errors.length > 0) {
	console.error("Portability check FAILED:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log("OK: portability checks passed");
