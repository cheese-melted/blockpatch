import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fail } from "./errors";
import {
  buildMoveSelection,
  commitMove,
  findTargetSelection,
  indexesOf,
  moveResultDetails,
  unique,
  type ByteRange,
  type MoveSelection
} from "./engine";
import { resolvePath } from "./paths";
import type { MoveBlockArgs, MoveBlockOptions, MoveBlockResult } from "./types";

interface NormalizedMoveBlockArgs {
  src: string;
  srcStart: Buffer;
  srcEnd: Buffer;
  dst: string;
  targetBefore: Buffer;
  targetAfter: Buffer;
}

const empty = Buffer.alloc(0);

const moveArgTypes: Record<keyof MoveBlockArgs, "string" | "boolean"> = {
  src: "string",
  src_start: "string",
  src_end: "string",
  dst: "string",
  dst_before: "string",
  dst_after: "string",
  target_before: "string",
  target_after: "string",
  insert: "string",
  dry_run: "boolean"
};

export async function moveBlock(
  args: MoveBlockArgs,
  options: MoveBlockOptions = {}
): Promise<MoveBlockResult> {
  const validated = validateMoveArgs(args);
  const normalized = normalizeArgs(validated);
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun ?? validated.dry_run ?? false;
  const srcPath = resolvePath(cwd, normalized.src, "source path");
  const dstPath = resolvePath(cwd, normalized.dst, "destination path");
  const sameFile = srcPath === dstPath;
  const srcOriginal = await readFile(srcPath);
  const dstOriginal = sameFile ? srcOriginal : await readFile(dstPath);
  const source = findSource(srcOriginal, normalized);
  const target = findTargetSelection(dstOriginal, normalized.targetBefore, normalized.targetAfter, normalized.dst);
  const selection = buildMoveSelection(srcOriginal, source, target, sameFile, normalized.dst);
  const payloadSha256 = createHash("sha256").update(selection.payload).digest("hex");
  const patch = options.diff
    ? renderMovePatch(normalized, srcOriginal, dstOriginal, selection, sameFile, payloadSha256)
    : undefined;

  const changed = await commitMove({
    srcPath,
    dstPath,
    sameFile,
    dryRun: dryRun || options.diff === true,
    srcOriginal,
    dstOriginal,
    selection,
    srcLabel: normalized.src,
    dstLabel: normalized.dst
  });

  return {
    changed,
    affected: unique([normalized.src, normalized.dst]),
    noop: changed.length === 0,
    moves: [
      moveResultDetails({
        id: "move-1",
        src: normalized.src,
        dst: normalized.dst,
        payloadSha256,
        selection
      })
    ],
    patch
  };
}

export function validateMoveArgs(value: unknown): MoveBlockArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid_move_args", "move arguments must be a JSON object");
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    const expected = moveArgTypes[key as keyof MoveBlockArgs];
    if (expected === undefined) {
      fail("invalid_move_args", `Unknown move argument: ${key}`);
    }
    if (typeof fieldValue !== expected) {
      fail("invalid_move_args", `move argument ${key} must be a ${expected}`);
    }
  }

  const args = value as MoveBlockArgs;
  if (args.insert !== undefined && args.insert !== "before" && args.insert !== "after") {
    fail("invalid_move_args", 'move argument insert must be "before" or "after"');
  }

  return args;
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
  const hasTargetBefore = args.target_before !== undefined;
  const hasTargetAfter = args.target_after !== undefined;

  if ((hasTargetBefore || hasTargetAfter) && (hasDstBefore || hasDstAfter)) {
    fail("invalid_move_args", "move cannot combine target_before/target_after with dst_before/dst_after");
  }

  if (hasTargetBefore !== hasTargetAfter) {
    fail("invalid_move_args", "move requires both target_before and target_after");
  }

  if (!hasDstBefore && !hasDstAfter && !hasTargetBefore) {
    fail("invalid_move_args", "move requires dst_before, dst_after, or target_before/target_after");
  }

  if ((hasTargetBefore || (hasDstBefore && hasDstAfter)) && args.insert !== undefined) {
    fail("invalid_move_args", "insert is only valid with a one-sided target anchor");
  }

  let targetBefore: Buffer;
  let targetAfter: Buffer;
  if (hasTargetBefore && hasTargetAfter) {
    targetBefore = Buffer.from(args.target_before ?? "", "utf8");
    targetAfter = Buffer.from(args.target_after ?? "", "utf8");
  } else if (hasDstBefore && hasDstAfter) {
    targetBefore = Buffer.from(args.dst_before ?? "", "utf8");
    targetAfter = Buffer.from(args.dst_after ?? "", "utf8");
  } else if (hasDstBefore) {
    if (args.insert !== undefined && args.insert !== "before") {
      fail("invalid_move_args", "insert=after conflicts with dst_before");
    }
    targetBefore = empty;
    targetAfter = Buffer.from(args.dst_before ?? "", "utf8");
    if (targetAfter.length === 0) {
      fail("invalid_move_args", "move requires a non-empty dst_before");
    }
  } else {
    if (args.insert !== undefined && args.insert !== "after") {
      fail("invalid_move_args", "insert=before conflicts with dst_after");
    }
    targetBefore = Buffer.from(args.dst_after ?? "", "utf8");
    targetAfter = empty;
    if (targetBefore.length === 0) {
      fail("invalid_move_args", "move requires a non-empty dst_after");
    }
  }

  if (targetBefore.length === 0 && targetAfter.length === 0) {
    fail("invalid_move_args", "move requires non-empty target context");
  }

  return {
    src: args.src,
    srcStart: Buffer.from(args.src_start, "utf8"),
    srcEnd: Buffer.from(args.src_end, "utf8"),
    dst: args.dst ?? args.src,
    targetBefore,
    targetAfter
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
    fail("source_not_found", `Source delimiters were not found in ${args.src}`, { path: args.src, matches: 0 });
  }
  if (ranges.length > 1) {
    fail("source_ambiguous", `Source delimiters are ambiguous in ${args.src}; matched ${ranges.length} locations`, {
      path: args.src,
      matches: ranges.length
    });
  }

  return ranges[0];
}

function renderMovePatch(
  args: NormalizedMoveBlockArgs,
  srcOriginal: Buffer,
  dstOriginal: Buffer,
  selection: MoveSelection,
  sameFile: boolean,
  payloadSha256: string
): string {
  const id = "move-1";
  const { source, target, payload } = selection;
  const targetAnchor = Buffer.concat([args.targetBefore, args.targetAfter]);
  const sourceBefore = adjacentLineBefore(srcOriginal, source.start);
  const sourceAfter = adjacentLineAfter(srcOriginal, source.end);
  const payloadLines = countLines(payload);

  const sourceHunkStart = source.start - sourceBefore.length;
  const sourceOldStart = lineNumberAt(srcOriginal, sourceHunkStart);
  const sourceOldCount = countLines(sourceBefore) + payloadLines + countLines(sourceAfter);
  const sourceNewStart =
    sameFile && target.insertIndex <= sourceHunkStart
      ? sourceOldStart + payloadLines
      : sourceOldStart;
  const sourceNewCount = sourceOldCount - payloadLines;

  const targetOldStart = lineNumberAt(dstOriginal, target.range.start);
  const targetOldCount = countLines(targetAnchor);
  const targetNewStart =
    sameFile && source.end <= target.range.start ? targetOldStart - payloadLines : targetOldStart;
  const targetNewCount = targetOldCount + payloadLines;

  const sourceBody = joinPatchChunks([
    renderHunkBytes(sourceBefore, " "),
    renderHunkBytes(payload, "-"),
    renderHunkBytes(sourceAfter, " ")
  ]);
  const targetBody = joinPatchChunks([
    renderHunkBytes(args.targetBefore, " "),
    renderHunkBytes(payload, "+"),
    renderHunkBytes(args.targetAfter, " ")
  ]);

  return [
    `diff --blockpatch a/${args.src} b/${args.dst}`,
    "blockpatch version 0",
    `blockpatch move id=${id} payload-sha256=${payloadSha256}`,
    `--- a/${args.src}`,
    `+++ b/${args.dst}`,
    "",
    `@@ blockpatch-source ${id} -${sourceOldStart},${sourceOldCount} +${sourceNewStart},${sourceNewCount} @@`,
    sourceBody,
    "",
    `@@ blockpatch-target ${id} -${targetOldStart},${targetOldCount} +${targetNewStart},${targetNewCount} @@`,
    targetBody
  ].join("\n");
}

function lineNumberAt(file: Buffer, byteIndex: number): number {
  let line = 1;
  for (let index = 0; index < byteIndex; index += 1) {
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

  let newlines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      newlines += 1;
    }
  }
  return bytes[bytes.length - 1] === 0x0a ? newlines : newlines + 1;
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
