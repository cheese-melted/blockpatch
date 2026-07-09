import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const smokeRoot = await mkdtemp(join(tmpdir(), "blockpatch-packed-cli-"));
const packDir = join(smokeRoot, "pack");
const installRoot = join(smokeRoot, "install");
const workRoot = join(smokeRoot, "work");
const binPath =
  process.platform === "win32"
    ? join(installRoot, "blockpatch.cmd")
    : join(installRoot, "bin", "blockpatch");
const conformanceBinPath =
  process.platform === "win32"
    ? join(installRoot, "blockpatch-conformance.cmd")
    : join(installRoot, "bin", "blockpatch-conformance");

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

try {
  await mkdir(packDir);
  await mkdir(workRoot);
  const tarballPath = await packPackage();
  await installPackage(tarballPath);
  await assertInstalledBin();
  await smokeVersion();
  await smokeCheckAndApply();
  await smokeConformance();
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}

async function packPackage() {
  const stdout = run(npmCommand, ["pack", "--json", "--pack-destination", packDir], {
    cwd: repoRoot,
    label: "npm pack"
  });
  const [packed] = JSON.parse(stdout);
  assert(packed?.filename, "npm pack must report a tarball filename");
  assert(
    packed.files.some((file) => file.path === "dist/cli.js" && (file.mode & 0o111) !== 0),
    "packed dist/cli.js must exist and be executable"
  );
  assert(
    packed.files.some((file) => file.path === "package.json"),
    "packed package.json must exist for version lookup"
  );
  assert(
    packed.files.some((file) => file.path === "conformance/runner.mjs" && (file.mode & 0o111) !== 0),
    "packed conformance runner must exist and be executable"
  );
  const tarballPath = join(packDir, packed.filename);
  await access(tarballPath, constants.R_OK);
  console.log(`ok: npm pack ${packed.filename}`);
  return tarballPath;
}

async function installPackage(tarballPath) {
  run(npmCommand, ["install", "--global", "--prefix", installRoot, tarballPath], {
    cwd: repoRoot,
    label: "npm install packed tarball"
  });
  console.log("ok: npm install packed tarball");
}

async function assertInstalledBin() {
  await access(binPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  await access(conformanceBinPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  console.log("ok: installed blockpatch bins");
}

async function smokeVersion() {
  const stdout = runBlockpatch(["version"]);
  assertEqual(stdout, `blockpatch ${packageJson.version}\n`, "installed version stdout");
  console.log("ok: installed blockpatch version");
}

async function smokeCheckAndApply() {
  const cwd = join(workRoot, "patch");
  await mkdir(cwd);
  await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\ntarget\n");
  await writeFile(join(cwd, "patch.blockpatch"), relocationPatch);

  const patchPath = join(cwd, "patch.blockpatch");
  const checkStdout = runBlockpatch(["check", patchPath, "--cwd", cwd]);
  assertEqual(checkStdout, "would change file.txt\n", "installed check stdout");
  assertEqual(
    await readFile(join(cwd, "file.txt"), "utf8"),
    "alpha\nmove me\nomega\ntarget\n",
    "installed check must not modify files"
  );

  const applyStdout = runBlockpatch(["apply", patchPath, "--cwd", cwd]);
  assertEqual(applyStdout, "changed file.txt\n", "installed apply stdout");
  assertEqual(
    await readFile(join(cwd, "file.txt"), "utf8"),
    "alpha\nomega\ntarget\nmove me\n",
    "installed apply must move the block"
  );
  console.log("ok: installed blockpatch check/apply");
}

async function smokeConformance() {
  const stdout = run(conformanceBinPath, [binPath], {
    cwd: workRoot,
    label: "installed blockpatch-conformance",
    shell: process.platform === "win32"
  });
  assert(stdout.includes("ok 10 conformance cases"), "conformance runner must pass installed blockpatch");
  console.log("ok: installed blockpatch-conformance");
}

function runBlockpatch(args, options = {}) {
  return run(binPath, args, {
    cwd: options.cwd ?? workRoot,
    input: options.input,
    label: `installed blockpatch ${args.join(" ")}`,
    shell: process.platform === "win32"
  });
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 1024 * 1024,
    shell: options.shell ?? false
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(
      `${options.label} failed\n` +
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
