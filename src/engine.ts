import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fail } from "./errors";
import { parseBlockPatch } from "./parser";
import type { ApplyOptions, ApplyResult, BlockPatch } from "./types";

interface ByteRange {
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

export async function applyPatchFile(
  patchPath: string,
  options: ApplyOptions = {}
): Promise<ApplyResult> {
  return runPatchFile(patchPath, options);
}

async function runPatchFile(patchPath: string, options: ApplyOptions): Promise<ApplyResult> {
  const cwd = options.cwd ?? process.cwd();
  const patchBytes = await readFile(resolve(cwd, patchPath));
  const patch = parseBlockPatch(patchBytes);
  const changedPath = await applyMovePatch(patch, cwd, options.dryRun ?? false);
  return { changed: [changedPath] };
}

async function applyMovePatch(patch: BlockPatch, cwd: string, dryRun: boolean): Promise<string> {
  const absolutePath = resolve(cwd, patch.path);
  const original = await readFile(absolutePath);
  const selection = selectMove(original, patch);
  const next = applyMove(original, selection);

  if (!dryRun && !next.equals(original)) {
    await writeAtomic(absolutePath, next);
  }

  return patch.path;
}

export function selectMove(file: Buffer, patch: BlockPatch): MoveSelection {
  const source = findSourceRange(file, patch);
  const target = findTarget(file, patch);

  if (rangesOverlap(source, target.range)) {
    fail("target_overlaps_source", `Target anchor for ${patch.path} overlaps the source block`);
  }

  return {
    source,
    target,
    payload: Buffer.from(file.subarray(source.start, source.end))
  };
}

export function applyMove(file: Buffer, selection: MoveSelection): Buffer {
  const withoutSource = Buffer.concat([
    file.subarray(0, selection.source.start),
    file.subarray(selection.source.end)
  ]);
  const targetIndex =
    selection.target.insertIndex > selection.source.end
      ? selection.target.insertIndex - selection.payload.length
      : selection.target.insertIndex;

  return Buffer.concat([
    withoutSource.subarray(0, targetIndex),
    selection.payload,
    withoutSource.subarray(targetIndex)
  ]);
}

function findSourceRange(file: Buffer, patch: BlockPatch): ByteRange {
  const fullSource = Buffer.concat([patch.sourceBefore, patch.sourcePayload, patch.sourceAfter]);
  const fullMatches = indexesOf(file, fullSource);

  if (fullMatches.length === 1) {
    const start = fullMatches[0] + patch.sourceBefore.length;
    return { start, end: start + patch.sourcePayload.length };
  }

  if (fullMatches.length > 1) {
    fail("source_ambiguous", `Source block is ambiguous in ${patch.path}; matched ${fullMatches.length} locations`);
  }

  const envelopes = findSourceEnvelopes(file, patch);
  if (envelopes.length === 1) {
    fail("payload_mismatch", `Source payload does not match located source anchors in ${patch.path}`);
  }

  if (envelopes.length > 1) {
    fail("source_ambiguous", `Source anchors are ambiguous in ${patch.path}; matched ${envelopes.length} locations`);
  }

  fail("source_not_found", `Source anchors were not found in ${patch.path}`);
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
    fail("target_not_found", `Target anchor was not found in ${patch.path}`);
  }

  if (matches.length > 1) {
    fail("target_ambiguous", `Target anchor is ambiguous in ${patch.path}; matched ${matches.length} locations`);
  }

  const start = matches[0];
  const end = start + patch.target.anchor.length;
  return {
    range: { start, end },
    insertIndex: patch.target.kind === "before" ? start : end
  };
}

function indexesOf(haystack: Buffer, needle: Buffer): number[] {
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

function rangesOverlap(left: ByteRange, right: ByteRange): boolean {
  return left.start < right.end && right.start < left.end;
}

async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
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
