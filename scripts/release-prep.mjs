#!/usr/bin/env node
/**
 * Pre-release checks for llm-stream-mux.
 * Does not tag, publish, or mutate git — prints actionable next steps.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
	return readFileSync(join(rootDir, path), "utf8");
}

function ok(message) {
	console.log(`OK: ${message}`);
}

function run(cmd, args) {
	execFileSync(cmd, args, { cwd: rootDir, stdio: "inherit" });
}

const errors = [];

if (!existsSync(join(rootDir, "package.json"))) {
	console.error("Missing package.json");
	process.exit(1);
}

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;
const tag = `v${version}`;

console.log(`Release prep for llm-stream-mux@${version}\n`);

if (!existsSync(join(rootDir, "CHANGELOG.md"))) {
	errors.push("Missing CHANGELOG.md");
} else {
	const changelog = read("CHANGELOG.md");
	if (!changelog.includes(`## [${version}]`)) {
		errors.push(`CHANGELOG.md missing ## [${version}] header`);
	} else {
		ok(`CHANGELOG has [${version}] section`);
	}
}

if (!existsSync(join(rootDir, "README.md"))) {
	errors.push("Missing README.md");
} else {
	const readme = read("README.md");
	if (
		version.startsWith("0.") &&
		!readme.includes("pre-implementation") &&
		!readme.includes(version)
	) {
		errors.push(`README.md should reference status or version ${version}`);
	} else {
		ok("README status section present");
	}
}

if (!existsSync(join(rootDir, "dist"))) {
	errors.push("Missing dist/ — run pnpm build before release (P0+)");
} else {
	ok("dist/ exists");
}

try {
	run("node", ["scripts/verify-zero-deps.mjs"]);
} catch {
	errors.push("verify:deps failed");
}

try {
	run("node", ["scripts/check-diagrams.mjs"]);
} catch {
	errors.push("diagrams:check failed");
}

if (errors.length > 0) {
	console.error("\nRelease prep FAILED:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log(`
Next steps (manual):
  git tag ${tag}
  git push origin ${tag}
  npm publish --access public   # when dist/ and API are ready (1.0.0)
`);
