# GitHub release templates

Copy-paste bodies when tagging. npm is the distribution source — no binary assets required.

![Publish ceremony](./img/publish-ceremony.svg)

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

### Optional: `v0.9.0` pre-release ceremony

If **`v0.9.0`** was never tagged on GitHub (npm publish also skipped):

```bash
git tag v0.9.0 <0.9.0-commit-sha>
git push origin v0.9.0
```

Create a GitHub Release from the template above, mark **pre-release**, and link forward to **`v1.0.0`**. Non-blocking for **`1.0.0`** verify gates.

---

## Stable — `v1.0.0`

**Title:** `v1.0.0 — first stable npm release`

**Settings:** **not** a pre-release

**Body:**

```markdown
## Summary

First stable npm release. Public API frozen under semver per [STABILITY.md](./STABILITY.md). Export shape unchanged vs `0.9.0`.

## Install

npm install llm-stream-mux@1.0.0

## Security

Report issues per [SECURITY.md](../SECURITY.md).

## Highlights

- **945** tests green (`pnpm verify`)
- **`LSM-EDGE-140`–`180`** — §H production edge matrix + full-matrix integrity
- **`LSM-REL-12a`–`12u`** — stable freeze gates (semver policy, pack audit, bench baseline, engines sync, rollback docs)
- **`scripts/verify-doc-links.mjs`**, **`scripts/smoke-published.mjs`** (cross-runtime flags)
- **6 new architecture diagrams** — api-frozen-surface, edge-matrix-h, publish-ceremony, interop-matrix, signal-timeout-flow, doc-audit-map

## Publish checklist (maintainer)

1. `pnpm verify:pre1`
2. `pnpm smoke:runtimes --ci`
3. `pnpm release:prep --full`
4. `npm publish --provenance --access public`
5. Tag `v1.0.0`, paste this template, link CHANGELOG

Full notes: [CHANGELOG.md](../CHANGELOG.md#100).
```

---

## GitHub Release checklist (stable)

Use when drafting **`v1.0.0`** (or later stable tags):

| Field           | Value                                                               |
| --------------- | ------------------------------------------------------------------- |
| **Title**       | `v1.0.0 — first stable npm release`                                 |
| **Pre-release** | **Off**                                                             |
| **Install**     | `npm install llm-stream-mux@1.0.0`                                  |
| **Tests**       | **945** green via `pnpm verify`                                     |
| **CHANGELOG**   | Link [CHANGELOG.md#100](../CHANGELOG.md#100)                        |
| **Security**    | Link [SECURITY.md](../SECURITY.md)                                  |
| **Provenance**  | Note npm provenance badge after `npm publish --provenance`          |
| **REL gates**   | `LSM-REL-12a`–`12u` (see [testing-strategy](./testing-strategy.md)) |

---

## Publish failure / rollback

| Scenario                                       | Maintainer action                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`npm publish` fails** before tarball visible | Fix issue; re-run `pnpm verify:pre1`; publish again — no tag change                                                                                          |
| **Publish succeeds but wrong version/tag**     | npm unpublish within policy window (72h rule for new packages); if tarball was public, ship fix as **new patch** only — **never** republish the same version |
| **`git tag` pushed but publish aborted**       | Delete remote tag only if no public npm artifact: `git push --delete origin v1.0.0`; fix; re-tag after green verify                                          |
| **Post-publish smoke fails**                   | Do not announce; patch release **`1.0.1`** if fix required; document in SECURITY if consumer impact                                                          |
| **Recovery dist-tag**                          | After verification: `npm dist-tag add llm-stream-mux@1.0.0 latest`                                                                                           |

See [STABILITY.md](./STABILITY.md) maintainer flow and [CHANGELOG](../CHANGELOG.md) for version-specific notes.

---

## Maintainer flow

```bash
pnpm verify:pre1
pnpm smoke:published              # default Node
pnpm smoke:published --all-runtimes # release-prep --full / optional local
git tag v1.0.0
git push origin v1.0.0
npm publish --provenance --access public
# GitHub → Releases → Draft from tag → paste stable template + checklist above
```
