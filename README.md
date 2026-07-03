# blockpatch

`blockpatch` applies anchored text block relocation patches that look like unified diffs. It is not a generic diff tool, an AST refactor tool, a formatter, or a fuzzy matcher.

The core invariant is simple: the source hunk removes exact bytes, the target hunk adds the same exact bytes, and `blockpatch` moves the original source bytes instead of regenerating them.

## Install

```sh
npx blockpatch check patch.blockpatch
npx blockpatch apply patch.blockpatch
bunx blockpatch apply patch.blockpatch --dry-run
npm install -g blockpatch
```

For local development:

```sh
bun install
bun test
bun run build
npm run publish:dry
```

## Commands

```sh
blockpatch check patch.blockpatch
blockpatch apply patch.blockpatch
blockpatch apply patch.blockpatch --dry-run
```

`check` parses the patch and verifies it against the target file without writing. `apply --dry-run` does the same validation through the apply path without writing.

## V0 Format

```diff
diff --blockpatch a/src/example.ts b/src/example.ts
blockpatch version 0
blockpatch move id=move-1 payload-sha256=bc8a95d6eb2b44aa564dbae1040ba8ff2273988ea43f0f3b0c47228f9dba6b3d
--- a/src/example.ts
+++ b/src/example.ts

@@ blockpatch-source move-1 -1,7 +1,3 @@ function movedThing
 function alpha() {
 }
-
-function movedThing() {
-  console.log("keep me exact");
-}
 function omega() {
 }

@@ blockpatch-target move-1 -10,2 +10,6 @@ constructor
   constructor() {
   }
+
+function movedThing() {
+  console.log("keep me exact");
+}
```

Line numbers in hunk headers are review hints only. Application uses context and exact payload verification, not line numbers.

## Grammar

```text
diff --blockpatch a/<path> b/<path>
blockpatch version 0
blockpatch move id=<id> payload-sha256=<sha256>
--- a/<path>
+++ b/<path>

@@ blockpatch-source <id> -<old-start>,<old-count> +<new-start>,<new-count> @@ optional label
 <context before>
-<moved payload>
 <context after>

@@ blockpatch-target <id> -<old-start>,<old-count> +<new-start>,<new-count> @@ optional label
 <target context>
+<same moved payload>
```

The target payload may also appear before target context:

```diff
@@ blockpatch-target move-1 -40,1 +40,2 @@
+moved line
 target line
```

In that case `blockpatch` inserts immediately before the target context. Otherwise, it inserts immediately after the context before the `+` payload.

## Semantics

For one patch:

1. Parse `diff --blockpatch`, metadata, file headers, and paired source/target hunks.
2. Verify source and target hunk ids match `blockpatch move id=<id>`.
3. Extract source payload from contiguous `-` lines.
4. Extract target payload from contiguous `+` lines.
5. Verify target payload exactly equals source payload.
6. Verify `payload-sha256` matches the exact moved payload bytes.
7. Locate exactly one source match for `source context before + payload + source context after`.
8. Locate exactly one target anchor independently from target context.
9. Fail if the target anchor overlaps the source payload bytes.
10. Remove the original source payload bytes.
11. Insert those exact original bytes at the target.
12. Write atomically by writing a temp file in the same directory, then renaming it over the original.

## Failure Rules

`blockpatch` exits non-zero and does not modify the file when:

- the patch file is malformed
- source anchors are missing
- source anchors or full source are ambiguous
- the located source payload does not exactly match the source hunk payload
- target added payload does not exactly match source removed payload
- `payload-sha256` does not match the moved payload
- the target anchor is missing
- the target anchor is ambiguous
- the target anchor overlaps the source payload
- file I/O fails before the atomic rename

## Byte Rules

Hunk body lines use unified-diff prefixes:

- space for context
- `-` for source payload
- `+` for target payload

The byte content after the prefix is matched exactly, including line endings. The standard `\ No newline at end of file` marker is supported for a hunk body line without a trailing newline.

## Intentionally Out Of Scope

V0 does not implement:

- fuzzy matching
- AST parsing
- code formatting
- multi-file patches
- copy operations
- generated diffs
- regex anchors
