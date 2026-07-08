# Remove File

Removes `file.txt` with a whole-file `file -> /dev/null` patch.

```sh
blockpatch check patch.blockpatch -d work
blockpatch apply patch.blockpatch -d work
test ! -e work/file.txt
```
