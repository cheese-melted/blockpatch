# Agent Protocol

This document describes the command and JSON contracts intended for agents and other tooling. The public API is the CLI and JSON output; TypeScript exports are internal.

## Common Commands

```sh
blockpatch check patch.blockpatch
blockpatch apply patch.blockpatch --dry-run
blockpatch apply patch.blockpatch
blockpatch plan --json -
blockpatch move --json -
```

`check` parses the patch and verifies it against the target file without writing. `apply --dry-run` does the same validation through the apply path without writing. `apply` writes the verified result.

`plan --json -` is the canonical planning handshake. It is a thin alias for `blockpatch move --json - --diff --json-output`: it validates the provided source delimiters and/or target anchors, computes byte ranges, hashes the selected or supplied payload, renders the exact reviewable `.blockpatch`, self-checks that patch through the same in-memory `check` path, lists affected files, and returns the patch in the JSON `patch` field without mutating the working tree. The explicit `move --json - --diff --json-output` form remains supported.

`move --json --diff` is a planner for the current tree. For relocation, in-file deletion, and whole-file removal, the JSON request selects the payload from the current source file; if that source block or file is already gone, the JSON request often cannot prove the final state because it does not carry the moved bytes. The generated `.blockpatch` is the retry/idempotence artifact because it carries the payload and can report `already_applied` from the final state. Target-only insertion and `create_file` JSON are the exceptions because they include `payload` directly.

A typical flow is: propose a move as JSON, let `blockpatch` validate and render the exact patch, show that patch to the user, then apply the `.blockpatch` in a second explicit step. Retry the `.blockpatch`, not the source-selected JSON plan.

## Move JSON

JSON over stdin is the most reliable form because it avoids shell quoting problems:

```sh
blockpatch move --json - <<'JSON'
{
  "src": "src/foo.ts",
  "src_start": "\nexport function movedThing(",
  "src_end": "\n}\n",
  "dst": "src/bar.ts",
  "target_before": "export class Target {\n",
  "target_after": "}\n"
}
JSON
```

The move JSON shape is:

```ts
type MoveBlockArgs = {
  src: string
  src_start?: string
  src_end?: string
  dst?: string
  payload?: string
  target_before?: string
  target_after?: string
  expected_payload_sha256?: string
  mode?: "create_file" | "remove_file"
  dry_run?: boolean
}
```

Rules:

- Without `mode`, `/dev/null` denotes the absent source or target hunk endpoint for in-file insertion/deletion; `move --diff` renders those as normal same-file one-sided patch sections.
- Use `mode: "create_file"` or `mode: "remove_file"` for whole-file path creation/removal; `move --diff` renders those as `.blockpatch` documents with `/dev/null` file headers.
- For relocation, `src_start` and `src_end` are inclusive source delimiters; `dst` defaults to `src`.
- For deletion, set `dst` to `/dev/null`; `src_start` and `src_end` select the removed payload.
- For insertion, set `src` to `/dev/null`; `dst`, `payload`, and target context are required.
- For file creation, set `src` to `/dev/null`, set `mode` to `create_file`, and provide `dst` plus `payload`. Empty payload is valid and creates an empty file.
- For file removal, set `dst` to `/dev/null` and set `mode` to `remove_file`. The whole source file is selected as the payload.
- `target_before`, `target_after`, or both are required for relocation and insertion.
- insertion is between the before and after contexts, and their concatenation must match exactly once.
- if only `target_before` is supplied, insertion is immediately after that context.
- if only `target_after` is supplied, insertion is immediately before that context.
- either target side may be empty when both are supplied, but not both may be empty.
- `payload` is only valid when `src` is `/dev/null`; it must be non-empty for in-file insertion.
- `expected_payload_sha256` is optional; in flag mode, pass `--expected-payload-sha256`; when supplied, the moved or materialized payload bytes must hash to that value before any write happens.
- source delimiter match must be unique.
- target anchor match must be unique.
- moved bytes are extracted from the source file, not regenerated from args.
- same-file source and target overlap is a hard failure.

Insertion:

```json
{
  "src": "/dev/null",
  "dst": "src/foo.ts",
  "payload": "inserted bytes\n",
  "target_before": "context before\n"
}
```

Deletion:

```json
{
  "src": "src/foo.ts",
  "src_start": "function removeMe() {\n",
  "src_end": "}\n",
  "dst": "/dev/null"
}
```

File creation:

```json
{
  "src": "/dev/null",
  "dst": "src/new.ts",
  "payload": "export const x = 1;\n",
  "mode": "create_file"
}
```

File removal:

```json
{
  "src": "src/old.ts",
  "dst": "/dev/null",
  "mode": "remove_file",
  "expected_payload_sha256": "<sha256>"
}
```

Matching and insertion are byte-exact: the moved bytes are cut at the source and inserted directly at the anchor boundary, with no newline handling. Keep delimiters and anchors on line boundaries or the result will splice mid-line. Include the surrounding newlines you want moved in `src_start` and `src_end`.

The move JSON and `--diff` planner interfaces are UTF-8 text interfaces. They are intended for source text, not arbitrary binary payloads or invalid UTF-8 byte sequences.

## JSON Output

With `--json-output`, successful commands print:

```ts
type ApplyResult = {
  ok: true
  changed: string[]
  affected: string[]
  written: boolean
  noop: boolean
  status: "applied" | "noop" | "already_applied"
  strip_components?: number
  patch?: string
  moves: Array<{
    id: string
    src: string
    dst: string
    payload_sha256: string
    payload_bytes: number
    source_range: { start: number; end: number } | null
    target_range: { start: number; end: number } | null
    insert_index: number | null
  }>
}
```

`changed` lists paths whose content changed, or would change during `check`, `--dry-run`, `--diff`, and `--explain`. `written` is true only when files were actually replaced by the command; it is false for `check`, `--dry-run`, `--diff`, `--explain`, `noop`, and `already_applied`. `affected` lists paths examined by the patch. `noop` is true when the patch validated but produced identical bytes.

`status` is `applied` for a normal computed move, `noop` for a computed move whose output bytes are identical, and `already_applied` when the command can prove the requested final state is already present. `strip_components` is present for `check` and `apply` JSON success output and reports the effective `-p` path-stripping count; it defaults to `1`.

`.blockpatch` apply/check can prove retry idempotence because the patch carries the payload; source-selected `move --json` relocation/deletion requests generally cannot after the source block is gone. `patch` is present when `move --diff --json-output` is used. In `already_applied` relocation results, `source_range` is `null` because the source block is no longer present. For target-only insertions, `source_range` is `null`. For source-only deletions, `target_range` and `insert_index` are `null`. For path creation/removal, `src` or `dst` is the string `/dev/null`.

Human text output prints `changed <path>`, `would change <path>`, or `unchanged <path>`.

With `--json-output`, errors print:

```ts
type BlockPatchJsonError = {
  ok: false
  error: {
    code: BlockPatchErrorCode
    message: string
    field?: string
    path?: string
    phase?: string
    anchor?: string
    matches?: number
    ranges?: Array<{ start: number; end: number }>
    line_ranges?: Array<{ start: number; end: number }>
  }
}
```

Ambiguous-match errors include up to the first 10 exact byte ranges for the matched anchors or candidate source ranges, plus matching 1-based inclusive `line_ranges` when the relevant file bytes are available. They do not include source snippets, fuzzy suggestions, or repair guidance.

Error codes are the agent-facing branch contract. Removing a code or changing its meaning is semver-major.

```ts
type BlockPatchErrorCode =
  | "parse_error"
  | "invalid_path"
  | "path_outside_cwd"
  | "symlink_path"
  | "file_not_found"
  | "not_regular_file"
  | "permission_denied"
  | "io_error"
  | "source_not_found"
  | "source_ambiguous"
  | "target_not_found"
  | "target_ambiguous"
  | "destination_exists"
  | "payload_mismatch"
  | "hash_mismatch"
  | "invalid_utf8"
  | "target_overlaps_source"
  | "already_applied"
  | "invalid_move_args"
  | "invalid_json"
  | "missing_move_args"
  | "unknown_command"
  | "unknown_option"
  | "invalid_option"
  | "missing_option_value"
  | "too_many_args"
  | "unexpected_error"
```

`unexpected_error` is the generic fallback for non-`BlockPatchError` failures; agents should treat it as an internal failure and avoid branching on its message.

## Additional Command Forms

These forms are supported when you need explicit input handling, path control, reverse application, or shell-friendly move arguments.

### Patch Input

```sh
blockpatch apply - < patch.blockpatch
blockpatch apply < patch.blockpatch
blockpatch apply -i patch.blockpatch
```

`apply` and `check` read the patch from stdin when no patch path is supplied. `-i`/`--input` names the patch file explicitly.

### Paths And Stripping

```sh
blockpatch apply -d repo-root -p1 patch.blockpatch
blockpatch check -p1 < patch.blockpatch
```

`-d`/`--directory` is an alias for `--cwd`. Use `--cwd` to choose the directory the operation is allowed to modify.

Patch files and move JSON files may be read from any path. Relative input paths are resolved from the shell working directory, not from `--cwd`; use an absolute path or run from the directory containing the input file when needed. Patch-declared operation paths and move JSON `src`/`dst` paths are still resolved inside `--cwd`.

`-pN`/`--strip N` strips leading path components from patch-declared file paths. Unlike GNU patch, `blockpatch` defaults to git-style `-p1` path stripping because patch headers require `a/` and `b/` prefixes.

### Reverse

```sh
blockpatch apply patch.blockpatch --reverse
blockpatch check patch.blockpatch -R
```

`-R`/`--reverse` moves the verified payload back from the target location to the source location; it works with both `check` and `apply`.

### Move JSON Files

```sh
blockpatch move --json -
blockpatch move --json move.json
```

`move --json -` reads the move request from stdin. The same shape can be loaded from a file with `blockpatch move --json move.json`.

### Move Flags

```sh
blockpatch move --src src/foo.ts --src-start $'\nfunction movedThing() {' --src-end $'\n}\n' --target-before $'class Target {\n'
blockpatch move --src /dev/null --dst src/foo.ts --payload $'inserted bytes\n' --target-before $'context before\n'
blockpatch move --src src/foo.ts --src-start $'\nfunction removeMe() {' --src-end $'\n}\n' --dst /dev/null
```

Human-friendly flags are supported for direct use, but JSON is usually more reliable for agents because it avoids shell quoting problems.
