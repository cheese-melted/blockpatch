# Contributing

`blockpatch` is intentionally small. The core invariant is: no fuzz, no AST parsing, and no regeneration of moved bytes.

Changes should preserve these rules:

- context and payload matching stay byte-exact
- moved bytes come from the source file, not from formatted or regenerated text
- line numbers are review hints, not match authority
- agent-facing output stays deterministic and structured

Before sending changes, run:

```sh
bun run typecheck
bun test
bun run build
npm run pack:dry
```
