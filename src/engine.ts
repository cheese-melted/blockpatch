import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { boundedLineRanges, boundedMatchLineRanges, boundedMatchRanges, boundedRanges, fail } from "./errors";
import { assertRegularFile, failFileSystem, readFileChecked, statChecked } from "./files";
import { devNull, parseBlockPatch } from "./parser";
import { resolvePath, resolvePathAllowMissing, sameFileIdentity } from "./paths";
import type { ApplyOptions, ApplyResult, BlockPatch, MoveResultDetails } from "./types";

export interface ByteRange {
  start: number;
  end: number;
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
  selection: MoveSelection;
  srcLabel: string;
  dstLabel: string;
}

interface AtomicWriteRequest {
  path: string;
  bytes: Buffer;
  create?: boolean;
}

interface StagedAtomicWrite {
  path: string;
  temp: string;
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

interface PatchWorkspace {
  files: Map<string, InMemoryFileState>;
  paths: Map<string, string>;
}

type PatchMutation =
  | { kind: "write"; label: string; bytes: Buffer; create?: boolean }
  | { kind: "delete"; label: string };

interface PlannedPatch {
  result: ApplyResult;
  mutations: PatchMutation[];
}

export async function checkPatchFile(
  patchPath: string,
  options: ApplyOptions = {}
): Promise<ApplyResult> {
  return runPatchFile(patchPath, { ...options, dryRun: true });
}

export async function checkPatchBytes(
  patchBytes: Buffer,
  options: ApplyOptions = {}
): Promise<ApplyResult> {
  return runPatchBytes(patchBytes, { ...options, dryRun: true });
}

export function checkPatchBytesInMemory(
  patchBytes: Buffer,
  files: readonly InMemoryPatchFile[],
  options: Pick<ApplyOptions, "reverse" | "stripComponents"> = {}
): ApplyResult {
  const patch = parseBlockPatch(patchBytes, { stripComponents: options.stripComponents });
  const effectivePatch = options.reverse === true ? reverseMovePatch(patch) : patch;
  return planMovePatch(effectivePatch, memoryFileMap(files)).result;
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
  return applyMovePatch(patch, cwd, options.dryRun ?? false, options.reverse ?? false);
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
      rememberPath(workspace, patch.dst, resolved.path);
      if (resolved.exists) {
        rememberFile(workspace, patch.dst, resolved.path, await readFileChecked(resolved.path, "destination file"));
      }
      return workspace;
    }
    if (patch.dst === null && patch.src !== null && patch.hasSourceHunk) {
      const resolved = resolvePathAllowMissing(cwd, patch.src, "source path");
      rememberPath(workspace, patch.src, resolved.path);
      if (resolved.exists) {
        rememberFile(workspace, patch.src, resolved.path, await readFileChecked(resolved.path, "source file"));
      }
      return workspace;
    }
    fail("parse_error", "Invalid /dev/null endpoint move shape");
  }

  if (!patch.hasSourceHunk) {
    const dstPath = resolvePath(cwd, patch.dst, "destination path");
    rememberFile(workspace, patch.dst, dstPath, await readFileChecked(dstPath, "destination file"));
    return workspace;
  }

  if (patch.target === null) {
    const srcPath = resolvePath(cwd, patch.src, "source path");
    rememberFile(workspace, patch.src, srcPath, await readFileChecked(srcPath, "source file"));
    return workspace;
  }

  const srcPath = resolvePath(cwd, patch.src, "source path");
  const dstPath = resolvePath(cwd, patch.dst, "destination path");
  const sameFile = await sameFileIdentity(srcPath, dstPath);
  const srcOriginal = await readFileChecked(srcPath, "source file");
  const dstOriginal = sameFile ? srcOriginal : await readFileChecked(dstPath, "destination file");
  const identity = sameFile ? "paired-file" : undefined;
  rememberFile(workspace, patch.src, srcPath, srcOriginal, identity);
  rememberFile(workspace, patch.dst, dstPath, dstOriginal, identity);
  return workspace;
}

function rememberPath(workspace: PatchWorkspace, label: string, path: string): void {
  workspace.paths.set(label, path);
}

function rememberFile(
  workspace: PatchWorkspace,
  label: string,
  path: string,
  bytes: Buffer,
  identity = path
): void {
  rememberPath(workspace, label, path);
  workspace.files.set(label, { bytes, identity });
}

async function commitPatchMutations(mutations: readonly PatchMutation[], paths: Map<string, string>): Promise<void> {
  const writes: AtomicWriteRequest[] = [];
  const deletes: string[] = [];

  for (const mutation of mutations) {
    const path = mutationPath(paths, mutation.label);
    if (mutation.kind === "write") {
      writes.push({ path, bytes: mutation.bytes, create: mutation.create });
    } else {
      deletes.push(path);
    }
  }

  await writeAtomically(writes);

  for (const path of deletes) {
    try {
      await unlink(path);
    } catch (error) {
      failFileSystem(error, path, "Could not remove file");
    }
  }
}

function mutationPath(paths: Map<string, string>, label: string): string {
  const path = paths.get(label);
  if (path === undefined) {
    fail("parse_error", `No resolved path for planned mutation: ${label}`, { path: label, phase: "path" });
  }
  return path;
}

function resultWithWriteFlag(result: ApplyResult, dryRun: boolean): ApplyResult {
  return {
    ...result,
    written: result.status === "applied" && !dryRun && result.changed.length > 0
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
          selection
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
        insertIndex: alreadyApplied.insertIndex
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
      insertIndex: selection.insertIndex
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
        insertIndex: null
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
      insertIndex: null
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
        source_range: args.sourceRange,
        target_range: args.targetRange,
        insert_index: args.insertIndex
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
        result: nullSourceResult(patch, dstLabel, "already_applied", { start: 0, end: original.length }, 0),
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
    result: nullSourceResult(patch, dstLabel, "applied", { start: 0, end: 0 }, 0),
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
    }),
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
  const fullMatches = indexesOf(file, fullSource);

  if (fullMatches.length === 1) {
    const start = fullMatches[0] + patch.sourceBefore.length;
    return { start, end: start + patch.sourcePayload.length };
  }

  if (fullMatches.length > 1) {
    fail("source_ambiguous", `Source block is ambiguous in ${srcLabel}; matched ${fullMatches.length} locations`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      matches: fullMatches.length,
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
  const adjacentMatches = indexesOf(file, adjacent).filter((start) =>
    isDeletionAlreadyAppliedMatch(file, patch, start)
  );
  if (adjacentMatches.length === 1) {
    return undefined;
  }
  if (adjacentMatches.length > 1) {
    fail("source_ambiguous", `Already-deleted source anchors are ambiguous in ${srcLabel}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      matches: adjacentMatches.length,
      ranges: boundedMatchRanges(adjacentMatches, adjacent.length),
      line_ranges: boundedMatchLineRanges(file, adjacentMatches, adjacent.length)
    });
  }

  const envelopes = findSourceEnvelopes(file, patch);
  if (envelopes.length === 1) {
    fail("payload_mismatch", `Source payload does not match located source anchors in ${srcLabel}`, {
      path: srcLabel,
      phase: "payload",
      anchor: "blockpatch-source"
    });
  }
  if (envelopes.length > 1) {
    fail("source_ambiguous", `Source anchors are ambiguous in ${srcLabel}; matched ${envelopes.length} locations`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      matches: envelopes.length,
      ranges: boundedRanges(envelopes),
      line_ranges: boundedLineRanges(file, envelopes)
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
  insertIndex: number
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
        source_range: null,
        target_range: targetRange,
        insert_index: insertIndex
      }
    ]
  };
}

function nullTargetResult(
  patch: BlockPatch,
  srcLabel: string,
  status: "applied" | "already_applied",
  sourceRange: ByteRange | null
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
        source_range: sourceRange,
        target_range: null,
        insert_index: null
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
        target
      })
    };
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
      writes.push({ path: args.dstPath, bytes: next.dst });
    }
    if (srcChanged) {
      writes.push({ path: args.srcPath, bytes: next.src });
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
  const fullMatches = indexesOf(srcFile, fullSource);

  if (fullMatches.length === 1) {
    const start = fullMatches[0] + patch.sourceBefore.length;
    return { start, end: start + patch.sourcePayload.length };
  }

  if (fullMatches.length > 1) {
    fail("source_ambiguous", `Source block is ambiguous in ${srcLabel}; matched ${fullMatches.length} locations`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      matches: fullMatches.length,
      ranges: boundedMatchRanges(fullMatches, fullSource.length),
      line_ranges: boundedMatchLineRanges(srcFile, fullMatches, fullSource.length)
    });
  }

  const alreadyApplied = findAlreadyAppliedTargetSelection(dstFile, patch);
  if (alreadyApplied !== undefined) {
    return undefined;
  }

  const envelopes = findSourceEnvelopes(srcFile, patch);
  if (envelopes.length === 1) {
    fail("payload_mismatch", `Source payload does not match located source anchors in ${srcLabel}`, {
      path: srcLabel,
      phase: "payload",
      anchor: "blockpatch-source"
    });
  }

  if (envelopes.length > 1) {
    fail("source_ambiguous", `Source anchors are ambiguous in ${srcLabel}; matched ${envelopes.length} locations`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      matches: envelopes.length,
      ranges: boundedRanges(envelopes),
      line_ranges: boundedLineRanges(srcFile, envelopes)
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
  const matches = indexesOf(file, alreadyApplied);

  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length > 1) {
    fail(
      "target_ambiguous",
      `Already-applied target is ambiguous in ${dstLabel}; matched ${matches.length} locations`,
      {
        path: dstLabel,
        phase: "target",
        anchor: "blockpatch-target",
        matches: matches.length,
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

function findSourceEnvelopes(file: Buffer, patch: BlockPatch): ByteRange[] {
  const beforeMatches = indexesOf(file, patch.sourceBefore);
  const afterMatches = indexesOf(file, patch.sourceAfter);
  const ranges: ByteRange[] = [];

  for (const beforeStart of beforeMatches) {
    const payloadStart = beforeStart + patch.sourceBefore.length;
    const afterStart = afterMatches.find((candidate) => candidate >= payloadStart);
    if (afterStart !== undefined) {
      ranges.push({ start: payloadStart, end: afterStart });
    }
  }

  return ranges;
}

export function findTargetSelection(
  file: Buffer,
  before: Buffer,
  after: Buffer,
  dstLabel: string,
  details: { phase?: string; anchor?: string } = {}
): TargetSelection {
  const anchor = Buffer.concat([before, after]);
  const matches = indexesOf(file, anchor);

  if (matches.length === 0) {
    fail("target_not_found", `Target anchor was not found in ${dstLabel}`, {
      path: dstLabel,
      ...details,
      matches: 0
    });
  }

  if (matches.length > 1) {
    fail("target_ambiguous", `Target anchor is ambiguous in ${dstLabel}; matched ${matches.length} locations`, {
      path: dstLabel,
      ...details,
      matches: matches.length,
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

export function indexesOf(haystack: Buffer, needle: Buffer): number[] {
  if (needle.length === 0) {
    return [];
  }

  const indexes: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    indexes.push(index);
    index = haystack.indexOf(needle, index + 1);
  }

  return indexes;
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
}): MoveResultDetails {
  return {
    id: args.id,
    src: args.src,
    dst: args.dst,
    payload_sha256: args.payloadSha256,
    payload_bytes: args.selection.payload.length,
    source_range: args.selection.source,
    target_range: args.selection.target.range,
    insert_index: args.selection.target.insertIndex
  };
}

function alreadyAppliedMoveResultDetails(args: {
  id: string;
  src: string;
  dst: string;
  payloadSha256: string;
  payload: Buffer;
  target: TargetSelection;
}): MoveResultDetails {
  return {
    id: args.id,
    src: args.src,
    dst: args.dst,
    payload_sha256: args.payloadSha256,
    payload_bytes: args.payload.length,
    source_range: null,
    target_range: args.target.range,
    insert_index: args.target.insertIndex
  };
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
      fail("parse_error", `Duplicate in-memory file: ${file.path}`, { path: file.path, phase: "check" });
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

export async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
  await writeAtomically([{ path, bytes }]);
}

async function writeAtomically(writes: AtomicWriteRequest[]): Promise<void> {
  const staged: StagedAtomicWrite[] = [];

  try {
    for (const write of writes) {
      staged.push(await stageAtomicWrite(write.path, write.bytes, write.create === true));
    }
    for (const write of staged) {
      try {
        await rename(write.temp, write.path);
      } catch (error) {
        failFileSystem(error, write.path, "Could not replace file");
      }
    }
  } catch (error) {
    await Promise.all(staged.map((write) => unlink(write.temp).catch(() => undefined)));
    throw error;
  }
}

async function stageAtomicWrite(path: string, bytes: Buffer, create = false): Promise<StagedAtomicWrite> {
  let mode: number | undefined;
  let createMissing = false;
  if (create) {
    const info = await statOptional(path);
    if (info !== undefined) {
      assertRegularFile(info, path, "output file");
      mode = info.mode;
    }
    if (mode === undefined) {
      createMissing = true;
      mode = 0o644;
    }
  } else {
    const info = await statChecked(path, "output file");
    assertRegularFile(info, path, "output file");
    mode = info.mode;
  }

  const dir = dirname(path);
  const base = basename(path);
  const temp = join(dir, `.${base}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);

  try {
    if (createMissing) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(temp, bytes, { flag: "wx" });
    if (mode !== undefined) {
      await chmod(temp, mode);
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    failFileSystem(error, path, "Could not stage file replacement");
  }

  return { path, temp };
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
