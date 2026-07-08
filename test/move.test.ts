import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { applyPatchFile } from "../src/engine";
import { moveBlock } from "../src/move";
import { BlockPatchError } from "../src/errors";
import {
  expectMissing,
  hardlinkOrSkip,
  moveFixture,
  pathExists,
  shaText,
  symlinkOrSkip
} from "./helpers";

describe("moveBlock API", () => {
  test("fails on ambiguous source delimiters without modifying file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-ambiguous-"));
    const sourceBlock = "function movedThing() {\n}\n";
    await writeFile(
      join(cwd, "source.ts"),
      `${sourceBlock}${sourceBlock}class Target {\n}\n`
    );
    const before = await readFile(join(cwd, "source.ts"));

    let error: unknown;
    try {
      await moveBlock(
        {
          src: "source.ts",
          src_start: "function movedThing() {\n",
          src_end: "}\n",
          target_before: "class Target {\n"
        },
        { cwd }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).message).toContain("Source delimiters are ambiguous");
    expect((error as BlockPatchError).details).toMatchObject({
      path: "source.ts",
      phase: "source",
      anchor: "src_start/src_end",
      matches: 2,
      ranges: [
        { start: 0, end: sourceBlock.length },
        { start: sourceBlock.length, end: sourceBlock.length * 2 }
      ]
    });

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
    expect(result.written).toBe(false);
    expect(result.noop).toBe(true);
    expect(result.status).toBe("noop");
    expect(result.moves[0]).toMatchObject({
      id: "move-1",
      src: "source.ts",
      dst: "source.ts",
      payload_sha256: "f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e",
      payload_bytes: "move me\n".length
    });
  });

  test("treats hardlinked src and dst paths as the same file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-hardlink-"));
    const sourcePath = join(cwd, "source.ts");
    const aliasPath = join(cwd, "alias.ts");
    const before = "alpha\nmove me\nomega\ntarget\n";
    const expected = "alpha\nomega\ntarget\nmove me\n";
    await writeFile(sourcePath, before);
    if (!(await hardlinkOrSkip(sourcePath, aliasPath))) {
      return;
    }

    const result = await moveBlock(
      {
        src: "source.ts",
        dst: "alias.ts",
        src_start: "move me",
        src_end: "\n",
        target_before: "target\n"
      },
      { cwd }
    );

    expect(result.changed).toEqual(["source.ts", "alias.ts"]);
    expect(result.affected).toEqual(["source.ts", "alias.ts"]);
    expect(result.written).toBe(true);
    expect(result.status).toBe("applied");
    expect(await readFile(sourcePath, "utf8")).toBe(expected);
    expect(await readFile(aliasPath, "utf8")).toBe(expected);
  });

  test("move --diff keeps distinct hardlink labels in split sections", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-hardlink-diff-"));
    const sourcePath = join(cwd, "source.ts");
    const aliasPath = join(cwd, "alias.ts");
    await writeFile(sourcePath, "alpha\nmove me\nomega\ntarget\n");
    if (!(await hardlinkOrSkip(sourcePath, aliasPath))) {
      return;
    }

    const result = await moveBlock(
      {
        src: "source.ts",
        dst: "alias.ts",
        src_start: "move me",
        src_end: "\n",
        target_before: "target\n"
      },
      { cwd, diff: true }
    );

    expect(result.patch).toContain("diff --blockpatch a/source.ts b/source.ts");
    expect(result.patch).toContain("blockpatch move id=move-1 role=source payload-sha256=");
    expect(result.patch).toContain("diff --blockpatch a/alias.ts b/alias.ts");
    expect(result.patch).toContain("blockpatch move id=move-1 role=target payload-sha256=");
    expect(result.patch).not.toContain("diff --blockpatch a/source.ts b/alias.ts");
    expect(await readFile(sourcePath, "utf8")).toBe("alpha\nmove me\nomega\ntarget\n");
    expect(await readFile(aliasPath, "utf8")).toBe("alpha\nmove me\nomega\ntarget\n");
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

  test("rejects invalid expected payload hash", async () => {
    await expect(
      moveBlock({
        src: "source.ts",
        src_start: "a",
        src_end: "b",
        target_before: "c",
        expected_payload_sha256: "not-a-sha"
      })
    ).rejects.toThrow("expected_payload_sha256 must be a 64-character lowercase sha256 hex digest");
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

  test("rejects absolute src paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-absolute-"));
    await expect(
      moveBlock(
        {
          src: join(cwd, "source.ts"),
          src_start: "a",
          src_end: "b",
          target_before: "c"
        },
        { cwd }
      )
    ).rejects.toThrow("must be relative");
  });

  test("rejects NUL bytes in paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-nul-"));
    await expect(
      moveBlock(
        {
          src: "source.ts\0.txt",
          src_start: "a",
          src_end: "b",
          target_before: "c"
        },
        { cwd }
      )
    ).rejects.toThrow("Invalid source path");
  });

  test("rejects display control characters in paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-control-path-"));
    await expect(
      moveBlock(
        {
          src: "source.ts\n.txt",
          src_start: "a",
          src_end: "b",
          target_before: "c"
        },
        { cwd }
      )
    ).rejects.toThrow("source path contains unsupported control characters");

    await expect(
      moveBlock(
        {
          src: "/dev/null",
          dst: "target\t.ts",
          payload: "inserted\n",
          target_before: "anchor\n"
        },
        { cwd }
      )
    ).rejects.toThrow("destination path contains unsupported control characters");
  });

  test("rejects Windows-style separators in paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-backslash-path-"));
    await expect(
      moveBlock(
        {
          src: "src\\source.ts",
          src_start: "a",
          src_end: "b",
          target_before: "c"
        },
        { cwd }
      )
    ).rejects.toThrow("source path must use POSIX-style / separators");

    await expect(
      moveBlock(
        {
          src: "/dev/null",
          dst: "src\\target.ts",
          payload: "inserted\n",
          target_before: "anchor\n"
        },
        { cwd }
      )
    ).rejects.toThrow("destination path must use POSIX-style / separators");
  });

  test("rejects symlink src paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-move-symlink-"));
    const realPath = join(cwd, "real.ts");
    const linkPath = join(cwd, "link.ts");
    const before = "function movedThing() {\n}\nclass Target {\n}\n";
    await writeFile(realPath, before);
    if (!(await symlinkOrSkip("real.ts", linkPath))) {
      return;
    }

    await expect(
      moveBlock(
        {
          src: "link.ts",
          src_start: "function movedThing() {\n",
          src_end: "}\n",
          target_before: "class Target {\n"
        },
        { cwd }
      )
    ).rejects.toThrow("must not contain symbolic links");

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(realPath, "utf8")).toBe(before);
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
    expect(result.patch).toContain("@@ -6,2 +3,5 @@ blockpatch-target id=move-1");
  });

  test("move --diff self-check accepts payload ending in bare CR", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-diff-bare-cr-"));
    await writeFile(join(cwd, "source.ts"), Buffer.from("before\nx\r", "utf8"));
    await writeFile(join(cwd, "target.ts"), "target\n");

    const result = await moveBlock(
      {
        src: "source.ts",
        src_start: "x",
        src_end: "\r",
        dst: "target.ts",
        target_before: "target\n"
      },
      { cwd, diff: true }
    );

    expect(result.patch).toContain("-x\r\n\\ No newline at end of file");
    expect(result.patch).toContain("+x\r\n\\ No newline at end of file");
    expect(result.written).toBe(false);
    expect(await readFile(join(cwd, "source.ts"))).toEqual(Buffer.from("before\nx\r", "utf8"));
    expect(await readFile(join(cwd, "target.ts"), "utf8")).toBe("target\n");
  });

  test("create_file mode renders a whole-file /dev/null creation patch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-file-json-"));
    const result = await moveBlock(
      {
        src: "/dev/null",
        dst: "src/new.ts",
        payload: "export const x = 1;\n",
        mode: "create_file"
      },
      { cwd, diff: true }
    );

    expect(result).toMatchObject({
      changed: ["src/new.ts"],
      affected: ["src/new.ts"],
      written: false,
      status: "applied"
    });
    expect(result.moves[0]).toMatchObject({
      src: "/dev/null",
      dst: "src/new.ts",
      source_range: null,
      target_range: { start: 0, end: 0 },
      insert_index: 0
    });
    expect(result.patch).toContain("diff --blockpatch /dev/null b/src/new.ts");
    expect(result.patch).toContain("--- /dev/null");
    expect(result.patch).toContain("+++ b/src/new.ts");
    expect(result.patch).toContain("@@ -0,0 +1,1 @@ blockpatch-target id=move-1");
    expect(result.patch).toContain("+export const x = 1;");
    expect(await pathExists(join(cwd, "src/new.ts"))).toBe(false);

    await writeFile(join(cwd, "generated.blockpatch"), result.patch ?? "");
    await applyPatchFile("generated.blockpatch", { cwd });
    expect(await readFile(join(cwd, "src/new.ts"), "utf8")).toBe("export const x = 1;\n");
  });

  test("create_file mode accepts an empty whole-file payload", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-create-file-empty-json-"));
    const result = await moveBlock(
      {
        src: "/dev/null",
        dst: "empty.txt",
        payload: "",
        mode: "create_file"
      },
      { cwd }
    );

    expect(result.changed).toEqual(["empty.txt"]);
    expect(result.written).toBe(true);
    expect(await readFile(join(cwd, "empty.txt"), "utf8")).toBe("");
  });

  test("remove_file mode renders a whole-file /dev/null removal patch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-remove-file-json-"));
    await writeFile(join(cwd, "old.ts"), "export const old = true;\n");
    const payloadSha256 = shaText("export const old = true;\n");

    const result = await moveBlock(
      {
        src: "old.ts",
        dst: "/dev/null",
        mode: "remove_file",
        expected_payload_sha256: payloadSha256
      },
      { cwd, diff: true }
    );

    expect(result).toMatchObject({
      changed: ["old.ts"],
      affected: ["old.ts"],
      written: false,
      status: "applied"
    });
    expect(result.moves[0]).toMatchObject({
      src: "old.ts",
      dst: "/dev/null",
      payload_sha256: payloadSha256,
      source_range: { start: 0, end: "export const old = true;\n".length },
      target_range: null,
      insert_index: null
    });
    expect(result.patch).toContain("diff --blockpatch a/old.ts /dev/null");
    expect(result.patch).toContain("--- a/old.ts");
    expect(result.patch).toContain("+++ /dev/null");
    expect(result.patch).toContain("@@ -1,1 +0,0 @@ blockpatch-source id=move-1");
    expect(result.patch).toContain("-export const old = true;");
    expect(await readFile(join(cwd, "old.ts"), "utf8")).toBe("export const old = true;\n");

    await writeFile(join(cwd, "generated.blockpatch"), result.patch ?? "");
    await applyPatchFile("generated.blockpatch", { cwd });
    await expectMissing(join(cwd, "old.ts"));
  });

  test("remove_file mode rejects expected payload hash mismatches", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-remove-file-json-hash-"));
    await writeFile(join(cwd, "old.ts"), "export const old = true;\n");

    await expect(
      moveBlock(
        {
          src: "old.ts",
          dst: "/dev/null",
          mode: "remove_file",
          expected_payload_sha256: "0000000000000000000000000000000000000000000000000000000000000000"
        },
        { cwd, diff: true }
      )
    ).rejects.toThrow("expected_payload_sha256 does not match selected source payload");
    expect(await readFile(join(cwd, "old.ts"), "utf8")).toBe("export const old = true;\n");
  });

  test("move --diff rejects invalid UTF-8 payload bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-invalid-utf8-"));
    await writeFile(
      join(cwd, "source.ts"),
      Buffer.concat([
        Buffer.from("alpha\nmove ", "utf8"),
        Buffer.from([0xff]),
        Buffer.from("\nomega\nclass Target {\n}\n", "utf8")
      ])
    );

    let error: unknown;
    try {
      await moveBlock(
        {
          src: "source.ts",
          src_start: "move ",
          src_end: "\n",
          target_before: "class Target {\n"
        },
        { cwd, diff: true }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BlockPatchError);
    expect((error as BlockPatchError).code).toBe("invalid_utf8");
  });
});
