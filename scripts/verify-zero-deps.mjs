import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const deps = pkg.dependencies ?? {};
const keys = Object.keys(deps);

if (keys.length > 0) {
	console.error("Runtime dependencies must be empty:", keys);
	process.exit(1);
}

console.log("OK: zero runtime dependencies");
