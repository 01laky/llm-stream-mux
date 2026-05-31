# Examples

**Status:** P8 (`0.8.0`) — runnable **`node-fetch`** samples with fake streams (no live HTTP in CI).

Small TypeScript programs using the public **`llm-stream-mux`** API. Production: replace fakes with **`fetch(url, { signal }).body!`**.

Diagrams: [pipeline](../docs/img/pipeline.svg) · [quick-decision](../docs/img/quick-decision.svg) · [strategies-overview](../docs/img/strategies-overview.svg)

---

## When to use which example

| Goal                         | File                                                    |
| ---------------------------- | ------------------------------------------------------- |
| Race two raw SSE bodies      | [node-fetch/race.ts](./node-fetch/race.ts)              |
| Primary → backup failover    | [node-fetch/fallback.ts](./node-fetch/fallback.ts)      |
| Multi-model merge with tags  | [node-fetch/merge.ts](./node-fetch/merge.ts)            |
| Client + logger fan-out      | [node-fetch/tee.ts](./node-fetch/tee.ts)                |
| Race bytes → assemble winner | [integration-cookbook](../docs/integration-cookbook.md) |

Shared fakes: [node-fetch/\_fake.ts](./node-fetch/_fake.ts)

---

## Prerequisites

```bash
pnpm install
pnpm build
pnpm typecheck:examples
```

Examples import **`llm-stream-mux`** from **`dist/`** (see **`tsconfig.examples.json`**).

---

## Run locally

```bash
pnpm build
node --experimental-strip-types examples/node-fetch/race.ts
node --experimental-strip-types examples/node-fetch/fallback.ts
node --experimental-strip-types examples/node-fetch/merge.ts
node --experimental-strip-types examples/node-fetch/tee.ts
```

CI gates: **`LSM-REL-10a`** (typecheck), **`LSM-REL-10e`** (race runtime smoke).

---

## Related

- [Usage guides](../docs/usage-guides.md)
- [Integration cookbook](../docs/integration-cookbook.md)
- [Edge-case matrix](../docs/edge-cases.md)
- [llm-stream-assemble examples](https://github.com/01laky/llm-stream-assemble/tree/main/examples)
