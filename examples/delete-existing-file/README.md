# Delete Existing File

Deletes a patch-carried payload from an existing file with a source-only hunk.

```sh
blockpatch apply patch.blockpatch -d work --dry-run
blockpatch apply patch.blockpatch -d work
diff -u expected/file.txt work/file.txt
```
