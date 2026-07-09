# Failure: Ambiguous Target

Demonstrates strict target matching. The target anchor appears twice, so `blockpatch` refuses to guess.

```sh
blockpatch apply patch.blockpatch -d work --dry-run
```

Expected error: `Target anchor is ambiguous`.
