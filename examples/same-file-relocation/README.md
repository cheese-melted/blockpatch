# Same-File Relocation

Moves `move me` from between `alpha` and `omega` to after `target` in the same file.

```sh
blockpatch apply patch.blockpatch -d work --dry-run
blockpatch apply patch.blockpatch -d work
diff -u expected/file.txt work/file.txt
```
