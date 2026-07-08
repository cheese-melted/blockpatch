# Same-File Relocation

Moves `move me` from between `alpha` and `omega` to after `target` in the same file.

```sh
blockpatch check patch.blockpatch -d work
blockpatch apply patch.blockpatch -d work
diff -u expected/file.txt work/file.txt
```
