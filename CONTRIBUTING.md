# Contributing to llm-stream-mux

**Maintainer:** Ladislav Kostolny ([01laky@gmail.com](mailto:01laky@gmail.com))

Thank you for your interest in contributing.

## Canonical spec

Read [`docs/proposal.MD`](./docs/proposal.MD) before making changes. Part A is normative; implement Part B phases **in order** (P0→P8).

For ecosystem context (no npm coupling): [`docs/integration-cookbook.md`](./docs/integration-cookbook.md) and [`llm-stream-assemble`](https://github.com/01laky/llm-stream-assemble).

## Requirements

- **Zero runtime dependencies** — enforced by `pnpm verify:deps` and CI.
- **Generic over `T`** — mux must not define an LLM event model (proposal §3).
- **Web Streams in `src/`** — no Node-only APIs; `getReader()` not `Symbol.asyncIterator` on streams.
- **Tests** — `LSM-<AREA>-NN` IDs; phase AC must pass before the next phase.
- **Long, descriptive commit messages** — subject + body (what, why, how tested).
- **CHANGELOG** — entries under version headers (**no dates**); bump `package.json` per §26.2 ladder.
- **No AI co-author trailers** in commits or PRs — see below.

## Git hooks (required once per clone)

Cursor Agent can inject `Co-authored-by: Cursor <cursoragent@cursor.com>` when it runs
`git commit`. There is **no Settings toggle** to disable this — use the repo hooks instead:

```bash
./scripts/setup-githooks.sh
```

This sets `core.hooksPath` to `.githooks/`, which strips AI co-author and marketing
trailers and **refuses the commit** if attribution remains.

Verify a clone is protected:

```bash
git config core.hooksPath   # should print: .githooks
git log -1 --format=%B | grep -Ei '^(Co-authored-by|Signed-off-by):.*cursor'  # empty
```

## Local-only paths

`.cursor/` and `prompts/` are gitignored — never commit them.

## Development

Implementation phase (from P0):

```bash
pnpm install
pnpm verify
```

Docs-only phase (current):

```bash
pnpm verify:docs
pnpm verify:deps
pnpm diagrams:check
```

Regenerate README diagrams after editing `docs/img/*.mmd`:

```bash
pnpm diagrams:build
```

## Pull requests

1. Branch from `main`.
2. Ensure `pnpm verify` passes (or docs-phase checks before P0).
3. Update diagrams if `.mmd` files change (`pnpm diagrams:build` + commit SVGs).
4. Do not expand scope into parsing, security policy, HTTP clients, or agent loops — see proposal non-goals.

## Documentation

- Architecture SVGs: [`docs/img/README.md`](./docs/img/README.md)
- Edge-case contracts: [`docs/edge-cases.md`](./docs/edge-cases.md)
- Strategy guides: [`docs/usage-guides.md`](./docs/usage-guides.md)
