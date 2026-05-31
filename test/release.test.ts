import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MUX_PKG_VERSION } from "../src/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** npm pack + install is slow on CI runners; default vitest 5s is too tight. */
const TARBALL_SMOKE_MS = 20_000;

function readPkg() {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		version: string;
		dependencies?: Record<string, string>;
		exports?: Record<string, { import?: string; require?: string; types?: string }>;
	};
}

function exportPath(relative: string) {
	return join(root, relative.replace(/^\.\//, ""));
}

const COMMON_OPTION_FIELDS = [
	"timeoutMs",
	"overallTimeoutMs",
	"highWaterMark",
	"sourceHighWaterMark",
] as const;

function expectCommonOptionsInDts(dts: string): void {
	for (const field of COMMON_OPTION_FIELDS) {
		expect(dts).toContain(`${field}?:`);
	}
}

describe("LSM-REL-01 release scaffold", () => {
	it("LSM-REL-01 MUX_PKG_VERSION matches package.json", () => {
		expect(MUX_PKG_VERSION).toBe(readPkg().version);
	});

	it("LSM-REL-01 has zero runtime dependencies", () => {
		expect(Object.keys(readPkg().dependencies ?? {})).toEqual([]);
	});

	it("LSM-REL-01 build artifacts exist on disk", () => {
		for (const file of [
			"dist/index.js",
			"dist/index.cjs",
			"dist/index.d.ts",
			"dist/index.js.map",
			"dist/index.cjs.map",
		]) {
			expect(existsSync(join(root, file)), file).toBe(true);
		}
	});

	it("LSM-REL-01 package exports map paths exist", () => {
		const sub = readPkg().exports?.["."];
		expect(sub).toBeDefined();
		for (const key of ["import", "require", "types"] as const) {
			const rel = sub?.[key];
			expect(rel, key).toBeTruthy();
			expect(existsSync(exportPath(rel!)), rel).toBe(true);
		}
	});

	it("LSM-REL-01 bundled ESM output has no npm runtime imports", () => {
		const body = readFileSync(join(root, "dist/index.js"), "utf8");
		expect(body).not.toContain("node_modules");
		expect(body).not.toMatch(/from\s+["'](?!\.|\/)@/);
	});

	it("LSM-REL-01 smoke:package passes from npm pack tarball", { timeout: TARBALL_SMOKE_MS }, () => {
		execFileSync("node", ["scripts/smoke-package.mjs"], { cwd: root, stdio: "pipe" });
	});
});

describe("LSM-REL-03 dist interop contract", () => {
	it("LSM-REL-03 dist index.d.ts declares interop helpers", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expect(dts).toMatch(/declare function collect\b/);
		expect(dts).toMatch(/declare function toReadable\b/);
		expect(dts).toMatch(/declare function toAsyncIterable\b/);
		expect(dts).not.toMatch(/declare function muxError\b/);
		expect(dts).not.toContain("normalizeSource");
		expect(dts).not.toContain("createTelemetry");
	});

	it("LSM-REL-03 bundled output exports collect without node_modules", () => {
		for (const file of ["dist/index.js", "dist/index.cjs"]) {
			const body = readFileSync(join(root, file), "utf8");
			expect(body).toContain("collect");
			expect(body).not.toContain("node_modules");
			expect(body).not.toMatch(/export \{[^}]*muxError/);
		}
	});
});

describe("LSM-REL-04 tee dist contract", () => {
	it("LSM-REL-04a tee runtime smoke from tarball", { timeout: TARBALL_SMOKE_MS }, () => {
		const temp = mkdtempSync(join(tmpdir(), "lsm-tee-smoke-"));
		try {
			execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
			const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
			expect(tarball).toBeTruthy();

			writeFileSync(
				join(temp, "package.json"),
				JSON.stringify({ type: "module", dependencies: {} }, null, 2),
			);
			execFileSync("npm", ["install", "--ignore-scripts", join(temp, tarball!)], {
				cwd: temp,
				stdio: "pipe",
			});

			writeFileSync(
				join(temp, "esm.mjs"),
				`import { tee, collect, toAsyncIterable } from "llm-stream-mux";
const branches = tee((async function* () {})(), 2);
if (branches.length !== 2) throw new Error("branch count");
await branches[1].cancel();
const empty = await collect(toAsyncIterable(branches[0]));
if (empty.length !== 0) throw new Error("tee drain");`,
			);
			writeFileSync(
				join(temp, "cjs.mjs"),
				`import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { tee, collect, toAsyncIterable } = require("llm-stream-mux");
const branches = tee((async function* () {})(), 2);
if (branches.length !== 2) throw new Error("branch count");
await branches[1].cancel();
const empty = await collect(toAsyncIterable(branches[0]));
if (empty.length !== 0) throw new Error("tee drain");`,
			);
			execFileSync("node", ["esm.mjs"], { cwd: temp, stdio: "pipe" });
			execFileSync("node", ["cjs.mjs"], { cwd: temp, stdio: "pipe" });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("LSM-REL-04b tee in d.ts race fallback merge ensemble present", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expect(dts).toMatch(/declare function tee\b/);
		expect(dts).toMatch(/declare function race\b/);
		expect(dts).toMatch(/declare function fallback\b/);
		expect(dts).toMatch(/declare function merge\b/);
		expect(dts).toMatch(/declare const ensemble\b/);
		expectCommonOptionsInDts(dts);
		expect(dts).not.toContain("normalizeSource");
		expect(dts).not.toContain("createTelemetry");
		expect(dts).not.toMatch(/declare function muxError\b/);
		for (const file of ["dist/index.js", "dist/index.cjs"]) {
			const body = readFileSync(join(root, file), "utf8");
			expect(body).toContain("tee");
			expect(body).not.toContain("node_modules");
		}
	});
});

describe("LSM-REL-05 race dist contract", () => {
	it("LSM-REL-05a race runtime smoke from tarball", { timeout: TARBALL_SMOKE_MS }, () => {
		const temp = mkdtempSync(join(tmpdir(), "lsm-race-smoke-"));
		try {
			execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
			const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
			expect(tarball).toBeTruthy();

			writeFileSync(
				join(temp, "package.json"),
				JSON.stringify({ type: "module", dependencies: {} }, null, 2),
			);
			execFileSync("npm", ["install", "--ignore-scripts", join(temp, tarball!)], {
				cwd: temp,
				stdio: "pipe",
			});

			writeFileSync(
				join(temp, "esm.mjs"),
				`import { race, collect } from "llm-stream-mux";
const out = await collect(race([
  (async function* () { yield 1; yield 2; })(),
  (async function* () { yield 9; })(),
]));
if (out.length !== 2 || out[0] !== 1 || out[1] !== 2) throw new Error("race winner");`,
			);
			writeFileSync(
				join(temp, "cjs.mjs"),
				`import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { race, collect } = require("llm-stream-mux");
(async () => {
  const out = await collect(race([
    (async function* () { yield 1; yield 2; })(),
    (async function* () { yield 9; })(),
  ]));
  if (out.length !== 2 || out[0] !== 1 || out[1] !== 2) throw new Error("race winner");
})();`,
			);
			execFileSync("node", ["esm.mjs"], { cwd: temp, stdio: "pipe" });
			execFileSync("node", ["cjs.mjs"], { cwd: temp, stdio: "pipe" });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("LSM-REL-05b race in d.ts fallback merge ensemble present", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expect(dts).toMatch(/declare function race\b/);
		expect(dts).toMatch(/declare function fallback\b/);
		expect(dts).toMatch(/declare function merge\b/);
		expect(dts).toMatch(/declare const ensemble\b/);
		expectCommonOptionsInDts(dts);
		expect(dts).not.toContain("normalizeSource");
		expect(dts).not.toContain("createTelemetry");
		expect(dts).not.toMatch(/declare function muxError\b/);
		for (const file of ["dist/index.js", "dist/index.cjs"]) {
			const body = readFileSync(join(root, file), "utf8");
			expect(body).toContain("race");
			expect(body).not.toContain("node_modules");
		}
	});
});

describe("LSM-REL-06 fallback dist contract", () => {
	it("LSM-REL-06a fallback runtime smoke from tarball", { timeout: TARBALL_SMOKE_MS }, () => {
		const temp = mkdtempSync(join(tmpdir(), "lsm-fallback-smoke-"));
		try {
			execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
			const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
			expect(tarball).toBeTruthy();

			writeFileSync(
				join(temp, "package.json"),
				JSON.stringify({ type: "module", dependencies: {} }, null, 2),
			);
			execFileSync("npm", ["install", "--ignore-scripts", join(temp, tarball!)], {
				cwd: temp,
				stdio: "pipe",
			});

			writeFileSync(
				join(temp, "esm.mjs"),
				`import { fallback, collect } from "llm-stream-mux";
const out = await collect(fallback([
  (async function* () { throw new Error("primary fail"); })(),
  (async function* () { yield 42; })(),
]));
if (out.length !== 1 || out[0] !== 42) throw new Error("fallback chain");`,
			);
			writeFileSync(
				join(temp, "cjs.mjs"),
				`import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { fallback, collect } = require("llm-stream-mux");
(async () => {
  const out = await collect(fallback([
    (async function* () { throw new Error("primary fail"); })(),
    (async function* () { yield 42; })(),
  ]));
  if (out.length !== 1 || out[0] !== 42) throw new Error("fallback chain");
})();`,
			);
			execFileSync("node", ["esm.mjs"], { cwd: temp, stdio: "pipe" });
			execFileSync("node", ["cjs.mjs"], { cwd: temp, stdio: "pipe" });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("LSM-REL-06b fallback merge ensemble in d.ts race tee present", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expect(dts).toMatch(/declare function fallback\b/);
		expect(dts).toMatch(/declare function race\b/);
		expect(dts).toMatch(/declare function tee\b/);
		expect(dts).toMatch(/declare function merge\b/);
		expect(dts).toMatch(/declare const ensemble\b/);
		expectCommonOptionsInDts(dts);
		expect(dts).not.toContain("normalizeSource");
		expect(dts).not.toContain("createTelemetry");
		expect(dts).not.toMatch(/declare function muxError\b/);
		for (const file of ["dist/index.js", "dist/index.cjs"]) {
			const body = readFileSync(join(root, file), "utf8");
			expect(body).toContain("fallback");
			expect(body).not.toContain("node_modules");
		}
	});
});

describe("LSM-REL-07 merge dist contract", () => {
	it("LSM-REL-07a merge ensemble runtime smoke from tarball", { timeout: TARBALL_SMOKE_MS }, () => {
		const temp = mkdtempSync(join(tmpdir(), "lsm-merge-smoke-"));
		try {
			execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
			const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
			expect(tarball).toBeTruthy();

			writeFileSync(
				join(temp, "package.json"),
				JSON.stringify({ type: "module", dependencies: {} }, null, 2),
			);
			execFileSync("npm", ["install", "--ignore-scripts", join(temp, tarball!)], {
				cwd: temp,
				stdio: "pipe",
			});

			writeFileSync(
				join(temp, "esm.mjs"),
				`import { merge, ensemble, collect } from "llm-stream-mux";
if (ensemble !== merge) throw new Error("ensemble alias");
const tags = await collect(merge([
  (async function* () { yield 1; })(),
  (async function* () { yield 2; })(),
]));
const values = tags.filter((t) => t.kind === "value");
if (values.length !== 2) throw new Error("merge values");
if (!values.some((t) => t.source === "0" && t.value === 1)) throw new Error("tag 0");
if (!values.some((t) => t.source === "1" && t.value === 2)) throw new Error("tag 1");
const dones = tags.filter((t) => t.kind === "done");
if (dones.length !== 2) throw new Error("merge dones");`,
			);
			writeFileSync(
				join(temp, "cjs.mjs"),
				`import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { merge, ensemble, collect } = require("llm-stream-mux");
(async () => {
  if (ensemble !== merge) throw new Error("ensemble alias");
  const tags = await collect(merge([
    (async function* () { yield 1; })(),
    (async function* () { yield 2; })(),
  ]));
  const values = tags.filter((t) => t.kind === "value");
  if (values.length !== 2) throw new Error("merge values");
  const dones = tags.filter((t) => t.kind === "done");
  if (dones.length !== 2) throw new Error("merge dones");
})();`,
			);
			execFileSync("node", ["esm.mjs"], { cwd: temp, stdio: "pipe" });
			execFileSync("node", ["cjs.mjs"], { cwd: temp, stdio: "pipe" });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("LSM-REL-07b merge ensemble in d.ts bundle race fallback tee present", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expect(dts).toMatch(/declare function merge\b/);
		expect(dts).toMatch(/declare const ensemble\b/);
		expect(dts).toMatch(/declare function race\b/);
		expect(dts).toMatch(/declare function fallback\b/);
		expect(dts).toMatch(/declare function tee\b/);
		expectCommonOptionsInDts(dts);
		expect(dts).not.toContain("normalizeSource");
		expect(dts).not.toContain("createTelemetry");
		expect(dts).not.toMatch(/declare function muxError\b/);
		for (const file of ["dist/index.js", "dist/index.cjs"]) {
			const body = readFileSync(join(root, file), "utf8");
			expect(body).toContain("merge");
			expect(body).toContain("ensemble");
			expect(body).not.toContain("node_modules");
		}
	});
});

describe("LSM-REL-08 cross-cutting dist contract", () => {
	it("LSM-REL-08a d.ts CommonOptions fields and MUX_PKG_VERSION 0.6.0", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expectCommonOptionsInDts(dts);
		expect(MUX_PKG_VERSION).toBe("0.6.0");
		expect(readPkg().version).toBe("0.6.0");
	});

	it(
		"LSM-REL-08b race timeoutMs and merge overallTimeoutMs smoke from tarball",
		{
			timeout: TARBALL_SMOKE_MS,
		},
		() => {
			const temp = mkdtempSync(join(tmpdir(), "lsm-cross-smoke-"));
			try {
				execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
				const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
				expect(tarball).toBeTruthy();

				writeFileSync(
					join(temp, "package.json"),
					JSON.stringify({ type: "module", dependencies: {} }, null, 2),
				);
				execFileSync("npm", ["install", "--ignore-scripts", join(temp, tarball!)], {
					cwd: temp,
					stdio: "pipe",
				});

				writeFileSync(
					join(temp, "esm.mjs"),
					`import { race, merge, collect } from "llm-stream-mux";
const raceOut = await collect(race([
  (async function* () { yield 1; })(),
], { timeoutMs: 60000 }));
if (raceOut[0] !== 1) throw new Error("race timeoutMs smoke");
const mergeIter = merge([
  (async function* () { yield 1; })(),
], { overallTimeoutMs: 60000 })[Symbol.asyncIterator]();
const step = await mergeIter.next();
if (step.done || step.value.kind !== "value") throw new Error("merge overallTimeoutMs smoke");
await mergeIter.return();`,
				);
				execFileSync("node", ["esm.mjs"], { cwd: temp, stdio: "pipe" });
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		},
	);
});
