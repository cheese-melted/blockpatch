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
  return applyMovePatch(patch, cwd, options.dryRun ?? false);
}

async function applyMovePatch(
  patch: BlockPatch,
  cwd: string,
  dryRun: boolean
): Promise<ApplyResult> {
  const srcPath = resolvePath(cwd, patch.src, "source path");
  const dstPath = resolvePath(cwd, patch.dst, "destination path");
  const sameFile = srcPath === dstPath;
  const srcOriginal = await readFile(srcPath);
  const dstOriginal = sameFile ? srcOriginal : await readFile(dstPath);
  const selection = selectMove(srcOriginal, dstOriginal, patch, sameFile);
  const changed = await commitMove({
    srcPath,
    dstPath,
    sameFile,
    dryRun,
    srcOriginal,
    dstOriginal,
    selection,
    srcLabel: patch.src,
    dstLabel: patch.dst
  });

  return {
    changed,
    affected: unique([patch.src, patch.dst]),
    noop: changed.length === 0,
    moves: [
      moveResultDetails({
        id: patch.id,
        src: patch.src,
        dst: patch.dst,
        payloadSha256: patch.payloadSha256,
        selection
      })
    ]
  };
}

export function selectMove(
  srcFile: Buffer,
  dstFile: Buffer,
  patch: BlockPatch,
  sameFile: boolean
): MoveSelection {
  const source = findSourceRange(srcFile, patch);
  const target = findTargetSelection(dstFile, patch.target.before, patch.target.after, patch.dst);
  return buildMoveSelection(srcFile, source, target, sameFile, patch.dst);
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
      path: dstLabel
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
    // Destination before source: an interrupted cross-file move can leave the
    // payload duplicated in both files, never deleted from both.
    if (dstChanged) {
      await writeAtomic(args.dstPath, next.dst);
    }
    if (srcChanged) {
      await writeAtomic(args.srcPath, next.src);
    }
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

function findSourceRange(file: Buffer, patch: BlockPatch): ByteRange {
  const fullSource = Buffer.concat([patch.sourceBefore, patch.sourcePayload, patch.sourceAfter]);
  const fullMatches = indexesOf(file, fullSource);

  if (fullMatches.length === 1) {
    const start = fullMatches[0] + patch.sourceBefore.length;
    return { start, end: start + patch.sourcePayload.length };
  }

  if (fullMatches.length > 1) {
    fail("source_ambiguous", `Source block is ambiguous in ${patch.src}; matched ${fullMatches.length} locations`, {
      path: patch.src,
      matches: fullMatches.length
    });
  }

  const envelopes = findSourceEnvelopes(file, patch);
  if (envelopes.length === 1) {
    fail("payload_mismatch", `Source payload does not match located source anchors in ${patch.src}`, {
      path: patch.src
    });
  }

  if (envelopes.length > 1) {
    fail("source_ambiguous", `Source anchors are ambiguous in ${patch.src}; matched ${envelopes.length} locations`, {
      path: patch.src,
      matches: envelopes.length
    });
  }

  fail("source_not_found", `Source anchors were not found in ${patch.src}`, { path: patch.src, matches: 0 });
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
  dstLabel: string
): TargetSelection {
  const anchor = Buffer.concat([before, after]);
  const matches = indexesOf(file, anchor);

  if (matches.length === 0) {
    fail("target_not_found", `Target anchor was not found in ${dstLabel}`, { path: dstLabel, matches: 0 });
  }

  if (matches.length > 1) {
    fail("target_ambiguous", `Target anchor is ambiguous in ${dstLabel}; matched ${matches.length} locations`, {
      path: dstLabel,
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

export function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
  const info = await stat(path);
  const dir = dirname(path);
  const base = basename(path);
  const temp = join(dir, `.${base}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);

  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await chmod(temp, info.mode);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
