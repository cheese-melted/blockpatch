import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import {
  BlockPatchError,
  boundedLineRanges,
  boundedMatchLineRanges,
  boundedMatchRanges,
  boundedRanges,
  fail,
  matchCountDetails,
  matchedLocations
} from "./errors";
import { assertRegularFile, failFileSystem, readFileChecked, readFileSnapshot } from "./files";
import { devNull, parseBlockPatch } from "./parser";
import { resolvePath, resolvePathAllowMissing, sameFileIdentity } from "./paths";
import type { ApplyOptions, ApplyResult, BlockPatch, MoveResultDetails } from "./types";
import type { FileSnapshot, FileStatSnapshot } from "./files";

export interface ByteRange {
  start: number;
  end: number;
}

export interface LimitedMatches {
  matches: number[];
  truncated: boolean;
}

export interface TargetSelection {
  range: ByteRange;
  insertIndex: number;
}

export interface MoveSelection {
  source: ByteRange;
  target: TargetSelection;
  payload: Buffer;
}

interface PendingMovePlan {
  status: "pending";
  selection: MoveSelection;
}

interface AlreadyAppliedMovePlan {
  status: "already_applied";
  details: MoveResultDetails;
}

type MovePlan = PendingMovePlan | AlreadyAppliedMovePlan;

export interface CommitMoveArgs {
  srcPath: string;
  dstPath: string;
  sameFile: boolean;
  dryRun: boolean;
  srcOriginal: Buffer;
  dstOriginal: Buffer;
  srcSnapshot?: FileSnapshot;
  dstSnapshot?: FileSnapshot;
  selection: MoveSelection;
  srcLabel: string;
  dstLabel: string;
}

export type AtomicPathExpectation =
  | { kind: "file"; label: string; snapshot: FileSnapshot }
  | { kind: "missing"; label: string; bytesIfExists?: Buffer };

export interface AtomicWriteOptions {
  create?: boolean;
  expected?: AtomicPathExpectation;
  label?: string;
}

interface AtomicWriteRequest {
  path: string;
  bytes: Buffer;
  create?: boolean;
  expected?: AtomicPathExpectation;
  label?: string;
}

interface AtomicDeleteRequest {
  path: string;
  expected?: AtomicPathExpectation;
  label?: string;
}

interface CreatedDirectoryChain {
  first: string;
  target: string;
}

interface StagedAtomicWrite {
  path: string;
  temp: string;
  request: AtomicWriteRequest;
  createdDirectory: CreatedDirectoryChain | undefined;
}

export interface InMemoryPatchFile {
  path: string;
  bytes: Buffer;
  identity?: string;
}

interface InMemoryFileState {
  bytes: Buffer;
  identity: string;
}

interface WorkspacePathState {
  path: string;
  snapshot?: FileSnapshot;
  missing?: boolean;
}

interface PatchWorkspace {
  files: Map<string, InMemoryFileState>;
  paths: Map<string, WorkspacePathState>;
}

type PatchMutation =
  | { kind: "write"; label: string; bytes: Buffer; create?: boolean }
  | { kind: "delete"; label: string };

interface LimitedRanges {
  ranges: ByteRange[];
  truncated: boolean;
}

interface PlannedPatch {
  result: ApplyResult;
  mutations: PatchMutation[];
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

  if (patch.src === null || patch.dst === null) {
    if (patch.src === null && patch.dst !== null && !patch.hasSourceHunk) {
      const resolved = resolvePathAllowMissing(cwd, patch.dst, "destination path");
      if (resolved.exists) {
        rememberFile(workspace, patch.dst, resolved.path, await readFileSnapshot(resolved.path, "destination file"));
      } else {
        rememberMissingPath(workspace, patch.dst, resolved.path);
      }
      return workspace;
    }
    if (patch.dst === null && patch.src !== null && patch.hasSourceHunk) {
      const resolved = resolvePathAllowMissing(cwd, patch.src, "source path");
      if (resolved.exists) {
        rememberFile(workspace, patch.src, resolved.path, await readFileSnapshot(resolved.path, "source file"));
      } else {
        rememberMissingPath(workspace, patch.src, resolved.path);
      }
      return workspace;
    }
    fail("parse_error", "Invalid /dev/null endpoint move shape");
  }

  if (!patch.hasSourceHunk) {
    const dstPath = resolvePath(cwd, patch.dst, "destination path");
    rememberFile(workspace, patch.dst, dstPath, await readFileSnapshot(dstPath, "destination file"));
    return workspace;
  }

  if (patch.target === null) {
    const srcPath = resolvePath(cwd, patch.src, "source path");
    rememberFile(workspace, patch.src, srcPath, await readFileSnapshot(srcPath, "source file"));
    return workspace;
  }

  const srcPath = resolvePath(cwd, patch.src, "source path");
  const dstPath = resolvePath(cwd, patch.dst, "destination path");
  const sameFile = await sameFileIdentity(srcPath, dstPath);
  const srcSnapshot = await readFileSnapshot(srcPath, "source file");
  const dstSnapshot = sameFile ? srcSnapshot : await readFileSnapshot(dstPath, "destination file");
  const identity = sameFile ? "paired-file" : undefined;
  rememberFile(workspace, patch.src, srcPath, srcSnapshot, identity);
  rememberFile(workspace, patch.dst, dstPath, dstSnapshot, identity);
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

function writeExpectation(mutation: Extract<PatchMutation, { kind: "write" }>, state: WorkspacePathState): AtomicPathExpectation {
  if (state.snapshot !== undefined) {
    return { kind: "file", label: mutation.label, snapshot: state.snapshot };
  }
  if (state.missing === true && mutation.create === true) {
    return { kind: "missing", label: mutation.label, bytesIfExists: mutation.bytes };
  }
  fail("parse_error", `No original state for planned write: ${mutation.label}`, { path: mutation.label, phase: "path" });
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

function planMovePatch(effectivePatch: BlockPatch, files: Map<string, InMemoryFileState>): PlannedPatch {
  if (effectivePatch.src === null || effectivePatch.dst === null) {
    if (effectivePatch.src === null && effectivePatch.dst !== null && !effectivePatch.hasSourceHunk) {
      return planPathCreationMove(effectivePatch, effectivePatch.dst, files);
    }
    if (effectivePatch.dst === null && effectivePatch.src !== null && effectivePatch.hasSourceHunk) {
      return planPathDeletionMove(effectivePatch, effectivePatch.src, files);
    }
    fail("parse_error", "Invalid /dev/null endpoint move shape");
  }

  if (!effectivePatch.hasSourceHunk) {
    return planInFileInsertionMove(effectivePatch, effectivePatch.src, effectivePatch.dst, files);
  }

  if (effectivePatch.target === null) {
    return planInFileDeletionMove(effectivePatch, effectivePatch.src, effectivePatch.dst, files);
  }

  return planPairedMove(effectivePatch, files);
}

function planPairedMove(patch: BlockPatch, files: Map<string, InMemoryFileState>): PlannedPatch {
  if (patch.src === null || patch.dst === null) {
    fail("parse_error", "Paired move requires source and destination paths");
  }
  const srcLabel = patch.src;
  const dstLabel = patch.dst;
  const srcFile = readMemoryFile(files, srcLabel, "source file");
  const sameFile = sameMemoryFile(files, srcLabel, dstLabel);
  const dstFile = sameFile ? srcFile : readMemoryFile(files, dstLabel, "destination file");
  const plan = selectMovePlan(srcFile, dstFile, patch, sameFile);

  if (plan.status === "already_applied") {
    return {
      result: {
        changed: [],
        affected: unique([srcLabel, dstLabel]),
        written: false,
        noop: true,
        status: "already_applied",
        moves: [plan.details]
      },
      mutations: []
    };
  }

  const selection = plan.selection;
  const next = sameFile ? applyMove(srcFile, selection) : applyCrossFileMove(srcFile, dstFile, selection);
  const changed = changedMoveLabels(srcLabel, dstLabel, sameFile, srcFile, dstFile, next);

  return {
    result: {
      changed,
      affected: unique([srcLabel, dstLabel]),
      written: false,
      noop: changed.length === 0,
      status: changed.length === 0 ? "noop" : "applied",
      moves: [
        moveResultDetails({
          id: patch.id,
          src: srcLabel,
          dst: dstLabel,
          payloadSha256: patch.payloadSha256,
          selection,
          srcFile,
          dstFile
        })
      ]
    },
    mutations: moveMutations(srcLabel, dstLabel, sameFile, srcFile, dstFile, next)
  };
}

function reverseMovePatch(patch: BlockPatch): BlockPatch {
  const reversedTarget = patch.hasSourceHunk
    ? {
        before: patch.sourceBefore,
        after: patch.sourceAfter
      }
    : null;

  return {
    ...patch,
    src: patch.dst,
    dst: patch.src,
    hasSourceHunk: patch.target !== null,
    sourceBefore: patch.target?.before ?? Buffer.alloc(0),
    sourcePayload: patch.sourcePayload,
    sourceAfter: patch.target?.after ?? Buffer.alloc(0),
    target: reversedTarget
  };
}

function planInFileInsertionMove(
  patch: BlockPatch,
  srcLabel: string,
  dstLabel: string,
  files: Map<string, InMemoryFileState>
): PlannedPatch {
  const target = requireTarget(patch);
  const original = readMemoryFile(files, dstLabel, "destination file");
  const alreadyApplied = findAlreadyAppliedTargetSelection(original, patch, dstLabel);
  if (alreadyApplied !== undefined) {
    return {
      result: oneSidedResult({
        patch,
        src: srcLabel,
        dst: dstLabel,
        changed: [],
        status: "already_applied",
        sourceRange: null,
        targetRange: alreadyApplied.range,
        insertIndex: alreadyApplied.insertIndex,
        targetFile: original
      }),
      mutations: []
    };
  }

  const selection = findTargetSelection(original, target.before, target.after, dstLabel, {
    phase: "target",
    anchor: "blockpatch-target"
  });
  const next = Buffer.concat([
    original.subarray(0, selection.insertIndex),
    patch.sourcePayload,
    original.subarray(selection.insertIndex)
  ]);
  const changed = next.equals(original) ? [] : unique([srcLabel, dstLabel]);

  return {
    result: oneSidedResult({
      patch,
      src: srcLabel,
      dst: dstLabel,
      changed,
      status: changed.length === 0 ? "noop" : "applied",
      sourceRange: null,
      targetRange: selection.range,
      insertIndex: selection.insertIndex,
      targetFile: original
    }),
    mutations: changed.length === 0 ? [] : [{ kind: "write", label: dstLabel, bytes: next }]
  };
}

function planInFileDeletionMove(
  patch: BlockPatch,
  srcLabel: string,
  dstLabel: string,
  files: Map<string, InMemoryFileState>
): PlannedPatch {
  const original = readMemoryFile(files, srcLabel, "source file");
  const source = findDeletionSourceRange(original, patch, srcLabel);

  if (source === undefined) {
    return {
      result: oneSidedResult({
        patch,
        src: srcLabel,
        dst: dstLabel,
        changed: [],
        status: "already_applied",
        sourceRange: null,
        targetRange: null,
        insertIndex: null,
        sourceFile: original
      }),
      mutations: []
    };
  }

  const next = Buffer.concat([original.subarray(0, source.start), original.subarray(source.end)]);
  const changed = next.equals(original) ? [] : unique([srcLabel, dstLabel]);
  return {
    result: oneSidedResult({
      patch,
      src: srcLabel,
      dst: dstLabel,
      changed,
      status: changed.length === 0 ? "noop" : "applied",
      sourceRange: source,
      targetRange: null,
      insertIndex: null,
      sourceFile: original
    }),
    mutations: changed.length === 0 ? [] : [{ kind: "write", label: srcLabel, bytes: next }]
  };
}

function oneSidedResult(args: {
  patch: BlockPatch;
  src: string;
  dst: string;
  changed: string[];
  status: "applied" | "noop" | "already_applied";
  sourceRange: ByteRange | null;
  targetRange: ByteRange | null;
  insertIndex: number | null;
  sourceFile?: Buffer;
  targetFile?: Buffer;
}): ApplyResult {
  return {
    changed: args.changed,
    affected: unique([args.src, args.dst]),
    written: false,
    noop: args.status !== "applied" || args.changed.length === 0,
    status: args.status,
    moves: [
      {
        id: args.patch.id,
        src: args.src,
        dst: args.dst,
        payload_sha256: args.patch.payloadSha256,
        payload_bytes: args.patch.sourcePayload.length,
        payload_lines: countLines(args.patch.sourcePayload),
        payload_hash_verified: true,
        source_range: args.sourceRange,
        source_line_range: byteRangeToLineRange(args.sourceFile, args.sourceRange),
        target_range: args.targetRange,
        target_line_range: byteRangeToLineRange(args.targetFile, args.targetRange),
        insert_index: args.insertIndex,
        insert_line: lineNumberOrNull(args.targetFile, args.insertIndex)
      }
    ]
  };
}

function planPathCreationMove(
  patch: BlockPatch,
  dstLabel: string,
  files: Map<string, InMemoryFileState>
): PlannedPatch {
  const fullTarget = fullTargetBytes(patch);
  const original = files.get(dstLabel)?.bytes;

  if (original !== undefined) {
    if (original.equals(fullTarget)) {
      return {
        result: nullSourceResult(patch, dstLabel, "already_applied", { start: 0, end: original.length }, 0, original),
        mutations: []
      };
    }
    fail("destination_exists", `Destination path for file creation already exists with different bytes: ${dstLabel}`, {
      path: dstLabel,
      phase: "target",
      anchor: "blockpatch-target"
    });
  }

  return {
    result: nullSourceResult(patch, dstLabel, "applied", { start: 0, end: 0 }, 0, Buffer.alloc(0)),
    mutations: [{ kind: "write", label: dstLabel, bytes: fullTarget, create: true }]
  };
}

function planPathDeletionMove(
  patch: BlockPatch,
  srcLabel: string,
  files: Map<string, InMemoryFileState>
): PlannedPatch {
  const original = files.get(srcLabel)?.bytes;
  if (original === undefined) {
    return {
      result: nullTargetResult(patch, srcLabel, "already_applied", null),
      mutations: []
    };
  }

  const fullSource = Buffer.concat([patch.sourceBefore, patch.sourcePayload, patch.sourceAfter]);
  if (!original.equals(fullSource)) {
    fail("source_not_found", `Whole-file source payload was not found in ${srcLabel}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      matches: 0
    });
  }

  return {
    result: nullTargetResult(patch, srcLabel, "applied", {
      start: patch.sourceBefore.length,
      end: patch.sourceBefore.length + patch.sourcePayload.length
    }, original),
    mutations: [{ kind: "delete", label: srcLabel }]
  };
}

function fullTargetBytes(patch: BlockPatch): Buffer {
  const target = requireTarget(patch);
  return Buffer.concat([target.before, patch.sourcePayload, target.after]);
}

function requireTarget(patch: BlockPatch): NonNullable<BlockPatch["target"]> {
  if (patch.target === null) {
    fail("parse_error", "Patch shape requires a blockpatch-target hunk");
  }
  return patch.target;
}

function findDeletionSourceRange(file: Buffer, patch: BlockPatch, srcLabel: string): ByteRange | undefined {
  const fullSource = Buffer.concat([patch.sourceBefore, patch.sourcePayload, patch.sourceAfter]);
  const fullMatchResult = indexesOfLimited(file, fullSource);
  const fullMatches = fullMatchResult.matches;

  if (fullMatches.length === 1 && !fullMatchResult.truncated) {
    const start = fullMatches[0] + patch.sourceBefore.length;
    return { start, end: start + patch.sourcePayload.length };
  }

  if (fullMatches.length > 1 || fullMatchResult.truncated) {
    fail("source_ambiguous", `Source block is ambiguous in ${srcLabel}; ${matchedLocations(fullMatches.length, fullMatchResult.truncated)}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      ...matchCountDetails(fullMatches.length, fullMatchResult.truncated),
      ranges: boundedMatchRanges(fullMatches, fullSource.length),
      line_ranges: boundedMatchLineRanges(file, fullMatches, fullSource.length)
    });
  }

  return deletionAlreadyAppliedOrFail(file, patch, srcLabel);
}

function deletionAlreadyAppliedOrFail(
  file: Buffer,
  patch: BlockPatch,
  srcLabel: string
): ByteRange | undefined {
  const anchorless = patch.sourceBefore.length === 0 && patch.sourceAfter.length === 0;
  if (anchorless) {
    return undefined;
  }

  const adjacent = Buffer.concat([patch.sourceBefore, patch.sourceAfter]);
  const adjacentMatchResult = indexesOfLimitedWhere(file, adjacent, (start) =>
    isDeletionAlreadyAppliedMatch(file, patch, start)
  );
  const adjacentMatches = adjacentMatchResult.matches;
  if (adjacentMatches.length === 1 && !adjacentMatchResult.truncated) {
    return undefined;
  }
  if (adjacentMatches.length > 1 || adjacentMatchResult.truncated) {
    fail("source_ambiguous", `Already-deleted source anchors are ambiguous in ${srcLabel}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      ...matchCountDetails(adjacentMatches.length, adjacentMatchResult.truncated),
      ranges: boundedMatchRanges(adjacentMatches, adjacent.length),
      line_ranges: boundedMatchLineRanges(file, adjacentMatches, adjacent.length)
    });
  }

  const envelopes = findSourceEnvelopes(file, patch);
  if (envelopes.ranges.length === 1 && !envelopes.truncated) {
    fail("payload_mismatch", `Source payload does not match located source anchors in ${srcLabel}`, {
      path: srcLabel,
      phase: "payload",
      anchor: "blockpatch-source"
    });
  }
  if (envelopes.ranges.length > 1 || envelopes.truncated) {
    fail("source_ambiguous", `Source anchors are ambiguous in ${srcLabel}; ${matchedLocations(envelopes.ranges.length, envelopes.truncated)}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      ...matchCountDetails(envelopes.ranges.length, envelopes.truncated),
      ranges: boundedRanges(envelopes.ranges),
      line_ranges: boundedLineRanges(file, envelopes.ranges)
    });
  }
  fail("source_not_found", `Source anchors were not found in ${srcLabel}`, {
    path: srcLabel,
    phase: "source",
    anchor: "blockpatch-source",
    matches: 0
  });
}

function isDeletionAlreadyAppliedMatch(file: Buffer, patch: BlockPatch, start: number): boolean {
  if (patch.sourceBefore.length === 0) {
    return start === 0;
  }
  if (patch.sourceAfter.length === 0) {
    return start + patch.sourceBefore.length === file.length;
  }
  return true;
}

function nullSourceResult(
  patch: BlockPatch,
  dstLabel: string,
  status: "applied" | "already_applied",
  targetRange: ByteRange,
  insertIndex: number,
  targetFile: Buffer
): ApplyResult {
  const applied = status === "applied";
  return {
    changed: applied ? [dstLabel] : [],
    affected: [dstLabel],
    written: false,
    noop: !applied,
    status,
    moves: [
      {
        id: patch.id,
        src: devNull,
        dst: dstLabel,
        payload_sha256: patch.payloadSha256,
        payload_bytes: patch.sourcePayload.length,
        payload_lines: countLines(patch.sourcePayload),
        payload_hash_verified: true,
        source_range: null,
        source_line_range: null,
        target_range: targetRange,
        target_line_range: byteRangeToLineRange(targetFile, targetRange),
        insert_index: insertIndex,
        insert_line: lineNumberOrNull(targetFile, insertIndex)
      }
    ]
  };
}

function nullTargetResult(
  patch: BlockPatch,
  srcLabel: string,
  status: "applied" | "already_applied",
  sourceRange: ByteRange | null,
  sourceFile?: Buffer
): ApplyResult {
  const applied = status === "applied";
  return {
    changed: applied ? [srcLabel] : [],
    affected: [srcLabel],
    written: false,
    noop: !applied,
    status,
    moves: [
      {
        id: patch.id,
        src: srcLabel,
        dst: devNull,
        payload_sha256: patch.payloadSha256,
        payload_bytes: patch.sourcePayload.length,
        payload_lines: countLines(patch.sourcePayload),
        payload_hash_verified: true,
        source_range: sourceRange,
        source_line_range: byteRangeToLineRange(sourceFile, sourceRange),
        target_range: null,
        target_line_range: null,
        insert_index: null,
        insert_line: null
      }
    ]
  };
}

function selectMovePlan(
  srcFile: Buffer,
  dstFile: Buffer,
  patch: BlockPatch,
  sameFile: boolean
): MovePlan {
  const srcLabel = patch.src ?? devNull;
  const dstLabel = patch.dst ?? devNull;
  const targetAnchor = requireTarget(patch);
  const source = findSourceRange(srcFile, dstFile, patch);
  if (source === undefined) {
    const target = findAlreadyAppliedTargetSelection(dstFile, patch);
    if (target === undefined) {
      fail("source_not_found", `Source anchors were not found in ${srcLabel}`, {
        path: srcLabel,
        phase: "source",
        anchor: "blockpatch-source",
        matches: 0
      });
    }
    return {
      status: "already_applied",
      details: alreadyAppliedMoveResultDetails({
        id: patch.id,
        src: srcLabel,
        dst: dstLabel,
        payloadSha256: patch.payloadSha256,
        payload: patch.sourcePayload,
        target,
        dstFile
      })
    };
  }

  if (!sameFile) {
    const alreadyAppliedTarget = findAlreadyAppliedTargetSelection(dstFile, patch, dstLabel);
    if (alreadyAppliedTarget !== undefined) {
      failPartialAppliedDuplicate(srcLabel, dstLabel, patch, source, alreadyAppliedTarget);
    }
  }

  const target = findTargetSelection(dstFile, targetAnchor.before, targetAnchor.after, dstLabel, {
    phase: "target",
    anchor: "blockpatch-target"
  });
  return {
    status: "pending",
    selection: buildMoveSelection(srcFile, source, target, sameFile, dstLabel)
  };
}

function failPartialAppliedDuplicate(
  srcLabel: string,
  dstLabel: string,
  patch: BlockPatch,
  source: ByteRange,
  target: TargetSelection
): never {
  fail(
    "partial_applied_duplicate",
    `Cross-file move appears partially applied: ${dstLabel} already contains the moved payload while ${srcLabel} still contains it`,
    {
      path: dstLabel,
      phase: "target",
      anchor: "blockpatch-target",
      source_range: source,
      target_range: target.range,
      payload_sha256: patch.payloadSha256,
      suggested_action: "review_then_remove_source"
    }
  );
}

export function buildMoveSelection(
  srcFile: Buffer,
  source: ByteRange,
  target: TargetSelection,
  sameFile: boolean,
  dstLabel: string
): MoveSelection {
  if (sameFile && rangesOverlap(source, target.range)) {
    fail("target_overlaps_source", `Target anchor for ${dstLabel} overlaps the source block`, {
      path: dstLabel,
      phase: "target",
      anchor: "blockpatch-target"
    });
  }

  return {
    source,
    target,
    payload: Buffer.from(srcFile.subarray(source.start, source.end))
  };
}

export async function commitMove(args: CommitMoveArgs): Promise<string[]> {
  const next = args.sameFile
    ? applyMove(args.srcOriginal, args.selection)
    : applyCrossFileMove(args.srcOriginal, args.dstOriginal, args.selection);
  const srcChanged = !next.src.equals(args.srcOriginal);
  const dstChanged = !args.sameFile && !next.dst.equals(args.dstOriginal);
  const sameFileAlias = args.sameFile && args.srcPath !== args.dstPath;

  if (!args.dryRun) {
    const writes: AtomicWriteRequest[] = [];
    // Destination before source: once renames begin, an interrupted cross-file
    // move can leave the payload duplicated in both files, never deleted from both.
    if (dstChanged || (sameFileAlias && srcChanged)) {
      writes.push({
        path: args.dstPath,
        bytes: next.dst,
        label: args.dstLabel,
        expected: args.dstSnapshot === undefined ? undefined : { kind: "file", label: args.dstLabel, snapshot: args.dstSnapshot }
      });
    }
    if (srcChanged) {
      writes.push({
        path: args.srcPath,
        bytes: next.src,
        label: args.srcLabel,
        expected: args.srcSnapshot === undefined ? undefined : { kind: "file", label: args.srcLabel, snapshot: args.srcSnapshot }
      });
    }
    await writeAtomically(writes);
  }

  const changed: string[] = [];
  if (srcChanged) {
    changed.push(args.srcLabel);
    if (sameFileAlias) {
      changed.push(args.dstLabel);
    }
  }
  if (dstChanged) {
    changed.push(args.dstLabel);
  }
  return unique(changed);
}

export function applyMove(file: Buffer, selection: MoveSelection): { src: Buffer; dst: Buffer } {
  const withoutSource = Buffer.concat([
    file.subarray(0, selection.source.start),
    file.subarray(selection.source.end)
  ]);
  const targetIndex =
    selection.target.insertIndex >= selection.source.end
      ? selection.target.insertIndex - selection.payload.length
      : selection.target.insertIndex;

  const next = Buffer.concat([
    withoutSource.subarray(0, targetIndex),
    selection.payload,
    withoutSource.subarray(targetIndex)
  ]);
  return { src: next, dst: next };
}

export function applyCrossFileMove(
  srcFile: Buffer,
  dstFile: Buffer,
  selection: MoveSelection
): { src: Buffer; dst: Buffer } {
  return {
    src: Buffer.concat([srcFile.subarray(0, selection.source.start), srcFile.subarray(selection.source.end)]),
    dst: Buffer.concat([
      dstFile.subarray(0, selection.target.insertIndex),
      selection.payload,
      dstFile.subarray(selection.target.insertIndex)
    ])
  };
}

function findSourceRange(srcFile: Buffer, dstFile: Buffer, patch: BlockPatch): ByteRange | undefined {
  const srcLabel = patch.src ?? devNull;
  const fullSource = Buffer.concat([patch.sourceBefore, patch.sourcePayload, patch.sourceAfter]);
  const fullMatchResult = indexesOfLimited(srcFile, fullSource);
  const fullMatches = fullMatchResult.matches;

  if (fullMatches.length === 1 && !fullMatchResult.truncated) {
    const start = fullMatches[0] + patch.sourceBefore.length;
    return { start, end: start + patch.sourcePayload.length };
  }

  if (fullMatches.length > 1 || fullMatchResult.truncated) {
    fail("source_ambiguous", `Source block is ambiguous in ${srcLabel}; ${matchedLocations(fullMatches.length, fullMatchResult.truncated)}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      ...matchCountDetails(fullMatches.length, fullMatchResult.truncated),
      ranges: boundedMatchRanges(fullMatches, fullSource.length),
      line_ranges: boundedMatchLineRanges(srcFile, fullMatches, fullSource.length)
    });
  }

  const alreadyApplied = findAlreadyAppliedTargetSelection(dstFile, patch);
  if (alreadyApplied !== undefined) {
    return undefined;
  }

  const envelopes = findSourceEnvelopes(srcFile, patch);
  if (envelopes.ranges.length === 1 && !envelopes.truncated) {
    fail("payload_mismatch", `Source payload does not match located source anchors in ${srcLabel}`, {
      path: srcLabel,
      phase: "payload",
      anchor: "blockpatch-source"
    });
  }

  if (envelopes.ranges.length > 1 || envelopes.truncated) {
    fail("source_ambiguous", `Source anchors are ambiguous in ${srcLabel}; ${matchedLocations(envelopes.ranges.length, envelopes.truncated)}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      ...matchCountDetails(envelopes.ranges.length, envelopes.truncated),
      ranges: boundedRanges(envelopes.ranges),
      line_ranges: boundedLineRanges(srcFile, envelopes.ranges)
    });
  }

  fail("source_not_found", `Source anchors were not found in ${srcLabel}`, {
    path: srcLabel,
    phase: "source",
    anchor: "blockpatch-source",
    matches: 0
  });
}

function findAlreadyAppliedTargetSelection(
  file: Buffer,
  patch: BlockPatch,
  dstLabel: string = patch.dst ?? devNull
): TargetSelection | undefined {
  const target = requireTarget(patch);
  const alreadyApplied = Buffer.concat([target.before, patch.sourcePayload, target.after]);
  const matchResult = indexesOfLimited(file, alreadyApplied);
  const matches = matchResult.matches;

  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length > 1 || matchResult.truncated) {
    fail(
      "target_ambiguous",
      `Already-applied target is ambiguous in ${dstLabel}; ${matchedLocations(matches.length, matchResult.truncated)}`,
      {
        path: dstLabel,
        phase: "target",
        anchor: "blockpatch-target",
        ...matchCountDetails(matches.length, matchResult.truncated),
        ranges: boundedMatchRanges(matches, alreadyApplied.length),
        line_ranges: boundedMatchLineRanges(file, matches, alreadyApplied.length)
      }
    );
  }

  const start = matches[0];
  return {
    range: { start, end: start + alreadyApplied.length },
    insertIndex: start + target.before.length
  };
}

function findSourceEnvelopes(file: Buffer, patch: BlockPatch, limit = 11): LimitedRanges {
  if (patch.sourceBefore.length === 0 || patch.sourceAfter.length === 0) {
    return { ranges: [], truncated: false };
  }

  const maxMatches = normalizedLimit(limit);
  const ranges: ByteRange[] = [];
  let beforeStart = file.indexOf(patch.sourceBefore);

  while (beforeStart !== -1) {
    const payloadStart = beforeStart + patch.sourceBefore.length;
    const afterStart = file.indexOf(patch.sourceAfter, payloadStart);
    if (afterStart !== -1) {
      if (ranges.length >= maxMatches) {
        return { ranges, truncated: true };
      }
      ranges.push({ start: payloadStart, end: afterStart });
    }
    beforeStart = file.indexOf(patch.sourceBefore, beforeStart + 1);
  }

  return { ranges, truncated: false };
}

export function findTargetSelection(
  file: Buffer,
  before: Buffer,
  after: Buffer,
  dstLabel: string,
  details: { phase?: string; anchor?: string } = {}
): TargetSelection {
  const anchor = Buffer.concat([before, after]);
  const matchResult = indexesOfLimited(file, anchor);
  const matches = matchResult.matches;

  if (matches.length === 0) {
    fail("target_not_found", `Target anchor was not found in ${dstLabel}`, {
      path: dstLabel,
      ...details,
      matches: 0
    });
  }

  if (matches.length > 1 || matchResult.truncated) {
    fail("target_ambiguous", `Target anchor is ambiguous in ${dstLabel}; ${matchedLocations(matches.length, matchResult.truncated)}`, {
      path: dstLabel,
      ...details,
      ...matchCountDetails(matches.length, matchResult.truncated),
      ranges: boundedMatchRanges(matches, anchor.length),
      line_ranges: boundedMatchLineRanges(file, matches, anchor.length)
    });
  }

  const start = matches[0];
  return {
    range: { start, end: start + anchor.length },
    insertIndex: start + before.length
  };
}

export function indexesOfLimited(haystack: Buffer, needle: Buffer, limit = 11): LimitedMatches {
  if (needle.length === 0) {
    return { matches: [], truncated: false };
  }

  const maxMatches = normalizedLimit(limit);
  const matches: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (matches.length >= maxMatches) {
      return { matches, truncated: true };
    }
    matches.push(index);
    index = haystack.indexOf(needle, index + 1);
  }

  return { matches, truncated: false };
}

function indexesOfLimitedWhere(
  haystack: Buffer,
  needle: Buffer,
  predicate: (start: number) => boolean,
  limit = 11
): LimitedMatches {
  if (needle.length === 0) {
    return { matches: [], truncated: false };
  }

  const maxMatches = normalizedLimit(limit);
  const matches: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (predicate(index)) {
      if (matches.length >= maxMatches) {
        return { matches, truncated: true };
      }
      matches.push(index);
    }
    index = haystack.indexOf(needle, index + 1);
  }

  return { matches, truncated: false };
}

function normalizedLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.trunc(limit));
}

export function rangesOverlap(left: ByteRange, right: ByteRange): boolean {
  return left.start < right.end && right.start < left.end;
}

export function moveResultDetails(args: {
  id: string;
  src: string;
  dst: string;
  payloadSha256: string;
  selection: MoveSelection;
  srcFile: Buffer;
  dstFile: Buffer;
}): MoveResultDetails {
  return {
    id: args.id,
    src: args.src,
    dst: args.dst,
    payload_sha256: args.payloadSha256,
    payload_bytes: args.selection.payload.length,
    payload_lines: countLines(args.selection.payload),
    payload_hash_verified: true,
    source_range: args.selection.source,
    source_line_range: byteRangeToLineRange(args.srcFile, args.selection.source),
    target_range: args.selection.target.range,
    target_line_range: byteRangeToLineRange(args.dstFile, args.selection.target.range),
    insert_index: args.selection.target.insertIndex,
    insert_line: lineNumberOrNull(args.dstFile, args.selection.target.insertIndex)
  };
}

function alreadyAppliedMoveResultDetails(args: {
  id: string;
  src: string;
  dst: string;
  payloadSha256: string;
  payload: Buffer;
  target: TargetSelection;
  dstFile: Buffer;
}): MoveResultDetails {
  return {
    id: args.id,
    src: args.src,
    dst: args.dst,
    payload_sha256: args.payloadSha256,
    payload_bytes: args.payload.length,
    payload_lines: countLines(args.payload),
    payload_hash_verified: true,
    source_range: null,
    source_line_range: null,
    target_range: args.target.range,
    target_line_range: byteRangeToLineRange(args.dstFile, args.target.range),
    insert_index: args.target.insertIndex,
    insert_line: lineNumberOrNull(args.dstFile, args.target.insertIndex)
  };
}

function byteRangeToLineRange(file: Buffer | undefined, range: ByteRange | null): { start: number; end: number } | null {
  if (file === undefined || range === null) {
    return null;
  }
  const start = clamp(range.start, 0, file.length);
  const end = clamp(range.end, start, file.length);
  const endByte = end > start ? end - 1 : start;
  return {
    start: lineNumberAt(file, start),
    end: lineNumberAt(file, endByte)
  };
}

function lineNumberOrNull(file: Buffer | undefined, byteIndex: number | null): number | null {
  if (file === undefined || byteIndex === null) {
    return null;
  }
  return lineNumberAt(file, clamp(byteIndex, 0, file.length));
}

function lineNumberAt(file: Buffer, byteIndex: number): number {
  let line = 1;
  const end = Math.min(byteIndex, file.length);
  for (let index = 0; index < end; index += 1) {
    if (file[index] === 0x0a) {
      line += 1;
    }
  }
  return line;
}

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) {
    return 0;
  }

  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines += 1;
    }
  }
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function changedMoveLabels(
  srcLabel: string,
  dstLabel: string,
  sameFile: boolean,
  srcOriginal: Buffer,
  dstOriginal: Buffer,
  next: { src: Buffer; dst: Buffer }
): string[] {
  const srcChanged = !next.src.equals(srcOriginal);
  const dstChanged = !sameFile && !next.dst.equals(dstOriginal);
  const sameFileAlias = sameFile && srcLabel !== dstLabel;
  const changed: string[] = [];

  if (srcChanged) {
    changed.push(srcLabel);
    if (sameFileAlias) {
      changed.push(dstLabel);
    }
  }
  if (dstChanged) {
    changed.push(dstLabel);
  }
  return unique(changed);
}

function moveMutations(
  srcLabel: string,
  dstLabel: string,
  sameFile: boolean,
  srcOriginal: Buffer,
  dstOriginal: Buffer,
  next: { src: Buffer; dst: Buffer }
): PatchMutation[] {
  const srcChanged = !next.src.equals(srcOriginal);
  const dstChanged = !sameFile && !next.dst.equals(dstOriginal);
  const sameFileAlias = sameFile && srcLabel !== dstLabel;
  const mutations: PatchMutation[] = [];

  if (dstChanged || (sameFileAlias && srcChanged)) {
    mutations.push({ kind: "write", label: dstLabel, bytes: next.dst });
  }
  if (srcChanged) {
    mutations.push({ kind: "write", label: srcLabel, bytes: next.src });
  }
  return mutations;
}

function memoryFileMap(files: readonly InMemoryPatchFile[]): Map<string, InMemoryFileState> {
  const mapped = new Map<string, InMemoryFileState>();
  for (const file of files) {
    if (mapped.has(file.path)) {
      fail("parse_error", `Duplicate in-memory file: ${file.path}`, { path: file.path, phase: "validate" });
    }
    mapped.set(file.path, {
      bytes: file.bytes,
      identity: file.identity ?? file.path
    });
  }
  return mapped;
}

function readMemoryFile(files: Map<string, InMemoryFileState>, path: string, label: string): Buffer {
  const file = files.get(path);
  if (file === undefined) {
    fail("file_not_found", `Could not read ${label}: ${path}`, { path, phase: "io" });
  }
  return file.bytes;
}

function sameMemoryFile(files: Map<string, InMemoryFileState>, left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftFile = files.get(left);
  const rightFile = files.get(right);
  return leftFile !== undefined && rightFile !== undefined && leftFile.identity === rightFile.identity;
}

export async function writeAtomic(
  path: string,
  bytes: Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await writeAtomically([
    {
      path,
      bytes,
      create: options.create,
      expected: options.expected,
      label: options.label
    }
  ]);
}

async function writeAtomically(
  writes: AtomicWriteRequest[],
  deletes: AtomicDeleteRequest[] = []
): Promise<void> {
  const staged: StagedAtomicWrite[] = [];

  try {
    for (const write of writes) {
      staged.push(await stageAtomicWrite(write));
    }
    const decisions = [];
    for (const write of staged) {
      decisions.push(await verifyStagedWrite(write));
    }
    for (const deletion of deletes) {
      await verifyAtomicDelete(deletion);
    }
    for (const [index, write] of staged.entries()) {
      if (decisions[index] === "skip") {
        await cleanupStagedWrite(write);
        continue;
      }
      try {
        await rename(write.temp, write.path);
      } catch (error) {
        failFileSystem(error, write.path, "Could not replace file");
      }
    }
    for (const deletion of deletes) {
      try {
        await unlink(deletion.path);
      } catch (error) {
        failFileSystem(error, deletion.path, "Could not remove file");
      }
    }
  } catch (error) {
    await cleanupStagedWrites(staged);
    throw error;
  }
}

type StagedWriteDecision = "rename" | "skip";

async function verifyStagedWrite(write: StagedAtomicWrite): Promise<StagedWriteDecision> {
  const expected = write.request.expected;
  if (expected === undefined) {
    return "rename";
  }
  if (expected.kind === "missing") {
    const current = await readFileSnapshotOptional(write.path, expected.label);
    if (current === undefined) {
      return "rename";
    }
    if (expected.bytesIfExists !== undefined && current.bytes.equals(expected.bytesIfExists)) {
      return "skip";
    }
    failConcurrentModification(expected.label);
  }

  const current = await readFileSnapshotOptional(write.path, expected.label);
  if (current === undefined || !sameFileSnapshot(expected.snapshot, current)) {
    failConcurrentModification(expected.label);
  }
  return "rename";
}

async function verifyAtomicDelete(deletion: AtomicDeleteRequest): Promise<void> {
  const expected = deletion.expected;
  if (expected === undefined) {
    return;
  }
  if (expected.kind === "missing") {
    const current = await readFileSnapshotOptional(deletion.path, expected.label);
    if (current === undefined) {
      return;
    }
    failConcurrentModification(expected.label);
  }

  const current = await readFileSnapshotOptional(deletion.path, expected.label);
  if (current === undefined || !sameFileSnapshot(expected.snapshot, current)) {
    failConcurrentModification(expected.label);
  }
}

async function readFileSnapshotOptional(path: string, label: string): Promise<FileSnapshot | undefined> {
  try {
    return await readFileSnapshot(path, "current file");
  } catch (error) {
    if (error instanceof BlockPatchError && error.code === "file_not_found") {
      return undefined;
    }
    if (error instanceof BlockPatchError && error.code === "not_regular_file") {
      failConcurrentModification(label);
    }
    throw error;
  }
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.sha256 === right.sha256 && sameStatSnapshot(left.stat, right.stat);
}

function sameStatSnapshot(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function failConcurrentModification(label: string): never {
  fail("concurrent_modification", `File changed after blockpatch verified its input: ${label}`, {
    path: label,
    phase: "write"
  });
}

async function stageAtomicWrite(write: AtomicWriteRequest): Promise<StagedAtomicWrite> {
  let mode: number | undefined;
  let createMissing = false;
  if (write.create === true) {
    const info = await statOptional(write.path);
    if (info !== undefined) {
      assertExpectedRegularFile(info, write.path, "output file", write.expected);
      mode = info.mode;
    }
    if (mode === undefined) {
      createMissing = true;
      mode = 0o644;
    }
  } else {
    const info = await statOptional(write.path);
    if (info === undefined) {
      if (write.expected !== undefined) {
        failConcurrentModification(write.expected.label);
      }
      fail("file_not_found", `Could not stat output file: ${write.path}`, { path: write.path, phase: "io" });
    }
    assertExpectedRegularFile(info, write.path, "output file", write.expected);
    mode = info.mode;
  }

  const dir = dirname(write.path);
  const base = basename(write.path);
  const temp = join(dir, `.${base}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let createdDirectory: CreatedDirectoryChain | undefined;

  try {
    if (createMissing) {
      const firstCreated = await mkdir(dir, { recursive: true });
      if (firstCreated !== undefined) {
        createdDirectory = { first: firstCreated, target: dir };
      }
    }
    await assertSafeOutputParentDirectory(dir, write.path);
    await writeFile(temp, write.bytes, { flag: "wx" });
    if (mode !== undefined) {
      await chmod(temp, mode);
    }
  } catch (error) {
    await cleanupStagedWrite({ temp, createdDirectory });
    failFileSystem(error, write.path, "Could not stage file replacement");
  }

  return { path: write.path, temp, request: write, createdDirectory };
}

async function assertSafeOutputParentDirectory(dir: string, outputPath: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(dir);
  } catch (error) {
    failFileSystem(error, outputPath, "Could not stat output directory", "path");
  }
  if (info.isSymbolicLink()) {
    fail("symlink_path", `output directory must not be a symbolic link: ${outputPath}`, {
      path: outputPath,
      phase: "path"
    });
  }
  if (!info.isDirectory()) {
    fail("not_regular_file", `output directory must be a directory: ${outputPath}`, {
      path: outputPath,
      phase: "path"
    });
  }
}

async function cleanupStagedWrites(staged: StagedAtomicWrite[]): Promise<void> {
  await Promise.all(staged.map((write) => unlink(write.temp).catch(() => undefined)));
  for (const write of [...staged].reverse()) {
    await cleanupCreatedDirectoryChain(write.createdDirectory);
  }
}

async function cleanupStagedWrite(write: Pick<StagedAtomicWrite, "temp" | "createdDirectory">): Promise<void> {
  await unlink(write.temp).catch(() => undefined);
  await cleanupCreatedDirectoryChain(write.createdDirectory);
}

async function cleanupCreatedDirectoryChain(chain: CreatedDirectoryChain | undefined): Promise<void> {
  if (chain === undefined || !isSameOrChildPath(chain.target, chain.first)) {
    return;
  }

  let current = chain.target;
  while (true) {
    try {
      await rmdir(current);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") {
        return;
      }
    }

    if (resolve(current) === resolve(chain.first)) {
      return;
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function isSameOrChildPath(child: string, parent: string): boolean {
  const childFromParent = relative(resolve(parent), resolve(child));
  return (
    childFromParent === "" ||
    (childFromParent !== ".." && !childFromParent.startsWith(`..${sep}`) && !isAbsolute(childFromParent))
  );
}

function assertExpectedRegularFile(
  info: Stats,
  path: string,
  label: string,
  expected: AtomicPathExpectation | undefined
): void {
  if (!info.isFile() && expected !== undefined) {
    failConcurrentModification(expected.label);
  }
  assertRegularFile(info, path, label);
}

async function statOptional(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    failFileSystem(error, path, "Could not stat output file");
  }
}
