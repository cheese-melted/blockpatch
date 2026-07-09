# Create File

Creates `file.txt` from a whole-file `/dev/null -> file` patch.

```sh
blockpatch apply patch.blockpatch -d work --dry-run
blockpatch apply patch.blockpatch -d work
diff -u expected/file.txt work/file.txt
```
