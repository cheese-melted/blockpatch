# blockpatch

`blockpatch` applies anchored text block relocation patches that look like unified diffs. It is not a generic diff tool, an AST refactor tool, a formatter, or a fuzzy matcher.

The core invariant is simple: the source hunk removes exact bytes, the target hunk adds the same exact bytes, and `blockpatch` moves the original source bytes instead of regenerating them.

`blockpatch` is intentionally closer to `patch --fuzz=0` than default GNU patch: context must match exactly, and line numbers are review hints rather than relocation authority.

## Install

The npm examples use the published package. Check `npm view blockpatch version` before relying on `npx blockpatch` for semantics that may only exist in this checkout.

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
node dist/cli.js version
```

## Commands

```sh
blockpatch check patch.blockpatch
blockpatch apply patch.blockpatch
blockpatch apply patch.blockpatch --dry-run
blockpatch apply - < patch.blockpatch
blockpatch apply < patch.blockpatch
blockpatch apply -i patch.blockpatch
blockpatch apply -d repo-root -p1 patch.blockpatch
blockpatch check -p1 < patch.blockpatch
blockpatch move --json -
blockpatch move --json move.json
blockpatch move --src src/foo.ts --src-start $'\nfunction movedThing() {' --src-end $'\n}\n' --dst-after $'class Target {\n'
```

`check` parses the patch and verifies it against the target file without writing. `apply --dry-run` does the same validation through the apply path without writing.

Patch-declared source and destination paths, and move JSON `src`/`dst` paths, must resolve inside `--cwd`. `-d`/`--directory` is an alias for `--cwd`. Patch files and move JSON files may be read from any path; use `--cwd` to choose the directory the operation is allowed to modify.

`apply` and `check` read the patch from stdin when no patch path is supplied. `-i`/`--input` names the patch file explicitly. `-pN`/`--strip N` strips leading path components from patch-declared file paths. Because V0 headers require `a/` and `b/` prefixes, the default is equivalent to `-p1`.

`move` is the plug-and-play agent interface. JSON over stdin is the most reliable form because it avoids shell quoting problems:

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

With `target_before` and `target_after`, insertion occurs between those exact adjacent contexts. For compatibility, the two-sided form may also be written as `dst_before` plus `dst_after`. With only `dst_after`, the legacy one-sided behavior inserts after that anchor. With only `dst_before`, the legacy one-sided behavior inserts before that anchor.

Matching and insertion are byte-exact: the moved bytes are cut at the source and inserted directly at the anchor boundary, with no newline handling. Keep delimiters and anchors on line boundaries or the result will splice mid-line. Include the surrounding newlines you want moved in `src_start` and `src_end`.

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
  --target-before $'export class Target {\n' \
  --target-after $'}\n'
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
  target_before?: string
  target_after?: string
  insert?: "before" | "after"
  dry_run?: boolean
}
```

Rules:

- `src_start` and `src_end` are inclusive source delimiters.
- `dst` defaults to `src`.
- either `target_before` plus `target_after`, `dst_before`, `dst_after`, or both `dst_before` and `dst_after` are required.
- `target_before` and `target_after` are the preferred two-sided target context fields.
- if two-sided target contexts are supplied, insertion is between the before and after contexts, and their concatenation must match exactly once.
- if only one target context is supplied, `dst_after` inserts after that anchor and `dst_before` inserts before that anchor.
- `target_before`/`target_after` cannot be mixed with `dst_before`/`dst_after`.
- `insert` is only valid with a one-sided target anchor and must agree with the anchor.
- either target side may be empty when both are supplied, but not both.
- source delimiter match must be unique.
- target anchor match must be unique.
- moved bytes are extracted from the source file, not regenerated from args.
- same-file source and target overlap is a hard failure.

## JSON Output

With `--json-output`, successful commands print:

```ts
type ApplyResult = {
  ok: true
  changed: string[]
  affected: string[]
  noop: boolean
  moves: Array<{
    id: string
    src: string
    dst: string
    payload_sha256: string
    payload_bytes: number
    source_range: { start: number; end: number }
    target_range: { start: number; end: number }
    insert_index: number
  }>
}
```

`changed` lists paths whose content changed, or would change during `check` and `--dry-run`. `affected` lists paths examined by the patch. `noop` is true when the patch validated but produced identical bytes. Human text output prints `changed <path>`, `would change <path>`, or `unchanged <path>`.

Errors print:

```ts
type BlockPatchJsonError = {
  ok: false
  error: {
    code: string
    message: string
    path?: string
    matches?: number
  }
}
```

## V0 Format

```diff
diff --blockpatch a/src/example.ts b/src/example.ts
blockpatch version 0
blockpatch move id=move-1 payload-sha256=bc8a95d6eb2b44aa564dbae1040ba8ff2273988ea43f0f3b0c47228f9dba6b3d
--- a/src/example.ts
+++ b/src/example.ts

@@ blockpatch-source move-1 -1,8 +1,4 @@ function movedThing
 function alpha() {
 }
-
-function movedThing() {
-  console.log("keep me exact");
-}
 function omega() {
 }

@@ blockpatch-target move-1 -40,3 +36,7 @@ constructor
   constructor() {
   }
+
+function movedThing() {
+  console.log("keep me exact");
+}
   methodAfter() {
```

Line numbers in hunk headers are review hints only. Application uses context and exact payload verification, not line numbers.

The `--- a/<path>` and `+++ b/<path>` headers may name the same file for an intra-file move or different files for a source-to-destination move. The `a/` and `b/` prefixes are required, and the `diff --blockpatch` line must name the same two raw paths. By default, `blockpatch` strips one leading component from those raw paths, so `a/src/file.ts` and `b/src/file.ts` resolve as `src/file.ts`; use `-p0` only if your working tree contains literal `a/` and `b/` directories.

## Grammar

```text
diff --blockpatch a/<path> b/<path>
blockpatch version 0
blockpatch move id=<id> payload-sha256=<sha256>
--- a/<path>
+++ b/<path>

@@ blockpatch-source <id> -<old-start>,<old-count> +<new-start>,<new-count> @@ optional label
[ <source context before> ]
-<moved payload>
[ <source context after> ]

@@ blockpatch-target <id> -<old-start>,<old-count> +<new-start>,<new-count> @@ optional label
[ <target context before> ]
+<same moved payload>
[ <target context after> ]
```

Source context before and after are exact byte anchors. Either side may be empty, and payload-only source hunks are allowed if the payload is unique.

The target hunk must include context on at least one side. `blockpatch` matches `target context before + target context after` exactly once in the destination file and inserts at `start + target context before.length`.

That means insertion occurs between target-before and target-after context:

```diff
@@ blockpatch-target move-1 -40,2 +40,3 @@
 context before
+moved payload
 context after
```

Either target side may be empty, but not both.

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
9. Fail if a same-file target context range overlaps the source payload bytes.
10. Remove the original source payload bytes.
11. Insert those exact original bytes at the target context boundary.
12. Write changed files with temp-file-and-rename replacement.

Same-file moves are atomic at file-replacement granularity. Cross-file moves preflight both files, then write each file atomically, but the two-file operation is not transactional. The destination is written before the source so an interrupted cross-file move can duplicate the payload, but should not delete it from both files.

## Failure Rules

`blockpatch` exits non-zero and does not modify files when:

- the patch file is malformed
- a patch-declared or move-declared source/destination path escapes `--cwd`
- source anchors are missing
- source anchors or full source are ambiguous
- the located source payload does not exactly match the source hunk payload
- target added payload does not exactly match source removed payload
- `payload-sha256` does not match the moved payload
- the target anchor is missing
- the target anchor is ambiguous
- the target anchor overlaps the source payload
- file I/O fails before a write completes

## Byte Rules

Hunk body lines use unified-diff prefixes:

- space for context
- `-` for source payload
- `+` for target payload

The byte content after the prefix is matched exactly, including line endings. The standard `\ No newline at end of file` marker is supported for a hunk body line without a trailing newline.

Blank lines are separators between the header and hunks. A blank line inside a hunk body is an error; encode an empty context line as a single space.

## Intentionally Out Of Scope

V0 does not implement:

- multiple independent moves in one patch document
- arbitrary generated diffs from before/after file snapshots
- fuzzy matching
- AST parsing
- code formatting
- copy operations
- regex anchors
