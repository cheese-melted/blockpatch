# blockpatch Commands

This document lists the supported CLI forms. For `.blockpatch`, move JSON, and JSON output contracts, see [Patch spec](spec.md). For planning, matching, idempotence, and write behavior, see [Behavior](behavior.md).

## Common Commands

```sh
blockpatch check patch.blockpatch
blockpatch apply patch.blockpatch --dry-run
blockpatch apply patch.blockpatch
blockpatch plan --json -
blockpatch move --json -
```

`check` parses a patch and verifies it against the target tree without writing. `apply --dry-run` validates through the apply path without writing. `apply` writes the verified result.

`plan --json -` reads a move JSON request from stdin and returns a reviewable `.blockpatch` in JSON output without writing. `move --json -` reads the same request shape and applies it directly unless a dry-run or diff-producing flag is used.

## Patch Input

```sh
blockpatch apply - < patch.blockpatch
blockpatch apply < patch.blockpatch
blockpatch apply -i patch.blockpatch
```

`apply` and `check` read the patch from stdin when no patch path is supplied. `-i`/`--input` names the patch file explicitly.

## Paths And Stripping

```sh
blockpatch apply -d repo-root -p1 patch.blockpatch
blockpatch check --cwd repo-root --strip 1 < patch.blockpatch
```

`-d`/`--directory` is an alias for `--cwd`. `-pN`/`--strip N` strips leading path components from patch-declared file paths.

## Reverse

```sh
blockpatch apply patch.blockpatch --reverse
blockpatch check patch.blockpatch -R
```

`-R`/`--reverse` works with both `check` and `apply`.

## Move JSON Input

```sh
blockpatch plan --json -
blockpatch move --json -
blockpatch move --json - --diff --json-output
blockpatch move --json move.json
```

`-` reads the move request from stdin. The same shape can be loaded from a file with `blockpatch move --json move.json`. `--diff --json-output` returns a reviewable patch without writing.

## Move Flags

```sh
blockpatch move --src src/foo.ts --src-start $'\nfunction movedThing() {' --src-end $'\n}\n' --target-before $'class Target {\n'
blockpatch move --src /dev/null --dst src/foo.ts --payload $'inserted bytes\n' --target-before $'context before\n'
blockpatch move --src src/foo.ts --src-start $'\nfunction removeMe() {' --src-end $'\n}\n' --dst /dev/null
```

Human-friendly flags are supported for direct use, but JSON is usually more reliable for agents because it avoids shell quoting problems.
