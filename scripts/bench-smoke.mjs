#!/usr/bin/env node
/**
 * Advisory micro-bench for race/merge. Not a CI gate unless --strict.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, merge, race } from "../dist/index.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(
	readFileSync(join(rootDir, "scripts/bench-smoke-baseline.json"), "utf8"),
);

const ITERATIONS = 100;
const warn = process.argv.includes("--warn");
const strict = process.argv.includes("--strict");

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function benchRace() {
	const times = [];
	for (let i = 0; i < ITERATIONS; i++) {
		const start = performance.now();
		await collect(
			race([
				(async function* () {
					yield 1;
				})(),
				(async function* () {
					yield 2;
				})(),
			]),
		);
		times.push(performance.now() - start);
	}
	return median(times);
}

async function benchMerge() {
	const times = [];
	for (let i = 0; i < ITERATIONS; i++) {
		const start = performance.now();
		await collect(
			merge([
				(async function* () {
					yield 1;
				})(),
				(async function* () {
					yield 2;
				})(),
			]),
		);
		times.push(performance.now() - start);
	}
	return median(times);
}

const raceMs = await benchRace();
const mergeMs = await benchMerge();

console.log(
	`bench-smoke: race median ${raceMs.toFixed(2)}ms, merge median ${mergeMs.toFixed(2)}ms`,
);

const warnings = [];
const failures = [];

for (const [label, actual, baseKey] of [
	["race", raceMs, "raceMedianMs"],
	["merge", mergeMs, "mergeMedianMs"],
]) {
	const base = baseline[baseKey];
	const warnLimit = base * baseline.regressionWarnRatio;
	const failLimit = base * baseline.regressionFailRatio;
	if (actual > failLimit)
		failures.push(`${label} ${actual.toFixed(2)}ms > fail ${failLimit.toFixed(2)}ms`);
	else if (actual > warnLimit)
		warnings.push(`${label} ${actual.toFixed(2)}ms > warn ${warnLimit.toFixed(2)}ms`);
}

for (const w of warnings) {
	const prefix = warn || strict ? "WARN" : "NOTE";
	console.log(`${prefix}: ${w}`);
}

if (failures.length > 0) {
	for (const f of failures) console.error(`FAIL: ${f}`);
	if (strict) process.exit(1);
	if (warn) process.exit(0);
	process.exit(0);
}

console.log("OK: bench-smoke within baseline");
