import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import piBlockpatch from "../integrations/pi/index";

interface CapturedTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string }
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

function captureTool(): CapturedTool {
  let captured: CapturedTool | undefined;
  piBlockpatch({
    registerTool(tool: CapturedTool) {
      captured = tool;
    }
  } as never);
  if (captured === undefined) throw new Error("Pi extension did not register its tool");
  return captured;
}

async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "blockpatch-pi-"));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "source.ts"), "keep\nmove one\nmove two\nend\n");
  await writeFile(join(cwd, "src", "target.ts"), "target\n");
  return cwd;
}

describe("Pi extension", () => {
  test("plans, persists, applies, and retries a reviewed move artifact", async () => {
    const cwd = await fixture();
    const tool = captureTool();
    const beforeSource = await readFile(join(cwd, "src", "source.ts"), "utf8");
    const beforeTarget = await readFile(join(cwd, "src", "target.ts"), "utf8");

    const planned = await tool.execute(
      "call-1",
      {
        action: "plan",
        src: "src/source.ts",
        src_start: "move one\n",
        src_end: "move two\n",
        dst: "src/target.ts",
        insert_after: "target\n"
      },
      undefined,
      undefined,
      { cwd }
    );

    expect(planned.isError).not.toBe(true);
    expect(await readFile(join(cwd, "src", "source.ts"), "utf8")).toBe(beforeSource);
    expect(await readFile(join(cwd, "src", "target.ts"), "utf8")).toBe(beforeTarget);
    const artifact = planned.details?.artifact;
    expect(typeof artifact).toBe("string");
    expect(artifact).toMatch(/^\.blockpatch-artifacts\/move-[a-f0-9]{64}\.blockpatch$/);
    expect(await readFile(join(cwd, artifact as string), "utf8")).toContain("payload-sha256=");
    expect(planned.content[0]?.text).toContain("diff --blockpatch");

    const applied = await tool.execute(
      "call-2",
      { action: "apply", patch: artifact },
      undefined,
      undefined,
      { cwd }
    );
    expect(applied.isError).not.toBe(true);
    expect(applied.content[0]?.text).toContain("applied:");
    expect(await readFile(join(cwd, "src", "source.ts"), "utf8")).toBe("keep\nend\n");
    expect(await readFile(join(cwd, "src", "target.ts"), "utf8")).toBe("target\nmove one\nmove two\n");

    const retry = await tool.execute(
      "call-3",
      { action: "apply", patch: artifact },
      undefined,
      undefined,
      { cwd }
    );
    expect(retry.isError).not.toBe(true);
    expect(retry.content[0]?.text).toContain("already_applied:");
  });

  test("returns structured blockpatch errors", async () => {
    const cwd = await fixture();
    const tool = captureTool();
    const result = await tool.execute(
      "call-error",
      {
        action: "plan",
        src: "src/source.ts",
        src_start: "missing\n",
        src_end: "missing\n",
        dst: "src/target.ts",
        insert_after: "target\n"
      },
      undefined,
      undefined,
      { cwd }
    );

    expect(result.isError).toBe(true);
    expect(result.details?.error).toMatchObject({ code: "source_not_found" });
  });

  test("rejects a reviewed artifact whose bytes changed after planning", async () => {
    const cwd = await fixture();
    const tool = captureTool();
    const planned = await tool.execute(
      "call-plan-tamper",
      {
        action: "plan",
        src: "src/source.ts",
        src_start: "move one\n",
        src_end: "move two\n",
        dst: "src/target.ts",
        insert_after: "target\n"
      },
      undefined,
      undefined,
      { cwd }
    );
    const artifact = planned.details?.artifact as string;
    await writeFile(join(cwd, artifact), `${await readFile(join(cwd, artifact), "utf8")}\n`);

    const applied = await tool.execute(
      "call-apply-tamper",
      { action: "apply", patch: artifact },
      undefined,
      undefined,
      { cwd }
    );

    expect(applied.isError).toBe(true);
    expect(applied.details?.error).toMatchObject({
      code: "hash_mismatch",
      details: {
        path: artifact,
        expected_sha256: artifact.match(/[a-f0-9]{64}/)?.[0]
      }
    });
    expect(await readFile(join(cwd, "src", "source.ts"), "utf8")).toBe("keep\nmove one\nmove two\nend\n");
    expect(await readFile(join(cwd, "src", "target.ts"), "utf8")).toBe("target\n");
  });

  test("rejects apply paths that are not canonical content-addressed artifacts", async () => {
    const cwd = await fixture();
    const tool = captureTool();
    await writeFile(join(cwd, "reviewed.blockpatch"), "not a patch");

    const applied = await tool.execute(
      "call-apply-non-artifact",
      { action: "apply", patch: "reviewed.blockpatch" },
      undefined,
      undefined,
      { cwd }
    );

    expect(applied.isError).toBe(true);
    expect(applied.details?.error).toMatchObject({ code: "invalid_path" });
  });
});
