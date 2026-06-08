import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MUX_ERROR_CODES, MUX_PKG_VERSION } from "../src/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** npm pack + install is slow on CI runners; default vitest 5s is too tight. */
const TARBALL_SMOKE_MS = 20_000;

function readPkg() {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		version: string;
		dependencies?: Record<string, string>;
		exports?: Record<string, { import?: string; require?: string; types?: string }>;
		license?: string;
		repository?: unknown;
		files?: string[];
		private?: boolean;
		publishConfig?: { access?: string };
		engines?: { node?: string };
	};
}

const PUBLIC_RUNTIME_EXPORTS = [
	"race",
	"fallback",
	"merge",
	"ensemble",
	"tee",
	"collect",
	"toReadable",
	"toAsyncIterable",
	"MUX_PKG_VERSION",
	"MUX_ERROR_CODES",
] as const;

const PUBLIC_TYPE_EXPORTS = [
	"Source",
	"Sources",
	"Tagged",
	"MuxError",
	"MuxErrorCode",
	"MuxErrorInit",
	"CreateMuxError",
	"SourceEvent",
	"SourceEventType",
	"MuxResult",
	"MuxSourceStats",
	"MuxStrategy",
	"FailoverPolicy",
	"TeeBackpressure",
	"MergeOrder",
	"CommonOptions",
	"RaceOptions",
	"FallbackOptions",
	"MergeOptions",
	"TeeOptions",
	"RaceFn",
	"FallbackFn",
	"MergeFn",
	"TeeFn",
	"CollectFn",
	"ToReadableFn",
	"ToAsyncIterableFn",
	"MuxCancelled",
	"MuxCancelledReason",
] as const;

const MUX_ERROR_CODE_SET = [
	"SOURCE_ERROR",
	"IN_BAND_ERROR",
	"ALL_FAILED",
	"ABORTED",
	"TIMEOUT",
	"NO_USABLE_SOURCE",
] as const;

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
	it("LSM-REL-08a d.ts CommonOptions fields and MUX_PKG_VERSION 1.1.0", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expectCommonOptionsInDts(dts);
		expect(MUX_PKG_VERSION).toBe("1.1.0");
		expect(readPkg().version).toBe("1.1.0");
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

describe("LSM-REL-09 edge matrix dist contract", () => {
	it("LSM-REL-09a MUX_PKG_VERSION 1.1.0 and edge.test.ts exists on disk", () => {
		expect(MUX_PKG_VERSION).toBe("1.1.0");
		expect(readPkg().version).toBe("1.1.0");
		expect(existsSync(join(root, "test/edge.test.ts"))).toBe(true);
		const edgeSrc = readFileSync(join(root, "test/edge.test.ts"), "utf8");
		expect(edgeSrc).toContain("LSM-EDGE-01");
		expect(edgeSrc).toContain("LSM-EDGE-119");
	});

	it(
		"LSM-REL-09b race empty and merge empty smoke from tarball",
		{
			timeout: TARBALL_SMOKE_MS,
		},
		() => {
			const temp = mkdtempSync(join(tmpdir(), "lsm-edge-smoke-"));
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
let raceErr;
try { race([]); } catch (e) { raceErr = e; }
if (!raceErr || raceErr.code !== "NO_USABLE_SOURCE") throw new Error("race([]) smoke");
const mergeEmpty = await collect(merge([]));
if (mergeEmpty.length !== 0) throw new Error("merge([]) smoke");`,
				);
				execFileSync("node", ["esm.mjs"], { cwd: temp, stdio: "pipe" });
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		},
	);
});

const EXAMPLE_FILES = [
	"examples/node-fetch/_fake.ts",
	"examples/node-fetch/race.ts",
	"examples/node-fetch/fallback.ts",
	"examples/node-fetch/merge.ts",
	"examples/node-fetch/tee.ts",
] as const;

function extractReadmeQuickstartBlocks(readmePath: string): string[] {
	const readme = readFileSync(readmePath, "utf8");
	const start = readme.indexOf("## Quickstart");
	if (start < 0) return [];
	const rest = readme.slice(start);
	const end = rest.search(/\n## [^#]/);
	const section = end >= 0 ? rest.slice(0, end) : rest;
	const blocks: string[] = [];
	const re = /```ts\n([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(section)) !== null) {
		blocks.push(m[1]!);
	}
	return blocks;
}

describe("LSM-REL-10 P8 examples and pack contract", () => {
	it("LSM-REL-10a examples typecheck against dist", () => {
		expect(existsSync(join(root, "dist/index.d.ts"))).toBe(true);
		for (const rel of EXAMPLE_FILES) {
			expect(existsSync(join(root, rel))).toBe(true);
		}
		execFileSync("pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.examples.json"], {
			cwd: root,
			stdio: "pipe",
		});
	});

	it("LSM-REL-10b npm pack excludes test examples docs prompts", () => {
		const temp = mkdtempSync(join(tmpdir(), "lsm-pack-manifest-"));
		try {
			execFileSync("npm", ["pack", "--pack-destination", temp], { cwd: root, stdio: "pipe" });
			const tarball = readdirSync(temp).find((f) => f.endsWith(".tgz"));
			expect(tarball).toBeTruthy();
			const listing = execFileSync("tar", ["-tzf", join(temp, tarball!)], {
				encoding: "utf8",
			});
			const paths = listing
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			expect(paths.some((p) => p.includes("dist/index.d.ts"))).toBe(true);
			for (const p of paths) {
				expect(p).not.toMatch(/\/(test|examples|docs|prompts)(\/|$)/);
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("LSM-REL-10c release prep script passes", () => {
		expect(MUX_PKG_VERSION).toBe("1.1.0");
		expect(readPkg().version).toBe("1.1.0");
		execFileSync("node", ["scripts/release-prep.mjs"], { cwd: root, stdio: "pipe" });
	});

	it("LSM-REL-10d README quickstart ts blocks typecheck", () => {
		const blocks = extractReadmeQuickstartBlocks(join(root, "README.md"));
		expect(blocks.length).toBeGreaterThanOrEqual(2);
		expect(blocks.some((b) => b.includes("race<Uint8Array>"))).toBe(true);
		expect(blocks.some((b) => b.includes("merge<MyEvent>"))).toBe(true);

		const temp = mkdtempSync(join(tmpdir(), "lsm-readme-quickstart-"));
		try {
			const preamble = [
				"type MyEvent = { type: string; text?: string };",
				"declare const resA: { body: ReadableStream<Uint8Array> };",
				"declare const resB: { body: ReadableStream<Uint8Array> };",
				"declare const streamA: AsyncIterable<MyEvent>;",
				"declare const streamB: AsyncIterable<MyEvent>;",
				"declare const signal: AbortSignal;",
				"declare function log(x: unknown): void;",
				"declare function render(source: string, value: MyEvent): void;",
			].join("\n");
			const combined = `${preamble}\n\n${blocks.join("\n\n")}`;
			writeFileSync(join(temp, "quickstart.ts"), combined);
			writeFileSync(
				join(temp, "tsconfig.json"),
				JSON.stringify(
					{
						extends: join(root, "tsconfig.examples.json"),
						compilerOptions: {
							rootDir: ".",
							baseUrl: root,
							paths: {
								"llm-stream-mux": [join(root, "dist/index.d.ts")],
							},
						},
						include: ["quickstart.ts"],
					},
					null,
					2,
				),
			);
			execFileSync("pnpm", ["exec", "tsc", "--noEmit", "-p", join(temp, "tsconfig.json")], {
				cwd: root,
				stdio: "pipe",
			});
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("LSM-REL-10e race example runtime smoke from dist import", { timeout: 15_000 }, () => {
		const temp = mkdtempSync(join(tmpdir(), "lsm-race-example-smoke-"));
		try {
			writeFileSync(
				join(temp, "smoke.mjs"),
				`import { collect, race } from ${JSON.stringify(join(root, "dist/index.js"))};
const slow = new ReadableStream({
  start(c) { c.enqueue(new Uint8Array(0)); c.enqueue(new Uint8Array([99])); c.close(); },
});
const fast = new ReadableStream({
  start(c) { c.enqueue(new Uint8Array([42])); c.close(); },
});
const out = await collect(race([slow, fast], {
  isUsable: (c) => c.byteLength > 0,
  timeoutMs: 5000,
}));
if (out.length !== 1 || out[0][0] !== 42) throw new Error("race smoke");`,
			);
			execFileSync("node", ["smoke.mjs"], { cwd: temp, stdio: "pipe" });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("LSM-REL-10f edge matrix authority file intact LSM-EDGE-01 through 180", () => {
		const edgeSrc = readFileSync(join(root, "test/edge.test.ts"), "utf8");
		expect(edgeSrc).toContain("LSM-EDGE-01");
		expect(edgeSrc).toContain("LSM-EDGE-180");
		expect(edgeSrc).toContain("LSM-EDGE ultra-extended §G");
		expect(edgeSrc).toContain("LSM-EDGE ultra-extended §F");
		expect(edgeSrc).toContain("LSM-EDGE ultra-extended §H");
		const matches = edgeSrc.match(/it\("LSM-EDGE-/g);
		expect(matches?.length).toBeGreaterThanOrEqual(181);
	});
});

describe("LSM-REL-11 P9 pre-1.0 §25 audit contract", () => {
	it("LSM-REL-11a dist index.d.ts export surface matches §9 allowlist", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		for (const name of ["muxError", "fromAsyncIterable"]) {
			expect(dts).not.toMatch(new RegExp(`export declare (const|function|var) ${name}\\b`));
		}
		for (const name of PUBLIC_RUNTIME_EXPORTS) {
			expect(dts).toContain(name);
		}
		for (const name of PUBLIC_TYPE_EXPORTS) {
			expect(dts).toContain(name);
		}
	});

	it("LSM-REL-11b MUX_ERROR_CODES length six matches §6.3 set", () => {
		expect(MUX_ERROR_CODES).toHaveLength(MUX_ERROR_CODE_SET.length);
		for (const code of MUX_ERROR_CODE_SET) {
			expect(MUX_ERROR_CODES).toContain(code);
		}
	});

	it("LSM-REL-11c release prep script passes at 1.1.0", () => {
		expect(readPkg().version).toBe("1.1.0");
		execFileSync("node", ["scripts/release-prep.mjs"], { cwd: root, stdio: "pipe" });
	});

	it(
		"LSM-REL-11d smoke-runtimes Node baseline passes skip-optional",
		() => {
			execFileSync("node", ["scripts/smoke-runtimes.mjs", "--skip-optional"], {
				cwd: root,
				stdio: "pipe",
				timeout: TARBALL_SMOKE_MS,
			});
		},
		TARBALL_SMOKE_MS,
	);

	it("LSM-REL-11e STABILITY.md frozen as of 1.0.0 active banner", () => {
		const stability = readFileSync(join(root, "docs/STABILITY.md"), "utf8");
		const active = stability.split(/^## Historical:/m)[0] ?? stability;
		expect(active).toContain("frozen as of `1.0.0`");
		expect(active).toContain("MUX_PKG_VERSION");
		expect(active).toContain("CreateMuxError");
	});

	it("LSM-REL-11f verify-docs requires STABILITY SECURITY RELEASE smoke scripts workers fixture", () => {
		const verifyDocs = readFileSync(join(root, "scripts/verify-docs.mjs"), "utf8");
		for (const token of [
			"docs/STABILITY.md",
			"SECURITY.md",
			"docs/RELEASE.md",
			"scripts/smoke-runtimes.mjs",
			"scripts/smoke-consumer.mjs",
			"examples/workers-smoke/README.md",
			"smoke-runtimes.yml",
		]) {
			expect(verifyDocs).toContain(token);
		}
	});

	it("LSM-REL-11h src has no assemble or guard imports", () => {
		const walk = (dir: string): string[] => {
			const entries = readdirSync(dir, { withFileTypes: true });
			const files: string[] = [];
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) files.push(...walk(path));
				else if (entry.name.endsWith(".ts")) files.push(path);
			}
			return files;
		};
		for (const file of walk(join(root, "src"))) {
			const body = readFileSync(file, "utf8");
			expect(body).not.toMatch(/llm-stream-assemble|llm-stream-guard/);
		}
	});

	it("LSM-REL-11i CHANGELOG 0.9.0 section exists", () => {
		const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		expect(changelog).toContain("## [0.9.0]");
	});

	it("LSM-REL-11j proposal contains D14 and 0.9.0 ladder row", () => {
		const proposal = readFileSync(join(root, "docs/proposal.MD"), "utf8");
		expect(proposal).toContain("D14");
		expect(proposal).toContain("0.9.0");
	});

	it("LSM-REL-11k MUX_PKG_VERSION and package.json pinned 1.1.0", () => {
		expect(MUX_PKG_VERSION).toBe("1.1.0");
		expect(readPkg().version).toBe("1.1.0");
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expect(dts).not.toContain('MUX_PKG_VERSION: "0.8.0"');
	});

	it("LSM-REL-11l edge matrix authority LSM-EDGE-139 unchanged", () => {
		const edgeSrc = readFileSync(join(root, "test/edge.test.ts"), "utf8");
		expect(edgeSrc).toContain("LSM-EDGE-139");
		expect(edgeSrc).toContain("LSM-EDGE ultra-extended §G");
	});

	it("LSM-REL-11m package.json publish readiness fields present", () => {
		const pkg = readPkg();
		expect(pkg.license).toBeTruthy();
		expect(pkg.repository).toBeTruthy();
		expect(pkg.exports?.["."]).toBeTruthy();
		expect(pkg.files).toContain("dist");
		expect(pkg.private).not.toBe(true);
		expect(pkg.engines?.node).toContain("22");
		expect(pkg.publishConfig?.access).toBe("public");
	});

	it("LSM-REL-11n verify-docs §25 doc set includes STABILITY", () => {
		execFileSync("node", ["scripts/verify-docs.mjs"], { cwd: root, stdio: "pipe" });
		expect(existsSync(join(root, "docs/STABILITY.md"))).toBe(true);
	});

	it("LSM-REL-11o semver drift gate no stale user-facing version pins", () => {
		const version = readPkg().version;
		expect(MUX_PKG_VERSION).toBe(version);
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expect(dts).not.toContain('MUX_PKG_VERSION: "0.8.0"');
		const userFacing = [
			"README.md",
			"CONTRIBUTING.md",
			"docs/testing-strategy.md",
			"docs/faq.md",
			"docs/compatibility.md",
			"docs/STABILITY.md",
			"docs/RELEASE.md",
		];
		for (const rel of userFacing) {
			const body = readFileSync(join(root, rel), "utf8");
			expect(body).toContain(version);
			expect(body).not.toMatch(/badge\/version-0\.8\.0/);
		}
		const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		const section = changelog.split(`## [${version}]`)[1]?.split(/^## \[/m)[0] ?? "";
		expect(section.length).toBeGreaterThan(20);
		expect(section).not.toMatch(/MUX_PKG_VERSION.*0\.8\.0/);
	});

	it("LSM-REL-11p package.json exports and files snapshot matches publish shape", () => {
		const pkg = readPkg();
		expect([...(pkg.files ?? [])].sort()).toEqual(["LICENSE", "README.md", "dist"]);
		expect(pkg.exports).toEqual({
			".": {
				types: "./dist/index.d.ts",
				import: "./dist/index.js",
				require: "./dist/index.cjs",
			},
		});
	});

	it("LSM-REL-11q CHANGELOG 0.9.0 LSM ID references exist in test files", () => {
		const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		const section = changelog.split("## [0.9.0]")[1]?.split(/^## \[/m)[0] ?? "";
		const ids = [...new Set([...section.matchAll(/LSM-[A-Z]+-\d+[a-z]?/g)].map((m) => m[0]))];
		expect(ids.length).toBeGreaterThan(0);
		const testDir = join(root, "test");
		const walk = (dir: string): string => {
			let body = "";
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) body += walk(path);
				else if (entry.name.endsWith(".ts")) body += readFileSync(path, "utf8");
			}
			return body;
		};
		const testSrc = walk(testDir);
		for (const id of ids) {
			expect(testSrc, `missing test reference for ${id}`).toContain(id);
		}
	});
});

describe("LSM-REL-12 P10 1.0.0 stable freeze contract", () => {
	function activeStability() {
		const stability = readFileSync(join(root, "docs/STABILITY.md"), "utf8");
		return stability.split(/^## Historical:/m)[0] ?? stability;
	}

	it("LSM-REL-12a STABILITY.md banner frozen as of 1.0.0", () => {
		expect(activeStability()).toContain("frozen as of `1.0.0`");
	});

	it("LSM-REL-12b README stable npm install path and no pre_stable badge", () => {
		const readme = readFileSync(join(root, "README.md"), "utf8");
		expect(readme).toContain("npm install llm-stream-mux");
		expect(readme).not.toMatch(/pre[_-]stable/i);
	});

	it("LSM-REL-12c CHANGELOG 1.0.0 section explicit API freeze", () => {
		const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		const section = changelog.split("## [1.0.0]")[1]?.split(/^## \[/m)[0] ?? "";
		expect(section).toMatch(/frozen/i);
		expect(section).toContain("§9");
		expect(section).toContain("§6.3");
	});

	it("LSM-REL-12d Version pins at 1.1.0", () => {
		expect(readPkg().version).toBe("1.1.0");
		expect(MUX_PKG_VERSION).toBe("1.1.0");
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		expect(dts).toContain('"1.1.0"');
	});

	it("LSM-REL-12e Edge matrix authority LSM-EDGE-179 and §H", () => {
		const edgeSrc = readFileSync(join(root, "test/edge.test.ts"), "utf8");
		expect(edgeSrc).toContain("LSM-EDGE-179");
		expect(edgeSrc).toContain("LSM-EDGE ultra-extended §H");
	});

	it("LSM-REL-12f verify-doc-links passes", () => {
		execFileSync("node", ["scripts/verify-doc-links.mjs"], { cwd: root, stdio: "pipe" });
	});

	it("LSM-REL-12g verify-docs includes smoke-published verify-doc-links 6 new diagrams", () => {
		const verifyDocs = readFileSync(join(root, "scripts/verify-docs.mjs"), "utf8");
		for (const token of [
			"scripts/smoke-published.mjs",
			"scripts/verify-doc-links.mjs",
			"api-frozen-surface.mmd",
			"edge-matrix-h.mmd",
			"publish-ceremony.mmd",
			"interop-matrix.mmd",
			"signal-timeout-flow.mmd",
			"doc-audit-map.mmd",
		]) {
			expect(verifyDocs).toContain(token);
		}
		const pkg = readFileSync(join(root, "package.json"), "utf8");
		expect(pkg).toContain("smoke:published");
	});

	it("LSM-REL-12h doc headers reference 1.0.0 stable", () => {
		for (const rel of [
			"docs/faq.md",
			"docs/testing-strategy.md",
			"docs/compatibility.md",
			"docs/edge-cases.md",
		]) {
			expect(readFileSync(join(root, rel), "utf8")).toContain("1.0.0");
		}
	});

	it(
		"LSM-REL-12i smoke-published.mjs passes at 1.1.0",
		() => {
			execFileSync("node", ["scripts/smoke-published.mjs"], {
				cwd: root,
				stdio: "pipe",
				timeout: TARBALL_SMOKE_MS,
			});
		},
		TARBALL_SMOKE_MS,
	);

	it("LSM-REL-12j proposal D15 and 1.0.0 ladder row", () => {
		const proposal = readFileSync(join(root, "docs/proposal.MD"), "utf8");
		expect(proposal).toContain("D15");
		expect(proposal).toMatch(/1\.0\.0.*P10/i);
	});

	it("LSM-REL-12k REL-11p exports snapshot unchanged vs 0.9.0 shape", () => {
		const pkg = readPkg();
		expect([...(pkg.files ?? [])].sort()).toEqual(["LICENSE", "README.md", "dist"]);
		expect(pkg.exports).toEqual({
			".": {
				types: "./dist/index.d.ts",
				import: "./dist/index.js",
				require: "./dist/index.cjs",
			},
		});
	});

	it("LSM-REL-12l CHANGELOG 1.0.0 LSM ID integrity", () => {
		const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		const section = changelog.split("## [1.0.0]")[1]?.split(/^## \[/m)[0] ?? "";
		const ids = [...new Set([...section.matchAll(/LSM-[A-Z]+-\d+[a-z]?/g)].map((m) => m[0]))];
		expect(ids.length).toBeGreaterThan(0);
		const testDir = join(root, "test");
		const walk = (dir: string): string => {
			let body = "";
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) body += walk(path);
				else if (entry.name.endsWith(".ts")) body += readFileSync(path, "utf8");
			}
			return body;
		};
		const testSrc = walk(testDir);
		for (const id of ids) {
			expect(testSrc, `missing test reference for ${id}`).toContain(id);
		}
	});

	it("LSM-REL-12m Public API runtime exports unchanged vs 0.9.0", () => {
		const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
		for (const name of PUBLIC_RUNTIME_EXPORTS) {
			expect(dts).toContain(name);
		}
		for (const name of ["muxError", "fromAsyncIterable"]) {
			expect(dts).not.toMatch(new RegExp(`export declare (const|function|var) ${name}\\b`));
		}
	});

	it("LSM-REL-12n release-prep passes at 1.1.0", () => {
		execFileSync("node", ["scripts/release-prep.mjs"], { cwd: root, stdio: "pipe" });
	});

	it("LSM-REL-12o diagrams check 19 SVGs present and fresh", () => {
		execFileSync("node", ["scripts/check-diagrams.mjs"], { cwd: root, stdio: "pipe" });
		const check = readFileSync(join(root, "scripts/check-diagrams.mjs"), "utf8");
		const count = (check.match(/^\s*"[a-z0-9-]+\.mmd",/gm) ?? []).length;
		expect(count).toBe(19);
	});

	it("LSM-REL-12p testing-strategy documents REL-12 and EDGE §H", () => {
		const body = readFileSync(join(root, "docs/testing-strategy.md"), "utf8");
		expect(body).toContain("LSM-REL-12");
		expect(body).toContain("§H");
		expect(body).toContain("972");
	});

	it("LSM-REL-12q STABILITY.md post-freeze semver policy declared", () => {
		const active = activeStability();
		expect(active).toMatch(/major/i);
		expect(active).toMatch(/minor/i);
		expect(active).toMatch(/patch/i);
	});

	it("LSM-REL-12r RELEASE.md stable template and rollback runbook complete", () => {
		const release = readFileSync(join(root, "docs/RELEASE.md"), "utf8");
		expect(release).toContain("v1.0.0");
		expect(release).toMatch(/Publish failure|rollback/i);
		expect(release).toMatch(/GitHub Release checklist/i);
	});

	it("LSM-REL-12s engines.node compatibility.md and ci.yml Node matrix aligned", () => {
		const pkg = readPkg();
		expect(pkg.engines?.node).toContain("22");
		const compat = readFileSync(join(root, "docs/compatibility.md"), "utf8");
		expect(compat).toMatch(/22.*24|22, 24/);
		const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
		expect(ci).toContain("22");
		expect(ci).toContain("24");
	});

	it("LSM-REL-12t npm pack tarball contents match REL-11p publish shape", () => {
		execFileSync("node", ["scripts/verify-pack.mjs"], { cwd: root, stdio: "pipe" });
	});

	it("LSM-REL-12u bench-smoke --warn passes at 1.0.0 baseline", () => {
		execFileSync("node", ["scripts/bench-smoke.mjs", "--warn"], { cwd: root, stdio: "pipe" });
	});
});
