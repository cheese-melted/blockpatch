import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyPatchBytes } from "../../src/engine";
import { BlockPatchError } from "../../src/errors";
import { moveBlock } from "../../src/move";
import { parseBlockPatch } from "../../src/parser";
import { resolvePath, resolvePathAllowMissing } from "../../src/paths";
import type { ApplyResult, BlockPatch, MoveBlockArgs, MoveBlockResult } from "../../src/types";

const moveFields = {
  src: Type.String({ description: "Source path relative to Pi's working directory, or /dev/null" }),
  src_start: Type.Optional(Type.String({ description: "Exact inclusive source-start delimiter" })),
  src_end: Type.Optional(Type.String({ description: "Exact inclusive source-end delimiter" })),
  dst: Type.Optional(Type.String({ description: "Destination path; defaults to src" })),
  payload: Type.Optional(Type.String({ description: "Literal payload when src is /dev/null" })),
  target_before: Type.Optional(Type.String({ description: "Exact destination context before the insertion" })),
  target_after: Type.Optional(Type.String({ description: "Exact destination context after the insertion" })),
  insert_before: Type.Optional(Type.String({ description: "Insert immediately before this exact destination context" })),
  insert_after: Type.Optional(Type.String({ description: "Insert immediately after this exact destination context" })),
  expected_payload_sha256: Type.Optional(Type.String({ description: "Expected lowercase SHA-256 of selected payload" })),
  mode: Type.Optional(Type.Union([Type.Literal("create_file"), Type.Literal("remove_file")]))
};

const parameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("plan"),
      ...moveFields
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      action: Type.Literal("apply"),
      patch: Type.String({ description: "Reviewed .blockpatch artifact path relative to Pi's working directory" }),
      dry_run: Type.Optional(Type.Boolean({ description: "Validate without writing files" })),
      reverse: Type.Optional(Type.Boolean({ description: "Apply the reviewed patch in reverse" }))
    },
    { additionalProperties: false }
  )
]);

type PlanParams = MoveBlockArgs & { action: "plan" };
type ApplyParams = { action: "apply"; patch: string; dry_run?: boolean; reverse?: boolean };
type BlockpatchParams = PlanParams | ApplyParams;

interface BlockpatchDetails {
  action: "plan" | "apply";
  artifact?: string;
  patch_sha256?: string;
  result?: MoveBlockResult | ApplyResult;
  error?: ReturnType<typeof structuredError>;
}

export default function blockpatchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "blockpatch",
    label: "blockpatch",
    description:
      "Plan or apply one exact, hash-verified block move. Plan writes a reviewable .blockpatch artifact and returns its diff; apply consumes that reviewed artifact.",
    promptSnippet: "Plan and apply exact, hash-verified block moves with reviewable artifacts",
    promptGuidelines: [
      "Use blockpatch plan for byte-exact relocation of existing code or text; use edit/write when the payload must be transformed or regenerated.",
      "Review the patch returned by blockpatch plan before calling blockpatch apply with its artifact path.",
      "Do not recreate or hand-edit a planned .blockpatch artifact; apply the artifact itself so retries remain hash-verified."
    ],
    parameters,

    async execute(_toolCallId, params: BlockpatchParams, signal, _onUpdate, ctx) {
      try {
        throwIfAborted(signal);
        if (params.action === "plan") {
          const result = await planMove(params, ctx.cwd, signal);
          return {
            content: [
              {
                type: "text" as const,
                text: `${planSummary(result.result, result.artifact, result.patchSha256)}\n\n${result.patch}`
              }
            ],
            details: {
              action: "plan" as const,
              artifact: result.artifact,
              patch_sha256: result.patchSha256,
              result: result.result
            } satisfies BlockpatchDetails
          };
        }

        const result = await applyArtifact(params, ctx.cwd, signal);
        return {
          content: [{ type: "text" as const, text: applySummary(result, params.patch) }],
          details: {
            action: "apply" as const,
            artifact: params.patch,
            patch_sha256: result.patch_sha256,
            result
          } satisfies BlockpatchDetails
        };
      } catch (error) {
        const structured = structuredError(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          details: {
            action: params.action,
            error: structured
          } satisfies BlockpatchDetails,
          isError: true
        };
      }
    }
  });
}

async function planMove(
  params: PlanParams,
  cwd: string,
  signal: AbortSignal | undefined
): Promise<{ result: MoveBlockResult; patch: string; artifact: string; patchSha256: string }> {
  const { action: _action, ...move } = params;
  const result = await moveBlock(move, { cwd, dryRun: true, diff: true });
  throwIfAborted(signal);
  if (result.patch === undefined) {
    throw new Error("blockpatch plan did not produce a patch");
  }

  const patchBytes = Buffer.from(result.patch, "utf8");
  const patchSha256 = createHash("sha256").update(patchBytes).digest("hex");
  const artifactDir = await ensureArtifactDirectory(cwd);
  const artifact = `.blockpatch-artifacts/move-${patchSha256}.blockpatch`;
  const artifactPath = resolve(artifactDir, `move-${patchSha256}.blockpatch`);
  await withFileMutationQueue(artifactPath, async () => {
    throwIfAborted(signal);
    try {
      await writeFile(artifactPath, patchBytes, { flag: "wx", mode: 0o644 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(artifactPath);
      if (!existing.equals(patchBytes)) {
        throw new Error(`Existing artifact does not match planned patch: ${artifact}`);
      }
    }
    throwIfAborted(signal);
  });

  return { result, patch: result.patch, artifact, patchSha256 };
}

async function applyArtifact(
  params: ApplyParams,
  cwd: string,
  signal: AbortSignal | undefined
): Promise<ApplyResult> {
  const patchPath = resolvePath(cwd, params.patch, "patch artifact");
  const artifactDir = resolve(cwd, ".blockpatch-artifacts");
  const artifactName = basename(patchPath);
  const artifactMatch = /^move-([a-f0-9]{64})\.blockpatch$/.exec(artifactName);
  if (dirname(patchPath) !== artifactDir || artifactMatch === null) {
    throw new BlockPatchError(
      "invalid_path",
      "Pi apply requires a content-addressed artifact path of the form .blockpatch-artifacts/move-<sha256>.blockpatch",
      { path: params.patch }
    );
  }

  const patchBytes = await readFile(patchPath);
  const expectedPatchSha256 = artifactMatch[1];
  const actualPatchSha256 = createHash("sha256").update(patchBytes).digest("hex");
  if (actualPatchSha256 !== expectedPatchSha256) {
    throw new BlockPatchError(
      "hash_mismatch",
      "Patch artifact bytes do not match the sha256 encoded in its filename",
      {
        path: params.patch,
        expected_sha256: expectedPatchSha256,
        actual_sha256: actualPatchSha256
      }
    );
  }

  const patch = parseBlockPatch(patchBytes);
  const mutationPaths = resolveMutationPaths(patch, cwd);

  return withMutationQueues(mutationPaths, async () => {
    throwIfAborted(signal);
    const result = await applyPatchBytes(patchBytes, {
      cwd,
      dryRun: params.dry_run ?? false,
      reverse: params.reverse ?? false
    });
    return result;
  });
}

function resolveMutationPaths(patch: BlockPatch, cwd: string): string[] {
  const paths = [patch.src, patch.dst]
    .filter((endpoint): endpoint is Extract<(typeof patch)["src"], { kind: "file" }> => endpoint.kind === "file")
    .map((endpoint) => resolvePathAllowMissing(cwd, endpoint.path, "operation path").path);
  return [...new Set(paths)].sort();
}

async function withMutationQueues<T>(paths: string[], operation: () => Promise<T>, index = 0): Promise<T> {
  const path = paths[index];
  if (path === undefined) return operation();
  return withFileMutationQueue(path, () => withMutationQueues(paths, operation, index + 1));
}

async function ensureArtifactDirectory(cwd: string): Promise<string> {
  const path = resolve(cwd, ".blockpatch-artifacts");
  try {
    await mkdir(path, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(".blockpatch-artifacts must be a real directory, not a symlink");
  }
  return path;
}

function planSummary(result: MoveBlockResult, artifact: string, patchSha256: string): string {
  const move = result.moves[0];
  return [
    `planned: ${artifact}`,
    `patch_sha256: ${patchSha256}`,
    move ? `payload: ${move.payload_lines} lines, ${move.payload_bytes} bytes, sha256=${move.payload_sha256}` : undefined,
    `changed if applied: ${result.changed.join(", ") || "none"}`
  ].filter(Boolean).join("\n");
}

function applySummary(result: ApplyResult, artifact: string): string {
  return [
    `${result.status}: ${artifact}`,
    `written: ${result.written}`,
    `changed: ${result.changed.join(", ") || "none"}`,
    result.patch_sha256 ? `patch_sha256: ${result.patch_sha256}` : undefined
  ].filter(Boolean).join("\n");
}

function structuredError(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof BlockPatchError) {
    return { code: error.code, message: error.message, details: error.details as Record<string, unknown> };
  }
  return {
    code: "unexpected_error",
    message: error instanceof Error ? error.message : String(error)
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}
