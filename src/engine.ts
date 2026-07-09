import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fail } from "./errors";
import { readFileChecked, readFileSnapshot } from "./files";
import { parseBlockPatch } from "./parser";
import { resolvePath, resolvePathAllowMissing, sameFileIdentity } from "./paths";
import {
  writeAtomically,
  type AtomicDeleteRequest,
  type AtomicPathExpectation,
  type AtomicWriteRequest
} from "./atomic-write";
import {
  memoryFileMap,
  planMovePatch,
  reverseMovePatch,
  type InMemoryFileState,
  type InMemoryPatchFile
} from "./planner";
import type { PatchMutation } from "./result";
import type { ApplyOptions, ApplyResult, BlockPatch, Endpoint } from "./types";
import type { FileSnapshot } from "./files";

export {
  buildMoveSelection,
  findTargetSelection,
  indexesOfLimited,
  type ByteRange,
  type MoveSelection,
  type TargetSelection
} from "./matcher";
export { moveResultDetails, unique } from "./result";
export { writeAtomic } from "./atomic-write";
export { commitMove, type CommitMoveArgs, type InMemoryPatchFile } from "./planner";

interface WorkspacePathState {
  path: string;
  snapshot?: FileSnapshot;
  missing?: boolean;
}

interface PatchWorkspace {
  files: Map<string, InMemoryFileState>;
  paths: Map<string, WorkspacePathState>;
}

export function validatePatchBytesInMemory(
  patchBytes: Buffer,
  files: readonly InMemoryPatchFile[],
  options: Pick<ApplyOptions, "reverse" | "stripComponents"> = {}
): ApplyResult {
  const patch = parseBlockPatch(patchBytes, { stripComponents: options.stripComponents });
  const effectivePatch = options.reverse === true ? reverseMovePatch(patch) : patch;
  return resultWithPatchHash(planMovePatch(effectivePatch, memoryFileMap(files)).result, patchBytes);
}

export async function applyPatchFile(
  patchPath: string,
  options: ApplyOptions = {}
): Promise<ApplyResult> {
  return runPatchFile(patchPath, options);
}

export async function applyPatchBytes(
  patchBytes: Buffer,
  options: ApplyOptions = {}
): Promise<ApplyResult> {
  return runPatchBytes(patchBytes, options);
}

async function runPatchFile(patchPath: string, options: ApplyOptions): Promise<ApplyResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const patchBytes = await readFileChecked(resolve(cwd, patchPath), "patch file");
  return runPatchBytes(patchBytes, { ...options, cwd });
}

async function runPatchBytes(patchBytes: Buffer, options: ApplyOptions): Promise<ApplyResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const patch = parseBlockPatch(patchBytes, { stripComponents: options.stripComponents });
  const result = await applyMovePatch(patch, cwd, options.dryRun ?? false, options.reverse ?? false);
  return resultWithPatchHash(result, patchBytes);
}

async function applyMovePatch(
  patch: BlockPatch,
  cwd: string,
  dryRun: boolean,
  reverse: boolean
): Promise<ApplyResult> {
  const effectivePatch = reverse ? reverseMovePatch(patch) : patch;
  const workspace = await readPatchWorkspace(effectivePatch, cwd);
  const plan = planMovePatch(effectivePatch, workspace.files);
  if (!dryRun) {
    await commitPatchMutations(plan.mutations, workspace.paths);
  }
  return resultWithWriteFlag(plan.result, dryRun);
}

async function readPatchWorkspace(patch: BlockPatch, cwd: string): Promise<PatchWorkspace> {
  const workspace: PatchWorkspace = {
    files: new Map(),
    paths: new Map()
  };

  if (isNullEndpoint(patch.src) || isNullEndpoint(patch.dst)) {
    if (isNullEndpoint(patch.src) && isFileEndpoint(patch.dst) && !patch.hasSourceHunk) {
      const dstLabel = patch.dst.path;
      const resolved = resolvePathAllowMissing(cwd, dstLabel, "destination path");
      if (resolved.exists) {
        rememberFile(workspace, dstLabel, resolved.path, await readFileSnapshot(resolved.path, "destination file"));
      } else {
        rememberMissingPath(workspace, dstLabel, resolved.path);
      }
      return workspace;
    }
    if (isNullEndpoint(patch.dst) && isFileEndpoint(patch.src) && patch.hasSourceHunk) {
      const srcLabel = patch.src.path;
      const resolved = resolvePathAllowMissing(cwd, srcLabel, "source path");
      if (resolved.exists) {
        rememberFile(workspace, srcLabel, resolved.path, await readFileSnapshot(resolved.path, "source file"));
      } else {
        rememberMissingPath(workspace, srcLabel, resolved.path);
      }
      return workspace;
    }
    fail("parse_error", "Invalid /dev/null endpoint move shape");
  }

  const srcLabel = fileEndpointPath(patch.src, "source path");
  const dstLabel = fileEndpointPath(patch.dst, "destination path");

  if (!patch.hasSourceHunk) {
    const dstPath = resolvePath(cwd, dstLabel, "destination path");
    rememberFile(workspace, dstLabel, dstPath, await readFileSnapshot(dstPath, "destination file"));
    return workspace;
  }

  if (patch.target === null) {
    const srcPath = resolvePath(cwd, srcLabel, "source path");
    rememberFile(workspace, srcLabel, srcPath, await readFileSnapshot(srcPath, "source file"));
    return workspace;
  }

  const srcPath = resolvePath(cwd, srcLabel, "source path");
  const dstPath = resolvePath(cwd, dstLabel, "destination path");
  const sameFile = await sameFileIdentity(srcPath, dstPath);
  const srcSnapshot = await readFileSnapshot(srcPath, "source file");
  const dstSnapshot = sameFile ? srcSnapshot : await readFileSnapshot(dstPath, "destination file");
  const identity = sameFile ? "paired-file" : undefined;
  rememberFile(workspace, srcLabel, srcPath, srcSnapshot, identity);
  rememberFile(workspace, dstLabel, dstPath, dstSnapshot, identity);
  return workspace;
}

function rememberMissingPath(workspace: PatchWorkspace, label: string, path: string): void {
  workspace.paths.set(label, { path, missing: true });
}

function rememberFile(
  workspace: PatchWorkspace,
  label: string,
  path: string,
  snapshot: FileSnapshot,
  identity = path
): void {
  workspace.paths.set(label, { path, snapshot });
  workspace.files.set(label, { bytes: snapshot.bytes, identity });
}

async function commitPatchMutations(
  mutations: readonly PatchMutation[],
  paths: Map<string, WorkspacePathState>
): Promise<void> {
  const writes: AtomicWriteRequest[] = [];
  const deletes: AtomicDeleteRequest[] = [];

  for (const mutation of mutations) {
    const pathState = mutationPath(paths, mutation.label);
    if (mutation.kind === "write") {
      writes.push({
        path: pathState.path,
        bytes: mutation.bytes,
        create: mutation.create,
        label: mutation.label,
        expected: writeExpectation(mutation, pathState)
      });
    } else {
      deletes.push({
        path: pathState.path,
        label: mutation.label,
        expected: fileExpectation(mutation.label, pathState)
      });
    }
  }

  await writeAtomically(writes, deletes);
}

function writeExpectation(
  mutation: Extract<PatchMutation, { kind: "write" }>,
  state: WorkspacePathState
): AtomicPathExpectation {
  if (state.snapshot !== undefined) {
    return { kind: "file", label: mutation.label, snapshot: state.snapshot };
  }
  if (state.missing === true && mutation.create === true) {
    return { kind: "missing", label: mutation.label, bytesIfExists: mutation.bytes };
  }
  fail("parse_error", `No original state for planned write: ${mutation.label}`, {
    path: mutation.label,
    phase: "path"
  });
}

function fileExpectation(label: string, state: WorkspacePathState): AtomicPathExpectation {
  if (state.snapshot !== undefined) {
    return { kind: "file", label, snapshot: state.snapshot };
  }
  fail("parse_error", `No original file state for planned mutation: ${label}`, { path: label, phase: "path" });
}

function mutationPath(paths: Map<string, WorkspacePathState>, label: string): WorkspacePathState {
  const state = paths.get(label);
  if (state === undefined) {
    fail("parse_error", `No resolved path for planned mutation: ${label}`, { path: label, phase: "path" });
  }
  return state;
}

function resultWithWriteFlag(result: ApplyResult, dryRun: boolean): ApplyResult {
  return {
    ...result,
    written: result.status === "applied" && !dryRun && result.changed.length > 0
  };
}

function resultWithPatchHash(result: ApplyResult, patchBytes: Buffer): ApplyResult {
  return {
    ...result,
    patch_sha256: createHash("sha256").update(patchBytes).digest("hex")
  };
}

function isFileEndpoint(endpoint: Endpoint): endpoint is Extract<Endpoint, { kind: "file" }> {
  return endpoint.kind === "file";
}

function isNullEndpoint(endpoint: Endpoint): endpoint is Extract<Endpoint, { kind: "null" }> {
  return endpoint.kind === "null";
}

function fileEndpointPath(endpoint: Endpoint, label: string): string {
  if (endpoint.kind === "file") {
    return endpoint.path;
  }
  fail("parse_error", `${label} requires a file endpoint`);
}
