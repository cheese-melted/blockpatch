import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { applyPatchFile, checkPatchFile } from "../src/engine";
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

describe("blockpatch v0 golden fixtures", () => {
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
          "blockpatch version 0\n" +
          "blockpatch move id=move-1 payload-sha256=10d316fe0179a4ccaa97a509f75294785f941d7f9b0656684844edcdf1b5a01a\n" +
          "--- a/file.txt\n" +
          "+++ b/file.txt\n" +
          "\n" +
          "@@ blockpatch-source move-1 -1,3 +1,2 @@\n" +
          " alpha\r\n" +
          "-move me\r\n" +
          " omega\r\n" +
          "\n" +
          "@@ blockpatch-target move-1 -4,1 +4,2 @@\n" +
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
          "blockpatch version 0\n" +
          "blockpatch move id=move-1 payload-sha256=f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e\n" +
          "--- a/file.txt\n" +
          "+++ b/file.txt\n" +
          "\n" +
          "@@ blockpatch-source move-1 -1,3 +1,2 @@\n" +
          " alpha\n" +
          "-move me\n" +
          " omega\n" +
          "\n" +
          "@@ blockpatch-target move-1 -4,1 +4,2 @@\n" +
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
        "blockpatch version 0\n" +
        "blockpatch move id=move-1 payload-sha256=f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e\n" +
        "--- a/file.txt\n" +
        "+++ b/file.txt\n" +
        "\n" +
        "@@ blockpatch-source move-1 -1,3 +1,2 @@\n" +
        " alpha\n" +
        "-move me\n" +
        " omega\n" +
        "\n" +
        "@@ blockpatch-target move-1 -2,1 +2,2 @@\n" +
        " move me\n" +
        "+move me\n"
    );

    const before = await readFile(join(cwd, "file.txt"));
    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("overlaps the source block");
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
});
