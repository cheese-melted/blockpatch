# Create File

Creates `file.txt` from a whole-file `/dev/null -> file` patch.

```sh
blockpatch check patch.blockpatch -d work
blockpatch apply patch.blockpatch -d work
diff -u expected/file.txt work/file.txt
```
