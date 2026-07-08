# Failure: Ambiguous Target

Demonstrates strict target matching. The target anchor appears twice, so `blockpatch` refuses to guess.

```sh
blockpatch check patch.blockpatch -d work
```

Expected error: `Target anchor is ambiguous`.
