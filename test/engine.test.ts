import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { applyPatchFile, indexesOfLimited, validatePatchBytesInMemory, writeAtomic } from "../src/engine";
import { BlockPatchError } from "../src/errors";
import { readFileSnapshot } from "../src/files";
import {
  conformanceAfter,
  conformanceFixture,
  crossFileConformanceFixture,
  crossFileSourceAfter,
  crossFileTargetAfter,
  exampleRoot,
  expectFixtureApply,
  expectFixtureFailure,
  expectMissing,
  expectSystemPatchApplies,
  fixtureCase,
  generateConformancePatch,
  generateCrossFileConformancePatch,
  generateMoveDiff,
  patchDocument,
  pathExists,
  publicExampleWork,
  shaText,
  systemPatchAvailable,
  symlinkOrSkip,
  driftConformanceLineNumbers,
  corruptConformanceSourceCount
} from "./helpers";
import type { PublicExampleCase } from "./helpers";

describe("blockpatch golden fixtures", () => {
  test("indexesOfLimited caps collected matches", () => {
    expect(indexesOfLimited(Buffer.from("aaaa"), Buffer.from("aa"), 2)).toEqual({
      matches: [0, 1],
      truncated: true
    });
    expect(indexesOfLimited(Buffer.from("aaaa"), Buffer.from("aa"), 3)).toEqual({
      matches: [0, 1, 2],
      truncated: false
    });
    expect(indexesOfLimited(Buffer.from("aaaa"), Buffer.from("z"), 2)).toEqual({
      matches: [],
      truncated: false
    });
  });

  test("successful move", async () => {
    await expectFixtureApply("success");
  });

  test("applying the same patch twice reports already_applied", async () => {
    const cwd = await fixtureCase("success");
    await applyPatchFile("patch.blockpatch", { cwd });

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.changed).toEqual([]);
    expect(result.affected).toEqual(["file.txt"]);
    expect(result.written).toBe(false);
    expect(result.noop).toBe(true);
    expect(result.status).toBe("already_applied");
    expect(result.moves[0]).toMatchObject({
      src: "file.txt",
      dst: "file.txt",
      source_range: null
    });
  });

  test("ambiguous source", async () => {
    const cwd = await fixtureCase("ambiguous-source");
    const before = await readFile(join(cwd, "file.txt"));
    const sourceBlock = Buffer.from("alpha\nmove me\nomega\n");
    const secondStart = Buffer.from("alpha\nmove me\nomega\ntarget\n").length;

    let error: unknown;
    try {
      await applyPatchFile("patch.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).message).toContain("Source block is ambiguous");
    expect((error as BlockPatchError).details).toMatchObject({
      path: "file.txt",
      phase: "source",
      anchor: "blockpatch-source",
      matches: 2,
      ranges: [
        { start: 0, end: sourceBlock.length },
        { start: secondStart, end: secondStart + sourceBlock.length }
      ],
      line_ranges: [
        { start: 1, end: 3 },
        { start: 5, end: 7 }
      ]
    });
    expect(await readFile(join(cwd, "file.txt"))).toEqual(before);
  });

  test("ambiguous target", async () => {
    await expectFixtureFailure("ambiguous-target", "Target anchor is ambiguous");
  });

  test("missing source", async () => {
    await expectFixtureFailure("missing-source", "Source anchors were not found");
  });

  test("missing target", async () => {
    await expectFixtureFailure("missing-target", "Target anchor was not found");
  });

  test("payload mismatch", async () => {
    await expectFixtureFailure("payload-mismatch", "Source payload does not match");
  });

  test("source before target", async () => {
    await expectFixtureApply("source-before-target");
  });

  test("source after target", async () => {
    await expectFixtureApply("source-after-target");
  });

  test("dry-run does not modify file", async () => {
    const cwd = await fixtureCase("dry-run");
    const before = await readFile(join(cwd, "file.txt"));
    const result = await applyPatchFile("patch.blockpatch", { cwd, dryRun: true });
    const after = await readFile(join(cwd, "file.txt"));
    expect(result.changed).toEqual(["file.txt"]);
    expect(result.written).toBe(false);
    expect(after).toEqual(before);
  });

  test("dry-run validates without modifying file", async () => {
    const cwd = await fixtureCase("success");
    const before = await readFile(join(cwd, "file.txt"));
    const result = await applyPatchFile("patch.blockpatch", { cwd, dryRun: true });
    const after = await readFile(join(cwd, "file.txt"));
    expect(result.changed).toEqual(["file.txt"]);
    expect(result.affected).toEqual(["file.txt"]);
    expect(result.written).toBe(false);
    expect(result.noop).toBe(false);
    expect(result.status).toBe("applied");
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]).toMatchObject({
      id: "move-1",
      src: "file.txt",
      dst: "file.txt",
      payload_sha256: "f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e",
      payload_bytes: "move me\n".length
    });
    expect(after).toEqual(before);
  });

  test("in-memory validation accepts supplied file bytes", () => {
    const payload = "move me\n";
    const file = Buffer.from("alpha\nmove me\nomega\ntarget\n");
    const patch = Buffer.from(
      "diff --blockpatch a/memory.txt b/memory.txt\n" +
        "blockpatch version 1\n" +
        `blockpatch move id=move-1 payload-sha256=${createHash("sha256").update(payload).digest("hex")}\n` +
        "--- a/memory.txt\n" +
        "+++ b/memory.txt\n" +
        "\n" +
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n" +
        " alpha\n" +
        "-move me\n" +
        " omega\n" +
        "@@ -4,1 +3,2 @@ blockpatch-target id=move-1\n" +
        " target\n" +
        "+move me\n"
    );

    const result = validatePatchBytesInMemory(patch, [{ path: "memory.txt", bytes: file }]);
    expect(result.changed).toEqual(["memory.txt"]);
    expect(result.written).toBe(false);
    expect(result.status).toBe("applied");
  });

  test("reverse apply restores a successful move", async () => {
    const cwd = await fixtureCase("success");
    const before = await readFile(join(cwd, "file.txt"));
    await applyPatchFile("patch.blockpatch", { cwd });

    const result = await applyPatchFile("patch.blockpatch", { cwd, reverse: true });
    expect(await readFile(join(cwd, "file.txt"))).toEqual(before);
    expect(result.changed).toEqual(["file.txt"]);
    expect(result.affected).toEqual(["file.txt"]);
    expect(result.written).toBe(true);
    expect(result.status).toBe("applied");
    expect(result.moves[0]).toMatchObject({
      src: "file.txt",
      dst: "file.txt",
      payload_sha256: "f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e"
    });
  });

  test("reverse dry-run validates without modifying an applied file", async () => {
    const cwd = await fixtureCase("success");
    await applyPatchFile("patch.blockpatch", { cwd });
    const applied = await readFile(join(cwd, "file.txt"));

    const result = await applyPatchFile("patch.blockpatch", { cwd, reverse: true, dryRun: true });
    expect(await readFile(join(cwd, "file.txt"))).toEqual(applied);
    expect(result.changed).toEqual(["file.txt"]);
    expect(result.written).toBe(false);
    expect(result.status).toBe("applied");
  });

  test("already-reversed patch is a reverse no-op with explicit status", async () => {
    const cwd = await fixtureCase("success");
    const before = await readFile(join(cwd, "file.txt"));

    const result = await applyPatchFile("patch.blockpatch", { cwd, reverse: true });
    expect(await readFile(join(cwd, "file.txt"))).toEqual(before);
    expect(result.changed).toEqual([]);
    expect(result.written).toBe(false);
    expect(result.noop).toBe(true);
    expect(result.status).toBe("already_applied");
    expect(result.moves[0]).toMatchObject({
      src: "file.txt",
      dst: "file.txt",
      source_range: null
    });
  });
});

describe("public examples", () => {
  const cases: PublicExampleCase[] = [
    { name: "same-file-relocation", changed: ["file.txt"], expectedFiles: ["file.txt"] },
    {
      name: "cross-file-relocation",
      changed: ["source.txt", "target.txt"],
      expectedFiles: ["source.txt", "target.txt"]
    },
    { name: "insert-existing-file", changed: ["file.txt"], expectedFiles: ["file.txt"] },
    { name: "delete-existing-file", changed: ["file.txt"], expectedFiles: ["file.txt"] },
    { name: "create-file", changed: ["file.txt"], expectedFiles: ["file.txt"] },
    { name: "remove-file", changed: ["file.txt"], missingFiles: ["file.txt"] },
    { name: "reverse", changed: ["file.txt"], expectedFiles: ["file.txt"], reverse: true }
  ];

  for (const example of cases) {
    test(`${example.name} applies from work to expected`, async () => {
      const cwd = await publicExampleWork(example.name);
      const patchPath = join(exampleRoot, example.name, "patch.blockpatch");
      const options = { cwd, reverse: example.reverse ?? false };

      const dryRun = await applyPatchFile(patchPath, { ...options, dryRun: true });
      expect([...dryRun.changed].sort()).toEqual([...example.changed].sort());
      expect(dryRun.status).toBe("applied");
      expect(dryRun.written).toBe(false);

      const result = await applyPatchFile(patchPath, options);
      expect([...result.changed].sort()).toEqual([...example.changed].sort());
      expect(result.status).toBe("applied");
      expect(result.written).toBe(true);

      for (const file of example.expectedFiles ?? []) {
        const actual = await readFile(join(cwd, file));
        const expected = await readFile(join(exampleRoot, example.name, "expected", file));
        expect(actual).toEqual(expected);
      }

      for (const file of example.missingFiles ?? []) {
        await expectMissing(join(cwd, file));
      }
    });
  }

  test("same-file relocation dry-run command matches the documented example shape", async () => {
    const cwd = await publicExampleWork("same-file-relocation");
    const patchPath = join(exampleRoot, "same-file-relocation", "patch.blockpatch");
    const before = await readFile(join(cwd, "file.txt"));
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", patchPath, "-d", cwd, "--dry-run"],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(
      "dry-run clean: move-1 file.txt:2 -> file.txt:5, 1 line\n"
    );
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await readFile(join(cwd, "file.txt"))).toEqual(before);
  });

  test("failure-ambiguous-target documents a strict matching error", async () => {
    const cwd = await publicExampleWork("failure-ambiguous-target");
    const patchPath = join(exampleRoot, "failure-ambiguous-target", "patch.blockpatch");
    const before = await readFile(join(cwd, "file.txt"));

    await expect(applyPatchFile(patchPath, { cwd, dryRun: true })).rejects.toThrow("Target anchor is ambiguous");
    expect(await readFile(join(cwd, "file.txt"))).toEqual(before);
  });
});

describe("byte preservation", () => {
  test("CRLF preservation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-crlf-"));
    await writeFile(join(cwd, "file.txt"), Buffer.from("alpha\r\nmove me\r\nomega\r\ntarget\r\n", "utf8"));
    await writeFile(
      join(cwd, "patch.blockpatch"),
      Buffer.from(
        "diff --blockpatch a/file.txt b/file.txt\n" +
          "blockpatch version 1\n" +
          "blockpatch move id=move-1 payload-sha256=10d316fe0179a4ccaa97a509f75294785f941d7f9b0656684844edcdf1b5a01a\n" +
          "--- a/file.txt\n" +
          "+++ b/file.txt\n" +
          "\n" +
          "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n" +
          " alpha\r\n" +
          "-move me\r\n" +
          " omega\r\n" +
          "\n" +
          "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n" +
          " target\r\n" +
          "+move me\r\n",
        "utf8"
      )
    );

    await applyPatchFile("patch.blockpatch", { cwd });
    const actual = await readFile(join(cwd, "file.txt"));
    expect(actual).toEqual(Buffer.from("alpha\r\nomega\r\ntarget\r\nmove me\r\n", "utf8"));
  });

  test("no trailing newline preservation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-no-trailing-newline-"));
    await writeFile(join(cwd, "file.txt"), Buffer.from("alpha\nmove me\nomega\ntarget", "utf8"));
    await writeFile(
      join(cwd, "patch.blockpatch"),
      Buffer.from(
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
          "+move me\n" +
          " target\n" +
          "\\ No newline at end of file\n",
        "utf8"
      )
    );

    await applyPatchFile("patch.blockpatch", { cwd });
    const actual = await readFile(join(cwd, "file.txt"));
    expect(actual).toEqual(Buffer.from("alpha\nomega\nmove me\ntarget", "utf8"));
  });

  test("source and target overlap unsafely", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-overlap-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
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
        "@@ -2,1 +2,2 @@ blockpatch-target id=move-1\n" +
        " move me\n" +
        "+move me\n"
    );

    const before = await readFile(join(cwd, "file.txt"));
    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("overlaps the source block");
    const after = await readFile(join(cwd, "file.txt"));
    expect(after).toEqual(before);
  });

  test("move to immediately before an anchor that follows the source is a no-op", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-noop-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
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
        "@@ -3,1 +2,2 @@ blockpatch-target id=move-1\n" +
        "+move me\n" +
        " omega\n"
    );

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    const actual = await readFile(join(cwd, "file.txt"), "utf8");
    expect(actual).toBe("alpha\nmove me\nomega\n");
    expect(result.changed).toEqual([]);
    expect(result.affected).toEqual(["file.txt"]);
    expect(result.written).toBe(false);
    expect(result.noop).toBe(true);
    expect(result.status).toBe("noop");
    expect(result.moves[0].source_range).toEqual({ start: "alpha\n".length, end: "alpha\nmove me\n".length });
  });

  test("already-applied same-file patch is a no-op with explicit status", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-already-applied-"));
    const alreadyApplied = "alpha\nomega\ntarget\nmove me\ntail\n";
    await writeFile(join(cwd, "file.txt"), alreadyApplied);
    await writeFile(
      join(cwd, "patch.blockpatch"),
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
        "@@ -3,2 +3,3 @@ blockpatch-target id=move-1\n" +
        " target\n" +
        "+move me\n" +
        " tail\n"
    );

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(alreadyApplied);
    expect(result.changed).toEqual([]);
    expect(result.affected).toEqual(["file.txt"]);
    expect(result.written).toBe(false);
    expect(result.noop).toBe(true);
    expect(result.status).toBe("already_applied");
    expect(result.moves[0]).toMatchObject({
      id: "move-1",
      src: "file.txt",
      dst: "file.txt",
      payload_sha256: "f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e",
      payload_bytes: "move me\n".length,
      source_range: null
    });
  });

  test("ambiguous already-applied target is rejected", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-already-applied-ambiguous-"));
    const appliedTarget = "target\nmove me\ntail\n";
    const file = `alpha\nomega\n${appliedTarget}${appliedTarget}`;
    await writeFile(join(cwd, "file.txt"), file);
    await writeFile(
      join(cwd, "patch.blockpatch"),
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
        "@@ -3,2 +3,3 @@ blockpatch-target id=move-1\n" +
        " target\n" +
        "+move me\n" +
        " tail\n"
    );

    let error: unknown;
    try {
      await applyPatchFile("patch.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }

    const firstStart = file.indexOf(appliedTarget);
    const secondStart = file.indexOf(appliedTarget, firstStart + 1);
    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).message).toContain("Already-applied target is ambiguous");
    expect((error as BlockPatchError).details).toMatchObject({
      path: "file.txt",
      phase: "target",
      anchor: "blockpatch-target",
      matches: 2,
      ranges: [
        { start: firstStart, end: firstStart + appliedTarget.length },
        { start: secondStart, end: secondStart + appliedTarget.length }
      ]
    });
  });

  test("source hunk can start at the beginning of a file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-source-start-"));
    await writeFile(join(cwd, "file.txt"), "move me\nomega\ntarget\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      "diff --blockpatch a/file.txt b/file.txt\n" +
        "blockpatch version 1\n" +
        "blockpatch move id=move-1 payload-sha256=f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e\n" +
        "--- a/file.txt\n" +
        "+++ b/file.txt\n" +
        "\n" +
        "@@ -1,2 +1,1 @@ blockpatch-source id=move-1\n" +
        "-move me\n" +
        " omega\n" +
        "\n" +
        "@@ -3,1 +3,2 @@ blockpatch-target id=move-1\n" +
        " target\n" +
        "+move me\n"
    );

    await applyPatchFile("patch.blockpatch", { cwd });
    const actual = await readFile(join(cwd, "file.txt"), "utf8");
    expect(actual).toBe("omega\ntarget\nmove me\n");
  });

  test("source hunk can end at the end of a file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-source-end-"));
    await writeFile(join(cwd, "file.txt"), "alpha\ntarget\nmove me\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      "diff --blockpatch a/file.txt b/file.txt\n" +
        "blockpatch version 1\n" +
        "blockpatch move id=move-1 payload-sha256=f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e\n" +
        "--- a/file.txt\n" +
        "+++ b/file.txt\n" +
        "\n" +
        "@@ -2,2 +2,1 @@ blockpatch-source id=move-1\n" +
        " target\n" +
        "-move me\n" +
        "\n" +
        "@@ -1,1 +1,2 @@ blockpatch-target id=move-1\n" +
        " alpha\n" +
        "+move me\n"
    );

    await applyPatchFile("patch.blockpatch", { cwd });
    const actual = await readFile(join(cwd, "file.txt"), "utf8");
    expect(actual).toBe("alpha\nmove me\ntarget\n");
  });

  test("target hunk can use context before and after the insertion", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-target-both-sides-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\ntarget\ntail\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
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
        "@@ -4,2 +4,3 @@ blockpatch-target id=move-1\n" +
        " target\n" +
        "+move me\n" +
        " tail\n"
    );

    await applyPatchFile("patch.blockpatch", { cwd });
    const actual = await readFile(join(cwd, "file.txt"), "utf8");
    expect(actual).toBe("alpha\nomega\ntarget\nmove me\ntail\n");
  });

  test("target hunk context after the insertion is verified", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-target-after-context-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\ntarget\nactual-tail\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
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
        "@@ -4,2 +4,3 @@ blockpatch-target id=move-1\n" +
        " target\n" +
        "+move me\n" +
        " expected-tail\n"
    );

    const before = await readFile(join(cwd, "file.txt"));
    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("Target anchor");
    const after = await readFile(join(cwd, "file.txt"));
    expect(after).toEqual(before);
  });

  test("payload hash mismatch", async () => {
    const cwd = await fixtureCase("success");
    const before = await readFile(join(cwd, "file.txt"));
    const patch = await readFile(join(cwd, "patch.blockpatch"), "utf8");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patch.replace(
        "payload-sha256=f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e",
        "payload-sha256=6993e48218ac17d1d5750b8e03de252572cc474f4011f315ff055009966cf91d"
      )
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("payload-sha256");
    const after = await readFile(join(cwd, "file.txt"));
    expect(after).toEqual(before);
  });

  test("target added payload must match source removed payload", async () => {
    const cwd = await fixtureCase("success");
    const before = await readFile(join(cwd, "file.txt"));
    const patch = await readFile(join(cwd, "patch.blockpatch"), "utf8");
    await writeFile(join(cwd, "patch.blockpatch"), patch.replace("+move me\n", "+different\n"));

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("Target added payload");
    const after = await readFile(join(cwd, "file.txt"));
    expect(after).toEqual(before);
  });
});

describe("patch --fuzz=0 conformance", () => {
  test("generated same-file patch applies with blockpatch apply", async () => {
    const patchText = await generateConformancePatch();
    const cwd = await conformanceFixture();
    await writeFile(join(cwd, "generated.blockpatch"), patchText);

    await applyPatchFile("generated.blockpatch", { cwd });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(conformanceAfter);
  });

  test("partially applied cross-file patch reports duplicate recovery state", async () => {
    const patchText = await generateCrossFileConformancePatch();
    const cwd = await crossFileConformanceFixture();
    const sourceBefore = await readFile(join(cwd, "source.ts"));
    const payload = "function movedThing() {\n  return 42;\n}\n";
    await writeFile(join(cwd, "target.ts"), crossFileTargetAfter);
    await writeFile(join(cwd, "generated.blockpatch"), patchText);

    let error: unknown;
    try {
      await applyPatchFile("generated.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).message).toContain("partially applied");
    expect((error as BlockPatchError).code).toBe("partial_applied_duplicate");
    expect((error as BlockPatchError).details).toMatchObject({
      path: "target.ts",
      phase: "target",
      anchor: "blockpatch-target",
      source_range: { start: "before\n".length, end: "before\n".length + payload.length },
      target_range: { start: 0, end: crossFileTargetAfter.length },
      payload_sha256: shaText(payload),
      suggested_action: "review_then_remove_source"
    });
    expect(await readFile(join(cwd, "source.ts"))).toEqual(sourceBefore);
    expect(await readFile(join(cwd, "target.ts"), "utf8")).toBe(crossFileTargetAfter);
  });

  test.skipIf(!systemPatchAvailable)(
    "generated same-file patch applies with system patch --fuzz=0",
    async () => {
      const patchText = await generateConformancePatch();
      const cwd = await conformanceFixture();
      await writeFile(join(cwd, "generated.blockpatch"), patchText);

      const proc = Bun.spawn({
        cmd: ["patch", "--fuzz=0", "-p1", "--batch", "-i", "generated.blockpatch"],
        cwd,
        stdout: "pipe",
        stderr: "pipe"
      });

      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(conformanceAfter);
    }
  );

  test.skipIf(!systemPatchAvailable)(
    "generated cross-file split patch applies with system patch --fuzz=0",
    async () => {
      const patchText = await generateCrossFileConformancePatch();
      const cwd = await crossFileConformanceFixture();
      await writeFile(join(cwd, "generated.blockpatch"), patchText);

      const proc = Bun.spawn({
        cmd: ["patch", "--fuzz=0", "-p1", "--batch", "-i", "generated.blockpatch"],
        cwd,
        stdout: "pipe",
        stderr: "pipe"
      });

      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(crossFileSourceAfter);
      expect(await readFile(join(cwd, "target.ts"), "utf8")).toBe(crossFileTargetAfter);
    }
  );

  test.skipIf(!systemPatchAvailable)(
    "target-only same-file patch applies with system patch --fuzz=0",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "blockpatch-system-target-only-"));
      await writeFile(join(cwd, "file.txt"), "alpha\nomega\n");
      const patchText = await generateMoveDiff(cwd, {
        src: "/dev/null",
        dst: "file.txt",
        payload: "inserted\n",
        target_before: "alpha\n",
        target_after: "omega\n"
      });

      await expectSystemPatchApplies(cwd, patchText);

      expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\ninserted\nomega\n");
    }
  );

  test.skipIf(!systemPatchAvailable)(
    "source-only same-file patch applies with system patch --fuzz=0",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "blockpatch-system-source-only-"));
      await writeFile(join(cwd, "file.txt"), "alpha\ndoomed\nomega\n");
      const patchText = await generateMoveDiff(cwd, {
        src: "file.txt",
        src_start: "doomed",
        src_end: "\n",
        dst: "/dev/null"
      });

      await expectSystemPatchApplies(cwd, patchText);

      expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nomega\n");
    }
  );

  test.skipIf(!systemPatchAvailable)(
    "/dev/null creation patch applies with system patch --fuzz=0",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "blockpatch-system-create-"));

      await expectSystemPatchApplies(
        cwd,
        patchDocument(
          "/dev/null",
          "b/new.txt",
          `payload-sha256=${shaText("one\ntwo\n")}`,
          "@@ -0,0 +1,2 @@ blockpatch-target id=move-1\n" +
            "+one\n" +
            "+two\n"
        )
      );

      expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("one\ntwo\n");
    }
  );

  test.skipIf(!systemPatchAvailable)(
    "/dev/null removal patch applies with system patch --fuzz=0",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "blockpatch-system-remove-"));
      await writeFile(join(cwd, "old.txt"), "one\ntwo\n");

      await expectSystemPatchApplies(
        cwd,
        patchDocument(
          "a/old.txt",
          "/dev/null",
          `payload-sha256=${shaText("one\ntwo\n")}`,
          "@@ -1,2 +0,0 @@ blockpatch-source id=move-1\n" +
            "-one\n" +
            "-two\n"
        )
      );

      expect(await pathExists(join(cwd, "old.txt"))).toBe(false);
    }
  );

  test.skipIf(!systemPatchAvailable)(
    "no-trailing-newline patch applies with system patch --fuzz=0",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "blockpatch-system-no-newline-"));
      await writeFile(join(cwd, "file.txt"), "alpha\nomega");
      const patchText = await generateMoveDiff(cwd, {
        src: "/dev/null",
        dst: "file.txt",
        payload: "inserted\n",
        target_before: "alpha\n",
        target_after: "omega"
      });

      await expectSystemPatchApplies(cwd, patchText);

      expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\ninserted\nomega");
    }
  );

  test.skipIf(!systemPatchAvailable)(
    "CRLF patch applies with system patch --fuzz=0",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "blockpatch-system-crlf-"));
      await writeFile(join(cwd, "file.txt"), Buffer.from("alpha\r\nomega\r\n", "utf8"));
      const patchText = await generateMoveDiff(cwd, {
        src: "/dev/null",
        dst: "file.txt",
        payload: "inserted\r\n",
        target_before: "alpha\r\n",
        target_after: "omega\r\n"
      });

      await expectSystemPatchApplies(cwd, Buffer.from(patchText, "utf8"));

      expect(await readFile(join(cwd, "file.txt"))).toEqual(Buffer.from("alpha\r\ninserted\r\nomega\r\n", "utf8"));
    }
  );

  test("line-number drift applies when exact context is unique", async () => {
    const patchText = driftConformanceLineNumbers(await generateConformancePatch());
    const cwd = await conformanceFixture();
    await writeFile(join(cwd, "generated.blockpatch"), patchText);

    await applyPatchFile("generated.blockpatch", { cwd });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(conformanceAfter);
  });

  test.skipIf(!systemPatchAvailable)(
    "line-number drift applies with system patch --fuzz=0 when context is exact",
    async () => {
      const patchText = driftConformanceLineNumbers(await generateConformancePatch());
      const cwd = await conformanceFixture();
      await writeFile(join(cwd, "generated.blockpatch"), patchText);

      const proc = Bun.spawn({
        cmd: ["patch", "--fuzz=0", "-p1", "--batch", "-i", "generated.blockpatch"],
        cwd,
        stdout: "pipe",
        stderr: "pipe"
      });

      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(conformanceAfter);
    }
  );

  test("duplicated context is rejected by blockpatch", async () => {
    const patchText = await generateConformancePatch();
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-conformance-duplicate-"));
    await writeFile(
      join(cwd, "source.ts"),
      "intro\nfunction movedThing() {\n  return 42;\n}\nmid\ngap\nclass Target {\n}\nclass Target {\n}\noutro\n"
    );
    await writeFile(join(cwd, "generated.blockpatch"), patchText);

    await expect(applyPatchFile("generated.blockpatch", { cwd })).rejects.toThrow(
      "Target anchor is ambiguous"
    );
  });

  test("malformed line counts are rejected by blockpatch", async () => {
    const patchText = corruptConformanceSourceCount(await generateConformancePatch());
    const cwd = await conformanceFixture();
    await writeFile(join(cwd, "generated.blockpatch"), patchText);

    await expect(applyPatchFile("generated.blockpatch", { cwd })).rejects.toThrow(
      "Hunk line counts do not match header"
    );
  });
});

describe("atomic write concurrency guards", () => {
  test("rejects an existing file changed after snapshot", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-concurrent-write-"));
    const path = join(cwd, "file.txt");
    await writeFile(path, "original\n");
    const snapshot = await readFileSnapshot(path, "file");
    await writeFile(path, "external\n");

    let error: unknown;
    try {
      await writeAtomic(path, Buffer.from("planned\n"), {
        expected: { kind: "file", label: "file.txt", snapshot }
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("concurrent_modification");
    expect((error as BlockPatchError).details).toMatchObject({ path: "file.txt", phase: "write" });
    expect(await readFile(path, "utf8")).toBe("external\n");
  });

  test("rejects a create target that appears with different bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-concurrent-create-"));
    const path = join(cwd, "file.txt");
    await writeFile(path, "external\n");

    let error: unknown;
    try {
      await writeAtomic(path, Buffer.from("planned\n"), {
        create: true,
        expected: { kind: "missing", label: "file.txt", bytesIfExists: Buffer.from("planned\n") }
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("concurrent_modification");
    expect(await readFile(path, "utf8")).toBe("external\n");
  });

  test("allows a create target that already contains the expected bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-concurrent-create-same-"));
    const path = join(cwd, "file.txt");
    await writeFile(path, "planned\n");

    await writeAtomic(path, Buffer.from("planned\n"), {
      create: true,
      expected: { kind: "missing", label: "file.txt", bytesIfExists: Buffer.from("planned\n") }
    });

    expect(await readFile(path, "utf8")).toBe("planned\n");
  });

  test.skipIf(process.platform === "win32")("preserves existing file mode for replacements", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-preserve-mode-"));
    const path = join(cwd, "file.sh");
    await writeFile(path, "original\n");
    await chmod(path, 0o755);
    const snapshot = await readFileSnapshot(path, "file");

    await writeAtomic(path, Buffer.from("planned\n"), {
      expected: { kind: "file", label: "file.sh", snapshot }
    });

    expect(await readFile(path, "utf8")).toBe("planned\n");
    expect((await lstat(path)).mode & 0o777).toBe(0o755);
  });

  test.skipIf(process.platform === "win32")("rejects mode changes after snapshot", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-mode-concurrent-"));
    const path = join(cwd, "file.sh");
    await writeFile(path, "original\n");
    await chmod(path, 0o755);
    const snapshot = await readFileSnapshot(path, "file");
    await chmod(path, 0o644);

    let error: unknown;
    try {
      await writeAtomic(path, Buffer.from("planned\n"), {
        expected: { kind: "file", label: "file.sh", snapshot }
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("concurrent_modification");
    expect(await readFile(path, "utf8")).toBe("original\n");
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
  });

  test("rejects a symlink output parent before staging a create", async () => {
    const parent = await mkdtemp(join(tmpdir(), "blockpatch-create-symlink-parent-"));
    const cwd = join(parent, "cwd");
    const outside = join(parent, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    if (!(await symlinkOrSkip(outside, join(cwd, "link")))) {
      return;
    }

    let error: unknown;
    try {
      await writeAtomic(join(cwd, "link", "file.txt"), Buffer.from("planned\n"), {
        create: true,
        expected: { kind: "missing", label: "link/file.txt", bytesIfExists: Buffer.from("planned\n") }
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("symlink_path");
    expect(await pathExists(join(outside, "file.txt"))).toBe(false);
  });
});

describe("one-sided hunks and null endpoints", () => {
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

  async function fileExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  function countPatchLines(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    const newlineCount = text.split("\n").length - 1;
    return text.endsWith("\n") ? newlineCount : newlineCount + 1;
  }

  function prefixedPayload(text: string, prefix: "+" | "-"): string {
    if (text.length === 0) {
      return "";
    }
    return text
      .split(/(?<=\n)/)
      .filter((line) => line.length > 0)
      .map((line) => `${prefix}${line.endsWith("\n") ? line.slice(0, -1) : line}\n`)
      .join("");
  }

  function insertionPatch(payload: string, before: string, after: string, path = "file.txt"): string {
    const oldCount = (before ? 1 : 0) + (after ? 1 : 0);
    const newCount = oldCount + countPatchLines(payload);
    return (
      `diff --blockpatch a/${path} b/${path}\n` +
      "blockpatch version 1\n" +
      `blockpatch move id=move-1 payload-sha256=${sha(payload)}\n` +
      `--- a/${path}\n` +
      `+++ b/${path}\n` +
      "\n" +
      `@@ -1,${oldCount} +1,${newCount} @@ blockpatch-target id=move-1\n` +
      (before ? ` ${before}\n` : "") +
      prefixedPayload(payload, "+") +
      (after ? ` ${after}\n` : "")
    );
  }

  function deletionPatch(payload: string, before: string, after: string, path = "file.txt"): string {
    const contextCount = (before ? 1 : 0) + (after ? 1 : 0);
    const payloadLineCount = countPatchLines(payload);
    return (
      `diff --blockpatch a/${path} b/${path}\n` +
      "blockpatch version 1\n" +
      `blockpatch move id=move-1 payload-sha256=${sha(payload)}\n` +
      `--- a/${path}\n` +
      `+++ b/${path}\n` +
      "\n" +
      `@@ -1,${contextCount + payloadLineCount} +${contextCount === 0 ? "0,0" : `1,${contextCount}`} @@ blockpatch-source id=move-1\n` +
      (before ? ` ${before}\n` : "") +
      prefixedPayload(payload, "-") +
      (after ? ` ${after}\n` : "")
    );
  }

  function creationPatch(payload: string, path = "file.txt"): string {
    const payloadLineCount = countPatchLines(payload);
    return (
      `diff --blockpatch /dev/null b/${path}\n` +
      "blockpatch version 1\n" +
      `blockpatch move id=move-1 payload-sha256=${sha(payload)}\n` +
      "--- /dev/null\n" +
      `+++ b/${path}\n` +
      "\n" +
      `@@ -0,0 +${payloadLineCount === 0 ? "0,0" : `1,${payloadLineCount}`} @@ blockpatch-target id=move-1\n` +
      prefixedPayload(payload, "+")
    );
  }

  function removalPatch(payload: string, path = "file.txt"): string {
    const payloadLineCount = countPatchLines(payload);
    return (
      `diff --blockpatch a/${path} /dev/null\n` +
      "blockpatch version 1\n" +
      `blockpatch move id=move-1 payload-sha256=${sha(payload)}\n` +
      `--- a/${path}\n` +
      "+++ /dev/null\n" +
      "\n" +
      `@@ -${payloadLineCount === 0 ? "0,0" : `1,${payloadLineCount}`} +0,0 @@ blockpatch-source id=move-1\n` +
      prefixedPayload(payload, "-")
    );
  }

  test("target-only insertion applies, retries, and reverses", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-insert-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nomega\n");
    await writeFile(join(cwd, "patch.blockpatch"), insertionPatch("new line\n", "alpha", "omega"));

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nnew line\nomega\n");
    expect(result.changed).toEqual(["file.txt"]);
    expect(result.written).toBe(true);
    expect(result.status).toBe("applied");
    expect(result.moves[0]).toMatchObject({
      src: "file.txt",
      dst: "file.txt",
      payload_sha256: sha("new line\n"),
      payload_bytes: "new line\n".length,
      source_range: null,
      insert_index: "alpha\n".length
    });

    const retry = await applyPatchFile("patch.blockpatch", { cwd });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nnew line\nomega\n");
    expect(retry.changed).toEqual([]);
    expect(retry.status).toBe("already_applied");

    const reversed = await applyPatchFile("patch.blockpatch", { cwd, reverse: true });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nomega\n");
    expect(reversed.status).toBe("applied");
    expect(reversed.moves[0]).toMatchObject({ src: "file.txt", dst: "file.txt", target_range: null });
  });

  test("target-only insertion into a missing file is file_not_found", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-insert-missing-"));
    await writeFile(join(cwd, "patch.blockpatch"), insertionPatch("new line\n", "alpha", "omega"));

    let error: unknown;
    try {
      await applyPatchFile("patch.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("file_not_found");
    expect(await fileExists(join(cwd, "file.txt"))).toBe(false);
  });

  test("target-only insertion hash mismatch is rejected without writing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-insert-hash-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nomega\n");
    const patch = insertionPatch("new line\n", "alpha", "omega").replace(sha("new line\n"), sha("different\n"));
    await writeFile(join(cwd, "patch.blockpatch"), patch);

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("payload-sha256");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nomega\n");
  });

  test("source-only deletion applies, retries, and reverses", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-delete-"));
    await writeFile(join(cwd, "file.txt"), "alpha\ndoomed\nomega\n");
    await writeFile(join(cwd, "patch.blockpatch"), deletionPatch("doomed\n", "alpha", "omega"));

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nomega\n");
    expect(result.status).toBe("applied");
    expect(result.moves[0]).toMatchObject({
      src: "file.txt",
      dst: "file.txt",
      source_range: { start: "alpha\n".length, end: "alpha\ndoomed\n".length },
      target_range: null,
      insert_index: null
    });

    const retry = await applyPatchFile("patch.blockpatch", { cwd });
    expect(retry.status).toBe("already_applied");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nomega\n");

    const reversed = await applyPatchFile("patch.blockpatch", { cwd, reverse: true });
    expect(reversed.status).toBe("applied");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\ndoomed\nomega\n");
  });

  test("source-only deletion retry with empty before requires after at file start", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-delete-empty-before-"));
    await writeFile(join(cwd, "patch.blockpatch"), deletionPatch("doomed\n", "", "omega"));

    await writeFile(join(cwd, "file.txt"), "doomed\nomega\n");
    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.status).toBe("applied");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("omega\n");

    const retry = await applyPatchFile("patch.blockpatch", { cwd });
    expect(retry.status).toBe("already_applied");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("omega\n");

    await writeFile(join(cwd, "file.txt"), "unexpected text\nomega\n");
    let error: unknown;
    try {
      await applyPatchFile("patch.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("source_not_found");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("unexpected text\nomega\n");
  });

  test("source-only deletion retry with empty after requires before at file end", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-delete-empty-after-"));
    await writeFile(join(cwd, "patch.blockpatch"), deletionPatch("doomed\n", "alpha", ""));

    await writeFile(join(cwd, "file.txt"), "alpha\ndoomed\n");
    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.status).toBe("applied");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\n");

    const retry = await applyPatchFile("patch.blockpatch", { cwd });
    expect(retry.status).toBe("already_applied");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\n");

    await writeFile(join(cwd, "file.txt"), "alpha\nunexpected text\n");
    let error: unknown;
    try {
      await applyPatchFile("patch.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("source_not_found");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nunexpected text\n");
  });

  test("source-only deletion of all bytes keeps an empty file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-delete-empty-result-"));
    await writeFile(join(cwd, "file.txt"), "only\ncontent\n");
    await writeFile(join(cwd, "patch.blockpatch"), deletionPatch("only\ncontent\n", "", ""));

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.status).toBe("applied");
    expect(await fileExists(join(cwd, "file.txt"))).toBe(true);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("");

    const retry = await applyPatchFile("patch.blockpatch", { cwd });
    expect(retry.status).toBe("already_applied");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("");
  });

  test("source-only deletion of a missing file is file_not_found", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-delete-missing-"));
    await writeFile(join(cwd, "patch.blockpatch"), deletionPatch("doomed\n", "alpha", "omega"));

    let error: unknown;
    try {
      await applyPatchFile("patch.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("file_not_found");
  });

  test("source-only deletion payload mismatch at located anchors is payload_mismatch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-delete-mismatch-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nsurprise\nomega\n");
    await writeFile(join(cwd, "patch.blockpatch"), deletionPatch("doomed\n", "alpha", "omega"));

    let error: unknown;
    try {
      await applyPatchFile("patch.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("payload_mismatch");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nsurprise\nomega\n");
  });

  test("null source creates a missing file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-"));
    await writeFile(join(cwd, "patch.blockpatch"), creationPatch("one\ntwo\n"));

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\ntwo\n");
    expect(result.status).toBe("applied");
    expect(result.changed).toEqual(["file.txt"]);

    const retry = await applyPatchFile("patch.blockpatch", { cwd });
    expect(retry.status).toBe("already_applied");
    expect(retry.changed).toEqual([]);
  });

  test("null source creation preserves bare CR before no-newline marker", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-bare-cr-marker-"));
    const payload = "x\r";
    await writeFile(
      join(cwd, "patch.blockpatch"),
      Buffer.from(
        "diff --blockpatch /dev/null b/file.txt\n" +
          "blockpatch version 1\n" +
          `blockpatch move id=move-1 payload-sha256=${sha(payload)}\n` +
          "--- /dev/null\n" +
          "+++ b/file.txt\n" +
          "\n" +
          "@@ -0,0 +1,1 @@ blockpatch-target id=move-1\n" +
          "+x\r\n" +
          "\\ No newline at end of file\n",
        "utf8"
      )
    );

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.status).toBe("applied");
    expect(await readFile(join(cwd, "file.txt"))).toEqual(Buffer.from(payload, "utf8"));
  });

  test("null source creation preserves terminal bare CR without a marker", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-terminal-bare-cr-"));
    const payload = "x\r";
    await writeFile(
      join(cwd, "patch.blockpatch"),
      Buffer.from(
        "diff --blockpatch /dev/null b/file.txt\n" +
          "blockpatch version 1\n" +
          `blockpatch move id=move-1 payload-sha256=${sha(payload)}\n` +
          "--- /dev/null\n" +
          "+++ b/file.txt\n" +
          "\n" +
          "@@ -0,0 +1,1 @@ blockpatch-target id=move-1\n" +
          "+x\r",
        "utf8"
      )
    );

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.status).toBe("applied");
    expect(await readFile(join(cwd, "file.txt"))).toEqual(Buffer.from(payload, "utf8"));
  });

  test("null source creates parent directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-nested-"));
    await writeFile(join(cwd, "patch.blockpatch"), creationPatch("one\n", "src/deep/new.txt"));

    await applyPatchFile("patch.blockpatch", { cwd });
    expect(await readFile(join(cwd, "src/deep/new.txt"), "utf8")).toBe("one\n");
  });

  test.skipIf(process.platform === "win32")("null source creates missing files with mode 0644", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-mode-"));
    await writeFile(join(cwd, "patch.blockpatch"), creationPatch("one\n"));
    const proc = Bun.spawn({
      cmd: ["sh", "-c", 'umask 077; bun "$BLOCKPATCH_CLI" apply "$PATCH_PATH" --cwd "$PATCH_CWD"'],
      env: {
        ...process.env,
        BLOCKPATCH_CLI: join(import.meta.dir, "../src/cli.ts"),
        PATCH_PATH: join(cwd, "patch.blockpatch"),
        PATCH_CWD: cwd
      },
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await new Response(proc.stdout).text()).toBe(
      "applied: move-1 /dev/null -> file.txt:1, 1 line\nchanged: file.txt\n"
    );
    expect((await lstat(join(cwd, "file.txt"))).mode & 0o777).toBe(0o644);
  });

  test("null source can create and reverse an empty file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-empty-"));
    await writeFile(join(cwd, "patch.blockpatch"), creationPatch(""));

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.status).toBe("applied");
    expect(await fileExists(join(cwd, "file.txt"))).toBe(true);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("");

    const reversed = await applyPatchFile("patch.blockpatch", { cwd, reverse: true });
    expect(reversed.status).toBe("applied");
    expect(await fileExists(join(cwd, "file.txt"))).toBe(false);
  });

  test("reverse of a null-source file creation removes the file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-reverse-"));
    await writeFile(join(cwd, "patch.blockpatch"), creationPatch("one\ntwo\n"));
    await applyPatchFile("patch.blockpatch", { cwd });
    expect(await fileExists(join(cwd, "file.txt"))).toBe(true);

    const reversed = await applyPatchFile("patch.blockpatch", { cwd, reverse: true });
    expect(reversed.status).toBe("applied");
    expect(await fileExists(join(cwd, "file.txt"))).toBe(false);

    const retry = await applyPatchFile("patch.blockpatch", { cwd, reverse: true });
    expect(retry.status).toBe("already_applied");
  });

  test("dry-run creation writes nothing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-dry-"));
    await writeFile(join(cwd, "patch.blockpatch"), creationPatch("one\n"));

    const result = await applyPatchFile("patch.blockpatch", { cwd, dryRun: true });
    expect(result.changed).toEqual(["file.txt"]);
    expect(result.written).toBe(false);
    expect(await fileExists(join(cwd, "file.txt"))).toBe(false);
  });

  test("null source into an existing non-empty file reports destination_exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-insert-nonempty-"));
    await writeFile(join(cwd, "file.txt"), "existing\n");
    await writeFile(join(cwd, "patch.blockpatch"), creationPatch("one\n"));

    let error: unknown;
    try {
      await applyPatchFile("patch.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("destination_exists");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("existing\n");
  });

  test("null source does not treat an existing empty file as missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-insert-empty-"));
    await writeFile(join(cwd, "file.txt"), "");
    await writeFile(join(cwd, "patch.blockpatch"), creationPatch("one\n"));

    let error: unknown;
    try {
      await applyPatchFile("patch.blockpatch", { cwd });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("destination_exists");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("");
  });

  test("null target removes a whole file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-delete-file-"));
    await writeFile(join(cwd, "file.txt"), "only\ncontent\n");
    await writeFile(join(cwd, "patch.blockpatch"), removalPatch("only\ncontent\n"));

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.status).toBe("applied");
    expect(await fileExists(join(cwd, "file.txt"))).toBe(false);

    const retry = await applyPatchFile("patch.blockpatch", { cwd });
    expect(retry.status).toBe("already_applied");

    const reversed = await applyPatchFile("patch.blockpatch", { cwd, reverse: true });
    expect(reversed.status).toBe("applied");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("only\ncontent\n");
  });

  test("null target removes an empty file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-delete-empty-file-"));
    await writeFile(join(cwd, "file.txt"), "");
    await writeFile(join(cwd, "patch.blockpatch"), removalPatch(""));

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.status).toBe("applied");
    expect(await fileExists(join(cwd, "file.txt"))).toBe(false);
  });

  test("null target requires whole-file payload", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-delete-partial-file-"));
    await writeFile(join(cwd, "file.txt"), "alpha\ndoomed\n");
    await writeFile(join(cwd, "patch.blockpatch"), removalPatch("doomed\n"));

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("Whole-file source payload");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\ndoomed\n");
  });

  test("both endpoints as /dev/null is a parse error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-both-null-"));
    const payload = "one\n";
    await writeFile(
      join(cwd, "patch.blockpatch"),
      "diff --blockpatch /dev/null /dev/null\n" +
        "blockpatch version 1\n" +
        `blockpatch move id=move-1 payload-sha256=${sha(payload)}\n` +
        "--- /dev/null\n" +
        "+++ /dev/null\n" +
        "\n" +
        "@@ -0,0 +1,1 @@ blockpatch-target id=move-1\n" +
        "+one\n"
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "cannot use /dev/null for both endpoints"
    );
  });

  test("null role-only section is accepted for file creation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-null-role-"));
    const patch = creationPatch("one\n").replace("id=move-1 payload", "id=move-1 role=target payload");
    await writeFile(join(cwd, "patch.blockpatch"), patch);

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.status).toBe("applied");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\n");
  });

  test("null endpoint paths are not resolved against the filesystem", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-null-real-devnull-"));
    await writeFile(join(cwd, "patch.blockpatch"), creationPatch("new line\n"));

    await applyPatchFile("patch.blockpatch", { cwd });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("new line\n");
    expect(await fileExists(join(cwd, "dev"))).toBe(false);
  });
});
