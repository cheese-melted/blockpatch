# blockpatch Behavior

`blockpatch` is intentionally strict. It prefers refusing a patch over guessing, regenerating bytes, or applying a fuzzy edit.

For CLI forms, see [Commands](commands.md). For the `.blockpatch` artifact format and JSON contracts, see [Patch spec](spec.md).

## Core Invariant

A move transfers one exact, hash-verified payload between endpoints. In a paired move, the source hunk removes exact bytes and the target hunk adds the same exact bytes, so `blockpatch` moves the original source bytes instead of regenerating them.

The payload hash is checked before any write happens. For paired moves, the source `-` payload and target `+` payload must be byte-identical.

## Planning And Retry Flow

`plan --json -` is the canonical planning handshake. It is a thin alias for `blockpatch move --json - --diff --json-output`: it validates the provided source delimiters and/or target anchors, computes byte ranges, hashes the selected or supplied payload, renders the exact reviewable `.blockpatch`, self-checks that patch through the same in-memory `check` path, lists affected files, and returns the patch in the JSON `patch` field without mutating the working tree.

`move --json --diff` is a planner for the current tree. For relocation, in-file deletion, and whole-file removal, the JSON request selects the payload from the current source file; if that source block or file is already gone, the JSON request often cannot prove the final state because it does not carry the moved bytes. The generated `.blockpatch` is the retry/idempotence artifact because it carries the payload and can report `already_applied` from the final state. Target-only insertion and `create_file` JSON are the exceptions because they include `payload` directly.

A typical flow is: propose a move as JSON, let `blockpatch` validate and render the exact patch, show that patch to the user, then apply the `.blockpatch` in a second explicit step. Retry the `.blockpatch`, not the source-selected JSON plan.

## Path Containment

Patch-declared source and destination paths, and move JSON `src`/`dst` paths, must be relative, non-empty, and resolve inside `--cwd`.

Rejected operation paths include:

- absolute paths
- `..` escapes
- paths containing symlink components
- existing regular files whose real path escapes `--cwd`

Patch files and move JSON files may be read from any path; use `--cwd` to choose the directory the operation is allowed to modify.

Relative patch file paths and relative move JSON file paths resolve from the shell working directory, not from `--cwd`. Operation paths declared inside a patch or move JSON request resolve inside `--cwd`.

`/dev/null` is reserved for path absence and is never resolved, opened, or checked against `--cwd`. An empty file is a real endpoint while `/dev/null` is the null endpoint. A missing file is an error unless the patch explicitly says `/dev/null`; missing files never silently resolve as empty files.

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

For target hunks in existing files, insertion occurs between target-before and target-after context:

```diff
@@ -40,2 +40,3 @@ blockpatch-target id=move-1
 context before
+moved payload
 context after
```

The moved bytes are extracted from the source file, not regenerated from arguments. `apply` and `check` preserve parsed hunk body bytes exactly, including CRLF and no-trailing-newline cases.

## Move JSON Behavior

Matching and insertion are byte-exact: the moved bytes are cut at the source and inserted directly at the anchor boundary, with no newline handling. Keep delimiters and anchors on line boundaries or the result will splice mid-line. Include the surrounding newlines you want moved in `src_start` and `src_end`.

For source selection, each `src_start` match pairs with the first `src_end` occurrence after it. The resulting source delimiter match must be unique.

For target placement:

- insertion is between the before and after contexts, and their concatenation must match exactly once.
- if only `target_before` is supplied, insertion is immediately after that context.
- if only `target_after` is supplied, insertion is immediately before that context.
- either target side may be empty when both are supplied, but not both may be empty.

When `expected_payload_sha256` is supplied, the moved or materialized payload bytes must hash to that value before any write happens.

Same-file source and target overlap is a hard failure.

`move --json` and generated `move --diff` output render anchors and payloads as UTF-8 text, so they are not a binary-safe round trip for invalid UTF-8.

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

Line-number ranges are review hints only. `blockpatch` validates hunk body line counts, but it locates changes by exact context and payload bytes.

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

## Intentionally Out Of Scope

`blockpatch` does not implement:

- multiple independent moves in one patch document
- arbitrary generated diffs from before/after file snapshots
- fuzzy matching
- AST parsing
- code formatting
- copy operations
- regex anchors
