# blockpatch Behavior

`blockpatch` is intentionally strict. It prefers refusing a patch over guessing, regenerating bytes, or applying a fuzzy edit.

For CLI forms and JSON contracts, see [Commands](commands.md). For the `.blockpatch` artifact format, see [Patch spec](spec.md).

## Core Invariant

A move transfers one exact, hash-verified payload between endpoints. In a paired move, the source hunk removes exact bytes and the target hunk adds the same exact bytes, so `blockpatch` moves the original source bytes instead of regenerating them.

The payload hash is checked before any write happens. For paired moves, the source `-` payload and target `+` payload must be byte-identical.

## Path Containment

Patch-declared source and destination paths, and move JSON `src`/`dst` paths, must be relative, non-empty, and resolve inside `--cwd`.

Rejected operation paths include:

- absolute paths
- `..` escapes
- paths containing symlink components
- existing regular files whose real path escapes `--cwd`

`-d`/`--directory` is an alias for `--cwd`. Patch files and move JSON files may be read from any path; use `--cwd` to choose the directory the operation is allowed to modify.

Relative patch file paths and relative move JSON file paths resolve from the shell working directory, not from `--cwd`. Operation paths declared inside a patch or move JSON request resolve inside `--cwd`.

`/dev/null` is reserved for path absence and is never resolved, opened, or checked against `--cwd`.

## Exact Matching

Source and target anchors are byte-exact. There is no fuzzy matching, regex matching, AST parsing, or formatting.

For source hunks, `blockpatch` locates exactly one source match for:

```text
source context before + payload + source context after
```

For target hunks in existing files, `blockpatch` locates exactly one target match for:

```text
target context before + target context after
```

The moved bytes are extracted from the source file, not regenerated from arguments. `move --json` and generated `move --diff` output are UTF-8 text interfaces and are not intended for arbitrary binary payloads or invalid UTF-8 byte sequences.

## Patch Evaluation

For one patch, `blockpatch`:

1. Parses one same-file section with source+target, source-only, or target-only hunks; or parses two cross-file relocation sections tied by `role=source` and `role=target`.
2. Verifies hunk ids match `blockpatch move id=<id>`.
3. Extracts source payload from contiguous `-` lines when a source hunk exists.
4. Extracts target payload from contiguous `+` lines when a target hunk exists.
5. For paired moves, verifies target payload exactly equals source payload.
6. Verifies `payload-sha256` matches the exact moved or materialized payload bytes.
7. For source hunks, locates exactly one source match for `source context before + payload + source context after`.
8. For target hunks in existing files, locates exactly one target match for `target context before + target context after`.
9. Fails if a same-file target context range overlaps the source payload bytes.
10. Applies the hunk transition: remove source payload, insert target payload, or both.
11. Applies any path-state transition from `/dev/null`: create the missing destination path or remove the source path.
12. Writes changed files with temp-file-and-rename replacement.

## One-Sided And Null-Endpoint Behavior

Rules for target-only insertion into an existing file:

- the section contains exactly one `blockpatch-target` hunk and no source hunk.
- the payload comes from the `+` lines and must match `payload-sha256`.
- the file must exist; missing files are not treated as empty files.
- `target context before + target context after` must match exactly once; the payload is inserted at the boundary.
- at least one side of target context is required, so arbitrary zero-byte in-file insertions are not valid.
- if `target before + payload + target after` is already present exactly once, the result is `already_applied`.

Rules for source-only deletion from an existing file:

- the section contains exactly one `blockpatch-source` hunk and no target hunk.
- the file must exist; missing files are not treated as empty files.
- `source context before + payload + source context after` must match exactly once; the payload bytes are removed.
- if removal leaves zero bytes, the file remains as an empty file.
- retries are idempotent when both source anchors are adjacent, when the remaining after anchor is at the start of the file, when the remaining before anchor is at the end of the file, or when an anchorless payload is absent.

Rules for `/dev/null -> file` creation:

- the section contains exactly one `blockpatch-target` hunk and no source hunk.
- the target hunk must be whole-file payload: only contiguous `+` payload lines, with no context lines.
- zero-byte payload is valid and creates an empty file.
- a missing destination is created, including parent directories; new files are created with mode 0644.
- if the destination already exists with exactly the requested bytes, the result is `already_applied`; if it exists with different bytes, the patch fails.

Rules for `file -> /dev/null` removal:

- the section contains exactly one `blockpatch-source` hunk and no target hunk.
- the source hunk must be whole-file payload: only contiguous `-` payload lines, with no context lines.
- zero-byte payload is valid and removes an empty file.
- the existing file bytes must exactly equal the source payload; then the path is removed.
- if the source path is already missing, the result is `already_applied`.

In JSON output, a target-only insertion has `source_range: null`, and a source-only deletion has `target_range: null` and `insert_index: null`. A null path endpoint is rendered as the string `/dev/null` in `src` or `dst`.

## Idempotence

If the requested final state is already present, `blockpatch` reports `already_applied`.

For paired moves, that means the source full match is absent and:

```text
target context before + payload + target context after
```

is present exactly once.

For target-only insertion, the target payload is already between the target anchors.

For source-only deletion, idempotence is proven when both source anchors are adjacent, when the remaining after anchor is at the start of the file, when the remaining before anchor is at the end of the file, or when an anchorless payload is absent.

This is strict retry idempotence. It does not search fuzzily or infer moved bytes.

## Reverse Application

`-R`/`--reverse` swaps source and target hunk roles: reversing a target-only insertion deletes the inserted payload, reversing a source-only deletion re-inserts the payload, reversing a file creation removes the created file, and reversing a file removal recreates it.

Reverse application is exact and non-fuzzy. A payload-only source hunk has no source-side anchor for reverse insertion, so reverse requires source context before or after unless it is a whole-file path recreation.

## Write Behavior

Same-file moves are atomic at file-replacement granularity. Cross-file moves preflight both files and stage all changed temp files before renaming any original. If staging fails, originals are left untouched.

Once renames begin, a two-file operation is not transactional. The destination is renamed before the source, so an interruption can duplicate the payload, but should not delete it from both files. Atomic here means per-file replacement, not a crash-durable multi-file transaction.

## Failure Rules

`blockpatch` exits non-zero and does not modify files when:

- the patch file is malformed
- both endpoints are `/dev/null`
- a patch-declared or move-declared source/destination path is absolute, invalid, or escapes `--cwd`
- a referenced file is missing, unless the patch explicitly says `/dev/null` where creation or removal would make that legal
- a referenced path is not a regular file, unreadable, unwritable, or otherwise hits a filesystem error
- a target-only existing-file insertion has no target context
- a `/dev/null -> file` creation targets an existing file with different bytes
- a `file -> /dev/null` removal hunk does not match the whole file
- source anchors are missing
- source anchors or full source are ambiguous
- the located source payload does not exactly match the source hunk payload
- target added payload does not exactly match source removed payload
- `payload-sha256` does not match the moved payload
- `move --diff` would need to render invalid UTF-8 bytes
- the target anchor is missing
- the target anchor is ambiguous
- the target anchor overlaps the source payload
- file I/O fails before a write completes

## Error Shape

With `--json-output`, errors use the stable error-code contract documented in [Commands](commands.md#json-output). Agents should branch on `error.code`, not on human-readable messages.
