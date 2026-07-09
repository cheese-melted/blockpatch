import {
  boundedLineRanges,
  boundedMatchLineRanges,
  boundedMatchRanges,
  boundedRanges,
  fail,
  matchCountDetails,
  matchedLocations
} from "./errors";
import { devNull } from "./parser";
import {
  buildMoveSelection,
  findTargetSelection,
  indexesOfLimited,
  indexesOfLimitedWhere,
  type ByteRange,
  type MoveSelection,
  type TargetSelection
} from "./matcher";
import {
  alreadyAppliedMoveResultDetails,
  changedMoveLabels,
  moveMutations,
  moveResultDetails,
  nullSourceResult,
  nullTargetResult,
  oneSidedResult,
  unique,
  type PatchMutation
} from "./result";
import { writeAtomically, type AtomicWriteRequest } from "./atomic-write";
import type { ApplyResult, BlockPatch, Endpoint, MoveResultDetails } from "./types";
import type { FileSnapshot } from "./files";

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

export interface InMemoryPatchFile {
  path: string;
  bytes: Buffer;
  identity?: string;
}

export interface InMemoryFileState {
  bytes: Buffer;
  identity: string;
}

interface LimitedRanges {
  ranges: ByteRange[];
  truncated: boolean;
}

export interface PlannedPatch {
  result: ApplyResult;
  mutations: PatchMutation[];
}

export function planMovePatch(effectivePatch: BlockPatch, files: Map<string, InMemoryFileState>): PlannedPatch {
  if (isNullEndpoint(effectivePatch.src) || isNullEndpoint(effectivePatch.dst)) {
    if (isNullEndpoint(effectivePatch.src) && isFileEndpoint(effectivePatch.dst) && !effectivePatch.hasSourceHunk) {
      return planPathCreationMove(effectivePatch, effectivePatch.dst.path, files);
    }
    if (isNullEndpoint(effectivePatch.dst) && isFileEndpoint(effectivePatch.src) && effectivePatch.hasSourceHunk) {
      return planPathDeletionMove(effectivePatch, effectivePatch.src.path, files);
    }
    fail("parse_error", "Invalid /dev/null endpoint move shape");
  }

  const srcLabel = fileEndpointPath(effectivePatch.src, "source path");
  const dstLabel = fileEndpointPath(effectivePatch.dst, "destination path");

  if (!effectivePatch.hasSourceHunk) {
    return planInFileInsertionMove(effectivePatch, srcLabel, dstLabel, files);
  }

  if (effectivePatch.target === null) {
    return planInFileDeletionMove(effectivePatch, srcLabel, dstLabel, files);
  }

  return planPairedMove(effectivePatch, files);
}

function planPairedMove(patch: BlockPatch, files: Map<string, InMemoryFileState>): PlannedPatch {
  const srcLabel = fileEndpointPath(patch.src, "source path");
  const dstLabel = fileEndpointPath(patch.dst, "destination path");
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

export function reverseMovePatch(patch: BlockPatch): BlockPatch {
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

function selectMovePlan(
  srcFile: Buffer,
  dstFile: Buffer,
  patch: BlockPatch,
  sameFile: boolean
): MovePlan {
  const srcLabel = endpointLabel(patch.src);
  const dstLabel = endpointLabel(patch.dst);
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
  const srcLabel = endpointLabel(patch.src);
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
  dstLabel: string = endpointLabel(patch.dst)
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

function normalizedLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.trunc(limit));
}

export function memoryFileMap(files: readonly InMemoryPatchFile[]): Map<string, InMemoryFileState> {
  const map = new Map<string, InMemoryFileState>();
  for (const file of files) {
    const identity = file.identity ?? file.path;
    const existing = map.get(file.path);
    if (existing !== undefined && existing.identity !== identity) {
      fail("parse_error", `Duplicate in-memory file with different identity: ${file.path}`, {
        path: file.path,
        phase: "path"
      });
    }
    map.set(file.path, { bytes: file.bytes, identity });
  }
  return map;
}

function readMemoryFile(files: Map<string, InMemoryFileState>, path: string, label: string): Buffer {
  const state = files.get(path);
  if (state === undefined) {
    fail("file_not_found", `Could not read ${label}: ${path}`, { path, phase: "path" });
  }
  return state.bytes;
}

function sameMemoryFile(files: Map<string, InMemoryFileState>, left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftState = files.get(left);
  const rightState = files.get(right);
  return leftState !== undefined && rightState !== undefined && leftState.identity === rightState.identity;
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

function endpointLabel(endpoint: Endpoint): string {
  return endpoint.kind === "file" ? endpoint.path : devNull;
}
