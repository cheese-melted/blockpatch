# Real-world blockpatch experiment

This harness compares the same Codex task in two isolated copies of a real
repository:

- `baseline`: ordinary agent editing
- `blockpatch`: ordinary editing plus an optional blockpatch review/apply flow

The source repository is only read. Each experiment copy is exported from a
historical commit into a sibling `.blockpatch-experiment-runs/` directory,
initialized as a new standalone Git
repository, and executed with Codex's `workspace-write` sandbox. The copied
repository has no original Git history, so the agent cannot discover the
historical solution with `git log`.

## First run

From the blockpatch repository:

```sh
bun run build
npm run experiment -- doctor git-trails-split-views
npm run experiment -- setup git-trails-split-views
npm run experiment -- run git-trails-split-views baseline
npm run experiment -- run git-trails-split-views blockpatch
npm run experiment -- compare git-trails-split-views
```

Or run both arms sequentially and print the report:

```sh
npm run experiment -- run-all git-trails-split-views
```

Choose the coding harness explicitly when comparing tool-level integration:

```sh
npm run experiment -- run-all shooter-move-csv \
  --agent pi \
  --model openai-codex/gpt-5.4-mini \
  --reasoning xhigh
```

The Pi baseline receives `read,bash,edit,write`. The treatment receives the
same tools plus the native `blockpatch` extension tool. Personal Pi extensions,
skills, and prompt templates are disabled for both arms; repository context
files remain enabled equally.

`setup` installs the task's dependencies before either agent starts. `run`
captures the Codex JSONL event stream, final response, final Git diff, project
test log, duration, token usage when exposed by the CLI, and any `.blockpatch`
artifacts. It also runs task-specific acceptance checks stored outside the agent
sandbox, so changing visible tests cannot disguise a missed requirement.
`compare` writes and prints a compact report.

Runs default to the model configured by Codex and a 15-minute timeout per agent
and test phase. Pin a model when repeatability matters:

```sh
npm run experiment -- run-all git-trails-split-views --model gpt-5.6-luna --reasoning max --timeout 1200
```

## Results

Artifacts are stored outside source repositories under:

```text
.blockpatch-experiment-runs/<task>/
  baseline/
    workspace/          isolated edited repository
    <agent>.jsonl       Codex or Pi event log
    <agent>.stderr.log  non-event harness diagnostics
    last-message.md     agent handoff
    result.patch        final change
    test.log            independent test run
    hidden-test.log     acceptance checks unavailable to the agent
    result.json         measurements
  blockpatch/
    ...
  report.md
```

The primary result is whether the hidden acceptance checks and tests are
correct. Exact equality
with the historical reference is only supporting evidence because more than one
implementation can be valid. Review both `result.patch` files without looking
at the arm name first, then inspect the treatment arm's `.blockpatch-artifacts/`
to decide whether it added useful assurance.

## Safety and cleanup

The harness deliberately avoids `git worktree`, `git reset`, and `git clean` in
the source project. Destructive cleanup is restricted to the selected task's
directory below `.blockpatch-experiment-runs/`. Keeping run copies outside the
source repository also prevents test runners from discovering copied tests.

To discard a trial:

```sh
npm run experiment -- clean git-trails-split-views
```

Task definitions live in `experiment/tasks/`. A task pins a source repository,
base revision, hidden reference revision, prompt, dependency setup command, test
command, external acceptance command, and timeout. Evaluators live under
`experiment/evaluators/` and receive the isolated workspace path.
