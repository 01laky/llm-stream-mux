#!/usr/bin/env node
/** Runtime npm pack audit — tarball contents match publish contract (REL-12t). */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "lsm-verify-pack-"));
const errors = [];

try {
	execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
	const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
	if (!tarball) throw new Error("npm pack produced no tarball");

	const listing = execFileSync("tar", ["-tzf", join(temp, tarball)], { encoding: "utf8" });
	const paths = listing
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (const p of paths) {
		if (/\/(src|test|examples|docs|prompts|scripts|\.github)(\/|$)/.test(p)) {
			errors.push(`forbidden path in pack: ${p}`);
		}
	}

	const required = ["dist/index.js", "dist/index.cjs", "dist/index.d.ts", "README.md", "LICENSE"];
	for (const req of required) {
		if (!paths.some((p) => p.includes(`package/${req}`) || p.endsWith(req))) {
			errors.push(`missing in pack: ${req}`);
		}
	}
} catch (err) {
	errors.push(String(err));
} finally {
	rmSync(temp, { recursive: true, force: true });
}

if (errors.length > 0) {
	console.error("verify-pack FAILED:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log("OK: npm pack manifest matches publish contract");
