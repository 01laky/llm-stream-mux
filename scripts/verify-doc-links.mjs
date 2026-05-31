#!/usr/bin/env node
/**
 * Internal markdown link + anchor integrity checker.
 * Anchor normalization: GitHub-style (lowercase, spaces→-, strip punctuation).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const root = process.cwd();

const scanRoots = ["README.md", "SECURITY.md", "docs", "examples"];

const anchorBoundFiles = ["README.md", "docs/edge-cases.md", "docs/testing-strategy.md"];

function githubAnchor(text) {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-");
}

function collectMarkdownFiles() {
	const files = [];
	for (const entry of scanRoots) {
		const abs = join(root, entry);
		if (!existsSync(abs)) continue;
		if (entry.endsWith(".md")) {
			files.push(abs);
			continue;
		}
		const walk = (dir) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (name.endsWith(".md")) files.push(path);
			}
		};
		walk(abs);
	}
	return files;
}

function headingsFor(filePath) {
	const body = readFileSync(filePath, "utf8");
	const anchors = new Set();
	for (const line of body.split("\n")) {
		const m = line.match(/^#{1,6}\s+(.+)$/);
		if (m) anchors.add(githubAnchor(m[1]));
	}
	return anchors;
}

const headingCache = new Map();

function getHeadings(filePath) {
	if (!headingCache.has(filePath)) {
		headingCache.set(filePath, headingsFor(filePath));
	}
	return headingCache.get(filePath);
}

const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
const errors = [];

for (const file of collectMarkdownFiles()) {
	const rel = file.slice(root.length + 1);
	const body = readFileSync(file, "utf8");
	const checkAnchors = anchorBoundFiles.some((bound) => rel === bound || rel.endsWith(`/${bound}`));

	for (const match of body.matchAll(linkRe)) {
		const href = match[2].trim();
		if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
			continue;
		}

		const [pathPart, anchorPart] = href.split("#");
		const targetRel = pathPart ? resolve(dirname(file), pathPart).slice(root.length + 1) : rel;

		if (pathPart) {
			const targetAbs = join(root, targetRel);
			if (!existsSync(targetAbs)) {
				errors.push(`${rel}: broken link → ${href}`);
				continue;
			}
		}

		if (anchorPart && checkAnchors) {
			const targetFile = pathPart ? join(root, targetRel) : file;
			const anchor = githubAnchor(decodeURIComponent(anchorPart));
			const headings = getHeadings(targetFile);
			if (!headings.has(anchor)) {
				errors.push(`${rel}: broken anchor #${anchorPart} in ${pathPart || rel}`);
			}
		}
	}
}

if (errors.length > 0) {
	console.error("verify-doc-links FAILED:");
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}

console.log(`OK: doc links verified (${collectMarkdownFiles().length} markdown files)`);
