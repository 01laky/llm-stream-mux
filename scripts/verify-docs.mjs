import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const required = [
	"README.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"LICENSE",
	"docs/proposal.MD",
	"docs/usage-guides.md",
	"docs/edge-cases.md",
	"docs/integration-cookbook.md",
	"docs/compatibility.md",
	"docs/comparison.md",
	"docs/faq.md",
	"docs/performance.md",
	"docs/testing-strategy.md",
	"docs/img/README.md",
	"examples/README.md",
	"scripts/setup-githooks.sh",
	"scripts/build-diagrams.mjs",
	"scripts/check-diagrams.mjs",
	"scripts/verify-zero-deps.mjs",
	"scripts/smoke-package.mjs",
	"scripts/release-prep.mjs",
	".github/workflows/ci.yml",
];

const missing = required.filter((rel) => !existsSync(join(root, rel)));

if (missing.length > 0) {
	console.error("Missing required docs / scripts:");
	for (const m of missing) console.error(`  - ${m}`);
	process.exit(1);
}

console.log(`OK: ${required.length} required docs / scripts present`);
