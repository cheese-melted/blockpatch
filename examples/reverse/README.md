# Reverse

Applies the same relocation patch in reverse. The `work/` tree starts in the already-applied state and `-R` restores the original ordering.

```sh
blockpatch apply -R patch.blockpatch -d work --dry-run
blockpatch apply -R patch.blockpatch -d work
diff -u expected/file.txt work/file.txt
```
