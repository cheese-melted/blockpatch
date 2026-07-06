import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { boundedMatchRanges, boundedRanges, fail } from "./errors";
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
  if (effectivePatch.src === null || effectivePatch.dst === null) {
    if (effectivePatch.src === null && effectivePatch.dst !== null && !effectivePatch.hasSourceHunk) {
      return applyPathCreationMove(effectivePatch, effectivePatch.dst, cwd, dryRun);
    }
    if (effectivePatch.dst === null && effectivePatch.src !== null && effectivePatch.hasSourceHunk) {
      return applyPathDeletionMove(effectivePatch, effectivePatch.src, cwd, dryRun);
    }
    fail("parse_error", "Invalid /dev/null endpoint move shape");
  }

  if (!effectivePatch.hasSourceHunk) {
    return applyInFileInsertionMove(effectivePatch, effectivePatch.src, effectivePatch.dst, cwd, dryRun);
  }

  if (effectivePatch.target === null) {
    return applyInFileDeletionMove(effectivePatch, effectivePatch.src, effectivePatch.dst, cwd, dryRun);
  }

  const srcLabel = effectivePatch.src;
  const dstLabel = effectivePatch.dst;
  const srcPath = resolvePath(cwd, srcLabel, "source path");
  const dstPath = resolvePath(cwd, dstLabel, "destination path");
  const sameFile = await sameFileIdentity(srcPath, dstPath);
  const srcOriginal = await readFileChecked(srcPath, "source file");
  const dstOriginal = sameFile ? srcOriginal : await readFileChecked(dstPath, "destination file");
  const plan = selectMovePlan(srcOriginal, dstOriginal, effectivePatch, sameFile);

  if (plan.status === "already_applied") {
    return {
      changed: [],
      affected: unique([srcLabel, dstLabel]),
      written: false,
      noop: true,
      status: "already_applied",
      moves: [plan.details]
    };
  }

  const selection = plan.selection;
  const changed = await commitMove({
    srcPath,
    dstPath,
    sameFile,
    dryRun,
    srcOriginal,
    dstOriginal,
    selection,
    srcLabel,
    dstLabel
  });

  return {
    changed,
    affected: unique([srcLabel, dstLabel]),
    written: !dryRun && changed.length > 0,
    noop: changed.length === 0,
    status: changed.length === 0 ? "noop" : "applied",
    moves: [
      moveResultDetails({
        id: effectivePatch.id,
        src: srcLabel,
        dst: dstLabel,
        payloadSha256: effectivePatch.payloadSha256,
        selection
      })
    ]
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

async function applyInFileInsertionMove(
  patch: BlockPatch,
  srcLabel: string,
  dstLabel: string,
  cwd: string,
  dryRun: boolean
): Promise<ApplyResult> {
  const target = requireTarget(patch);
  const dstPath = resolvePath(cwd, dstLabel, "destination path");
  const original = await readFileChecked(dstPath, "destination file");
  const alreadyApplied = findAlreadyAppliedTargetSelection(original, patch, dstLabel);
  if (alreadyApplied !== undefined) {
    return oneSidedResult({
      patch,
      src: srcLabel,
      dst: dstLabel,
      changed: [],
      dryRun,
      status: "already_applied",
      sourceRange: null,
      targetRange: alreadyApplied.range,
      insertIndex: alreadyApplied.insertIndex
    });
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

  if (!dryRun) {
    await writeAtomically([{ path: dstPath, bytes: next }]);
  }

  return oneSidedResult({
    patch,
    src: srcLabel,
    dst: dstLabel,
    changed: next.equals(original) ? [] : unique([srcLabel, dstLabel]),
    dryRun,
    status: next.equals(original) ? "noop" : "applied",
    sourceRange: null,
    targetRange: selection.range,
    insertIndex: selection.insertIndex
  });
}

async function applyInFileDeletionMove(
  patch: BlockPatch,
  srcLabel: string,
  dstLabel: string,
  cwd: string,
  dryRun: boolean
): Promise<ApplyResult> {
  const srcPath = resolvePath(cwd, srcLabel, "source path");
  const original = await readFileChecked(srcPath, "source file");
  const source = findDeletionSourceRange(original, patch, srcLabel);

  if (source === undefined) {
    return oneSidedResult({
      patch,
      src: srcLabel,
      dst: dstLabel,
      changed: [],
      dryRun,
      status: "already_applied",
      sourceRange: null,
      targetRange: null,
      insertIndex: null
    });
  }

  const next = Buffer.concat([original.subarray(0, source.start), original.subarray(source.end)]);
  if (!dryRun) {
    await writeAtomically([{ path: srcPath, bytes: next }]);
  }

  return oneSidedResult({
    patch,
    src: srcLabel,
    dst: dstLabel,
    changed: next.equals(original) ? [] : unique([srcLabel, dstLabel]),
    dryRun,
    status: next.equals(original) ? "noop" : "applied",
    sourceRange: source,
    targetRange: null,
    insertIndex: null
  });
}

function oneSidedResult(args: {
  patch: BlockPatch;
  src: string;
  dst: string;
  changed: string[];
  dryRun: boolean;
  status: "applied" | "noop" | "already_applied";
  sourceRange: ByteRange | null;
  targetRange: ByteRange | null;
  insertIndex: number | null;
}): ApplyResult {
  return {
    changed: args.changed,
    affected: unique([args.src, args.dst]),
    written: args.status === "applied" && !args.dryRun && args.changed.length > 0,
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

// /dev/null -> file: create the file path with the patch-carried whole-file payload.
async function applyPathCreationMove(
  patch: BlockPatch,
  dstLabel: string,
  cwd: string,
  dryRun: boolean
): Promise<ApplyResult> {
  const resolved = resolvePathAllowMissing(cwd, dstLabel, "destination path");
  const fullTarget = fullTargetBytes(patch);

  if (resolved.exists) {
    const original = await readFileChecked(resolved.path, "destination file");
    if (original.equals(fullTarget)) {
      return nullSourceResult(patch, dstLabel, dryRun, "already_applied", { start: 0, end: original.length }, 0);
    }
    fail("target_not_found", `Destination path for file creation already exists: ${dstLabel}`, {
      path: dstLabel,
      phase: "target",
      anchor: "blockpatch-target"
    });
  }

  if (!dryRun) {
    await writeAtomically([{ path: resolved.path, bytes: fullTarget, create: true }]);
  }
  return nullSourceResult(patch, dstLabel, dryRun, "applied", { start: 0, end: 0 }, 0);
}

// file -> /dev/null: verify the whole-file payload, then remove the path.
async function applyPathDeletionMove(
  patch: BlockPatch,
  srcLabel: string,
  cwd: string,
  dryRun: boolean
): Promise<ApplyResult> {
  const resolved = resolvePathAllowMissing(cwd, srcLabel, "source path");
  if (!resolved.exists) {
    return nullTargetResult(patch, srcLabel, dryRun, "already_applied", null);
  }

  const original = await readFileChecked(resolved.path, "source file");
  const fullSource = Buffer.concat([patch.sourceBefore, patch.sourcePayload, patch.sourceAfter]);
  if (!original.equals(fullSource)) {
    fail("source_not_found", `Whole-file source payload was not found in ${srcLabel}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      matches: 0
    });
  }

  if (!dryRun) {
    try {
      await unlink(resolved.path);
    } catch (error) {
      failFileSystem(error, srcLabel, "Could not remove file");
    }
  }

  return nullTargetResult(patch, srcLabel, dryRun, "applied", {
    start: patch.sourceBefore.length,
    end: patch.sourceBefore.length + patch.sourcePayload.length
  });
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
      ranges: boundedMatchRanges(fullMatches, fullSource.length)
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
    if (indexesOf(file, patch.sourcePayload).length === 0) {
      return undefined;
    }
    fail("source_ambiguous", `Source payload is ambiguous in ${srcLabel}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source"
    });
  }

  const adjacent = Buffer.concat([patch.sourceBefore, patch.sourceAfter]);
  const adjacentMatches = indexesOf(file, adjacent);
  if (adjacentMatches.length === 1) {
    return undefined;
  }
  if (adjacentMatches.length > 1) {
    fail("source_ambiguous", `Already-deleted source anchors are ambiguous in ${srcLabel}`, {
      path: srcLabel,
      phase: "source",
      anchor: "blockpatch-source",
      matches: adjacentMatches.length,
      ranges: boundedMatchRanges(adjacentMatches, adjacent.length)
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
      ranges: boundedRanges(envelopes)
    });
  }
  fail("source_not_found", `Source anchors were not found in ${srcLabel}`, {
    path: srcLabel,
    phase: "source",
    anchor: "blockpatch-source",
    matches: 0
  });
}

function nullSourceResult(
  patch: BlockPatch,
  dstLabel: string,
  dryRun: boolean,
  status: "applied" | "already_applied",
  targetRange: ByteRange,
  insertIndex: number
): ApplyResult {
  const applied = status === "applied";
  return {
    changed: applied ? [dstLabel] : [],
    affected: [dstLabel],
    written: applied && !dryRun,
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
  dryRun: boolean,
  status: "applied" | "already_applied",
  sourceRange: ByteRange | null
): ApplyResult {
  const applied = status === "applied";
  return {
    changed: applied ? [srcLabel] : [],
    affected: [srcLabel],
    written: applied && !dryRun,
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

export function selectMove(
  srcFile: Buffer,
  dstFile: Buffer,
  patch: BlockPatch,
  sameFile: boolean
): MoveSelection {
  const dstLabel = patch.dst ?? devNull;
  const targetAnchor = requireTarget(patch);
  const source = findSourceRange(srcFile, dstFile, patch);
  if (source === undefined) {
    fail("already_applied", `Patch is already applied in ${dstLabel}`, {
      path: dstLabel,
      phase: "target",
      anchor: "blockpatch-target"
    });
  }
  const target = findTargetSelection(dstFile, targetAnchor.before, targetAnchor.after, dstLabel, {
    phase: "target",
    anchor: "blockpatch-target"
  });
  return buildMoveSelection(srcFile, source, target, sameFile, dstLabel);
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
      ranges: boundedMatchRanges(fullMatches, fullSource.length)
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
      ranges: boundedRanges(envelopes)
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
        ranges: boundedMatchRanges(matches, alreadyApplied.length)
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
      ranges: boundedMatchRanges(matches, anchor.length)
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
  if (create) {
    const info = await statOptional(path);
    if (info !== undefined) {
      assertRegularFile(info, path, "output file");
      mode = info.mode;
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
    if (create && mode === undefined) {
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
