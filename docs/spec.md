# blockpatch Patch Spec

This is the canonical `.blockpatch` format. The header line `blockpatch version 1` is required syntax for the current format.

## Format

```diff
diff --blockpatch a/src/example.ts b/src/example.ts
blockpatch version 1
blockpatch move id=move-1 payload-sha256=bc8a95d6eb2b44aa564dbae1040ba8ff2273988ea43f0f3b0c47228f9dba6b3d
--- a/src/example.ts
+++ b/src/example.ts

@@ -1,8 +1,4 @@ blockpatch-source id=move-1 function movedThing
 function alpha() {
 }
-
-function movedThing() {
-  console.log("keep me exact");
-}
 function omega() {
 }

@@ -40,3 +36,7 @@ blockpatch-target id=move-1 constructor
   constructor() {
   }
+
+function movedThing() {
+  console.log("keep me exact");
+}
   methodAfter() {
```

Line numbers in hunk headers are review hints only. Application uses context and exact payload verification, not line numbers.

Same-file moves, insertions, and deletions use one file section. In that shape, the `--- a/<path>` and `+++ b/<path>` headers must name the same file after normal path cleanup.

```text
diff --blockpatch a/<path> b/<path>
blockpatch version 1
blockpatch move id=<id> payload-sha256=<sha256>
--- a/<path>
+++ b/<path>

@@ -<old-start>,<old-count> +<new-start>,<new-count> @@ blockpatch-source id=<id> optional label
[ <source context before> ]
-<moved payload>
[ <source context after> ]

@@ -<old-start>,<old-count> +<new-start>,<new-count> @@ blockpatch-target id=<id> optional label
[ <target context before> ]
+<same moved payload>
[ <target context after> ]
```

For relocation, include both hunks and the target `+` payload must equal the source `-` payload. For source-only deletion, omit the target hunk. For target-only insertion, omit the source hunk and the payload comes from the target `+` lines.

Cross-file moves use two conventional file sections tied by the same move id and payload hash: one `role=source` section for the source file and one `role=target` section for the target file. Each section's `---` and `+++` headers name the same file. This avoids the misleading patch shape where `--- a/source.ts` and `+++ b/target.ts` look like a transformation from one filename into another.

```text
diff --blockpatch a/<source-path> b/<source-path>
blockpatch version 1
blockpatch move id=<id> role=source payload-sha256=<sha256>
--- a/<source-path>
+++ b/<source-path>

@@ -<old-start>,<old-count> +<new-start>,<new-count> @@ blockpatch-source id=<id> optional label
[ <source context before> ]
-<moved payload>
[ <source context after> ]

diff --blockpatch a/<target-path> b/<target-path>
blockpatch version 1
blockpatch move id=<id> role=target payload-sha256=<sha256>
--- a/<target-path>
+++ b/<target-path>

@@ -<old-start>,<old-count> +<new-start>,<new-count> @@ blockpatch-target id=<id> optional label
[ <target context before> ]
+<same moved payload>
[ <target context after> ]
```

Format constraints:

- The `a/` and `b/` prefixes are required, and each `diff --blockpatch` line must name the same two raw paths as that section's file headers. Unlike GNU patch, `blockpatch` defaults to git-style `-p1` path stripping: `a/src/file.ts` and `b/src/file.ts` resolve as `src/file.ts`; use `-p0` only if your working tree contains literal `a/` and `b/` directories.
- `blockpatch move` metadata keys must be unique. The recognized keys are `id`, `payload-sha256`, and `role`; unknown keys are rejected unless they use the reserved `x-` extension prefix.
- Source context before and after are exact byte anchors. Either side may be empty, and payload-only source hunks are allowed if the payload is unique.
- Target hunks for existing files must include context on at least one side. `blockpatch` matches `target context before + target context after` exactly once in the destination file and inserts at `start + target context before.length`.
- Either target side may be empty, but not both, unless the target hunk is a whole-file `/dev/null -> file` creation hunk.
- The `-<old-start>,<old-count> +<new-start>,<new-count>` ranges are line-number hints for review, not match authority. `blockpatch` validates the line counts against the hunk body, but it locates changes by exact context and payload bytes.

That means insertion occurs between target-before and target-after context:

```diff
@@ -40,2 +40,3 @@ blockpatch-target id=move-1
 context before
+moved payload
 context after
```

## One-Sided Hunks And Null Endpoints

Same-file sections may contain a source hunk and a target hunk, a source hunk only, or a target hunk only. One-sided hunks are for in-file insertion and deletion when the file exists both before and after the patch.

Target-only insertion into an existing file:

```diff
diff --blockpatch a/src/example.ts b/src/example.ts
blockpatch version 1
blockpatch move id=move-1 payload-sha256=<sha256 of the added payload>
--- a/src/example.ts
+++ b/src/example.ts

@@ -1,2 +1,3 @@ blockpatch-target id=move-1
 context before
+inserted line
 context after
```

Source-only deletion from an existing file:

```diff
diff --blockpatch a/src/example.ts b/src/example.ts
blockpatch version 1
blockpatch move id=move-1 payload-sha256=<sha256 of the removed payload>
--- a/src/example.ts
+++ b/src/example.ts

@@ -1,3 +1,2 @@ blockpatch-source id=move-1
 context before
-doomed line
 context after
```

`/dev/null` is reserved for path absence. It appears bare, without an `a/` or `b/` prefix, exactly as in git diffs, so it can never collide with a real file named `dev/null` (which would appear as `a/dev/null`). The token is recognized during parsing and is never resolved, opened, or checked against `--cwd`; path validation and `-p` stripping do not apply to it.

Use `/dev/null` only when the file path itself is absent before or after the patch. A move from `/dev/null` creates a file from a whole-file target payload:

```diff
diff --blockpatch /dev/null b/src/new.txt
blockpatch version 1
blockpatch move id=move-1 payload-sha256=<sha256 of the file payload>
--- /dev/null
+++ b/src/new.txt

@@ -0,0 +1,2 @@ blockpatch-target id=move-1
+first line
+second line
```

A move to `/dev/null` removes a file after verifying a whole-file source payload:

```diff
diff --blockpatch a/src/old.txt /dev/null
blockpatch version 1
blockpatch move id=move-1 payload-sha256=<sha256 of the file payload>
--- a/src/old.txt
+++ /dev/null

@@ -1,2 +0,0 @@ blockpatch-source id=move-1
-first line
-second line
```

The section shapes and their meaning:

| Shape | Meaning |
| --- | --- |
| `file -> file`, source + target hunks | relocation |
| `file -> file`, target hunk only | insert payload into an existing file |
| `file -> file`, source hunk only | delete payload from an existing file |
| `/dev/null -> file`, target hunk only | create a file |
| `file -> /dev/null`, source hunk only | remove a file |
| `/dev/null -> /dev/null` | invalid |

The key distinction is that an empty file is a real endpoint while `/dev/null` is the null endpoint. A missing file is an error unless the patch explicitly says `/dev/null`; missing files never silently resolve as empty files.

## One-Sided Rules

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

`-R`/`--reverse` swaps source and target hunk roles: reversing a target-only insertion deletes the inserted payload, reversing a source-only deletion re-inserts the payload, reversing a file creation removes the created file, and reversing a file removal recreates it.

In JSON output, a target-only insertion has `source_range: null`, and a source-only deletion has `target_range: null` and `insert_index: null`. A null path endpoint is rendered as the string `/dev/null` in `src` or `dst`.

## Semantics

For one patch:

1. Parse one same-file section with source+target, source-only, or target-only hunks; or parse two cross-file relocation sections tied by `role=source` and `role=target`.
2. Verify hunk ids match `blockpatch move id=<id>`.
3. Extract source payload from contiguous `-` lines when a source hunk exists.
4. Extract target payload from contiguous `+` lines when a target hunk exists.
5. For paired moves, verify target payload exactly equals source payload.
6. Verify `payload-sha256` matches the exact moved or materialized payload bytes.
7. For source hunks, locate exactly one source match for `source context before + payload + source context after`.
8. For target hunks in existing files, locate exactly one target match for `target context before + target context after`.
9. Fail if a same-file target context range overlaps the source payload bytes.
10. Apply the hunk transition: remove source payload, insert target payload, or both.
11. Apply any path-state transition from `/dev/null`: create the missing destination path or remove the source path.
12. Write changed files with temp-file-and-rename replacement.

If the requested final state is already present, `blockpatch` reports `already_applied`. For paired moves, that means the source full match is absent and `target context before + payload + target context after` is present exactly once. For target-only insertion, the target payload is already between the target anchors. For source-only deletion, both source anchors must be adjacent, the remaining after anchor must be at the start of the file, the remaining before anchor must be at the end of the file, or the anchorless payload must be absent. This is strict idempotence for retries; it does not search fuzzily or infer moved bytes.

With `-R`/`--reverse`, `blockpatch` swaps hunk roles and path endpoints. Reverse application is exact and non-fuzzy. A payload-only source hunk has no source-side anchor for reverse insertion, so reverse requires source context before or after unless it is a whole-file path recreation.

Same-file moves are atomic at file-replacement granularity. Cross-file moves preflight both files and stage all changed temp files before renaming any original. If staging fails, originals are left untouched. Once renames begin, the two-file operation is still not transactional; the destination is renamed before the source so an interruption can duplicate the payload, but should not delete it from both files. Atomic here means per-file replacement, not a crash-durable multi-file transaction.

## Byte Rules

Hunk body lines use unified-diff prefixes:

- space for context
- `-` for source payload
- `+` for target payload

The byte content after the prefix is matched exactly, including line endings. The standard `\ No newline at end of file` marker is supported for a hunk body line without a trailing newline.

`.blockpatch` `apply` and `check` preserve parsed hunk body bytes exactly, including CRLF and no-trailing-newline cases. `move --json` and generated `move --diff` output render anchors and payloads as UTF-8 text, so they are not a binary-safe round trip for invalid UTF-8.

Blank lines are separators between the header and hunks. A blank line inside a hunk body is an error; encode an empty context line as a single space.

## Intentionally Out Of Scope

The current format does not implement:

- multiple independent moves in one patch document
- arbitrary generated diffs from before/after file snapshots
- fuzzy matching
- AST parsing
- code formatting
- copy operations
- regex anchors
