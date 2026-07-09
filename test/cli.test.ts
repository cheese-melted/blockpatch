import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { applyPatchFile, checkPatchBytes } from "../src/engine";
import { moveBlock } from "../src/move";
import {
  fixtureCase,
  fixtureRoot,
  moveFixture,
  pathExists,
  shaText
} from "./helpers";

describe("CLI", () => {
  test("help explains move JSON anchors and newline behavior", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "--help"],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("Move JSON fields:");
    expect(stdout).toContain("target_before is the exact context immediately before the insertion point");
    expect(stdout).toContain("blockpatch never adds separators");
  });

  test("supports required check/apply commands", async () => {
    const cwd = await fixtureCase("success");
    const patchPath = join(cwd, "patch.blockpatch");
    const check = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "check", patchPath, "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(await check.exited).toBe(0);
    expect(await new Response(check.stderr).text()).toBe("");

    const apply = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", patchPath, "--cwd", cwd],
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
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "apply",
        join(cwd, "patch.blockpatch"),
        "--dry-run",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(await dryRun.exited).toBe(0);
    expect(await new Response(dryRun.stderr).text()).toBe("");
    const after = await readFile(join(cwd, "file.txt"));
    expect(after).toEqual(before);
  });

  test("supports apply --reverse and check -R", async () => {
    const cwd = await fixtureCase("success");
    const patchPath = join(cwd, "patch.blockpatch");
    const before = await readFile(join(cwd, "file.txt"));
    await applyPatchFile("patch.blockpatch", { cwd });
    const applied = await readFile(join(cwd, "file.txt"));

    const check = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "check", "-R", patchPath, "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(await check.exited).toBe(0);
    expect(await new Response(check.stderr).text()).toBe("");
    expect(await readFile(join(cwd, "file.txt"))).toEqual(applied);

    const reverse = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "--reverse", patchPath, "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });
    expect(await reverse.exited).toBe(0);
    expect(await new Response(reverse.stderr).text()).toBe("");
    expect(await readFile(join(cwd, "file.txt"))).toEqual(before);
  });

  test("apply --explain prints dry-run JSON without modifying files", async () => {
    const cwd = await fixtureCase("success");
    const before = await readFile(join(cwd, "file.txt"));
    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "apply",
        join(cwd, "patch.blockpatch"),
        "--explain",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as {
      ok: boolean;
      changed: string[];
      affected: string[];
      written: boolean;
      status: string;
      strip_components: number;
      moves: Array<{ payload_sha256: string; source_range: { start: number; end: number } }>;
    };
    expect(stdout).toMatchObject({
      ok: true,
      changed: ["file.txt"],
      affected: ["file.txt"],
      written: false,
      status: "applied",
      strip_components: 1
    });
    expect(stdout.moves[0]).toMatchObject({
      payload_sha256: "f721166071c491fd38ac82a8432ecc349f39f537a969054ab2c8d3175c731e7e",
      source_range: { start: "alpha\n".length, end: "alpha\nmove me\n".length }
    });
    expect(await readFile(join(cwd, "file.txt"))).toEqual(before);
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
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "-i", join(cwd, "patch.blockpatch"), "-d", cwd, "-p1"],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const actual = await readFile(join(cwd, "file.txt"));
    const expected = await readFile(join(fixtureRoot, "success", "after.txt"));
    expect(actual).toEqual(expected);
  });

  test("relative patch input paths resolve from the shell working directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "blockpatch-relative-input-"));
    const cwd = join(parent, "repo");
    await mkdir(cwd);
    await writeFile(join(cwd, "file.txt"), "alpha\nmove me\nomega\ntarget\n");
    await writeFile(join(parent, "patch.blockpatch"), await readFile(join(fixtureRoot, "success", "patch.blockpatch")));

    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", "-d", "repo", "patch.blockpatch"],
      cwd: parent,
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nomega\ntarget\nmove me\n");
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

  test("patch command JSON reports effective strip count", async () => {
    const cwd = await fixtureCase("success");
    const patch = (await readFile(join(cwd, "patch.blockpatch"), "utf8"))
      .replaceAll("a/file.txt", "a/nested/file.txt")
      .replaceAll("b/file.txt", "b/nested/file.txt");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "check", "-d", cwd, "-p2", "--json-output"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(patch);
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as {
      changed: string[];
      written: boolean;
      strip_components: number;
    };
    expect(stdout.changed).toEqual(["file.txt"]);
    expect(stdout.written).toBe(false);
    expect(stdout.strip_components).toBe(2);
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

  test("move --json inserts payload from /dev/null", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-json-insert-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nomega\n");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--json-output", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "/dev/null",
        dst: "file.txt",
        payload: "new line\n",
        target_before: "alpha\n",
        target_after: "omega\n"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as {
      ok: boolean;
      changed: string[];
      moves: Array<{ src: string; dst: string; source_range: null; insert_index: number }>;
    };
    expect(stdout.ok).toBe(true);
    expect(stdout.changed).toEqual(["file.txt"]);
    expect(stdout.moves[0]).toMatchObject({
      src: "/dev/null",
      dst: "file.txt",
      source_range: null,
      insert_index: "alpha\n".length
    });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nnew line\nomega\n");
  });

  test("move --json deletes payload to /dev/null", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-json-delete-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nfunction removeMe() {\n  return 1;\n}\nomega\n");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--json-output", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "file.txt",
        src_start: "function removeMe() {\n",
        src_end: "}\n",
        dst: "/dev/null"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as {
      ok: boolean;
      changed: string[];
      moves: Array<{ src: string; dst: string; target_range: null; insert_index: null }>;
    };
    expect(stdout.ok).toBe(true);
    expect(stdout.changed).toEqual(["file.txt"]);
    expect(stdout.moves[0]).toMatchObject({
      src: "file.txt",
      dst: "/dev/null",
      target_range: null,
      insert_index: null
    });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nomega\n");
  });

  test("move --diff for /dev/null insertion emits target-only same-file patch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-json-insert-diff-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nomega\n");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--diff", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "/dev/null",
        dst: "file.txt",
        payload: "new line\n",
        target_before: "alpha\n",
        target_after: "omega\n"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("diff --blockpatch a/file.txt b/file.txt");
    expect(stdout).toContain("@@ -1,2 +1,3 @@ blockpatch-target id=move-1");
    expect(stdout).toContain("+new line");
    expect(stdout).not.toContain("blockpatch-source");
    expect(stdout).not.toContain("/dev/null");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nomega\n");

    await writeFile(join(cwd, "generated.blockpatch"), stdout);
    await applyPatchFile("generated.blockpatch", { cwd });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nnew line\nomega\n");
  });

  test("move --diff for /dev/null deletion emits source-only same-file patch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-json-delete-diff-"));
    await writeFile(join(cwd, "file.txt"), "alpha\nfunction removeMe() {\n  return 1;\n}\nomega\n");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--diff", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "file.txt",
        src_start: "function removeMe() {\n",
        src_end: "}\n",
        dst: "/dev/null"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("diff --blockpatch a/file.txt b/file.txt");
    expect(stdout).toContain("@@ -1,5 +1,2 @@ blockpatch-source id=move-1");
    expect(stdout).toContain("-function removeMe() {");
    expect(stdout).not.toContain("blockpatch-target");
    expect(stdout).not.toContain("/dev/null");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
      "alpha\nfunction removeMe() {\n  return 1;\n}\nomega\n"
    );

    await writeFile(join(cwd, "generated.blockpatch"), stdout);
    await applyPatchFile("generated.blockpatch", { cwd });
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nomega\n");
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
      written: boolean;
      noop: boolean;
      status: string;
      moves: Array<{ src: string; dst: string; payload_sha256: string; payload_bytes: number }>;
    };
    expect(stdout.ok).toBe(true);
    expect(stdout.changed).toEqual(["source.ts"]);
    expect(stdout.affected).toEqual(["source.ts"]);
    expect(stdout.written).toBe(false);
    expect(stdout.noop).toBe(false);
    expect(stdout.status).toBe("applied");
    expect(stdout.moves[0]).toMatchObject({
      src: "source.ts",
      dst: "source.ts",
      payload_sha256: "a990c0da5571138b0e2363af883a399fe214a137ad809c67f6530c618967a4e6",
      payload_bytes: "function movedThing() {\n  return 42;\n}\n".length
    });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);
  });

  test("move --json honors dry_run field", async () => {
    const cwd = await moveFixture();
    const before = await readFile(join(cwd, "source.ts"), "utf8");
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
        target_before: "class Target {\n",
        target_after: "}\n",
        dry_run: true
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as {
      ok: boolean;
      changed: string[];
      written: boolean;
      status: string;
    };
    expect(stdout).toMatchObject({
      ok: true,
      changed: ["source.ts"],
      written: false,
      status: "applied"
    });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);
  });

  test("move --explain prints dry-run JSON without modifying files", async () => {
    const cwd = await moveFixture();
    const before = await readFile(join(cwd, "source.ts"), "utf8");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--explain", "--cwd", cwd],
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
      written: boolean;
      status: string;
      moves: Array<{
        payload_sha256: string;
        source_range: { start: number; end: number };
        target_range: { start: number; end: number };
        insert_index: number;
      }>;
    };
    expect(stdout).toMatchObject({
      ok: true,
      changed: ["source.ts"],
      affected: ["source.ts"],
      written: false,
      status: "applied"
    });
    expect(stdout.moves[0]).toMatchObject({
      payload_sha256: "a990c0da5571138b0e2363af883a399fe214a137ad809c67f6530c618967a4e6",
      source_range: { start: "alpha\n".length, end: "alpha\nfunction movedThing() {\n  return 42;\n}\n".length },
      target_range: {
        start: "alpha\nfunction movedThing() {\n  return 42;\n}\nomega\n".length,
        end: before.length
      },
      insert_index: "alpha\nfunction movedThing() {\n  return 42;\n}\nomega\nclass Target {\n".length
    });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);
  });

  test("move --diff --json-output returns the reviewable patch without writing", async () => {
    const cwd = await moveFixture();
    const before = await readFile(join(cwd, "source.ts"), "utf8");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--diff", "--json-output", "--cwd", cwd],
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
      written: boolean;
      noop: boolean;
      status: string;
      patch: string;
      moves: Array<{ payload_sha256: string; source_range: { start: number; end: number } }>;
    };
    expect(stdout).toMatchObject({
      ok: true,
      changed: ["source.ts"],
      affected: ["source.ts"],
      written: false,
      noop: false,
      status: "applied"
    });
    expect(stdout.moves[0]).toMatchObject({
      payload_sha256: "a990c0da5571138b0e2363af883a399fe214a137ad809c67f6530c618967a4e6",
      source_range: { start: "alpha\n".length, end: "alpha\nfunction movedThing() {\n  return 42;\n}\n".length }
    });
    expect(stdout.patch).toContain("diff --blockpatch a/source.ts b/source.ts");
    expect(stdout.patch).toContain("blockpatch move id=move-1 payload-sha256=");
    expect(stdout.patch).toContain("@@ -1,5 +1,2 @@ blockpatch-source id=move-1");
    expect(stdout.patch).toContain("@@ -6,2 +3,5 @@ blockpatch-target id=move-1");
    const selfCheck = await checkPatchBytes(Buffer.from(stdout.patch, "utf8"), { cwd });
    expect(selfCheck.status).toBe("applied");
    expect(selfCheck.written).toBe(false);
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);
  });

  test("plan --json returns a reviewable patch without writing", async () => {
    const cwd = await moveFixture();
    const before = await readFile(join(cwd, "source.ts"), "utf8");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "plan", "--json", "-", "--cwd", cwd],
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
      written: boolean;
      patch: string;
    };
    expect(stdout.ok).toBe(true);
    expect(stdout.changed).toEqual(["source.ts"]);
    expect(stdout.written).toBe(false);
    expect(stdout.patch).toContain("diff --blockpatch a/source.ts b/source.ts");
    expect(stdout.patch).toContain("@@ -1,5 +1,2 @@ blockpatch-source id=move-1");
    expect(stdout.patch).toContain("@@ -6,2 +3,5 @@ blockpatch-target id=move-1");
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);
  });

  test("plan --json supports whole-file creation mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-plan-create-file-"));
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "plan", "--json", "-", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "/dev/null",
        dst: "src/new.ts",
        payload: "export const x = 1;\n",
        mode: "create_file"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as {
      ok: boolean;
      changed: string[];
      written: boolean;
      patch: string;
      moves: Array<{ src: string; dst: string; payload_sha256: string; source_range: null }>;
    };
    expect(stdout).toMatchObject({
      ok: true,
      changed: ["src/new.ts"],
      written: false
    });
    expect(stdout.moves[0]).toMatchObject({
      src: "/dev/null",
      dst: "src/new.ts",
      payload_sha256: shaText("export const x = 1;\n"),
      source_range: null
    });
    expect(stdout.patch).toContain("diff --blockpatch /dev/null b/src/new.ts");
    expect(stdout.patch).toContain("@@ -0,0 +1,1 @@ blockpatch-target id=move-1");
    expect(await pathExists(join(cwd, "src/new.ts"))).toBe(false);
  });

  test("plan --json supports whole-file removal mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-plan-remove-file-"));
    await writeFile(join(cwd, "old.ts"), "export const old = true;\n");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "plan", "--json", "-", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "old.ts",
        dst: "/dev/null",
        mode: "remove_file",
        expected_payload_sha256: shaText("export const old = true;\n")
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as {
      ok: boolean;
      changed: string[];
      written: boolean;
      patch: string;
      moves: Array<{ src: string; dst: string; payload_sha256: string; target_range: null }>;
    };
    expect(stdout).toMatchObject({
      ok: true,
      changed: ["old.ts"],
      written: false
    });
    expect(stdout.moves[0]).toMatchObject({
      src: "old.ts",
      dst: "/dev/null",
      payload_sha256: shaText("export const old = true;\n"),
      target_range: null
    });
    expect(stdout.patch).toContain("diff --blockpatch a/old.ts /dev/null");
    expect(stdout.patch).toContain("@@ -1,1 +0,0 @@ blockpatch-source id=move-1");
    expect(await readFile(join(cwd, "old.ts"), "utf8")).toBe("export const old = true;\n");
  });

  test("plan errors are JSON by default", async () => {
    const cwd = await moveFixture();
    const before = await readFile(join(cwd, "source.ts"), "utf8");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "plan", "--json", "-", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: { code: string; field: string };
    };
    expect(stderr).toMatchObject({
      ok: false,
      error: {
        code: "invalid_move_args",
        field: "target_before"
      }
    });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);
  });

  test("empty move JSON reports the expected request shape", async () => {
    const cwd = await moveFixture();
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--json-output", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write("{}");
    proc.stdin.end();

    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: { code: string; field: string; message: string; suggested_action: string };
    };
    expect(stderr).toMatchObject({
      ok: false,
      error: {
        code: "invalid_move_args",
        field: "src",
        message: "Move JSON cannot be empty; provide src plus source selectors or payload and target anchors"
      }
    });
    expect(stderr.error.suggested_action).toContain("src_start");
  });

  test("move JSON warns when target_before and payload will be joined without a newline", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-adjacent-warning-"));
    await writeFile(join(cwd, "file.txt"), "marker\n");
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--dry-run", "--json-output", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "/dev/null",
        dst: "file.txt",
        payload: "payload",
        target_before: "marker"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const stdout = JSON.parse(await new Response(proc.stdout).text()) as {
      ok: boolean;
      warnings: Array<{
        code: string;
        message: string;
        path: string;
        phase: string;
        boundary: string;
        suggested_action: string;
      }>;
    };
    expect(stdout.ok).toBe(true);
    expect(stdout.warnings).toEqual([
      {
        code: "adjacent_bytes",
        message:
          "Insertion will place payload immediately after target_before with no newline or separator inserted by blockpatch",
        path: "file.txt",
        phase: "target",
        boundary: "target_before+payload",
        suggested_action: "include the intended newline in target_before or at the start of payload"
      }
    ]);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("marker\n");
  });

  test("move --json accepts expected_payload_sha256", async () => {
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
        target_after: "}\n",
        expected_payload_sha256: "a990c0da5571138b0e2363af883a399fe214a137ad809c67f6530c618967a4e6"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(
      "alpha\nomega\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\n"
    );
  });

  test("move --json rejects expected_payload_sha256 mismatch without modifying files", async () => {
    const cwd = await moveFixture();
    const before = await readFile(join(cwd, "source.ts"), "utf8");
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
        target_before: "class Target {\n",
        target_after: "}\n",
        expected_payload_sha256: "0000000000000000000000000000000000000000000000000000000000000000"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: { code: string; field: string; phase: string; anchor: string };
    };
    expect(stderr.ok).toBe(false);
    expect(stderr.error).toMatchObject({
      code: "hash_mismatch",
      field: "expected_payload_sha256",
      phase: "payload",
      anchor: "expected_payload_sha256"
    });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);
  });

  test("move --json expected_payload_sha256 catches a generic src_end selecting a shorter block", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-wrong-delimiter-"));
    const fullPayload = "function movedThing() {\n  if (ready) {\n    return 42;\n  }\n}\n";
    const shortPayload = "function movedThing() {\n  if (ready) {\n    return 42;\n  }\n";
    const fullPayloadSha256 = createHash("sha256").update(fullPayload).digest("hex");
    await writeFile(join(cwd, "source.ts"), `alpha\n${fullPayload}omega\nclass Target {\n}\n`);

    const loose = await moveBlock(
      {
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n"
      },
      { cwd, dryRun: true }
    );
    expect(loose.moves[0]).toMatchObject({
      payload_sha256: createHash("sha256").update(shortPayload).digest("hex"),
      payload_bytes: shortPayload.length
    });
    expect(loose.moves[0].payload_sha256).not.toBe(fullPayloadSha256);

    await expect(
      moveBlock(
        {
          src: "source.ts",
          src_start: "function movedThing() {\n",
          src_end: "}\n",
          target_before: "class Target {\n",
          expected_payload_sha256: fullPayloadSha256
        },
        { cwd }
      )
    ).rejects.toThrow("expected_payload_sha256 does not match selected source payload");
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(`alpha\n${fullPayload}omega\nclass Target {\n}\n`);
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
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "move",
        "--json",
        join(cwd, "move.json"),
        "--dry-run",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    const after = await readFile(join(cwd, "source.ts"), "utf8");
    expect(after).toBe(before);
  });

  test("relative move JSON input paths resolve from the shell working directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "blockpatch-relative-move-json-"));
    const cwd = join(parent, "repo");
    await mkdir(cwd);
    await writeFile(
      join(cwd, "source.ts"),
      "alpha\nfunction movedThing() {\n  return 42;\n}\nomega\nclass Target {\n}\n"
    );
    await writeFile(
      join(parent, "move.json"),
      JSON.stringify({
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        target_before: "class Target {\n"
      })
    );

    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "move.json", "--cwd", "repo"],
      cwd: parent,
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(
      "alpha\nomega\nclass Target {\nfunction movedThing() {\n  return 42;\n}\n}\n"
    );
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

  test("move flag mode treats --json-output as a payload value", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-json-output-payload-"));
    await writeFile(join(cwd, "file.txt"), "alpha\n");

    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "move",
        "--src",
        "/dev/null",
        "--dst",
        "file.txt",
        "--payload",
        "--json-output",
        "--target-before",
        "alpha\n",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await new Response(proc.stdout).text()).toBe("changed file.txt\n");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\n--json-output");
  });

  test("move flag mode does not format errors as JSON when a value is --json-output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-json-output-payload-error-"));
    await writeFile(join(cwd, "file.txt"), "alpha\n");

    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "move",
        "--src",
        "/dev/null",
        "--dst",
        "file.txt",
        "--payload",
        "--json-output",
        "--cwd",
        cwd
      ],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("blockpatch: move requires target_before or target_after");
    expect(stderr.trim().startsWith("{")).toBe(false);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\n");
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

  test("move flag mode accepts expected payload hash", async () => {
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
        "--expected-payload-sha256",
        "a990c0da5571138b0e2363af883a399fe214a137ad809c67f6530c618967a4e6",
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

  test("move flag mode rejects expected payload hash mismatch without modifying files", async () => {
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
        "--expected-payload-sha256",
        "0000000000000000000000000000000000000000000000000000000000000000",
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
      error: { code: string; field: string; phase: string; anchor: string };
    };
    expect(stderr).toMatchObject({
      ok: false,
      error: {
        code: "hash_mismatch",
        field: "expected_payload_sha256",
        phase: "payload",
        anchor: "expected_payload_sha256"
      }
    });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(before);
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
    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("diff --blockpatch a/source.ts b/source.ts");
    expect(stdout).toContain("blockpatch move id=move-1 role=source payload-sha256=");
    expect(stdout).toContain("diff --blockpatch a/target.ts b/target.ts");
    expect(stdout).toContain("blockpatch move id=move-1 role=target payload-sha256=");
    expect(stdout).not.toContain("diff --blockpatch a/source.ts b/target.ts");

    await writeFile(join(cwd, "generated.blockpatch"), stdout);
    await applyPatchFile("generated.blockpatch", { cwd });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe("before\nafter\n");
    expect(await readFile(join(cwd, "target.ts"), "utf8")).toBe(
      "class Target {\nfunction movedThing() {\n  return 42;\n}\n}\n"
    );

    const retry = await applyPatchFile("generated.blockpatch", { cwd });
    expect(retry.changed).toEqual([]);
    expect(retry.affected).toEqual(["source.ts", "target.ts"]);
    expect(retry.written).toBe(false);
    expect(retry.noop).toBe(true);
    expect(retry.status).toBe("already_applied");
    expect(retry.moves[0]).toMatchObject({
      src: "source.ts",
      dst: "target.ts",
      source_range: null,
      payload_sha256: "a990c0da5571138b0e2363af883a399fe214a137ad809c67f6530c618967a4e6"
    });

    const reversed = await applyPatchFile("generated.blockpatch", { cwd, reverse: true });
    expect(reversed.changed).toEqual(["target.ts", "source.ts"]);
    expect(reversed.affected).toEqual(["target.ts", "source.ts"]);
    expect(reversed.written).toBe(true);
    expect(reversed.status).toBe("applied");
    expect(reversed.moves[0]).toMatchObject({
      src: "target.ts",
      dst: "source.ts",
      payload_sha256: "a990c0da5571138b0e2363af883a399fe214a137ad809c67f6530c618967a4e6"
    });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe("before\nfunction movedThing() {\n  return 42;\n}\nafter\n");
    expect(await readFile(join(cwd, "target.ts"), "utf8")).toBe("class Target {\n}\n");

    const reverseRetry = await applyPatchFile("generated.blockpatch", { cwd, reverse: true });
    expect(reverseRetry.changed).toEqual([]);
    expect(reverseRetry.affected).toEqual(["target.ts", "source.ts"]);
    expect(reverseRetry.written).toBe(false);
    expect(reverseRetry.status).toBe("already_applied");
    expect(reverseRetry.moves[0]).toMatchObject({
      src: "target.ts",
      dst: "source.ts",
      source_range: null
    });
  });

  test("old single-section cross-file patch shape is rejected", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-old-cross-file-"));
    await writeFile(join(cwd, "source.ts"), "before\nfunction movedThing() {\n  return 42;\n}\nafter\n");
    await writeFile(join(cwd, "target.ts"), "class Target {\n}\n");
    await writeFile(
      join(cwd, "old.blockpatch"),
      "diff --blockpatch a/source.ts b/target.ts\n" +
        "blockpatch version 1\n" +
        "blockpatch move id=move-1 payload-sha256=a990c0da5571138b0e2363af883a399fe214a137ad809c67f6530c618967a4e6\n" +
        "--- a/source.ts\n" +
        "+++ b/target.ts\n" +
        "\n" +
        "@@ -1,5 +1,2 @@ blockpatch-source id=move-1\n" +
        " before\n" +
        "-function movedThing() {\n" +
        "-  return 42;\n" +
        "-}\n" +
        " after\n" +
        "\n" +
        "@@ -1,1 +1,4 @@ blockpatch-target id=move-1\n" +
        " class Target {\n" +
        "+function movedThing() {\n" +
        "+  return 42;\n" +
        "+}\n"
    );

    await expect(applyPatchFile("old.blockpatch", { cwd })).rejects.toThrow(
      "Cross-file moves must use separate source and target file sections"
    );
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(
      "before\nfunction movedThing() {\n  return 42;\n}\nafter\n"
    );
    expect(await readFile(join(cwd, "target.ts"), "utf8")).toBe("class Target {\n}\n");
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

  test("move --json-output includes invalid move argument fields", async () => {
    const cwd = await moveFixture();
    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "move", "--json", "-", "--json-output", "--cwd", cwd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    proc.stdin.write(
      JSON.stringify({
        src: "source.ts",
        src_start: 123,
        src_end: "}\n",
        target_before: "class Target {\n"
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(1);
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: { code: string; field: string };
    };
    expect(stderr.ok).toBe(false);
    expect(stderr.error).toMatchObject({
      code: "invalid_move_args",
      field: "src_start"
    });
  });

  test("move --json-output includes structured match details", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-json-error-details-"));
    const targetAnchor = "class Target {\n";
    const source = `function movedThing() {\n}\n${targetAnchor.repeat(12)}`;
    await writeFile(join(cwd, "source.ts"), source);
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
        target_before: targetAnchor
      })
    );
    proc.stdin.end();

    expect(await proc.exited).toBe(1);
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: {
        code: string;
        message: string;
        path: string;
        phase: string;
        anchor: string;
        matches: number;
        matches_truncated: boolean;
        ranges: Array<{ start: number; end: number }>;
        line_ranges: Array<{ start: number; end: number }>;
      };
    };
    const firstTargetStart = source.indexOf(targetAnchor);
    expect(stderr.ok).toBe(false);
    expect(stderr.error).toMatchObject({
      code: "target_ambiguous",
      path: "source.ts",
      phase: "target",
      anchor: "target_before",
      matches: 11,
      matches_truncated: true
    });
    expect(stderr.error.message).toContain("matched at least 11 locations");
    expect(stderr.error.ranges).toHaveLength(10);
    expect(stderr.error.ranges[0]).toEqual({
      start: firstTargetStart,
      end: firstTargetStart + targetAnchor.length
    });
    expect(stderr.error.ranges[9]).toEqual({
      start: firstTargetStart + 9 * targetAnchor.length,
      end: firstTargetStart + 10 * targetAnchor.length
    });
    expect(stderr.error.line_ranges).toHaveLength(10);
    expect(stderr.error.line_ranges[0]).toEqual({ start: 3, end: 3 });
    expect(stderr.error.line_ranges[9]).toEqual({ start: 12, end: 12 });
  });

  test("apply --json-output reports partial cross-file duplicate state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "blockpatch-partial-duplicate-json-"));
    const payload = "function movedThing() {\n  return 42;\n}\n";
    await writeFile(join(cwd, "source.ts"), `before\n${payload}after\n`);
    await writeFile(join(cwd, "target.ts"), "class Target {\n}\n");
    const planned = await moveBlock(
      {
        src: "source.ts",
        src_start: "function movedThing() {\n",
        src_end: "}\n",
        dst: "target.ts",
        target_before: "class Target {\n"
      },
      { cwd, diff: true }
    );
    await writeFile(join(cwd, "target.ts"), `class Target {\n${payload}}\n`);
    await writeFile(join(cwd, "generated.blockpatch"), planned.patch ?? "");

    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "apply", join(cwd, "generated.blockpatch"), "--json-output", "--cwd", cwd],
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(await proc.exited).toBe(1);
    const stderr = JSON.parse(await new Response(proc.stderr).text()) as {
      ok: boolean;
      error: {
        code: string;
        source_range: { start: number; end: number };
        target_range: { start: number; end: number };
        payload_sha256: string;
        suggested_action: string;
      };
    };
    expect(stderr).toMatchObject({
      ok: false,
      error: {
        code: "partial_applied_duplicate",
        source_range: { start: "before\n".length, end: "before\n".length + payload.length },
        target_range: { start: 0, end: `class Target {\n${payload}}\n`.length },
        payload_sha256: shaText(payload),
        suggested_action: "review_then_remove_source"
      }
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
