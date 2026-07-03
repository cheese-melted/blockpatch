import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { applyPatchFile, checkPatchFile } from "../src/engine";
import { moveBlock } from "../src/move";
import { BlockPatchError } from "../src/errors";

const fixtureRoot = join(import.meta.dir, "fixtures");

async function fixtureCase(name: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `blockpatch-${name}-`));
  const fixtureDir = join(fixtureRoot, name);
  const before = await readFile(join(fixtureDir, "before.txt"));
  const patch = await readFile(join(fixtureDir, "patch.blockpatch"));
  await writeFile(join(cwd, "file.txt"), before);
  await writeFile(join(cwd, "patch.blockpatch"), patch);
  return cwd;
}

async function expectFixtureApply(name: string): Promise<void> {
  const cwd = await fixtureCase(name);
  await applyPatchFile("patch.blockpatch", { cwd });
  const actual = await readFile(join(cwd, "file.txt"));
  const expected = await readFile(join(fixtureRoot, name, "after.txt"));
  expect(actual).toEqual(expected);
}

async function expectFixtureFailure(name: string, message: string): Promise<void> {
  const cwd = await fixtureCase(name);
  const before = await readFile(join(cwd, "file.txt"));
  await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(message);
  const after = await readFile(join(cwd, "file.txt"));
  expect(after).toEqual(before);
}

describe("blockpatch golden fixtures", () => {
  test("successful move", async () => {
    await expectFixtureApply("success");
  });

  test("ambiguous source", async () => {
    await expectFixtureFailure("ambiguous-source", "Source block is ambiguous");
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
    await applyPatchFile("patch.blockpatch", { cwd, dryRun: true });
    const after = await readFile(join(cwd, "file.txt"));
    expect(after).toEqual(before);
  });

  test("check validates without modifying file", async () => {
    const cwd = await fixtureCase("success");
    const before = await readFile(join(cwd, "file.txt"));
    const result = await checkPatchFile("patch.blockpatch", { cwd });
    const after = await readFile(join(cwd, "file.txt"));
    expect(result.changed).toEqual(["file.txt"]);
    expect(result.affected).toEqual(["file.txt"]);
    expect(result.noop).toBe(false);
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
    expect(result.noop).toBe(true);
    expect(result.moves[0].source_range).toEqual({ start: "alpha\n".length, end: "alpha\nmove me\n".length });
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

describe("CLI", () => {
  test("supports required check/apply commands", async () => {
    const cwd = await fixtureCase("success");
    const check = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "check", "patch.blockpatch", "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(await check.exited).toBe(0);
    expect(await new Response(check.stderr).text()).toBe("");

    const apply = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "patch.blockpatch", "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(await apply.exited).toBe(0);
    expect(await new Response(apply.stderr).text()).toBe("");

    const actual = await readFile(join(cwd, "file.txt"));
    const expected = await readFile(join(fixtureRoot, "success", "after.txt"));
    expect(actual).toEqual(expected);
  });

  test("supports apply --dry-run", async () => {
    const cwd = await fixtureCase("success");
    const before = await readFile(join(cwd, "file.txt"));
    const dryRun = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "patch.blockpatch", "--dry-run", "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(await dryRun.exited).toBe(0);
    expect(await new Response(dryRun.stderr).text()).toBe("");
    const after = await readFile(join(cwd, "file.txt"));
    expect(after).toEqual(before);
  });

  test("supports apply from stdin", async () => {
    const cwd = await fixtureCase("success");
    const patch = await readFile(join(cwd, "patch.blockpatch"));
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "-", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(patch);
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const actual = await readFile(join(cwd, "file.txt"));
    const expected = await readFile(join(fixtureRoot, "success", "after.txt"));
    expect(actual).toEqual(expected);
  });

  test("apply reads stdin when no patch path is supplied", async () => {
    const cwd = await fixtureCase("success");
    const patch = await readFile(join(cwd, "patch.blockpatch"));
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(patch);
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const actual = await readFile(join(cwd, "file.txt"));
    const expected = await readFile(join(fixtureRoot, "success", "after.txt"));
    expect(actual).toEqual(expected);
  });

  test("supports -i, -d, and -p aliases", async () => {
    const cwd = await fixtureCase("success");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "-i", "patch.blockpatch", "-d", cwd, "-p1"],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const actual = await readFile(join(cwd, "file.txt"));
    const expected = await readFile(join(fixtureRoot, "success", "after.txt"));
    expect(actual).toEqual(expected);
  });

  test("-p strips patch-declared path components", async () => {
    const cwd = await fixtureCase("success");
    const patch = (await readFile(join(cwd, "patch.blockpatch"), "utf8"))
      .replaceAll("a/file.txt", "a/nested/file.txt")
      .replaceAll("b/file.txt", "b/nested/file.txt");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "check", "-d", cwd, "-p2"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(patch);
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("would change file.txt");
  });

  test("move --json - applies a same-file move", async () => {
    const cwd = await moveFixture();
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const actual = await readFile(join(cwd, "source.ts"), "utf8");
    expect(actual).toBe("alpha\nomega\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\n");
  });

  test("move --json accepts two-sided target anchors", async () => {
    const cwd = await moveFixture();
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n",
        target_after: "}\n"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const actual = await readFile(join(cwd, "source.ts"), "utf8");
    expect(actual).toBe("alpha\nomega\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\n");
  });

  test("move --json accepts target_before and target_after", async () => {
    const cwd = await moveFixture();
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n",
        target_after: "}\n"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const actual = await readFile(join(cwd, "source.ts"), "utf8");
    expect(actual).toBe("alpha\nomega\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\n");
  });

  test("move --json-output prints machine-readable success details", async () => {
    const cwd = await moveFixture();
    const before = await readFile(join(cwd, "source.ts"), "utf8");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--dry-run", "--json-output", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n",
        target_after: "}\n"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as {
      ok: boolean;
      changed: string[];
      affected: string[];
      noop: boolean;
      moves: Array<{ src: string; dst: string; payload_sha256: string; payload_bytes: number }>;
    };
    expect(stdout.ok).toBe(true);
    expect(stdout.changed).toEqual(["source.ts"]);
    expect(stdout.affected).toEqual(["source.ts"]);
    expect(stdout.noop).toBe(false);
    expect(stdout.moves[0]).toMatchObject({
      src: "source.ts",
      dst: "source.ts",
      payload_sha256: "a990c0da5571138b0e2363af883a399fe214a137ad809c67f6530c618967a4e6",
      payload_bytes: "function movedThing() {\n  return 42;\n}\n".length
    });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);
  });

  test("move --json path supports dry-run", async () => {
    const cwd = await moveFixture();
    const before = await readFile(join(cwd, "source.ts"), "utf8");
    await writeFile(
      join(cwd, "move.json"),
      JSON.stringify({
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n"
      })
    );

    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "move.json", "--dry-run", "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const after = await readFile(join(cwd, "source.ts"), "utf8");
    expect(after).toBe(before);
  });

  test("move --json path may be read outside the working directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "blockpatch-external-move-json-"));
    const cwd = join(parent, "repo");
    await mkdir(cwd);
    await writeFile(
      join(cwd, "source.ts"),
      "alpha\nfunction movedThing() {\n  return 42;\n}\nomega\nclass Target {\n}\n"
    );
    const moveJsonPath = join(parent, "move.json");
    await writeFile(
      moveJsonPath,
      JSON.stringify({
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n"
      })
    );

    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", moveJsonPath, "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(
      "alpha\nomega\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\n"
    );
  });

  test("move flag mode supports cross-file move", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-cross-file-"));
    await writeFile(join(cwd, "source.ts"), "before\nfunction movedThing() {\n  return 42;\n}\nafter\n");
    await writeFile(join(cwd, "target.ts"), "class Target {\n}\n");

    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "move",
        "--src",
        "source.ts",
        "--src-start",
        "function movedThing() {\n",
        "--src-end",
        "}\n",
        "--dst",
        "target.ts",
        "--target-before",
        "class Target {\n",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe("before\nafter\n");
    expect(await readFile(join(cwd, "target.ts"), "utf8")).toBe(
      "class Target {\nfunction movedThing() {\n  return 42;\n}\n}\n"
    );
  });

  test("move flag mode supports target-before and target-after", async () => {
    const cwd = await moveFixture();
    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "move",
        "--src",
        "source.ts",
        "--src-start",
        "function movedThing() {\n",
        "--src-end",
        "}\n",
        "--target-before",
        "class Target {\n",
        "--target-after",
        "}\n",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(
      "alpha\nomega\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\n"
    );
  });

  test("move --diff cross-file output can be applied", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-cross-file-diff-"));
    await writeFile(join(cwd, "source.ts"), "before\nfunction movedThing() {\n  return 42;\n}\nafter\n");
    await writeFile(join(cwd, "target.ts"), "class Target {\n}\n");

    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "move",
        "--src",
        "source.ts",
        "--src-start",
        "function movedThing() {\n",
        "--src-end",
        "}\n",
        "--dst",
        "target.ts",
        "--target-before",
        "class Target {\n",
        "--diff",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    await writeFile(join(cwd, "generated.blockpatch"), await new Response(proc.stdout).text());
    await applyPatchFile("generated.blockpatch", { cwd });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe("before\nafter\n");
    expect(await readFile(join(cwd, "target.ts"), "utf8")).toBe(
      "class Target {\nfunction movedThing() {\n  return 42;\n}\n}\n"
    );
  });

  test("move --diff prints a patch and does not modify files", async () => {
    const cwd = await moveFixture();
    const before = await readFile(join(cwd, "source.ts"), "utf8");
    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "move",
        "--src",
        "source.ts",
        "--src-start",
        "function movedThing() {\n",
        "--src-end",
        "}\n",
        "--target-before",
        "class Target {\n",
        "--diff",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("diff --blockpatch a/source.ts b/source.ts");
    expect(stdout).toContain("payload-sha256=");
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);

    await writeFile(join(cwd, "generated.blockpatch"), stdout);
    await applyPatchFile("generated.blockpatch", { cwd });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(
      "alpha\nomega\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\n"
    );
  });

  test("move --diff output applies when the source starts at the file boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-diff-source-boundary-"));
    await writeFile(join(cwd, "source.ts"), "function movedThing() {\n  return 42;\n}\nalpha\nclass Target {\n}\n");

    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "move",
        "--src",
        "source.ts",
        "--src-start",
        "function movedThing() {\n",
        "--src-end",
        "}\n",
        "--target-before",
        "class Target {\n",
        "--diff",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    await writeFile(join(cwd, "generated.blockpatch"), await new Response(proc.stdout).text());
    await applyPatchFile("generated.blockpatch", { cwd });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(
      "alpha\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\n"
    );
  });

  test("move --json-output prints machine-readable errors", async () => {
    const cwd = await moveFixture();
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--json-output", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write("{not json");
    proc.stdin.end();

    expect(await proc.exited).toBe(1);
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(stderr.ok).toBe(false);
    expect(stderr.error.code).toBe("invalid_json");
  });

  test("move --json-output includes structured match details", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-json-error-details-"));
    await writeFile(
      join(cwd, "source.ts"),
      "function movedThing() {\n}\nclass Target {\n}\nclass Target {\n}\n"
    );
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--json-output", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(1);
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: { code: string; path: string; matches: number };
    };
    expect(stderr.ok).toBe(false);
    expect(stderr.error).toMatchObject({
      code: "target_ambiguous",
      path: "source.ts",
      matches: 2
    });
  });

  test("--unsafe-paths is not a supported escape hatch", async () => {
    const cwd = await fixtureCase("success");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "patch.blockpatch", "--cwd", cwd, "--unsafe-paths"],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toContain("Unknown option: --unsafe-paths");
  });
});

describe("moveBlock API", () => {
  test("fails on ambiguous source delimiters without modifying file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-ambiguous-"));
    await writeFile(
      join(cwd, "source.ts"),
      "function movedThing() {\n}\nfunction movedThing() {\n}\nclass Target {\n}\n"
    );
    const before = await readFile(join(cwd, "source.ts"));

    await expect(
      moveBlock(
        {
          src: "source.ts",
          src_start: "function movedThing() {\n",
          src_end: "}\n",
          target_before: "class Target {\n"
        },
        { cwd }
      )
    ).rejects.toThrow("ambiguous");

    expect(await readFile(join(cwd, "source.ts"))).toEqual(before);
  });

  test("move to immediately before an anchor that follows the source is a no-op", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-noop-"));
    await writeFile(join(cwd, "source.ts"), "alpha\nmove me\nomega\ntail\n");

    const result = await moveBlock(
      {
        src: "source.ts",
        src_start: "move me",
        src_end: "\n",
        target_after: "omega\n"
      },
      { cwd }
    );

    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe("alpha\nmove me\nomega\ntail\n");
    expect(result.changed).toEqual([]);
    expect(result.affected).toEqual(["source.ts"]);
    expect(result.noop).toBe(true);
    expect(result.moves[0]).toMatchObject({
      id: "move-1",
      src: "source.ts",
      dst: "source.ts",
      payload_sha256: "f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e",
      payload_bytes: "move me\n".length
    });
  });

  test("rejects unknown argument keys", async () => {
    await expect(
      moveBlock({
        src: "source.ts",
        src_start: "a",
        src_end: "b",
        target_afterr: "c"
      } as never)
    ).rejects.toThrow("Unknown move argument: target_afterr");
  });

  test("rejects wrongly typed argument values", async () => {
    await expect(
      moveBlock({
        src: "source.ts",
        src_start: 123,
        src_end: "b",
        target_before: "c"
      } as never)
    ).rejects.toThrow("move argument src_start must be a string");
  });

  test("rejects legacy insert argument", async () => {
    await expect(
      moveBlock({
        src: "source.ts",
        src_start: "a",
        src_end: "b",
        target_before: "c",
        insert: "around"
      } as never)
    ).rejects.toThrow("Unknown move argument: insert");
  });

  test("rejects empty target anchors", async () => {
    await expect(
      moveBlock({
        src: "source.ts",
        src_start: "a",
        src_end: "b",
        target_before: ""
      })
    ).rejects.toThrow("move requires non-empty target context");
  });

  test("rejects legacy dst_before argument", async () => {
    await expect(
      moveBlock({
        src: "source.ts",
        src_start: "a",
        src_end: "b",
        dst_before: "c"
      } as never)
    ).rejects.toThrow("Unknown move argument: dst_before");
  });

  test("rejects legacy dst_after argument", async () => {
    await expect(
      moveBlock({
        src: "source.ts",
        src_start: "a",
        src_end: "b",
        dst_after: "e"
      } as never)
    ).rejects.toThrow("Unknown move argument: dst_after");
  });

  test("rejects src outside the working directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-escape-"));
    await expect(
      moveBlock(
        {
          src: "../outside.ts",
          src_start: "a",
          src_end: "b",
          target_before: "c"
        },
        { cwd }
      )
    ).rejects.toThrow("escapes the working directory");
  });

  test("--diff emits real line-number hints", async () => {
    const cwd = await moveFixture();
    const result = await moveBlock(
      {
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n"
      },
      { cwd, diff: true }
    );

    expect(result.patch).toContain("blockpatch version 1");
    expect(result.patch).toContain("@@ -1,5 +1,2 @@ blockpatch-source id=move-1");
    expect(result.patch).toContain("@@ -6,1 +3,4 @@ blockpatch-target id=move-1");
  });
});

describe("format hardening", () => {
  function patchFor(payload: string, src: string, dst: string, sourceHunk: string, targetHunk: string): string {
    const sha = createHash("sha256").update(payload).digest("hex");
    return (
      `diff --blockpatch a/${src} b/${dst}\n` +
      "blockpatch version 1\n" +
      `blockpatch move id=move-1 payload-sha256=${sha}\n` +
      `--- a/${src}\n` +
      `+++ b/${dst}\n` +
      "\n" +
      sourceHunk +
      "\n" +
      targetHunk
    );
  }

  test("overlap detection is not bypassed by a dot path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-dot-path-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patchFor(
        "move me\n",
        "./file.txt",
        "file.txt",
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n alpha\n-move me\n omega\n",
        "@@ -2,1 +2,2 @@ blockpatch-target id=move-1\n move me\n+move me\n"
      )
    );

    const before = await readFile(join(cwd, "file.txt"));
    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("overlaps the source block");
    expect(await readFile(join(cwd, "file.txt"))).toEqual(before);
  });

  test("patch paths may not escape the working directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "blockpatch-traversal-"));
    const cwd = join(parent, "repo");
    await mkdir(cwd);
    await writeFile(join(parent, "outside.txt"), "safe\nmove me\nomega\nanchor\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patchFor(
        "move me\n",
        "../outside.txt",
        "../outside.txt",
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n safe\n-move me\n omega\n",
        "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n anchor\n+move me\n"
      )
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("escapes the working directory");
    expect(await readFile(join(parent, "outside.txt"), "utf8")).toBe("safe\nmove me\nomega\nanchor\n");
  });

  test("patch files may be read outside the working directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "blockpatch-external-patch-"));
    const cwd = join(parent, "repo");
    await mkdir(cwd);
    await writeFile(join(cwd, "file.txt"), "safe\nmove me\nomega\nanchor\n");
    const patchPath = join(parent, "patch.blockpatch");
    await writeFile(
      patchPath,
      patchFor(
        "move me\n",
        "file.txt",
        "file.txt",
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n safe\n-move me\n omega\n",
        "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n anchor\n+move me\n"
      )
    );

    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "apply",
        patchPath,
        "--cwd",
        cwd,
        "--json-output"
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as { changed: string[] };
    expect(stdout.changed).toEqual(["file.txt"]);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("safe\nomega\nanchor\nmove me\n");
  });

  test("diff header paths must match the file headers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-header-mismatch-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\ntarget\n");
    const patch = patchFor(
      "move me\n",
      "file.txt",
      "file.txt",
      "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n alpha\n-move me\n omega\n",
      "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n target\n+move me\n"
    ).replace("diff --blockpatch a/file.txt b/file.txt", "diff --blockpatch a/other.txt b/other.txt");
    await writeFile(join(cwd, "patch.blockpatch"), patch);

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "must match the --- and +++ headers"
    );
  });

  test("blank lines inside a hunk body are rejected", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-blank-line-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\ntarget\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patchFor(
        "move me\n",
        "file.txt",
        "file.txt",
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n alpha\n\n-move me\n omega\n",
        "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n target\n+move me\n"
      )
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "must not contain blank lines"
    );
  });

  test("hunk line counts must match the header", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-bad-counts-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\ntarget\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patchFor(
        "move me\n",
        "file.txt",
        "file.txt",
        "@@ -1,4 +1,2 @@ blockpatch-source id=move-1\n alpha\n-move me\n omega\n",
        "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n target\n+move me\n"
      )
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "Hunk line counts do not match header"
    );
  });

  test.skipIf(process.getuid?.() === 0)(
    "interrupted cross-file move duplicates the payload instead of losing it",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "blockpatch-interrupted-"));
      await mkdir(join(cwd, "locked"));
      await writeFile(join(cwd, "locked", "source.ts"), "before\nfunction movedThing() {\n}\nafter\n");
      await writeFile(join(cwd, "target.ts"), "class Target {\n}\n");
      await chmod(join(cwd, "locked"), 0o555);

      try {
        await expect(
          moveBlock(
            {
              src: "locked/source.ts",
              src_start: "function movedThing() {\n",
              src_end: "}\n",
              dst: "target.ts",
              target_before: "class Target {\n"
            },
            { cwd }
          )
        ).rejects.toThrow();

        const source = await readFile(join(cwd, "locked", "source.ts"), "utf8");
        const target = await readFile(join(cwd, "target.ts"), "utf8");
        expect(source).toContain("function movedThing()");
        expect(target).toContain("function movedThing()");
      } finally {
        await chmod(join(cwd, "locked"), 0o755);
      }
    }
  );

  test("version output matches package.json", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8")) as {
      version: string;
    };
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "version", "--json-output"],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as { ok: boolean; version: string };
    expect(stdout.version).toBe(pkg.version);
  });
});

async function moveFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-"));
  await writeFile(
    join(cwd, "source.ts"),
    "alpha\nfunction movedThing() {\n  return 42;\n}\nomega\nclass Target {\n}\n"
  );
  return cwd;
}
