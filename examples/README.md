# Examples

**Status:** Pre-implementation — runnable samples land in P8 (`examples/node-fetch/`).

Small TypeScript snippets using plain `fetch` and the public `llm-stream-mux` API. No live provider calls in CI by default — fake streams from `test/helpers/streams.ts`.

---

## When to use which example (planned)

| Goal                         | File (P8)                                                   |
| ---------------------------- | ----------------------------------------------------------- |
| Race two raw SSE bodies      | `node-fetch/race.ts`                                        |
| Primary → backup failover    | `node-fetch/fallback.ts`                                    |
| Multi-model merge with tags  | `node-fetch/merge.ts`                                       |
| Client + logger fan-out      | `node-fetch/tee.ts`                                         |
| Race bytes → assemble winner | See [integration-cookbook](../docs/integration-cookbook.md) |

---

## Prerequisites

```bash
pnpm install
pnpm build
```

Examples typecheck against `dist/` — gate `LSM-REL-03` (P8).

---

## Related

- [Usage guides](../docs/usage-guides.md)
- [Integration cookbook](../docs/integration-cookbook.md)
- [llm-stream-assemble examples](https://github.com/01laky/llm-stream-assemble/tree/main/examples) (parsing layer)
