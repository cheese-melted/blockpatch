# blockpatch conformance

These cases exercise the public `.blockpatch` dry-run/apply contract for independent implementations.

Run against an installed implementation:

```sh
npx -p blockpatch blockpatch-conformance ./my-implementation
```

The shorter `npx blockpatch-conformance ./my-implementation` spelling would require publishing a separate npm package named `blockpatch-conformance`; this repository currently ships the runner as a `blockpatch` package binary.

Run against this repository after building:

```sh
npm run build
node conformance/runner.mjs node dist/cli.js
```

The runner invokes the implementation as:

```sh
<implementation> apply <patch.blockpatch> --cwd <work> --dry-run --json-output
<implementation> apply <patch.blockpatch> --cwd <work> --json-output
```

Successful cases also verify retry idempotence and `apply --reverse`. Failure cases verify the expected JSON error code and that the work tree remains byte-identical.

Set `BLOCKPATCH_CONFORMANCE_KEEP=1` to keep the temporary work directory after a failure.
