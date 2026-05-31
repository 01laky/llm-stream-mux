# Security policy

## Supported versions

| Version   | Supported   | Notes                                |
| --------- | ----------- | ------------------------------------ |
| `1.x`     | Yes         | After first npm publish (`1.0.0`)    |
| `0.9.x`   | Best effort | Pre-stable RC — engineering complete |
| `< 0.9.0` | No          | Upgrade to latest tag on `main`      |

## Reporting a vulnerability

**Email:** [01laky@gmail.com](mailto:01laky@gmail.com) (subject: `[llm-stream-mux security]`)

Alternatively, open a **private** GitHub security advisory on
[github.com/01laky/llm-stream-mux/security/advisories](https://github.com/01laky/llm-stream-mux/security/advisories).

Please include: affected version, minimal repro, impact assessment, suggested fix if any.

**Response:** best-effort acknowledgment within 7 days; patch timeline depends on severity.

## Scope

**In scope**

- Stream orchestration bugs in `race`, `fallback`, `merge`, `tee`, `collect`, interop helpers
- Cancel / abort leaks (sources not stopped, timers not cleared)
- Unbounded memory growth under documented backpressure modes
- Incorrect `MuxErrorCode` classification vs §6.3

**Out of scope**

- Caller HTTP clients, TLS, auth, provider SDKs
- Content in streams (`T`) — parsing, redaction, tool policy belong in assemble/guard
- Denial-of-service from intentionally huge user-provided streams without bounds (document limits in your app)

## Dependency policy

- **Zero runtime dependencies** — `"dependencies": {}` always
- Every release runs **`pnpm verify:deps`** in CI
- Adding a runtime dependency requires explicit maintainer review and a major version discussion

## Secure development

Before tagging a release:

1. **`pnpm verify`** green
2. **`pnpm verify:pre1`** for maintainer checkpoints (`0.9.0+`)
3. Review CHANGELOG for security-relevant behavior changes

See [`docs/STABILITY.md`](./docs/STABILITY.md) for the 1.0.0 publish checklist.
