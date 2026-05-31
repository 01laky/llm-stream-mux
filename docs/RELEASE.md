# GitHub release templates

Copy-paste bodies when tagging. npm is the distribution source — no binary assets required.

---

## Pre-release — `v0.9.0`

**Title:** `v0.9.0 — P9 pre-stable RC`

**Settings:** mark as **pre-release**

**Body:**

```markdown
## Summary

Pre-stable release candidate. §25 Definition of done automated; Bun/Deno smoke in CI; no public API changes vs `0.8.0`.

**API is not semver-frozen until `1.0.0`.** See [STABILITY.md](./STABILITY.md).

## Highlights

- `docs/STABILITY.md` — intended stable surface + 1.0.0 maintainer checklist
- `SECURITY.md` — coordinated disclosure + zero-deps policy
- `LSM-REL-11a`–`11q` — §25 audit gates
- Multi-runtime smoke: Node, Bun, Deno (`smoke-runtimes.yml`)
- Consumer smoke: ESM + CJS tarball install (`pnpm smoke:consumer`)
- `pnpm verify:pre1` — maintainer gate before tag

## Install (not on npm yet)

git clone + `pnpm build`, or `npm pack` / GitHub dependency.

## Tests

883 tests green via `pnpm verify`.

Full notes: [CHANGELOG.md](../CHANGELOG.md#090).
```

---

## Stable — `v1.0.0`

**Title:** `v1.0.0 — first stable npm release`

**Settings:** **not** a pre-release

**Body:**

```markdown
## Summary

First npm publish. Public API frozen under semver per [STABILITY.md](./STABILITY.md).

## Install

npm install llm-stream-mux@1.0.0

## Security

Report issues per [SECURITY.md](../SECURITY.md).

## Publish checklist (maintainer)

1. `pnpm verify:pre1`
2. `pnpm smoke:runtimes --ci`
3. `pnpm release:prep --full`
4. Bump `1.0.0`, update STABILITY banner to frozen
5. `npm publish --provenance --access public`
6. Tag `v1.0.0`, paste this template, link CHANGELOG

Full notes: [CHANGELOG.md](../CHANGELOG.md#100).
```

---

## Maintainer flow

```bash
pnpm verify:pre1
git tag v0.9.0
git push origin v0.9.0
# GitHub → Releases → Draft from tag → paste section above
```
