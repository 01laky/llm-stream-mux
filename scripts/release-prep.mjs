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

console.log(`Release prep for llm-stream-mux@${version}\n`);

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

if (errors.length > 0) {
	console.error("\nRelease prep FAILED:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log(`
Next steps (manual):
  git tag ${tag}
  git push origin ${tag}
  npm publish --access public   # at 1.0.0 when API is frozen
`);
