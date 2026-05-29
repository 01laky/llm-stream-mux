import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MUX_PKG_VERSION } from "../src/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

	it("LSM-REL-01 smoke:package passes from npm pack tarball", () => {
		const temp = mkdtempSync(join(tmpdir(), "lsm-smoke-"));
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
				`import { MUX_PKG_VERSION, MUX_ERROR_CODES } from "llm-stream-mux";
if (MUX_PKG_VERSION !== "${readPkg().version}") throw new Error("version");
if (MUX_ERROR_CODES.length !== 6) throw new Error("codes");`,
			);
			writeFileSync(
				join(temp, "cjs.cjs"),
				`const { MUX_PKG_VERSION, MUX_ERROR_CODES } = require("llm-stream-mux");
if (MUX_PKG_VERSION !== "${readPkg().version}") throw new Error("version");
if (MUX_ERROR_CODES.length !== 6) throw new Error("codes");`,
			);
			execFileSync("node", ["esm.mjs"], { cwd: temp, stdio: "pipe" });
			execFileSync("node", ["cjs.cjs"], { cwd: temp, stdio: "pipe" });
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
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
