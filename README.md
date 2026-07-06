# blockpatch

`blockpatch` applies anchored text block relocation patches that look like unified diffs. It is not a generic diff tool, an AST refactor tool, a formatter, or a fuzzy matcher.

The core invariant is simple: a move transfers one exact, hash-verified payload between endpoints. In a paired move, the source hunk removes exact bytes and the target hunk adds the same exact bytes, so `blockpatch` moves the original source bytes instead of regenerating them.

A move may also be one-sided. A source-only hunk removes the verified payload from an existing file. A target-only hunk materializes the patch-carried payload into an existing file. File path absence is represented separately with `/dev/null` in file headers: `/dev/null -> file` creates a file, and `file -> /dev/null` removes a file.

`blockpatch` emits reviewable unified-diff-shaped patches that are intended to be compatible with `patch --fuzz=0` where possible. `blockpatch apply` accepts a strict, hash-verified subset of those patches and deliberately rejects fuzzy, heuristic, or ambiguous application.

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
blockpatch apply patch.blockpatch --reverse
blockpatch check patch.blockpatch -R
blockpatch apply - < patch.blockpatch
blockpatch apply < patch.blockpatch
blockpatch apply -i patch.blockpatch
blockpatch apply -d repo-root -p1 patch.blockpatch
blockpatch check -p1 < patch.blockpatch
blockpatch move --json -
blockpatch move --json move.json
blockpatch move --src src/foo.ts --src-start $'\nfunction movedThing() {' --src-end $'\n}\n' --target-before $'class Target {\n'
blockpatch move --src /dev/null --dst src/foo.ts --payload $'inserted bytes\n' --target-before $'context before\n'
blockpatch move --src src/foo.ts --src-start $'\nfunction removeMe() {' --src-end $'\n}\n' --dst /dev/null
```

`check` parses the patch and verifies it against the target file without writing. `apply --dry-run` does the same validation through the apply path without writing. `-R`/`--reverse` moves the verified payload back from the target location to the source location; it works with both `check` and `apply`.

Patch-declared source and destination paths, and move JSON `src`/`dst` paths, must be relative, non-empty, and resolve inside `--cwd`. Absolute operation paths, `..` escapes, and operation paths containing symlink components are rejected. Existing regular files are also realpath-checked; if the real path escapes `--cwd`, the operation is rejected. `-d`/`--directory` is an alias for `--cwd`. Patch files and move JSON files may be read from any path; use `--cwd` to choose the directory the operation is allowed to modify.

`apply` and `check` read the patch from stdin when no patch path is supplied. `-i`/`--input` names the patch file explicitly. `-pN`/`--strip N` strips leading path components from patch-declared file paths. Unlike GNU patch, `blockpatch` defaults to git-style `-p1` path stripping because patch headers require `a/` and `b/` prefixes.

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

Insertion occurs between `target_before` and `target_after`. Either side may be omitted, but not both. With only `target_before`, the block is inserted after that context. With only `target_after`, the block is inserted before that context.

Matching and insertion are byte-exact: the moved bytes are cut at the source and inserted directly at the anchor boundary, with no newline handling. Keep delimiters and anchors on line boundaries or the result will splice mid-line. Include the surrounding newlines you want moved in `src_start` and `src_end`.

The move JSON and `--diff` planner interfaces are UTF-8 text interfaces. They are intended for source text, not arbitrary binary payloads or invalid UTF-8 byte sequences.

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
  --target-after $'}\n' \
  --expected-payload-sha256 <sha256>
```

Use `--dry-run` to validate without writing, `--diff` to print a reviewable `.blockpatch` document (`--diff` implies dry-run and never writes), and `--json-output` for machine-readable success or error output. Before `move --diff` returns success, it parses and checks its own emitted patch against the current tree in memory. `--explain` is a dry-run JSON alias for `--dry-run --json-output`; it reuses the existing `moves` byte ranges and payload hash fields instead of introducing a separate planner.

For agents, the canonical planning handshake is:

```sh
blockpatch move --json - --diff --json-output
```

That command validates the provided source delimiters and/or target anchors, computes byte ranges, hashes the selected or supplied payload, renders the exact reviewable `.blockpatch`, self-checks that patch through the same in-memory `check` path, lists affected files, and returns the patch in the JSON `patch` field without mutating the working tree. A typical flow is: propose a move as JSON, let `blockpatch` validate and render the exact patch, show that patch to the user, then apply the `.blockpatch` in a second explicit step.

## Move JSON

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
  dry_run?: boolean
}
```

Rules:

- In `move --json`, `/dev/null` denotes the absent source or target hunk endpoint for in-file insertion/deletion; `move --diff` renders those as normal same-file one-sided patch sections. Whole-file path creation/removal is expressed directly as `.blockpatch` documents with `/dev/null` file headers.
- For relocation, `src_start` and `src_end` are inclusive source delimiters; `dst` defaults to `src`.
- For deletion, set `dst` to `/dev/null`; `src_start` and `src_end` select the removed payload.
- For insertion, set `src` to `/dev/null`; `dst`, `payload`, and target context are required.
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

`changed` lists paths whose content changed, or would change during `check`, `--dry-run`, `--diff`, and `--explain`. `written` is true only when files were actually replaced by the command; it is false for `check`, `--dry-run`, `--diff`, `--explain`, `noop`, and `already_applied`. `affected` lists paths examined by the patch. `noop` is true when the patch validated but produced identical bytes. `status` is `applied` for a normal computed move, `noop` for a computed move whose output bytes are identical, and `already_applied` when the requested final state is already present. `patch` is present when `move --diff --json-output` is used. In `already_applied` relocation results, `source_range` is `null` because the source block is no longer present. For target-only insertions, `source_range` is `null`. For source-only deletions, `target_range` and `insert_index` are `null`. For path creation/removal, `src` or `dst` is the string `/dev/null`. Human text output prints `changed <path>`, `would change <path>`, or `unchanged <path>`.

Errors print:

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

Error codes are the agent-facing branch contract. From `1.0.0` onward, removing a code or changing its meaning is semver-major.

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

## V1 Format

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
- retries are idempotent: adjacent source anchors, or an absent anchorless payload, report `already_applied`.

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

Same-file moves use one file section. In that shape, the `--- a/<path>` and `+++ b/<path>` headers must name the same file after normal path cleanup.

Cross-file moves use two conventional file sections tied by the same move id and payload hash: one `role=source` section for the source file and one `role=target` section for the target file. Each section's `---` and `+++` headers name the same file. This avoids the misleading patch shape where `--- a/source.ts` and `+++ b/target.ts` look like a transformation from one filename into another.

The `a/` and `b/` prefixes are required, and each `diff --blockpatch` line must name the same two raw paths as that section's file headers. Unlike GNU patch, `blockpatch` defaults to git-style `-p1` path stripping: `a/src/file.ts` and `b/src/file.ts` resolve as `src/file.ts`; use `-p0` only if your working tree contains literal `a/` and `b/` directories.

## Grammar

Same-file move, insertion, or deletion:

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

Cross-file move:

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

Source context before and after are exact byte anchors. Either side may be empty, and payload-only source hunks are allowed if the payload is unique. Target hunks for existing files must include context on at least one side.

`blockpatch move` metadata keys must be unique. The recognized keys are `id`, `payload-sha256`, and `role`; unknown keys are rejected unless they use the reserved `x-` extension prefix.

The `-<old-start>,<old-count> +<new-start>,<new-count>` ranges are line-number hints for review, not match authority. `blockpatch` validates the line counts against the hunk body, but it locates changes by exact context and payload bytes.

For target hunks in existing files, `blockpatch` matches `target context before + target context after` exactly once in the destination file and inserts at `start + target context before.length`.

That means insertion occurs between target-before and target-after context:

```diff
@@ -40,2 +40,3 @@ blockpatch-target id=move-1
 context before
+moved payload
 context after
```

Either target side may be empty, but not both, unless the target hunk is a whole-file `/dev/null -> file` creation hunk.

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

If the requested final state is already present, `blockpatch` reports `already_applied`. For paired moves, that means the source full match is absent and `target context before + payload + target context after` is present exactly once. For target-only insertion, the target payload is already between the target anchors. For source-only deletion, the source anchors are already adjacent or an anchorless payload is absent. This is strict idempotence for retries; it does not search fuzzily or infer moved bytes.

With `-R`/`--reverse`, `blockpatch` swaps hunk roles and path endpoints. Reverse application is exact and non-fuzzy. A payload-only source hunk has no source-side anchor for reverse insertion, so reverse requires source context before or after unless it is a whole-file path recreation.

Same-file moves are atomic at file-replacement granularity. Cross-file moves preflight both files and stage all changed temp files before renaming any original. If staging fails, originals are left untouched. Once renames begin, the two-file operation is still not transactional; the destination is renamed before the source so an interruption can duplicate the payload, but should not delete it from both files. Atomic here means per-file replacement, not a crash-durable multi-file transaction.

## Failure Rules

`blockpatch` exits non-zero and does not modify files when:

- the patch file is malformed
- both endpoints are `/dev/null`
- a patch-declared or move-declared source/destination path is absolute, invalid, or escapes `--cwd`
- a referenced file is missing (and the patch does not say `/dev/null` where creation or removal would make that legal), not a regular file, unreadable, unwritable, or otherwise hits a filesystem error
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
