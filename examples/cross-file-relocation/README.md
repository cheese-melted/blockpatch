# Cross-File Relocation

Moves `movedThing` from `source.txt` to `target.txt`. Cross-file relocations use two sections tied by the same move id and payload hash.

```sh
blockpatch check patch.blockpatch -d work
blockpatch apply patch.blockpatch -d work
diff -u expected/source.txt work/source.txt
diff -u expected/target.txt work/target.txt
```
