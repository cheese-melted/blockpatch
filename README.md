# blockpatch

`blockpatch` applies anchored text block relocation patches that look like unified diffs. It is not a generic diff tool, an AST refactor tool, a formatter, or a fuzzy matcher.

The core invariant is simple: the source hunk removes exact bytes, the target hunk adds the same exact bytes, and `blockpatch` moves the original source bytes instead of regenerating them.

## Install

```sh
npx blockpatch check patch.blockpatch
npx blockpatch apply patch.blockpatch
npx blockpatch move --json -
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
blockpatch apply - < patch.blockpatch
blockpatch move --json -
blockpatch move --json move.json
blockpatch move --src src/foo.ts --src-start $'\nfunction movedThing() {' --src-end $'\n}\n' --dst-after $'class Target {\n'
```

`check` parses the patch and verifies it against the target file without writing. `apply --dry-run` does the same validation through the apply path without writing.

`move` is the plug-and-play agent interface. JSON over stdin is the most reliable form because it avoids shell quoting problems:

```sh
blockpatch move --json - <<'JSON'
{
  "src": "src/foo.ts",
  "src_start": "\nexport function movedThing(",
  "src_end": "\n}\n",
  "dst": "src/bar.ts",
  "dst_after": "export class Target {\n",
  "insert": "after"
}
JSON
```

Matching and insertion are byte-exact: the moved bytes are cut at the source and inserted directly at the anchor boundary, with no newline handling. Keep delimiters and anchors on line boundaries or the result will splice mid-line — end `dst_after` anchors with `\n`, start `dst_before` anchors at the beginning of a line, and include the surrounding newlines you want moved in `src_start`/`src_end`.

The same shape can be loaded from a file:

```sh
blockpatch move --json move.blockpatch.json
```

Human-friendly flags are also supported:

```sh
blockpatch move \
  --src src/foo.ts \
  --src-start $'\nexport function movedThing(' \
  --src-end $'\n}\n' \
  --dst src/bar.ts \
  --dst-after $'export class Target {\n'
```

Use `--dry-run` to validate without writing, `--diff` to print a reviewable `.blockpatch` document (`--diff` implies dry-run and never writes), and `--json-output` for machine-readable success or error output.

## Move JSON

```ts
type MoveBlockArgs = {
  src: string
  src_start: string
  src_end: string
  dst?: string
  dst_before?: string
  dst_after?: string
  insert?: "before" | "after"
  dry_run?: boolean
}
```

Rules:

- `src_start` and `src_end` are inclusive source delimiters.
- `dst` defaults to `src`.
- exactly one of `dst_before` or `dst_after` is required.
- source delimiter match must be unique.
- target anchor match must be unique.
- moved bytes are extracted from the source file, not regenerated from args.
- same-file source and target overlap is a hard failure.

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

The `--- a/<path>` and `+++ b/<path>` headers may name the same file for an intra-file move or different files for a source-to-destination move.

## Grammar

```text
diff --blockpatch a/<path> b/<path>
blockpatch version 0
blockpatch move id=<id> payload-sha256=<sha256>
--- a/<path>
+++ b/<path>

@@ blockpatch-source <id> -<old-start>,<old-count> +<new-start>,<new-count> @@ optional label
[ <context before> ]
-<moved payload>
[ <context after> ]

@@ blockpatch-target <id> -<old-start>,<old-count> +<new-start>,<new-count> @@ optional label
[ <target context before> ]
+<same moved payload>
[ <target context after> ]
```

Source context may be one-sided or absent at file boundaries. The exact concatenation of source context before, moved payload, and source context after must match uniquely.

The target hunk must include context on at least one side. If the target hunk has both before and after context, `blockpatch` matches their exact concatenation in the target file and inserts at the boundary between them. The target payload may also appear before target context:

```diff
@@ blockpatch-target move-1 -40,1 +40,2 @@
+moved line
 target line
```

In that case `blockpatch` inserts immediately before the target context. If only context before the `+` payload is present, it inserts immediately after that context.

## Semantics

For one patch:

1. Parse `diff --blockpatch`, metadata, source/destination file headers, and paired source/target hunks.
2. Verify source and target hunk ids match `blockpatch move id=<id>`.
3. Extract source payload from contiguous `-` lines.
4. Extract target payload from contiguous `+` lines.
5. Verify target payload exactly equals source payload.
6. Verify `payload-sha256` matches the exact moved payload bytes.
7. Locate exactly one source match for `source context before + payload + source context after`.
8. Locate exactly one target match for `target context before + target context after`.
9. Fail if the target context range overlaps the source payload bytes.
10. Remove the original source payload bytes.
11. Insert those exact original bytes at the target context boundary.
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
