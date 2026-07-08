import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { applyPatchFile } from "../src/engine";
import { moveBlock } from "../src/move";
import {
  fixtureCase,
  fixtureRoot,
  hardlinkOrSkip,
  symlinkOrSkip
} from "./helpers";

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

  function splitPatchFor(payload: string, src: string, dst: string, sourceHunk: string, targetHunk: string): string {
    const sha = createHash("sha256").update(payload).digest("hex");
    return (
      `diff --blockpatch a/${src} b/${src}\n` +
      "blockpatch version 1\n" +
      `blockpatch move id=move-1 role=source payload-sha256=${sha}\n` +
      `--- a/${src}\n` +
      `+++ b/${src}\n` +
      "\n" +
      sourceHunk +
      "\n" +
      `diff --blockpatch a/${dst} b/${dst}\n` +
      "blockpatch version 1\n" +
      `blockpatch move id=move-1 role=target payload-sha256=${sha}\n` +
      `--- a/${dst}\n` +
      `+++ b/${dst}\n` +
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

  test("hardlinked split patch paths use same-file semantics", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-hardlink-split-"));
    const realPath = join(cwd, "real.txt");
    const aliasPath = join(cwd, "alias.txt");
    const before = "safe\nmove me\nomega\nanchor\n";
    const expected = "safe\nomega\nanchor\nmove me\n";
    await writeFile(realPath, before);
    if (!(await hardlinkOrSkip(realPath, aliasPath))) {
      return;
    }
    await writeFile(
      join(cwd, "patch.blockpatch"),
      splitPatchFor(
        "move me\n",
        "real.txt",
        "alias.txt",
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n safe\n-move me\n omega\n",
        "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n anchor\n+move me\n"
      )
    );

    const result = await applyPatchFile("patch.blockpatch", { cwd });
    expect(result.changed).toEqual(["real.txt", "alias.txt"]);
    expect(result.affected).toEqual(["real.txt", "alias.txt"]);
    expect(result.written).toBe(true);
    expect(await readFile(realPath, "utf8")).toBe(expected);
    expect(await readFile(aliasPath, "utf8")).toBe(expected);
  });

  test("duplicate move metadata keys are rejected", async () => {
    const cwd = await fixtureCase("success");
    const patch = await readFile(join(cwd, "patch.blockpatch"), "utf8");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patch.replace("blockpatch move id=move-1 ", "blockpatch move id=move-1 id=move-2 ")
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "Duplicate blockpatch move metadata field: id"
    );
  });

  test("unknown move metadata keys are rejected", async () => {
    const cwd = await fixtureCase("success");
    const patch = await readFile(join(cwd, "patch.blockpatch"), "utf8");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patch.replace("blockpatch move id=move-1 ", "blockpatch move id=move-1 agent=codex ")
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "Unknown blockpatch move metadata field: agent"
    );
  });

  test("reserved x-prefixed move metadata keys are accepted", async () => {
    const cwd = await fixtureCase("success");
    const patch = await readFile(join(cwd, "patch.blockpatch"), "utf8");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patch.replace("blockpatch move id=move-1 ", "blockpatch move id=move-1 x-agent=codex ")
    );

    await applyPatchFile("patch.blockpatch", { cwd });
    expect(await readFile(join(cwd, "file.txt"))).toEqual(await readFile(join(fixtureRoot, "success", "after.txt")));
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

  test("patch paths may not use in-tree symlinks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-symlink-"));
    const realPath = join(cwd, "real.txt");
    const linkPath = join(cwd, "link.txt");
    await writeFile(realPath, "safe\nmove me\nomega\nanchor\n");
    if (!(await symlinkOrSkip("real.txt", linkPath))) {
      return;
    }
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patchFor(
        "move me\n",
        "link.txt",
        "link.txt",
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n safe\n-move me\n omega\n",
        "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n anchor\n+move me\n"
      )
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "must not contain symbolic links"
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(realPath, "utf8")).toBe("safe\nmove me\nomega\nanchor\n");
  });

  test("patch paths may not use symlink directory components", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-symlink-dir-"));
    await mkdir(join(cwd, "real-dir"));
    const realPath = join(cwd, "real-dir", "file.txt");
    const linkPath = join(cwd, "link-dir");
    await writeFile(realPath, "safe\nmove me\nomega\nanchor\n");
    if (!(await symlinkOrSkip("real-dir", linkPath))) {
      return;
    }
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patchFor(
        "move me\n",
        "link-dir/file.txt",
        "link-dir/file.txt",
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n safe\n-move me\n omega\n",
        "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n anchor\n+move me\n"
      )
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "must not contain symbolic links"
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(realPath, "utf8")).toBe("safe\nmove me\nomega\nanchor\n");
  });

  test("patch paths may not escape the working directory through a symlink", async () => {
    const parent = await mkdtemp(join(tmpdir(), "blockpatch-symlink-escape-"));
    const cwd = join(parent, "repo");
    await mkdir(cwd);
    await writeFile(join(parent, "outside.txt"), "safe\nmove me\nomega\nanchor\n");
    if (!(await symlinkOrSkip(join(parent, "outside.txt"), join(cwd, "link.txt")))) {
      return;
    }
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patchFor(
        "move me\n",
        "link.txt",
        "link.txt",
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n safe\n-move me\n omega\n",
        "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n anchor\n+move me\n"
      )
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "must not contain symbolic links"
    );
    expect(await readFile(join(parent, "outside.txt"), "utf8")).toBe("safe\nmove me\nomega\nanchor\n");
  });

  test("patch paths may not be absolute", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-absolute-path-"));
    const absolutePath = join(cwd, "file.txt");
    await writeFile(absolutePath, "safe\nmove me\nomega\nanchor\n");
    await writeFile(
      join(cwd, "patch.blockpatch"),
      patchFor(
        "move me\n",
        absolutePath,
        absolutePath,
        "@@ -1,3 +1,2 @@ blockpatch-source id=move-1\n safe\n-move me\n omega\n",
        "@@ -4,1 +4,2 @@ blockpatch-target id=move-1\n anchor\n+move me\n"
      )
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow("must be relative");
    expect(await readFile(absolutePath, "utf8")).toBe("safe\nmove me\nomega\nanchor\n");
  });

  test("patch operation paths may not contain display control characters", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-control-path-"));
    const payload = "inserted bytes\n";
    const sha = createHash("sha256").update(payload).digest("hex");
    const dst = "bad\tpath.txt";
    await writeFile(
      join(cwd, "patch.blockpatch"),
      [
        `diff --blockpatch /dev/null b/${dst}`,
        "blockpatch version 1",
        `blockpatch move id=move-1 payload-sha256=${sha}`,
        "--- /dev/null",
        `+++ b/${dst}`,
        "",
        "@@ -0,0 +1,1 @@ blockpatch-target id=move-1",
        "+inserted bytes"
      ].join("\n") + "\n"
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "contains unsupported control characters"
    );
  });

  test("patch operation paths must use POSIX separators", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-backslash-path-"));
    const payload = "inserted bytes\n";
    const sha = createHash("sha256").update(payload).digest("hex");
    const dst = "src\\new.txt";
    await writeFile(
      join(cwd, "patch.blockpatch"),
      [
        `diff --blockpatch /dev/null b/${dst}`,
        "blockpatch version 1",
        `blockpatch move id=move-1 payload-sha256=${sha}`,
        "--- /dev/null",
        `+++ b/${dst}`,
        "",
        "@@ -0,0 +1,1 @@ blockpatch-target id=move-1",
        "+inserted bytes"
      ].join("\n") + "\n"
    );

    await expect(applyPatchFile("patch.blockpatch", { cwd })).rejects.toThrow(
      "must use POSIX-style / separators"
    );
  });

  test("missing patch files report structured JSON errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-missing-patch-"));
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "missing.blockpatch", "--json-output", "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: { code: string; path: string; phase: string };
    };
    expect(stderr).toMatchObject({
      ok: false,
      error: {
        code: "file_not_found",
        phase: "io"
      }
    });
    expect(stderr.error.path).toContain("missing.blockpatch");
  });

  test("non-regular operation paths report structured JSON errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-directory-path-"));
    await mkdir(join(cwd, "file.txt"));
    await writeFile(
      join(cwd, "patch.blockpatch"),
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
        join(cwd, "patch.blockpatch"),
        "--json-output",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: { code: string; path: string; phase: string };
    };
    expect(stderr).toMatchObject({
      ok: false,
      error: {
        code: "not_regular_file",
        path: "file.txt",
        phase: "path"
      }
    });
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
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as { changed: string[]; written: boolean };
    expect(stdout.changed).toEqual(["file.txt"]);
    expect(stdout.written).toBe(true);
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

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "failed cross-file staging leaves originals untouched",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "blockpatch-interrupted-"));
      await mkdir(join(cwd, "locked"));
      const sourceBefore = "before\nfunction movedThing() {\n}\nafter\n";
      const targetBefore = "class Target {\n}\n";
      await writeFile(join(cwd, "locked", "source.ts"), sourceBefore);
      await writeFile(join(cwd, "target.ts"), targetBefore);
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
        expect(source).toBe(sourceBefore);
        expect(target).toBe(targetBefore);
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

  test("version rejects extra arguments", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "version", "typo"],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toContain("Unexpected argument: typo");
  });

  test("version rejects extra arguments as JSON when requested", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "version", "typo", "--json-output"],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(stderr).toMatchObject({
      ok: false,
      error: {
        code: "too_many_args",
        message: "Unexpected argument: typo"
      }
    });
  });
});
