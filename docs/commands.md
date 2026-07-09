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

`check` parses a patch and verifies it against the target tree without writing. `apply --dry-run` validates through the apply path without writing. `apply` writes the verified result. `plan` returns a reviewable `.blockpatch` for a move JSON request without writing; `move` applies the request directly.

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

`-d`/`--directory` is an alias for `--cwd`. `-pN`/`--strip N` strips leading path components from patch-declared file paths. Unlike GNU `patch`, the default is `-p1`, matching the git-style `a/`/`b/` prefixes; use `-p0` only if your working tree contains literal `a/` and `b/` directories.

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

`--json -` reads the move request from stdin; `--json move.json` reads the same shape from a file. `plan` is shorthand for `move --json - --diff --json-output`: it validates the request and returns the rendered `.blockpatch` in the JSON `patch` field without writing. On `move`, `--dry-run` validates without writing, and `--diff` never writes: it prints the rendered patch, or returns it in the JSON `patch` field with `--json-output`.

## Plan Envelope

```sh
blockpatch plan --json - < move.json > plan.json
jq -r .patch plan.json > patch.blockpatch
blockpatch apply patch.blockpatch
```

`plan` writes a single-line JSON envelope to stdout: `ok`, `changed`, `affected`, `status`, per-move byte ranges, and the rendered patch in the `patch` field, per the contract in [Patch spec](spec.md#json-output). Extract the `patch` field to save the reviewable artifact; `apply` accepts only the `.blockpatch`, never the envelope.

## Move Flags

```sh
blockpatch move --src src/foo.ts --src-start $'\nfunction movedThing() {' --src-end $'\n}\n' --target-before $'class Target {\n'
blockpatch move --src /dev/null --dst src/foo.ts --payload $'inserted bytes\n' --target-before $'context before\n'
blockpatch move --src src/foo.ts --src-start $'\nfunction removeMe() {' --src-end $'\n}\n' --dst /dev/null
```

Each flag sets the move JSON field of the same name and cannot be combined with `--json`. `mode` has no flag form, so whole-file `create_file`/`remove_file` requests are JSON-only. JSON avoids shell quoting problems, so it is usually the more reliable form for agents.

`--target-before` means “this exact context is before the insertion point,” so the payload is inserted after that context. `--target-after` means “this exact context is after the insertion point,” so the payload is inserted before that context. These names describe the anchor's relationship to the insertion point; they do not mean “insert before this text” or “insert after this text.”

`--src-start`, `--src-end`, `--target-before`, and `--target-after` are byte-exact and newline-sensitive. `src_start`/`src_end` select bytes from the beginning of `src_start` through the end of the first following `src_end`. `blockpatch` does not add separators, so include the newlines you want moved or inserted. If `target_before` does not end with `\n` and the payload does not start with `\n`, they will be joined directly.

## Output

```sh
blockpatch apply patch.blockpatch --json-output
blockpatch apply patch.blockpatch --explain
blockpatch version --json-output
```

Without `--json-output`, successful commands print `changed <path>`, `would change <path>`, or `unchanged <path>`. `--json-output` switches success and error reporting to the JSON contract in [Patch spec](spec.md#json-output); `plan` always uses it. `--explain` implies `--json-output` plus, for `apply`, `move`, and `plan`, `--dry-run`, so it always reports without writing. `version` prints the CLI version.
