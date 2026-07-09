# blockpatch

[![CI](https://github.com/cheese-melted/blockpatch/actions/workflows/ci.yml/badge.svg)](https://github.com/cheese-melted/blockpatch/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/blockpatch.svg)](https://www.npmjs.com/package/blockpatch)

Cut/paste for agents: hash-verified block moves that read like unified diffs.

`blockpatch` emits reviewable unified-diff-shaped patches for exact, hash-verified payload moves. In a paired move, the source hunk removes exact bytes and the target hunk adds the same exact bytes, so `blockpatch` moves the original source bytes instead of regenerating them. Generated patches are intended to be compatible with `patch --fuzz=0` where possible, while `blockpatch apply` accepts a strict subset and deliberately rejects fuzzy, heuristic, or ambiguous application.

## Install

```sh
npm install -g blockpatch
blockpatch --help
```

Or run without installing:

```sh
npx blockpatch --help
```

## Usage

`blockpatch` is a deterministic move planner/apply layer for coding agents:

1. Send a JSON move request to `blockpatch move --json - --diff`.
2. Show the emitted `.blockpatch` to the user for review.
3. Apply the reviewed patch with `blockpatch apply`.
4. Retry the `.blockpatch`, not the original JSON request.

Example: move `movedThing` from `src/foo.ts` into `src/bar.ts`, starting from this tree:

```ts
// before: src/foo.ts
export function keepThing() {
  return 7;
}

export function movedThing() {
  return 42;
}

// before: src/bar.ts
export const target = "here";
```

The JSON request selects the source bytes and target anchors. Ask `blockpatch` to plan the byte-exact move and emit the reviewable patch:

```sh
blockpatch move --json - --diff <<'JSON' > patch.blockpatch
{
  "src": "src/foo.ts",
  "src_start": "\nexport function movedThing() {\n",
  "src_end": "}\n",
  "dst": "src/bar.ts",
  "target_before": "export const target = \"here\";\n"
}
JSON
```

`patch.blockpatch` now carries the move as a unified-diff-shaped document:

```diff
diff --blockpatch a/src/foo.ts b/src/foo.ts
blockpatch version 1
blockpatch move id=move-1 role=source payload-sha256=bb03c42613e9289c043d2fced7ce2d8c87410cdb15fa48341ce79fa409d45303
--- a/src/foo.ts
+++ b/src/foo.ts

@@ -3,5 +3,1 @@ blockpatch-source id=move-1
 }
-
-export function movedThing() {
-  return 42;
-}

diff --blockpatch a/src/bar.ts b/src/bar.ts
blockpatch version 1
blockpatch move id=move-1 role=target payload-sha256=bb03c42613e9289c043d2fced7ce2d8c87410cdb15fa48341ce79fa409d45303
--- a/src/bar.ts
+++ b/src/bar.ts

@@ -1,1 +1,5 @@ blockpatch-target id=move-1
 export const target = "here";
+
+export function movedThing() {
+  return 42;
+}
```

`move --diff` validates the source delimiters and target anchors, hashes the selected payload, self-checks the rendered patch against the current tree in memory, and prints it without writing to the tree.

Review the patch, then apply it:

```sh
blockpatch apply patch.blockpatch
```

```
changed src/foo.ts
changed src/bar.ts
```

`apply` checks the payload hash, requires the source block and target anchors to each match exactly once in the current tree, and replaces each changed file atomically. The tree now matches the requested final state:

```ts
// after: src/foo.ts
export function keepThing() {
  return 7;
}

// after: src/bar.ts
export const target = "here";

export function movedThing() {
  return 42;
}
```

Retrying the same `patch.blockpatch` against this tree reports `already_applied`: the patch carries the payload and hash, so a retry validates the final state instead of reselecting bytes from a changed tree.

The same handshake covers whole-file creation and removal via `mode: "create_file"` and `mode: "remove_file"`; those patches use strict `/dev/null` file headers.

## Common Commands

```sh
blockpatch check patch.blockpatch
blockpatch apply patch.blockpatch --dry-run
blockpatch apply patch.blockpatch
blockpatch plan --json -
blockpatch move --json -
```

`check` parses a patch and verifies it against the target tree without writing. `apply --dry-run` validates through the apply path without writing. `apply` writes the verified result.

`move --json -` applies a move request directly; with `--diff` it only prints the rendered patch. `plan --json -` runs the same planner but returns a JSON envelope with validation metadata and the patch in its `patch` field — the agent-facing form shown in [Commands](docs/commands.md). JSON over stdin is the most reliable form because it avoids shell quoting problems.

When using `--cwd`, operation paths inside patches and move JSON are relative to `--cwd`; input patch and move JSON filenames are normal CLI paths, relative to your shell working directory unless absolute.

## Docs

- [Commands](docs/commands.md): supported CLI forms and flags.
- [Patch spec](docs/spec.md): canonical `.blockpatch` artifact format, hunk syntax, `/dev/null`, byte rules, move JSON requests, JSON output, and error codes.
- [Behavior](docs/behavior.md): exact matching, idempotence, path containment, failure rules, and write behavior.
- [Conformance](conformance/): runnable `.blockpatch` cases for checking another implementation.

## Examples

- [same-file relocation](examples/same-file-relocation/)
- [cross-file relocation](examples/cross-file-relocation/)
- [insert existing file](examples/insert-existing-file/)
- [delete existing file](examples/delete-existing-file/)
- [create file](examples/create-file/)
- [remove file](examples/remove-file/)
- [reverse](examples/reverse/)
- [failure: ambiguous target](examples/failure-ambiguous-target/)

Each example has a `patch.blockpatch`, a runnable `work/` directory, and `expected/` output for successful cases.

## Conformance

Run the published conformance cases against a blockpatch-compatible CLI:

```sh
npx -p blockpatch blockpatch-conformance ./my-implementation
```

The runner checks apply/check behavior, retry idempotence, reverse application, byte preservation, and expected structured failures.

## Scope

`blockpatch` intentionally does not implement fuzzy matching, AST parsing, code formatting, copy operations, regex anchors, multiple independent moves in one patch document, or arbitrary generated diffs from before/after snapshots.

`apply` preserves patch body bytes exactly, but `plan`/`move --json` are text-oriented and intended for source files, not arbitrary binary payloads: JSON requests and rendered patches are UTF-8.
