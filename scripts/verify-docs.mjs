import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();

const required = [
	"README.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"LICENSE",
	"SECURITY.md",
	"docs/proposal.MD",
	"docs/usage-guides.md",
	"docs/edge-cases.md",
	"docs/integration-cookbook.md",
	"docs/compatibility.md",
	"docs/comparison.md",
	"docs/faq.md",
	"docs/performance.md",
	"docs/testing-strategy.md",
	"docs/STABILITY.md",
	"docs/RELEASE.md",
	"docs/img/README.md",
	"examples/README.md",
	"examples/node-fetch/_fake.ts",
	"examples/node-fetch/race.ts",
	"examples/node-fetch/fallback.ts",
	"examples/node-fetch/merge.ts",
	"examples/node-fetch/tee.ts",
	"examples/workers-smoke/README.md",
	"examples/workers-smoke/smoke.mjs",
	"scripts/setup-githooks.sh",
	"scripts/build-diagrams.mjs",
	"scripts/check-diagrams.mjs",
	"scripts/verify-zero-deps.mjs",
	"scripts/smoke-package.mjs",
	"scripts/smoke-consumer.mjs",
	"scripts/smoke-published.mjs",
	"scripts/verify-doc-links.mjs",
	"scripts/verify-pack.mjs",
	"scripts/bench-smoke.mjs",
	"scripts/bench-smoke-baseline.json",
	"scripts/check-portability.mjs",
	"scripts/release-prep.mjs",
	"scripts/smoke-runtimes.mjs",
	".github/workflows/ci.yml",
	".github/workflows/smoke-runtimes.yml",
	"docs/img/api-frozen-surface.mmd",
	"docs/img/edge-matrix-h.mmd",
	"docs/img/publish-ceremony.mmd",
	"docs/img/interop-matrix.mmd",
	"docs/img/signal-timeout-flow.mmd",
	"docs/img/doc-audit-map.mmd",
];

const missing = required.filter((rel) => !existsSync(join(root, rel)));

if (missing.length > 0) {
	console.error("Missing required docs / scripts:");
	for (const m of missing) console.error(`  - ${m}`);
	process.exit(1);
}

console.log(`OK: ${required.length} required docs / scripts present`);
execFileSync("node", ["scripts/verify-doc-links.mjs"], { stdio: "inherit" });
