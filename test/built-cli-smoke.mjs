import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join("dist", "cli.js");
const fixtureRoot = join(repoRoot, "test", "fixtures");
const positiveGoldenFixtures = ["success", "source-before-target", "source-after-target"];

const relocationPatch =
  "diff --blockpatch a/file.txt b/file.txt\n" +
  "blockpatch version 1\n" +
  "blockpatch move id=move-1 payload-sha256=f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e\n" +
  "--- a/file.txt\n" +
  "+++ b/file.txt\n" +
  "\n" +
  "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n" +
  " alpha\n" +
  "-move me\n" +
  " omega\n" +
  "\n" +
  "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n" +
  " target\n" +
  "+move me\n";

const patchBefore = "alpha\nmove me\nomega\ntarget\n";
const patchAfter = "alpha\nomega\ntarget\nmove me\n";
const moveBefore = "alpha\nfunction movedThing() {\n  return 42;\n}\nomega\nclass Target {\n}\n";

const smokeRoot = await mkdtemp(join(tmpdir(), "blockpatch-built-cli-"));

try {
  await smokeCheckAndApply();
  await smokeGoldenFixtureApply();
  await smokeMoveDiffJson();
  await smokePlanJson();
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}

async function smokeCheckAndApply() {
  const cwd = join(smokeRoot, "patch");
  await mkdir(cwd);
  await writeFile(join(cwd, "file.txt"), patchBefore);
  await writeFile(join(cwd, "patch.blockpatch"), relocationPatch);

  const checkStdout = runCli(["check", "patch.blockpatch", "--cwd", cwd]);
  assertEqual(checkStdout, "would change file.txt\n", "check stdout");
  assertEqual(await readFile(join(cwd, "file.txt"), "utf8"), patchBefore, "check must not modify files");
  console.log("ok: node dist/cli.js check");

  const applyStdout = runCli(["apply", "patch.blockpatch", "--cwd", cwd]);
  assertEqual(applyStdout, "changed file.txt\n", "apply stdout");
  assertEqual(await readFile(join(cwd, "file.txt"), "utf8"), patchAfter, "apply must move the block");
  console.log("ok: node dist/cli.js apply");
}

async function smokeGoldenFixtureApply() {
  for (const fixtureName of positiveGoldenFixtures) {
    const cwd = join(smokeRoot, `golden-${fixtureName}`);
    const fixtureDir = join(fixtureRoot, fixtureName);
    await mkdir(cwd);
    await writeFile(join(cwd, "file.txt"), await readFile(join(fixtureDir, "before.txt")));
    await writeFile(join(cwd, "patch.blockpatch"), await readFile(join(fixtureDir, "patch.blockpatch")));

    const stdout = runCli(["apply", "patch.blockpatch", "--cwd", cwd]);
    assertEqual(stdout, "changed file.txt\n", `${fixtureName} apply stdout`);
    assertEqual(
      await readFile(join(cwd, "file.txt"), "utf8"),
      await readFile(join(fixtureDir, "after.txt"), "utf8"),
      `${fixtureName} apply output`
    );
  }
  console.log("ok: node dist/cli.js apply golden fixtures");
}

async function smokeMoveDiffJson() {
  const cwd = join(smokeRoot, "move");
  await mkdir(cwd);
  await writeFile(join(cwd, "source.ts"), moveBefore);

  const stdout = runCli(["move", "--json", "-", "--diff", "--json-output", "--cwd", cwd], {
    input: JSON.stringify({
      src: "source.ts",
      src_start: "function movedThing() {\n",
      src_end: "}\n",
      target_before: "class Target {\n",
      target_after: "}\n"
    })
  });
  const result = JSON.parse(stdout);

  assertEqual(result.ok, true, "move JSON ok");
  assertEqual(result.changed, ["source.ts"], "move JSON changed");
  assertEqual(result.written, false, "move --diff must not write");
  assert(typeof result.patch === "string", "move JSON must include a patch");
  assert(result.patch.includes("diff --blockpatch a/source.ts b/source.ts"), "move patch must include source.ts diff");
  assert(result.patch.includes("@@ -1,5 +1,2 @@ blockpatch-source id=move-1"), "move patch must include source hunk");
  assert(result.patch.includes("@@ -6,2 +3,5 @@ blockpatch-target id=move-1"), "move patch must include target hunk");
  assertEqual(await readFile(join(cwd, "source.ts"), "utf8"), moveBefore, "move --diff must not modify files");
  console.log("ok: node dist/cli.js move --json - --diff --json-output");
}

async function smokePlanJson() {
  const cwd = join(smokeRoot, "plan");
  await mkdir(cwd);
  await writeFile(join(cwd, "source.ts"), moveBefore);

  const stdout = runCli(["plan", "--json", "-", "--cwd", cwd], {
    input: JSON.stringify({
      src: "source.ts",
      src_start: "function movedThing() {\n",
      src_end: "}\n",
      target_before: "class Target {\n",
      target_after: "}\n"
    })
  });
  const result = JSON.parse(stdout);

  assertEqual(result.ok, true, "plan JSON ok");
  assertEqual(result.changed, ["source.ts"], "plan JSON changed");
  assertEqual(result.written, false, "plan must not write");
  assert(typeof result.patch === "string", "plan JSON must include a patch");
  assert(result.patch.includes("diff --blockpatch a/source.ts b/source.ts"), "plan patch must include source.ts diff");
  assert(result.patch.includes("@@ -1,5 +1,2 @@ blockpatch-source id=move-1"), "plan patch must include source hunk");
  assert(result.patch.includes("@@ -6,2 +3,5 @@ blockpatch-target id=move-1"), "plan patch must include target hunk");
  assertEqual(await readFile(join(cwd, "source.ts"), "utf8"), moveBefore, "plan must not modify files");
  console.log("ok: node dist/cli.js plan --json -");
}

function runCli(args, options = {}) {
  const command = ["node", "dist/cli.js", ...args].join(" ");
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 1024 * 1024
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(
      `${command} failed\n` +
        `exit: ${String(result.status)}\n` +
        `stdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`
    );
  }

  return result.stdout;
}

function assertEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${label}: expected ${expectedJson}, got ${actualJson}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
