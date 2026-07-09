# blockpatch Commands

This document lists the supported CLI forms. For `.blockpatch`, move JSON, and JSON output contracts, see [Patch spec](spec.md). For planning, matching, idempotence, and write behavior, see [Behavior](behavior.md).

## Common Commands

```sh
blockpatch apply patch.blockpatch --dry-run
blockpatch apply patch.blockpatch
blockpatch move --json - --diff --output patch.blockpatch --dry-run
blockpatch plan --json -
```

`apply --dry-run` validates through the apply path without writing. `apply` writes the verified result. `move --json - --diff --output ... --dry-run` returns a reviewable `.blockpatch` for a move JSON request and prints the validation summary without writing the target tree; `move --json -` applies the request directly.

Use `move --json - --diff --output patch.blockpatch --dry-run` when you want a reviewable `.blockpatch` artifact plus a validation summary and no target-tree writes. Use `apply --dry-run` when you want to validate a reviewed patch file later before `apply`. Use `plan --json -` only when an agent or script needs metadata and patch text together.

For CLI reminders:

```sh
blockpatch move --help
blockpatch plan --help
```

## Patch Input

```sh
blockpatch apply - < patch.blockpatch
blockpatch apply < patch.blockpatch
blockpatch apply --patch patch.blockpatch
blockpatch apply --patch - --dry-run < patch.blockpatch
```

`apply` reads the patch from stdin when no patch path is supplied. `--patch` names the patch input explicitly; use `--patch -` to consume stdin without a temporary patch file.

## Paths And Stripping

```sh
blockpatch apply -d repo-root -p1 patch.blockpatch
blockpatch apply --cwd repo-root --strip 1 --dry-run < patch.blockpatch
```

`-d`/`--directory` is an alias for `--cwd`. `-pN`/`--strip N` strips leading path components from patch-declared file paths. Unlike GNU `patch`, the default is `-p1`, matching the git-style `a/`/`b/` prefixes; use `-p0` only if your working tree contains literal `a/` and `b/` directories.

Patch-declared paths and move JSON `src`/`dst` are operation paths inside `--cwd`. For `--cwd /home/alan/dev/test1/shooter`, use `src/game/file.ts`, not `dev/test1/shooter/src/game/file.ts`. Patch input files, move JSON input files, and `--output` are normal CLI paths and may be absolute.

## Reverse

```sh
blockpatch apply patch.blockpatch --reverse
blockpatch apply patch.blockpatch -R --dry-run
```

`-R`/`--reverse` works with `apply`, including `apply --dry-run`.

## Move JSON Input

```sh
blockpatch move --json -
blockpatch move --json - --diff --json-output
blockpatch move --json - --diff --output patch.blockpatch --dry-run
blockpatch plan --json -
blockpatch move --json move.json
```

`--json -` reads the move request from stdin; `--json move.json` reads the same shape from a file. On `move`, `--dry-run` validates without writing, and `--diff` never writes to the target tree: it prints the rendered patch, returns it in the JSON `patch` field with `--json-output`, or writes it atomically with `--output`. When `--diff --output` is combined with `--dry-run`, the patch is written to the output file and the dry-run summary is printed to stdout. `plan` is the same planning operation as `move --json - --diff --json-output`, but exposed as a JSON-envelope command.

Use `--output <patch.blockpatch>` instead of shell redirection when you want an existing patch file left untouched if rendering fails.

## Plan Envelope

```sh
blockpatch plan --json - < move.json > plan.json
jq -r .patch plan.json > patch.blockpatch
blockpatch apply patch.blockpatch
```

`plan` writes a single-line JSON envelope to stdout: `ok`, `changed`, `affected`, `status`, per-move byte ranges, and the rendered patch in the `patch` field, per the contract in [Patch spec](spec.md#json-output). Extract the `patch` field to save the reviewable artifact; `apply` accepts only the `.blockpatch`, never the envelope.

## Move Flags

```sh
blockpatch move --src src/foo.ts --src-start $'\nfunction movedThing() {' --src-end $'\n}\n' --insert-before $'class Target {\n'
blockpatch move --src /dev/null --dst src/foo.ts --payload $'inserted bytes\n' --insert-after $'context before\n'
blockpatch move --src src/foo.ts --src-start $'\nfunction removeMe() {' --src-end $'\n}\n' --dst /dev/null
```

Each flag sets the move JSON field of the same name and cannot be combined with `--json`. `mode` has no flag form, so whole-file `create_file`/`remove_file` requests are JSON-only. JSON avoids shell quoting problems, so it is usually the more reliable form for agents.

`--insert-before` means insert immediately before the exact context. `--insert-after` means insert immediately after the exact context. The lower-level `--target-before` and `--target-after` flags are also available: they describe the anchor's relationship to the insertion point.

`--src-start`, `--src-end`, `--insert-before`, and `--insert-after` are byte-exact and newline-sensitive. `src_start`/`src_end` select bytes from the beginning of `src_start` through the end of the first following `src_end`. `blockpatch` does not add separators, so include the newlines you want moved or inserted.

## Output

```sh
blockpatch apply patch.blockpatch --json-output
blockpatch apply patch.blockpatch --explain
blockpatch version --json-output
```

Without `--json-output`, successful dry-runs print `dry-run clean: <move> <src>:<line> -> <dst>:<line>, <n> lines`. Successful writes print the same move summary with `applied:` followed by `changed: <paths>` when files were written. `--json-output` switches success and error reporting to the JSON contract in [Patch spec](spec.md#json-output); `plan` always uses it. `--explain` implies `--json-output` plus, for `apply`, `move`, and `plan`, `--dry-run`, so it always reports without writing. `version` prints the CLI version.
