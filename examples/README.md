# Examples

## End-To-End Move

Start with two files:

```ts
// src/foo.ts
export function keepThing() {
  return 7;
}

export function movedThing() {
  return 42;
}

// src/bar.ts
export const target = "here";
```

Create a reviewable patch without writing to the tree:

```sh
blockpatch move --json - --diff --output patch.blockpatch <<'JSON'
{
  "src": "src/foo.ts",
  "src_start": "\nexport function movedThing() {\n",
  "src_end": "}\n",
  "dst": "src/bar.ts",
  "insert_after": "export const target = \"here\";\n"
}
JSON
```

Validate and apply the reviewed artifact:

```sh
blockpatch apply patch.blockpatch --dry-run
blockpatch apply patch.blockpatch
```

The result is:

```ts
// src/foo.ts
export function keepThing() {
  return 7;
}

// src/bar.ts
export const target = "here";

export function movedThing() {
  return 42;
}
```

Use `blockpatch plan --json -` instead when a script or agent needs the same
patch plus validation metadata in a JSON envelope.

## Fixture Examples

Each successful example contains:

- `patch.blockpatch`: the reviewed patch artifact.
- `work/`: the before-state tree used by `-d`.
- `expected/`: the after-state tree after applying the patch.

Check an example without writing:

```sh
blockpatch apply examples/same-file-relocation/patch.blockpatch -d examples/same-file-relocation/work --dry-run
```

To apply without changing the checked-in example tree, copy `work/` to a scratch directory and use that as `-d`.
