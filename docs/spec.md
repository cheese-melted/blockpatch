# blockpatch Spec

This document defines the `.blockpatch` artifact format, move JSON request contract, and JSON output contract. The public API is the CLI and its JSON output; there is no library API.

For command forms, see [Commands](commands.md). For planning, matching, idempotence, and write behavior, see [Behavior](behavior.md).

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

- Every file section must declare `blockpatch version 1` on the line after `diff --blockpatch`.
- The `a/` and `b/` prefixes are required, and each `diff --blockpatch` line must name the same two raw paths as that section's file headers. The prefixes are consumed by the default `-p1` path stripping ([Commands](commands.md#paths-and-stripping)).
- Patch-declared paths use POSIX-style `/` separators on every platform. Backslashes, `.`/`..` path segments, and non-printing control characters are rejected instead of normalized or escaped.
- `blockpatch move` metadata keys must be unique. The recognized keys are `id`, `payload-sha256`, and `role`; unknown keys are rejected unless they use the reserved `x-` extension prefix.
- Source context before and after may each be empty.
- Target hunks for existing files must include context on at least one side; either side may be empty, but not both.
- Whole-file creation and removal hunks (a `/dev/null` endpoint) contain only contiguous payload lines, with no context lines.
- The `-<old-start>,<old-count> +<new-start>,<new-count>` ranges must match the hunk body line counts, but the range values are line-number hints for review.

## One-Sided Hunks And Null Endpoints

One-sided hunks are for in-file insertion and deletion when the file exists both before and after the patch.

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

`/dev/null` is reserved for path absence. It appears bare, without an `a/` or `b/` prefix, exactly as in git diffs, so it can never collide with a real file named `dev/null` (which would appear as `a/dev/null`).

Use `/dev/null` only when the file path itself is absent before or after the patch. A `/dev/null -> file` section is the whole-file creation shape:

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

A `file -> /dev/null` section is the whole-file removal shape:

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

Matching rules, idempotence, reverse application, and write behavior are documented in [Behavior](behavior.md).

## Byte Rules

Hunk body lines use unified-diff prefixes:

- space for context
- `-` for source payload
- `+` for target payload

The byte content after the prefix is matched exactly, including line endings. The standard `\ No newline at end of file` marker is supported for a hunk body line without a trailing newline.

Blank lines are separators between the header and hunks. A blank line inside a hunk body is an error; encode an empty context line as a single space.

## Move JSON

Move JSON is the request contract accepted by `blockpatch plan --json` and `blockpatch move --json`.

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

Request shapes:

- For relocation, `src_start` and `src_end` are inclusive source delimiters, and `dst` defaults to `src`.
- For deletion, set `dst` to `/dev/null`; `src_start` and `src_end` select the removed payload.
- For insertion, set `src` to `/dev/null`; `dst`, `payload`, and target context are required.
- For file creation, set `src` to `/dev/null`, set `mode` to `create_file`, and provide `dst` plus `payload`. Empty payload is valid and creates an empty file.
- For file removal, set `dst` to `/dev/null` and set `mode` to `remove_file`. The whole source file is selected as the payload.
- `mode` selects the whole-file path shapes; without it, `/dev/null` endpoints denote in-file insertion/deletion. `move --diff` renders the in-file shapes as same-file one-sided sections and the `mode` shapes with `/dev/null` file headers.
- `target_before`, `target_after`, or both are required for relocation and insertion.
- `payload` is only valid when `src` is `/dev/null`; it must be non-empty for in-file insertion.
- `expected_payload_sha256` is optional.

`src_start`, `src_end`, `target_before`, and `target_after` are byte-exact and newline-sensitive. Source selection starts at `src_start` and ends after the first following `src_end`; include any leading or trailing newline you want in the selected payload. `target_before` is the exact context before the insertion point, so insertion occurs after it. `target_after` is the exact context after the insertion point, so insertion occurs before it. `blockpatch` never inserts extra newlines or spacing between anchors and payload.

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

Matching behavior for move JSON requests is documented in [Behavior](behavior.md#move-json-behavior).

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
  warnings?: Array<{
    code: "adjacent_bytes"
    message: string
    path: string
    phase: "target"
    boundary: "target_before+payload" | "payload+target_after"
    suggested_action: string
  }>
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

`patch` is present when `move --diff --json-output` is used. `warnings` is present when a move validates but may surprise a caller, such as an insertion boundary where neither side contains a newline and the bytes will be joined directly. In `already_applied` relocation results, `source_range` is `null` because the source block is no longer present. For target-only insertions, `source_range` is `null`. For source-only deletions, `target_range` and `insert_index` are `null`. For path creation/removal, `src` or `dst` is the string `/dev/null`.

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
    matches_truncated?: boolean
    ranges?: Array<{ start: number; end: number }>
    line_ranges?: Array<{ start: number; end: number }>
    source_range?: { start: number; end: number }
    target_range?: { start: number; end: number }
    payload_sha256?: string
    suggested_action?: string
  }
}
```

Ambiguous-match errors include up to the first 10 exact byte ranges for the matched anchors or candidate source ranges, plus matching 1-based inclusive `line_ranges` when the relevant file bytes are available. When `matches_truncated` is true, `matches` is a lower bound rather than an exact count. They do not include source snippets, fuzzy suggestions, or repair guidance.

`partial_applied_duplicate` reports an interrupted cross-file apply state where the source payload is still present and the destination already contains the exact final target state. It includes `source_range`, `target_range`, `payload_sha256`, and `suggested_action: "review_then_remove_source"`. `blockpatch` does not auto-repair this state.

Error codes are the agent-facing branch contract: branch on `error.code`, not on human-readable messages. Removing a code or changing its meaning is semver-major.

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
  | "concurrent_modification"
  | "partial_applied_duplicate"
  | "payload_mismatch"
  | "hash_mismatch"
  | "invalid_utf8"
  | "target_overlaps_source"
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
