import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fail } from "./errors";
import { parseBlockPatch } from "./parser";
import { resolvePath } from "./paths";
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
  const patchBytes = await readFile(resolve(cwd, patchPath));
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
  const srcPath = resolvePath(cwd, effectivePatch.src, "source path");
  const dstPath = resolvePath(cwd, effectivePatch.dst, "destination path");
  const sameFile = srcPath === dstPath;
  const srcOriginal = await readFile(srcPath);
  const dstOriginal = sameFile ? srcOriginal : await readFile(dstPath);
  const plan = selectMovePlan(srcOriginal, dstOriginal, effectivePatch, sameFile);

  if (plan.status === "already_applied") {
    return {
      changed: [],
      affected: unique([effectivePatch.src, effectivePatch.dst]),
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
    srcLabel: effectivePatch.src,
    dstLabel: effectivePatch.dst
  });

  return {
    changed,
    affected: unique([effectivePatch.src, effectivePatch.dst]),
    noop: changed.length === 0,
    status: changed.length === 0 ? "noop" : "applied",
    moves: [
      moveResultDetails({
        id: effectivePatch.id,
        src: effectivePatch.src,
        dst: effectivePatch.dst,
        payloadSha256: effectivePatch.payloadSha256,
        selection
      })
    ]
  };
}

function reverseMovePatch(patch: BlockPatch): BlockPatch {
  return {
    ...patch,
    src: patch.dst,
    dst: patch.src,
    sourceBefore: patch.target.before,
    sourceAfter: patch.target.after,
    target: {
      before: patch.sourceBefore,
      after: patch.sourceAfter
    }
  };
}

export function selectMove(
  srcFile: Buffer,
  dstFile: Buffer,
  patch: BlockPatch,
  sameFile: boolean
): MoveSelection {
  const source = findSourceRange(srcFile, dstFile, patch);
  if (source === undefined) {
    fail("already_applied", `Patch is already applied in ${patch.dst}`, {
      path: patch.dst,
      phase: "target",
      anchor: "blockpatch-target"
    });
  }
  const target = findTargetSelection(dstFile, patch.target.before, patch.target.after, patch.dst, {
    phase: "target",
    anchor: "blockpatch-target"
  });
  return buildMoveSelection(srcFile, source, target, sameFile, patch.dst);
}

function selectMovePlan(
  srcFile: Buffer,
  dstFile: Buffer,
  patch: BlockPatch,
  sameFile: boolean
): MovePlan {
  const source = findSourceRange(srcFile, dstFile, patch);
  if (source === undefined) {
    const target = findAlreadyAppliedTargetSelection(dstFile, patch);
    if (target === undefined) {
      fail("source_not_found", `Source anchors were not found in ${patch.src}`, {
        path: patch.src,
        phase: "source",
        anchor: "blockpatch-source",
        matches: 0
      });
    }
    return {
      status: "already_applied",
      details: alreadyAppliedMoveResultDetails({
        id: patch.id,
        src: patch.src,
        dst: patch.dst,
        payloadSha256: patch.payloadSha256,
        payload: patch.sourcePayload,
        target
      })
    };
  }

  const target = findTargetSelection(dstFile, patch.target.before, patch.target.after, patch.dst, {
    phase: "target",
    anchor: "blockpatch-target"
  });
  return {
    status: "pending",
    selection: buildMoveSelection(srcFile, source, target, sameFile, patch.dst)
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

  if (!args.dryRun) {
    const writes: AtomicWriteRequest[] = [];
    // Destination before source: once renames begin, an interrupted cross-file
    // move can leave the payload duplicated in both files, never deleted from both.
    if (dstChanged) {
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
  }
  if (dstChanged) {
    changed.push(args.dstLabel);
  }
  return changed;
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
  const fullSource = Buffer.concat([patch.sourceBefore, patch.sourcePayload, patch.sourceAfter]);
  const fullMatches = indexesOf(srcFile, fullSource);

  if (fullMatches.length === 1) {
    const start = fullMatches[0] + patch.sourceBefore.length;
    return { start, end: start + patch.sourcePayload.length };
  }

  if (fullMatches.length > 1) {
    fail("source_ambiguous", `Source block is ambiguous in ${patch.src}; matched ${fullMatches.length} locations`, {
      path: patch.src,
      phase: "source",
      anchor: "blockpatch-source",
      matches: fullMatches.length
    });
  }

  const alreadyApplied = findAlreadyAppliedTargetSelection(dstFile, patch);
  if (alreadyApplied !== undefined) {
    return undefined;
  }

  const envelopes = findSourceEnvelopes(srcFile, patch);
  if (envelopes.length === 1) {
    fail("payload_mismatch", `Source payload does not match located source anchors in ${patch.src}`, {
      path: patch.src,
      phase: "payload",
      anchor: "blockpatch-source"
    });
  }

  if (envelopes.length > 1) {
    fail("source_ambiguous", `Source anchors are ambiguous in ${patch.src}; matched ${envelopes.length} locations`, {
      path: patch.src,
      phase: "source",
      anchor: "blockpatch-source",
      matches: envelopes.length
    });
  }

  fail("source_not_found", `Source anchors were not found in ${patch.src}`, {
    path: patch.src,
    phase: "source",
    anchor: "blockpatch-source",
    matches: 0
  });
}

function findAlreadyAppliedTargetSelection(
  file: Buffer,
  patch: BlockPatch
): TargetSelection | undefined {
  const alreadyApplied = Buffer.concat([patch.target.before, patch.sourcePayload, patch.target.after]);
  const matches = indexesOf(file, alreadyApplied);

  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length > 1) {
    fail(
      "target_ambiguous",
      `Already-applied target is ambiguous in ${patch.dst}; matched ${matches.length} locations`,
      {
        path: patch.dst,
        phase: "target",
        anchor: "blockpatch-target",
        matches: matches.length
      }
    );
  }

  const start = matches[0];
  return {
    range: { start, end: start + alreadyApplied.length },
    insertIndex: start + patch.target.before.length
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
      matches: matches.length
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
      staged.push(await stageAtomicWrite(write.path, write.bytes));
    }
    for (const write of staged) {
      await rename(write.temp, write.path);
    }
  } catch (error) {
    await Promise.all(staged.map((write) => unlink(write.temp).catch(() => undefined)));
    throw error;
  }
}

async function stageAtomicWrite(path: string, bytes: Buffer): Promise<StagedAtomicWrite> {
  const info = await stat(path);
  const dir = dirname(path);
  const base = basename(path);
  const temp = join(dir, `.${base}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);

  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await chmod(temp, info.mode);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }

  return { path, temp };
}
