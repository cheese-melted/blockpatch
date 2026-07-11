# Pi coding harness integration

The Pi extension registers `blockpatch` beside Pi's built-in `read`, `edit`,
and `write` tools. The model receives structured `plan` and `apply` actions;
it does not need to discover or invoke the blockpatch CLI through `bash`.

## Local development

From another project, load this checkout's extension explicitly:

```sh
pi \
  --extension /path/to/blockpatch/integrations/pi/index.ts \
  --tools read,edit,write,blockpatch
```

To try the published package after a release:

```sh
pi install npm:blockpatch
pi --tools read,edit,write,blockpatch
```

Pi packages execute with the same host access as Pi. Review an extension before
installing it. This extension confines operation paths and reviewed artifacts to
Pi's working directory using blockpatch's normal path and symlink checks.

## Tool protocol

`blockpatch` has two actions:

- `plan`: accepts the normal move fields, validates the exact move without
  changing source files, writes a content-addressed artifact under
  `.blockpatch-artifacts/`, and returns the reviewable patch.
- `apply`: accepts the reviewed artifact path and optionally `dry_run` or
  `reverse`. It verifies that the artifact bytes match the SHA-256 encoded in
  the content-addressed filename, then revalidates the patch against the live
  tree before writing. Apply rejects patch paths outside the canonical
  `.blockpatch-artifacts/move-<sha256>.blockpatch` form.

The extension joins Pi's shared mutation queue for every affected path. A
concurrent `edit`, `write`, or second blockpatch operation targeting the same
file is serialized rather than racing the apply operation.
