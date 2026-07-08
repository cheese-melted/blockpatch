# blockpatch

[![CI](https://github.com/cheese-melted/blockpatch/actions/workflows/ci.yml/badge.svg)](https://github.com/cheese-melted/blockpatch/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/blockpatch.svg)](https://www.npmjs.com/package/blockpatch)

Cut/paste for agents: hash-verified block moves that read like unified diffs.

`blockpatch` emits reviewable unified-diff-shaped patches for exact, hash-verified payload moves. In a paired move, the source hunk removes exact bytes and the target hunk adds the same exact bytes, so `blockpatch` moves the original source bytes instead of regenerating them. Generated patches are intended to be compatible with `patch --fuzz=0` where possible, while `blockpatch apply` accepts a strict subset and deliberately rejects fuzzy, heuristic, or ambiguous application.

## Install

```sh
npm install -g blockpatch
npx blockpatch --help
```

## Usage

`blockpatch` is a deterministic move planner/apply layer for coding agents:

1. Send a JSON move request to `blockpatch plan --json -`.
2. Show the returned `.blockpatch` to the user for review.
3. Apply the reviewed patch with `blockpatch apply`.
4. Retry the `.blockpatch`, not the original JSON request.

Example:

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

The JSON request selects the source bytes and target anchors. The returned `.blockpatch` carries the exact payload and hash, so retries validate the final state without asking the agent to reselect bytes from a changed tree.

Ask `blockpatch` to plan a byte-exact move from JSON:

```sh
blockpatch plan --json - <<'JSON'
{
  "src": "src/foo.ts",
  "src_start": "\nexport function movedThing() {\n",
  "src_end": "}\n",
  "dst": "src/bar.ts",
  "target_before": "export const target = \"here\";\n"
}
JSON
```

`plan` validates the source delimiters and target anchors, computes byte ranges, hashes the selected payload, renders a reviewable `.blockpatch`, self-checks that patch against the current tree in memory, and returns the patch in JSON without writing.

Apply the reviewed patch explicitly:

```sh
blockpatch apply patch.blockpatch --dry-run
blockpatch apply patch.blockpatch
```

The same JSON planning handshake covers whole-file path creation and removal with explicit `mode: "create_file"` and `mode: "remove_file"` requests; the returned review artifact uses strict `/dev/null` file headers.

## Common Commands

```sh
blockpatch check patch.blockpatch
blockpatch apply patch.blockpatch --dry-run
blockpatch apply patch.blockpatch
blockpatch plan --json -
blockpatch move --json -
```

`check` parses a patch and verifies it against the target tree without writing. `apply --dry-run` validates through the apply path without writing. `apply` writes the verified result.

`plan --json -` is the canonical agent planning handshake. `move --json -` uses the same move interface directly. JSON over stdin is the most reliable form because it avoids shell quoting problems.

When using `--cwd`, operation paths inside patches and move JSON are relative to `--cwd`; input patch and move JSON filenames are normal CLI paths, relative to your shell working directory unless absolute.

## Docs

- [Patch spec](docs/spec.md): canonical `.blockpatch` syntax, grammar, one-sided hunks, `/dev/null`, semantics, byte rules, and scope.
- [Agent protocol](docs/agent-protocol.md): command forms, move JSON, JSON output, and error codes.
- [Safety model](docs/safety-model.md): exact matching, path containment, idempotence, failure rules, and write behavior.

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

## Scope

`blockpatch` intentionally does not implement fuzzy matching, AST parsing, code formatting, copy operations, regex anchors, multiple independent moves in one patch document, or arbitrary generated diffs from before/after snapshots.
