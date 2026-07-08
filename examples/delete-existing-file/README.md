# Delete Existing File

Deletes a patch-carried payload from an existing file with a source-only hunk.

```sh
blockpatch check patch.blockpatch -d work
blockpatch apply patch.blockpatch -d work
diff -u expected/file.txt work/file.txt
```
