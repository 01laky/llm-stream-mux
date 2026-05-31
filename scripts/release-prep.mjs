#!/usr/bin/env node
/**
 * Pre-release checks for llm-stream-mux.
 * Does not tag, publish, or mutate git — prints actionable next steps.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
	return readFileSync(join(rootDir, path), "utf8");
}

function ok(message) {
	console.log(`OK: ${message}`);
}

function run(cmd, args, opts = {}) {
	execFileSync(cmd, args, { cwd: rootDir, stdio: "inherit", ...opts });
}

const errors = [];

if (!existsSync(join(rootDir, "package.json"))) {
	console.error("Missing package.json");
	process.exit(1);
}

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;
const tag = `v${version}`;
const full = process.argv.includes("--full");

console.log(`Release prep for llm-stream-mux@${version}${full ? " (--full)" : ""}\n`);

if (!existsSync(join(rootDir, "CHANGELOG.md"))) {
	errors.push("Missing CHANGELOG.md");
} else {
	const changelog = read("CHANGELOG.md");
	if (!changelog.includes(`## [${version}]`)) {
		errors.push(`CHANGELOG.md missing ## [${version}] header`);
	} else {
		const section = changelog.split(`## [${version}]`)[1]?.split(/^## \[/m)[0] ?? "";
		if (section.trim().length < 20) {
			errors.push(`CHANGELOG.md [${version}] section appears empty`);
		} else {
			ok(`CHANGELOG has [${version}] section`);
		}
	}
}

const indexSrc = read("src/index.ts");
const muxMatch = indexSrc.match(/MUX_PKG_VERSION\s*=\s*"([^"]+)"/);
if (!muxMatch) {
	errors.push("src/index.ts missing MUX_PKG_VERSION");
} else if (muxMatch[1] !== version) {
	errors.push(`MUX_PKG_VERSION ${muxMatch[1]} !== package.json ${version}`);
} else {
	ok("MUX_PKG_VERSION matches package.json");
}

if (!existsSync(join(rootDir, "README.md"))) {
	errors.push("Missing README.md");
} else {
	const readme = read("README.md");
	if (!readme.includes(version)) {
		errors.push(`README.md should reference version ${version}`);
	} else {
		ok("README references version");
	}
}

if (!existsSync(join(rootDir, "dist"))) {
	errors.push("Missing dist/ — run pnpm build before release");
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

try {
	run("node", ["scripts/verify-docs.mjs"]);
} catch {
	errors.push("verify:docs failed");
}

if (existsSync(join(rootDir, "dist/index.d.ts"))) {
	try {
		run("pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.examples.json"], { stdio: "pipe" });
		ok("examples typecheck against dist");
	} catch {
		errors.push("typecheck:examples failed");
	}
}

const temp = mkdtempSync(join(tmpdir(), "lsm-release-prep-pack-"));
try {
	execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: rootDir, stdio: "pipe" });
	const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
	if (!tarball) {
		errors.push("npm pack produced no tarball");
	} else {
		const listing = execFileSync("tar", ["-tzf", join(temp, tarball)], { encoding: "utf8" });
		const paths = listing
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const packErrors = [];
		for (const p of paths) {
			if (/\/(test|examples|docs|prompts)(\/|$)/.test(p)) {
				packErrors.push(`npm pack must not include: ${p}`);
			}
		}
		if (!paths.some((p) => p.includes("dist/index.d.ts"))) {
			packErrors.push("npm pack missing dist/index.d.ts");
		}
		if (packErrors.length === 0) {
			ok("npm pack manifest (dist only, no test/examples/docs)");
		} else {
			errors.push(...packErrors);
		}
	}
} catch {
	errors.push("npm pack audit failed");
} finally {
	rmSync(temp, { recursive: true, force: true });
}

if (!existsSync(join(rootDir, "docs/STABILITY.md"))) {
	errors.push("Missing docs/STABILITY.md");
} else {
	const stability = read("docs/STABILITY.md");
	if (!stability.includes("1.0.0")) {
		errors.push("docs/STABILITY.md should reference 1.0.0 freeze/handoff");
	} else {
		ok("docs/STABILITY.md present");
	}
}

if (!existsSync(join(rootDir, "scripts/smoke-runtimes.mjs"))) {
	errors.push("Missing scripts/smoke-runtimes.mjs");
} else {
	ok("scripts/smoke-runtimes.mjs present");
}

if (!existsSync(join(rootDir, "scripts/smoke-consumer.mjs"))) {
	errors.push("Missing scripts/smoke-consumer.mjs");
} else {
	ok("scripts/smoke-consumer.mjs present");
}

if (!existsSync(join(rootDir, "SECURITY.md"))) {
	errors.push("Missing SECURITY.md");
} else {
	ok("SECURITY.md present");
}

if (!existsSync(join(rootDir, "docs/RELEASE.md"))) {
	errors.push("Missing docs/RELEASE.md");
} else {
	ok("docs/RELEASE.md present");
}

if (!existsSync(join(rootDir, "examples/workers-smoke/README.md"))) {
	errors.push("Missing examples/workers-smoke/README.md");
} else {
	ok("examples/workers-smoke fixture present");
}

if (pkg.private === true) {
	errors.push("package.json must not set private: true for publish");
} else {
	ok("package.json not private");
}

for (const field of ["license", "repository", "exports", "files", "engines"]) {
	if (pkg[field] === undefined) {
		errors.push(`package.json missing ${field}`);
	} else {
		ok(`package.json has ${field}`);
	}
}

if (pkg.publishConfig?.access !== "public") {
	errors.push("package.json must set publishConfig.access to public");
} else {
	ok("publishConfig.access is public");
}

if (full) {
	try {
		run("node", ["scripts/smoke-runtimes.mjs", "--ci"], { stdio: "pipe" });
		ok("smoke-runtimes --ci passed");
	} catch {
		errors.push("smoke-runtimes --ci failed");
	}
	try {
		run("node", ["scripts/smoke-consumer.mjs"], { stdio: "pipe" });
		ok("smoke-consumer passed");
	} catch {
		errors.push("smoke-consumer failed");
	}
	try {
		run("node", ["scripts/bench-smoke.mjs", "--warn"], { stdio: "inherit" });
		ok("bench-smoke --warn completed");
	} catch {
		errors.push("bench-smoke failed");
	}
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
  # Optional pre-release: mark GitHub pre-release for ${version}
  # At 1.0.0 only: follow docs/STABILITY.md + docs/RELEASE.md
  npm publish --provenance --access public
`);
