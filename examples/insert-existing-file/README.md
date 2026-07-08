# Insert Existing File

Inserts a patch-carried payload into an existing file with a target-only hunk.

```sh
blockpatch check patch.blockpatch -d work
blockpatch apply patch.blockpatch -d work
diff -u expected/file.txt work/file.txt
```
