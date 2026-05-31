# Workers smoke fixture

Minimal **Web Streams only** import check for Cloudflare Workers / `workerd`.

Not run in default CI — manual verification after tarball install.

## Steps

```bash
pnpm build
npm pack
mkdir /tmp/ws-smoke && cd /tmp/ws-smoke
npm init -y
npm install /path/to/llm-stream-mux-0.9.0.tgz
cp /path/to/repo/examples/workers-smoke/smoke.mjs .
node smoke.mjs   # or: wrangler dev / workerd run
```

Expected: `OK: workers-smoke MUX_PKG_VERSION=0.9.0`

See also [`docs/STABILITY.md`](../../docs/STABILITY.md) and [`docs/compatibility.md`](../../docs/compatibility.md).
