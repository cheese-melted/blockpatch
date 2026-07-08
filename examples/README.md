# Examples

Each successful example contains:

- `patch.blockpatch`: the reviewed patch artifact.
- `work/`: the before-state tree used by `-d`.
- `expected/`: the after-state tree after applying the patch.

Check an example without writing:

```sh
blockpatch check examples/same-file-relocation/patch.blockpatch -d examples/same-file-relocation/work
```

To apply without changing the checked-in example tree, copy `work/` to a scratch directory and use that as `-d`.
