import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const npmShell = process.platform === "win32";
const executableModeRequired = process.platform !== "win32";
const smokeRoot = await mkdtemp(join(tmpdir(), "blockpatch-packed-cli-"));
const packDir = join(smokeRoot, "pack");
const installRoot = join(smokeRoot, "install");
const workRoot = join(smokeRoot, "work");
const installedPackageRoot =
  process.platform === "win32"
    ? join(installRoot, "node_modules", "blockpatch")
    : join(installRoot, "lib", "node_modules", "blockpatch");
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
  await assertInstalledPiExtension();
  await smokeVersion();
  await smokeCheckAndApply();
  await smokeConformance();
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}

async function packPackage() {
  const stdout = run("npm", ["pack", "--json", "--pack-destination", packDir], {
    cwd: repoRoot,
    label: "npm pack",
    shell: npmShell
  });
  const [packed] = JSON.parse(stdout);
  assert(packed?.filename, "npm pack must report a tarball filename");
  assert(
    packed.files.some((file) => file.path === "dist/cli.js" && isExecutablePackEntry(file)),
    "packed dist/cli.js must exist and be executable"
  );
  assert(
    packed.files.some((file) => file.path === "package.json"),
    "packed package.json must exist for version lookup"
  );
  assert(
    packed.files.some((file) => file.path === "conformance/runner.mjs" && isExecutablePackEntry(file)),
    "packed conformance runner must exist and be executable"
  );
  assert(
    packed.files.some((file) => file.path === "dist/pi/index.js"),
    "packed Pi extension must exist"
  );
  const tarballPath = join(packDir, packed.filename);
  await access(tarballPath, constants.R_OK);
  console.log(`ok: npm pack ${packed.filename}`);
  return tarballPath;
}

function isExecutablePackEntry(file) {
  return !executableModeRequired || (file.mode & 0o111) !== 0;
}

async function installPackage(tarballPath) {
  run("npm", ["install", "--global", "--prefix", installRoot, tarballPath], {
    cwd: repoRoot,
    label: "npm install packed tarball",
    shell: npmShell
  });
  console.log("ok: npm install packed tarball");
}

async function assertInstalledBin() {
  await access(binPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  await access(conformanceBinPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  console.log("ok: installed blockpatch bins");
}

async function assertInstalledPiExtension() {
  const installedManifest = JSON.parse(await readFile(join(installedPackageRoot, "package.json"), "utf8"));
  assertEqual(installedManifest.pi?.extensions, ["./dist/pi/index.js"], "installed Pi extension manifest");
  await access(join(installedPackageRoot, "dist", "pi", "index.js"), constants.R_OK);
  console.log("ok: installed Pi extension");
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
  const dryRunStdout = runBlockpatch(["apply", patchPath, "--cwd", cwd, "--dry-run"]);
  assertEqual(dryRunStdout, "dry-run clean: move-1 file.txt:2 -> file.txt:5, 1 line\n", "installed dry-run stdout");
  assertEqual(
    await readFile(join(cwd, "file.txt"), "utf8"),
    "alpha\nmove me\nomega\ntarget\n",
    "installed dry-run must not modify files"
  );

  const applyStdout = runBlockpatch(["apply", patchPath, "--cwd", cwd]);
  assertEqual(
    applyStdout,
    "applied: move-1 file.txt:2 -> file.txt:5, 1 line\nchanged: file.txt\n",
    "installed apply stdout"
  );
  assertEqual(
    await readFile(join(cwd, "file.txt"), "utf8"),
    "alpha\nomega\ntarget\nmove me\n",
    "installed apply must move the block"
  );
  console.log("ok: installed blockpatch dry-run/apply");
}

async function smokeConformance() {
  const stdout = run(conformanceBinPath, [binPath], {
    cwd: workRoot,
    label: "installed blockpatch-conformance",
    shell: process.platform === "win32",
    allowedStderr: isNodeShellDeprecationWarning
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
  if (result.status !== 0 || !isAllowedStderr(result.stderr, options.allowedStderr)) {
    throw new Error(
      `${options.label} failed\n` +
        `exit: ${String(result.status)}\n` +
        `stdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`
    );
  }

  return result.stdout;
}

function isAllowedStderr(stderr, allowedStderr) {
  return stderr === "" || (allowedStderr !== undefined && allowedStderr(stderr));
}

function isNodeShellDeprecationWarning(stderr) {
  return (
    /^\(node:\d+\) \[DEP0190\] DeprecationWarning: Passing args to a child process with shell option true/m.test(stderr) &&
    stderr
      .trim()
      .split(/\r?\n/)
      .every((line) => line.includes("[DEP0190]") || line.includes("Use `node --trace-deprecation"))
  );
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
