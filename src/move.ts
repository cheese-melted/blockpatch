import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fail } from "./errors";
import { indexesOf, rangesOverlap, writeAtomic, type ByteRange } from "./engine";
import type { MoveBlockArgs, MoveBlockOptions, MoveBlockResult, TargetKind } from "./types";

interface NormalizedMoveBlockArgs {
  src: string;
  srcStart: Buffer;
  srcEnd: Buffer;
  dst: string;
  targetKind: TargetKind;
  targetAnchor: Buffer;
}

interface TargetSelection {
  range: ByteRange;
  insertIndex: number;
}

export async function moveBlock(
  args: MoveBlockArgs,
  options: MoveBlockOptions = {}
): Promise<MoveBlockResult> {
  const normalized = normalizeArgs(args);
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun ?? args.dry_run ?? false;
  const srcPath = resolve(cwd, normalized.src);
  const dstPath = resolve(cwd, normalized.dst);
  const sameFile = srcPath === dstPath;
  const srcOriginal = await readFile(srcPath);
  const dstOriginal = sameFile ? srcOriginal : await readFile(dstPath);
  const source = findSource(srcOriginal, normalized);
  const payload = Buffer.from(srcOriginal.subarray(source.start, source.end));
  const target = findTarget(dstOriginal, normalized);

  if (sameFile && rangesOverlap(source, target.range)) {
    fail("target_overlaps_source", `Target anchor for ${normalized.dst} overlaps the source block`);
  }

  const updates = sameFile
    ? applySameFileMove(srcOriginal, source, target, payload)
    : applyCrossFileMove(srcOriginal, dstOriginal, source, target, payload);

  const changed = unique([normalized.src, normalized.dst]);
  const patch = options.diff ? renderMovePatch(normalized, srcOriginal, source, payload) : undefined;

  if (!dryRun && !options.diff) {
    await writeAtomic(srcPath, updates.src);
    if (!sameFile) {
      await writeAtomic(dstPath, updates.dst);
    }
  }

  return { changed, patch };
}

function normalizeArgs(args: MoveBlockArgs): NormalizedMoveBlockArgs {
  if (!args.src) {
    fail("invalid_move_args", "move requires src");
  }
  if (!args.src_start) {
    fail("invalid_move_args", "move requires src_start");
  }
  if (!args.src_end) {
    fail("invalid_move_args", "move requires src_end");
  }

  const hasDstBefore = args.dst_before !== undefined;
  const hasDstAfter = args.dst_after !== undefined;
  if (hasDstBefore === hasDstAfter) {
    fail("invalid_move_args", "move requires exactly one of dst_before or dst_after");
  }

  const targetKind: TargetKind = hasDstBefore ? "before" : "after";
  if (args.insert !== undefined && args.insert !== targetKind) {
    fail("invalid_move_args", `insert=${args.insert} conflicts with dst_${targetKind}`);
  }

  return {
    src: args.src,
    srcStart: Buffer.from(args.src_start, "utf8"),
    srcEnd: Buffer.from(args.src_end, "utf8"),
    dst: args.dst ?? args.src,
    targetKind,
    targetAnchor: Buffer.from((hasDstBefore ? args.dst_before : args.dst_after) ?? "", "utf8")
  };
}

function findSource(file: Buffer, args: NormalizedMoveBlockArgs): ByteRange {
  const startMatches = indexesOf(file, args.srcStart);
  const ranges: ByteRange[] = [];

  for (const start of startMatches) {
    const searchFrom = start + args.srcStart.length;
    const endStart = file.indexOf(args.srcEnd, searchFrom);
    if (endStart !== -1) {
      ranges.push({ start, end: endStart + args.srcEnd.length });
    }
  }

  if (ranges.length === 0) {
    fail("source_not_found", `Source delimiters were not found in ${args.src}`);
  }
  if (ranges.length > 1) {
    fail("source_ambiguous", `Source delimiters are ambiguous in ${args.src}; matched ${ranges.length} locations`);
  }

  return ranges[0];
}

function findTarget(file: Buffer, args: NormalizedMoveBlockArgs): TargetSelection {
  const matches = indexesOf(file, args.targetAnchor);
  if (matches.length === 0) {
    fail("target_not_found", `Target anchor was not found in ${args.dst}`);
  }
  if (matches.length > 1) {
    fail("target_ambiguous", `Target anchor is ambiguous in ${args.dst}; matched ${matches.length} locations`);
  }

  const start = matches[0];
  const end = start + args.targetAnchor.length;
  return {
    range: { start, end },
    insertIndex: args.targetKind === "before" ? start : end
  };
}

function applySameFileMove(
  original: Buffer,
  source: ByteRange,
  target: TargetSelection,
  payload: Buffer
): { src: Buffer; dst: Buffer } {
  const withoutSource = Buffer.concat([original.subarray(0, source.start), original.subarray(source.end)]);
  const insertIndex = target.insertIndex >= source.end ? target.insertIndex - payload.length : target.insertIndex;
  const next = Buffer.concat([
    withoutSource.subarray(0, insertIndex),
    payload,
    withoutSource.subarray(insertIndex)
  ]);
  return { src: next, dst: next };
}

function applyCrossFileMove(
  srcOriginal: Buffer,
  dstOriginal: Buffer,
  source: ByteRange,
  target: TargetSelection,
  payload: Buffer
): { src: Buffer; dst: Buffer } {
  return {
    src: Buffer.concat([srcOriginal.subarray(0, source.start), srcOriginal.subarray(source.end)]),
    dst: Buffer.concat([
      dstOriginal.subarray(0, target.insertIndex),
      payload,
      dstOriginal.subarray(target.insertIndex)
    ])
  };
}

function renderMovePatch(
  args: NormalizedMoveBlockArgs,
  srcOriginal: Buffer,
  source: ByteRange,
  payload: Buffer
): string {
  const id = "move-1";
  const sha = createHash("sha256").update(payload).digest("hex");
  const sourceBefore = adjacentLineBefore(srcOriginal, source.start);
  const sourceAfter = adjacentLineAfter(srcOriginal, source.end);
  const sourceLines = renderHunkBytes(payload, "-");
  const sourceBody = joinPatchChunks([
    renderHunkBytes(sourceBefore, " "),
    sourceLines,
    renderHunkBytes(sourceAfter, " ")
  ]);
  const targetLines = renderHunkBytes(payload, "+");
  const targetContext = renderHunkBytes(args.targetAnchor, " ");
  const targetBody =
    args.targetKind === "after"
      ? joinPatchChunks([targetContext, targetLines])
      : joinPatchChunks([targetLines, targetContext]);

  return [
    `diff --blockpatch a/${args.src} b/${args.dst}`,
    "blockpatch version 0",
    `blockpatch move id=${id} payload-sha256=${sha}`,
    `--- a/${args.src}`,
    `+++ b/${args.dst}`,
    "",
    `@@ blockpatch-source ${id} -0,0 +0,0 @@`,
    sourceBody,
    "",
    `@@ blockpatch-target ${id} -0,0 +0,0 @@`,
    targetBody
  ].join("\n");
}

function joinPatchChunks(chunks: string[]): string {
  return chunks.filter((chunk) => chunk.length > 0).join("\n");
}

function adjacentLineBefore(file: Buffer, index: number): Buffer {
  if (index === 0) {
    return Buffer.alloc(0);
  }

  const previousLf = file.lastIndexOf(0x0a, index - 2);
  return Buffer.from(file.subarray(previousLf === -1 ? 0 : previousLf + 1, index));
}

function adjacentLineAfter(file: Buffer, index: number): Buffer {
  if (index >= file.length) {
    return Buffer.alloc(0);
  }

  const nextLf = file.indexOf(0x0a, index);
  return Buffer.from(file.subarray(index, nextLf === -1 ? file.length : nextLf + 1));
}

function renderHunkBytes(bytes: Buffer, prefix: " " | "-" | "+"): string {
  const text = bytes.toString("utf8");
  if (text.length === 0) {
    return "";
  }

  const lines = text.split(/(?<=\n)/);
  return lines
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.endsWith("\n")) {
        return `${prefix}${line.slice(0, -1)}`;
      }
      return `${prefix}${line}\n\\ No newline at end of file`;
    })
    .join("\n");
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}
