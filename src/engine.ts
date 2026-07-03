import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fail } from "./errors";
import { parseBlockPatch } from "./parser";
import type { ApplyOptions, ApplyResult, BlockPatch } from "./types";

export interface ByteRange {
  start: number;
  end: number;
}

interface TargetSelection {
  range: ByteRange;
  insertIndex: number;
}

interface MoveSelection {
  source: ByteRange;
  target: TargetSelection;
  payload: Buffer;
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
  const cwd = options.cwd ?? process.cwd();
  const patchBytes = await readFile(resolve(cwd, patchPath));
  return runPatchBytes(patchBytes, options);
}

async function runPatchBytes(patchBytes: Buffer, options: ApplyOptions): Promise<ApplyResult> {
  const cwd = options.cwd ?? process.cwd();
  const patch = parseBlockPatch(patchBytes);
  const changed = await applyMovePatch(patch, cwd, options.dryRun ?? false);
  return { changed };
}

async function applyMovePatch(patch: BlockPatch, cwd: string, dryRun: boolean): Promise<string[]> {
  const srcPath = resolve(cwd, patch.src);
  const dstPath = resolve(cwd, patch.dst);
  const sameFile = srcPath === dstPath;
  const srcOriginal = await readFile(srcPath);
  const dstOriginal = sameFile ? srcOriginal : await readFile(dstPath);
  const selection = selectMove(srcOriginal, dstOriginal, patch);
  const next = sameFile
    ? applyMove(srcOriginal, selection)
    : applyCrossFileMove(srcOriginal, dstOriginal, selection);

  if (!dryRun) {
    if (sameFile) {
      if (!next.src.equals(srcOriginal)) {
        await writeAtomic(srcPath, next.src);
      }
    } else {
      if (!next.src.equals(srcOriginal)) {
        await writeAtomic(srcPath, next.src);
      }
      if (!next.dst.equals(dstOriginal)) {
        await writeAtomic(dstPath, next.dst);
      }
    }
  }

  return [...new Set([patch.src, patch.dst])];
}

export function selectMove(srcFile: Buffer, dstFile: Buffer, patch: BlockPatch): MoveSelection {
  const source = findSourceRange(srcFile, patch);
  const target = findTarget(dstFile, patch);

  if (patch.src === patch.dst && rangesOverlap(source, target.range)) {
    fail("target_overlaps_source", `Target anchor for ${patch.dst} overlaps the source block`);
  }

  return {
    source,
    target,
    payload: Buffer.from(srcFile.subarray(source.start, source.end))
  };
}

export function applyMove(file: Buffer, selection: MoveSelection): { src: Buffer; dst: Buffer } {
  const withoutSource = Buffer.concat([
    file.subarray(0, selection.source.start),
    file.subarray(selection.source.end)
  ]);
  const targetIndex =
    selection.target.insertIndex > selection.source.end
      ? selection.target.insertIndex - selection.payload.length
      : selection.target.insertIndex;

  const next = Buffer.concat([
    withoutSource.subarray(0, targetIndex),
    selection.payload,
    withoutSource.subarray(targetIndex)
  ]);
  return { src: next, dst: next };
}

function applyCrossFileMove(
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
    fail("source_ambiguous", `Source block is ambiguous in ${patch.src}; matched ${fullMatches.length} locations`);
  }

  const envelopes = findSourceEnvelopes(file, patch);
  if (envelopes.length === 1) {
    fail("payload_mismatch", `Source payload does not match located source anchors in ${patch.src}`);
  }

  if (envelopes.length > 1) {
    fail("source_ambiguous", `Source anchors are ambiguous in ${patch.src}; matched ${envelopes.length} locations`);
  }

  fail("source_not_found", `Source anchors were not found in ${patch.src}`);
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

function findTarget(file: Buffer, patch: BlockPatch): TargetSelection {
  const matches = indexesOf(file, patch.target.anchor);

  if (matches.length === 0) {
    fail("target_not_found", `Target anchor was not found in ${patch.dst}`);
  }

  if (matches.length > 1) {
    fail("target_ambiguous", `Target anchor is ambiguous in ${patch.dst}; matched ${matches.length} locations`);
  }

  const start = matches[0];
  const end = start + patch.target.anchor.length;
  return {
    range: { start, end },
    insertIndex: patch.target.kind === "before" ? start : end
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
