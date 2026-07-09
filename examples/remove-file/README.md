# Remove File

Removes `file.txt` with a whole-file `file -> /dev/null` patch.

```sh
blockpatch apply patch.blockpatch -d work --dry-run
blockpatch apply patch.blockpatch -d work
test ! -e work/file.txt
```
