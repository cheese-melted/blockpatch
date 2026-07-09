import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, link, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { applyPatchFile } from "../src/engine";
import { moveBlock } from "../src/move";

export const fixtureRoot = join(import.meta.dir, "fixtures");
export const exampleRoot = join(import.meta.dir, "..", "examples");
export const systemPatchAvailable = hasSystemPatch();

export type PublicExampleCase = {
  name: string;
  changed: string[];
  expectedFiles?: string[];
  missingFiles?: string[];
  reverse?: boolean;
};

export async function fixtureCase(name: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `blockpatch-${name}-`));
  const fixtureDir = join(fixtureRoot, name);
  const before = await readFile(join(fixtureDir, "before.txt"));
  const patch = await readFile(join(fixtureDir, "patch.blockpatch"));
  await writeFile(join(cwd, "file.txt"), before);
  await writeFile(join(cwd, "patch.blockpatch"), patch);
  return cwd;
}

export async function symlinkOrSkip(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      return false;
    }
    throw error;
  }
}

export async function hardlinkOrSkip(existingPath: string, newPath: string): Promise<boolean> {
  try {
    await link(existingPath, newPath);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || code === "EXDEV") {
      return false;
    }
    throw error;
  }
}

export async function expectFixtureApply(name: string): Promise<void> {
  const cwd = await fixtureCase(name);
  await applyPatchFile("patch.blockpatch", { cwd });
  const actual = await readFile(join(cwd, "file.txt"));
  const expected = await readFile(join(fixtureRoot, name, "after.txt"));
  expect(actual).toEqual(expected);
}

export async function expectFixtureFailure(name: string, message: string): Promise<void> {
  const cwd = await fixtureCase(name);
  const before = await readFile(join(cwd, "file.txt"));
  await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(message);
  const after = await readFile(join(cwd, "file.txt"));
  expect(after).toEqual(before);
}

export async function publicExampleWork(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), `blockpatch-example-${name}-`));
  const cwd = join(parent, "work");
  await cp(join(exampleRoot, name, "work"), cwd, { recursive: true });
  return cwd;
}

export async function expectMissing(path: string): Promise<void> {
  let missing = false;
  try {
    await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
    missing = true;
  }
  expect(missing).toBe(true);
}

export async function moveFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-"));
  await writeFile(
    join(cwd, "source.ts"),
    "alpha\nfunction movedThing() {\n  return 42;\n}\nomega\nclass Target {\n}\n"
  );
  return cwd;
}

const conformanceBefore = "intro\nfunction movedThing() {\n  return 42;\n}\nmid\ngap\nclass Target {\n}\noutro\n";
export const conformanceAfter = "intro\nmid\ngap\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\noutro\n";
const crossFileSourceBefore = "before\nfunction movedThing() {\n  return 42;\n}\nafter\n";
export const crossFileSourceAfter = "before\nafter\n";
const crossFileTargetBefore = "class Target {\n}\n";
export const crossFileTargetAfter = "class Target {\nfunction movedThing() {\n  return 42;\n}\n}\n";

function hasSystemPatch(): boolean {
  try {
    const version = Bun.spawnSync({
      cmd: ["patch", "--version"],
      stdout: "pipe",
      stderr: "pipe"
    });
    if (version.exitCode !== 0) {
      return false;
    }

    const cwd = mkdtempSync(join(tmpdir(), "blockpatch-system-patch-"));
    try {
      writeFileSync(join(cwd, "file.txt"), "alpha\nomega\n");
      writeFileSync(
        join(cwd, "probe.blockpatch"),
        "diff --blockpatch a/file.txt b/file.txt\n" +
          "blockpatch version 1\n" +
          "blockpatch move id=move-1 payload-sha256=0000000000000000000000000000000000000000000000000000000000000000\n" +
          "--- a/file.txt\n" +
          "+++ b/file.txt\n" +
          "\n" +
          "@@ -1,2 +1,2 @@ blockpatch-source id=move-1\n" +
          "-alpha\n" +
          "+beta\n" +
          " omega\n"
      );

      const probe = Bun.spawnSync({
        cmd: ["patch", "--fuzz=0", "-p1", "--batch", "-E", "-i", "probe.blockpatch"],
        cwd,
        stdout: "pipe",
        stderr: "pipe"
      });

      return probe.exitCode === 0 && readFileSync(join(cwd, "file.txt"), "utf8") === "beta\nomega\n";
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}

export async function conformanceFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "blockpatch-conformance-"));
  await writeFile(join(cwd, "source.ts"), conformanceBefore);
  return cwd;
}

export async function crossFileConformanceFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "blockpatch-cross-file-conformance-"));
  await writeFile(join(cwd, "source.ts"), crossFileSourceBefore);
  await writeFile(join(cwd, "target.ts"), crossFileTargetBefore);
  return cwd;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function shaText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function patchDocument(src: string, dst: string, metadata: string, hunks: string): string {
  return (
    `diff --blockpatch ${src} ${dst}\n` +
    "blockpatch version 1\n" +
    `blockpatch move id=move-1 ${metadata}\n` +
    `--- ${src}\n` +
    `+++ ${dst}\n` +
    "\n" +
    hunks
  );
}

export async function expectSystemPatchApplies(cwd: string, patchText: string | Buffer): Promise<void> {
  await writeFile(join(cwd, "generated.blockpatch"), patchText);

  const proc = Bun.spawn({
    cmd: ["patch", "--fuzz=0", "-p1", "--batch", "-E", "-i", "generated.blockpatch"],
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });

  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stderr).text()).toBe("");
}

export async function generateMoveDiff(cwd: string, args: Parameters<typeof moveBlock>[0]): Promise<string> {
  const result = await moveBlock(args, { cwd, diff: true });
  if (result.patch === undefined) {
    throw new Error("Expected moveBlock diff output");
  }
  return result.patch;
}

export async function generateConformancePatch(): Promise<string> {
  const cwd = await conformanceFixture();
  return generateMoveDiff(cwd, {
    src: "source.ts",
    src_start: "function movedThing() {\n",
    src_end: "}\n",
    target_before: "class Target {\n"
  });
}

export async function generateCrossFileConformancePatch(): Promise<string> {
  const cwd = await crossFileConformanceFixture();
  return generateMoveDiff(cwd, {
    src: "source.ts",
    dst: "target.ts",
    src_start: "function movedThing() {\n",
    src_end: "}\n",
    target_before: "class Target {\n"
  });
}

export function driftConformanceLineNumbers(patchText: string): string {
  return patchText
    .replace(/@@ -\d+(,\d+) \+\d+(,\d+) @@ blockpatch-source id=move-1/, "@@ -90$1 +90$2 @@ blockpatch-source id=move-1")
    .replace(/@@ -\d+(,\d+) \+\d+(,\d+) @@ blockpatch-target id=move-1/, "@@ -120$1 +120$2 @@ blockpatch-target id=move-1");
}

export function corruptConformanceSourceCount(patchText: string): string {
  return patchText.replace(
    /@@ -(\d+),(\d+) \+(\d+),(\d+) @@ blockpatch-source id=move-1/,
    (_header, oldStart: string, oldCount: string, newStart: string, newCount: string) =>
      `@@ -${oldStart},${Number(oldCount) + 1} +${newStart},${newCount} @@ blockpatch-source id=move-1`
  );
}
