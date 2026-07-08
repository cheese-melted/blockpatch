import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { boundedLineRanges, boundedRanges, fail } from "./errors";
import { readFileChecked } from "./files";
import {
  applyPatchBytes,
  buildMoveSelection,
  checkPatchBytesInMemory,
  commitMove,
  findTargetSelection,
  indexesOf,
  moveResultDetails,
  unique,
  writeAtomic,
  type ByteRange,
  type InMemoryPatchFile,
  type TargetSelection,
  type MoveSelection
} from "./engine";
import { devNull } from "./parser";
import { resolvePath, sameFileIdentity, validateOperationPath } from "./paths";
import type { MoveBlockArgs, MoveBlockOptions, MoveBlockResult } from "./types";

interface NormalizedRelocationArgs {
  kind: "relocation";
  src: string;
  srcStart: Buffer;
  srcEnd: Buffer;
  dst: string;
  targetBefore: Buffer;
  targetAfter: Buffer;
}

interface NormalizedInsertionArgs {
  kind: "insertion";
  src: typeof devNull;
  dst: string;
  payload: Buffer;
  targetBefore: Buffer;
  targetAfter: Buffer;
}

interface NormalizedDeletionArgs {
  kind: "deletion";
  src: string;
  srcStart: Buffer;
  srcEnd: Buffer;
  dst: typeof devNull;
}

interface NormalizedFileCreationArgs {
  kind: "create_file";
  src: typeof devNull;
  dst: string;
  payload: Buffer;
}

interface NormalizedFileRemovalArgs {
  kind: "remove_file";
  src: string;
  dst: typeof devNull;
}

type NormalizedMoveBlockArgs =
  | NormalizedRelocationArgs
  | NormalizedInsertionArgs
  | NormalizedDeletionArgs
  | NormalizedFileCreationArgs
  | NormalizedFileRemovalArgs;

const moveArgTypes: Record<keyof MoveBlockArgs, "string" | "boolean"> = {
  src: "string",
  src_start: "string",
  src_end: "string",
  dst: "string",
  payload: "string",
  target_before: "string",
  target_after: "string",
  expected_payload_sha256: "string",
  mode: "string",
  dry_run: "boolean"
};
const moveModes = new Set(["create_file", "remove_file"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function moveBlock(
  args: MoveBlockArgs,
  options: MoveBlockOptions = {}
): Promise<MoveBlockResult> {
  const validated = validateMoveArgs(args);
  const normalized = normalizeArgs(validated);
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun ?? validated.dry_run ?? false;
  if (normalized.kind === "create_file") {
    return createFile(normalized, validated, cwd, dryRun, options);
  }
  if (normalized.kind === "remove_file") {
    return removeFile(normalized, validated, cwd, dryRun, options);
  }
  if (normalized.kind === "insertion") {
    return insertPayload(normalized, validated, cwd, dryRun, options);
  }
  if (normalized.kind === "deletion") {
    return deletePayload(normalized, validated, cwd, dryRun, options);
  }

  const srcPath = resolvePath(cwd, normalized.src, "source path");
  const dstPath = resolvePath(cwd, normalized.dst, "destination path");
  const sameFile = await sameFileIdentity(srcPath, dstPath);
  const srcOriginal = await readFileChecked(srcPath, "source file");
  const dstOriginal = sameFile ? srcOriginal : await readFileChecked(dstPath, "destination file");
  const source = findSource(srcOriginal, normalized);
  const target = findTargetSelection(dstOriginal, normalized.targetBefore, normalized.targetAfter, normalized.dst, {
    phase: "target",
    anchor: targetAnchorName(normalized)
  });
  const selection = buildMoveSelection(srcOriginal, source, target, sameFile, normalized.dst);
  const payloadSha256 = createHash("sha256").update(selection.payload).digest("hex");
  verifyExpectedPayloadHash(validated, payloadSha256);
  const samePatchLabel = samePatchPath(normalized.src, normalized.dst);
  const patch = options.diff
    ? renderMovePatch(normalized, srcOriginal, dstOriginal, selection, sameFile && samePatchLabel, payloadSha256)
    : undefined;
  await selfCheckRenderedPatch(
    patch,
    pairedSelfCheckFiles(normalized.src, normalized.dst, srcOriginal, dstOriginal, sameFile)
  );
  const writeSuppressed = dryRun || options.diff === true;

  const changed = await commitMove({
    srcPath,
    dstPath,
    sameFile,
    dryRun: writeSuppressed,
    srcOriginal,
    dstOriginal,
    selection,
    srcLabel: normalized.src,
    dstLabel: normalized.dst
  });

  return {
    changed,
    affected: unique([normalized.src, normalized.dst]),
    written: !writeSuppressed && changed.length > 0,
    noop: changed.length === 0,
    status: changed.length === 0 ? "noop" : "applied",
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
      fail("invalid_move_args", `Unknown move argument: ${key}`, { field: key });
    }
    if (typeof fieldValue !== expected) {
      fail("invalid_move_args", `move argument ${key} must be a ${expected}`, { field: key });
    }
  }

  const args = value as MoveBlockArgs;
  if (
    args.expected_payload_sha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(args.expected_payload_sha256)
  ) {
    fail("invalid_move_args", "expected_payload_sha256 must be a 64-character lowercase sha256 hex digest", {
      field: "expected_payload_sha256"
    });
  }
  if (args.mode !== undefined && !moveModes.has(args.mode)) {
    fail("invalid_move_args", "mode must be create_file or remove_file", { field: "mode" });
  }

  return args;
}

function normalizeArgs(args: MoveBlockArgs): NormalizedMoveBlockArgs {
  if (!args.src) {
    fail("invalid_move_args", "move requires src", { field: "src" });
  }
  if (args.src !== devNull) {
    validateOperationPath(args.src, "source path");
  }
  if (args.dst !== undefined && args.dst !== devNull) {
    validateOperationPath(args.dst, "destination path");
  }

  if (args.mode === "create_file") {
    return normalizeFileCreationArgs(args);
  }
  if (args.mode === "remove_file") {
    return normalizeFileRemovalArgs(args);
  }

  const dst = args.dst ?? args.src;
  if (args.src === devNull && dst === devNull) {
    fail("invalid_move_args", "move cannot use /dev/null for both src and dst", { field: "dst" });
  }

  if (args.src === devNull) {
    if (args.dst === undefined) {
      fail("invalid_move_args", "move from /dev/null requires dst", { field: "dst" });
    }
    if (args.src_start !== undefined || args.src_end !== undefined) {
      fail("invalid_move_args", "move from /dev/null uses payload instead of src_start/src_end", {
        field: args.src_start !== undefined ? "src_start" : "src_end"
      });
    }
    if (args.payload === undefined) {
      fail("invalid_move_args", "move from /dev/null requires payload", { field: "payload" });
    }
    if (args.payload.length === 0) {
      fail("invalid_move_args", "move from /dev/null requires non-empty payload", { field: "payload" });
    }
    const target = normalizeTargetArgs(args);
    return {
      kind: "insertion",
      src: devNull,
      dst: args.dst,
      payload: Buffer.from(args.payload, "utf8"),
      targetBefore: target.before,
      targetAfter: target.after
    };
  }

  if (dst === devNull) {
    if (args.payload !== undefined) {
      fail("invalid_move_args", "move to /dev/null selects payload from src_start/src_end", { field: "payload" });
    }
    if (args.target_before !== undefined || args.target_after !== undefined) {
      fail("invalid_move_args", "move to /dev/null must not include target anchors", {
        field: args.target_before !== undefined ? "target_before" : "target_after"
      });
    }
    return {
      kind: "deletion",
      src: args.src,
      srcStart: requiredBuffer(args.src_start, "src_start"),
      srcEnd: requiredBuffer(args.src_end, "src_end"),
      dst: devNull
    };
  }

  if (args.payload !== undefined) {
    fail("invalid_move_args", "payload is only valid when src is /dev/null", { field: "payload" });
  }

  const target = normalizeTargetArgs(args);

  return {
    kind: "relocation",
    src: args.src,
    srcStart: requiredBuffer(args.src_start, "src_start"),
    srcEnd: requiredBuffer(args.src_end, "src_end"),
    dst,
    targetBefore: target.before,
    targetAfter: target.after
  };
}

function normalizeFileCreationArgs(args: MoveBlockArgs): NormalizedFileCreationArgs {
  if (args.src !== devNull) {
    fail("invalid_move_args", "create_file mode requires src to be /dev/null", { field: "src" });
  }
  if (args.dst === undefined) {
    fail("invalid_move_args", "create_file mode requires dst", { field: "dst" });
  }
  if (args.dst === devNull) {
    fail("invalid_move_args", "create_file mode cannot target /dev/null", { field: "dst" });
  }
  if (args.payload === undefined) {
    fail("invalid_move_args", "create_file mode requires payload", { field: "payload" });
  }
  rejectSourceSelectionArgs(args, "create_file mode uses payload as the whole-file content");
  rejectTargetAnchorArgs(args, "create_file mode must not include target anchors");

  return {
    kind: "create_file",
    src: devNull,
    dst: args.dst,
    payload: Buffer.from(args.payload, "utf8")
  };
}

function normalizeFileRemovalArgs(args: MoveBlockArgs): NormalizedFileRemovalArgs {
  if (args.src === devNull) {
    fail("invalid_move_args", "remove_file mode requires a real src path", { field: "src" });
  }
  if (args.dst !== devNull) {
    fail("invalid_move_args", "remove_file mode requires dst to be /dev/null", { field: "dst" });
  }
  if (args.payload !== undefined) {
    fail("invalid_move_args", "remove_file mode reads the whole-file payload from src", { field: "payload" });
  }
  rejectSourceSelectionArgs(args, "remove_file mode removes the whole src file");
  rejectTargetAnchorArgs(args, "remove_file mode must not include target anchors");

  return {
    kind: "remove_file",
    src: args.src,
    dst: devNull
  };
}

function rejectSourceSelectionArgs(args: MoveBlockArgs, message: string): void {
  if (args.src_start !== undefined || args.src_end !== undefined) {
    fail("invalid_move_args", message, {
      field: args.src_start !== undefined ? "src_start" : "src_end"
    });
  }
}

function rejectTargetAnchorArgs(args: MoveBlockArgs, message: string): void {
  if (args.target_before !== undefined || args.target_after !== undefined) {
    fail("invalid_move_args", message, {
      field: args.target_before !== undefined ? "target_before" : "target_after"
    });
  }
}

function normalizeTargetArgs(args: MoveBlockArgs): { before: Buffer; after: Buffer } {
  const hasTargetBefore = args.target_before !== undefined;
  const hasTargetAfter = args.target_after !== undefined;

  if (!hasTargetBefore && !hasTargetAfter) {
    fail("invalid_move_args", "move requires target_before or target_after", { field: "target_before" });
  }

  const targetBefore = Buffer.from(args.target_before ?? "", "utf8");
  const targetAfter = Buffer.from(args.target_after ?? "", "utf8");

  if (targetBefore.length === 0 && targetAfter.length === 0) {
    fail("invalid_move_args", "move requires non-empty target context", { field: "target_before" });
  }

  return { before: targetBefore, after: targetAfter };
}

function requiredBuffer(value: string | undefined, field: "src_start" | "src_end"): Buffer {
  if (!value) {
    fail("invalid_move_args", `move requires ${field}`, { field });
  }
  return Buffer.from(value, "utf8");
}

async function createFile(
  args: NormalizedFileCreationArgs,
  validated: MoveBlockArgs,
  cwd: string,
  dryRun: boolean,
  options: MoveBlockOptions
): Promise<MoveBlockResult> {
  const payloadSha256 = createHash("sha256").update(args.payload).digest("hex");
  verifyExpectedPayloadHash(validated, payloadSha256);
  const patch = renderFileCreationPatch(args, payloadSha256);
  return runRenderedPatch(patch, cwd, dryRun, options);
}

async function removeFile(
  args: NormalizedFileRemovalArgs,
  validated: MoveBlockArgs,
  cwd: string,
  dryRun: boolean,
  options: MoveBlockOptions
): Promise<MoveBlockResult> {
  const srcPath = resolvePath(cwd, args.src, "source path");
  const payload = await readFileChecked(srcPath, "source file");
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  verifyExpectedPayloadHash(validated, payloadSha256);
  const patch = renderFileRemovalPatch(args, payload, payloadSha256);
  return runRenderedPatch(patch, cwd, dryRun, options);
}

async function runRenderedPatch(
  patch: string,
  cwd: string,
  dryRun: boolean,
  options: MoveBlockOptions
): Promise<MoveBlockResult> {
  const writeSuppressed = dryRun || options.diff === true;
  const result = await applyPatchBytes(Buffer.from(patch, "utf8"), { cwd, dryRun: writeSuppressed });
  return {
    ...result,
    patch: options.diff === true ? patch : undefined
  };
}

async function insertPayload(
  args: NormalizedInsertionArgs,
  validated: MoveBlockArgs,
  cwd: string,
  dryRun: boolean,
  options: MoveBlockOptions
): Promise<MoveBlockResult> {
  const dstPath = resolvePath(cwd, args.dst, "destination path");
  const original = await readFileChecked(dstPath, "destination file");
  const payloadSha256 = createHash("sha256").update(args.payload).digest("hex");
  verifyExpectedPayloadHash(validated, payloadSha256);

  const alreadyApplied = findAlreadyAppliedTarget(original, args, args.dst);
  if (alreadyApplied !== undefined) {
    const renderedPatch = options.diff ? renderInsertionPatch(args, original, alreadyApplied, payloadSha256) : undefined;
    await selfCheckRenderedPatch(renderedPatch, [{ path: args.dst, bytes: original }]);
    return {
      changed: [],
      affected: [args.dst],
      written: false,
      noop: true,
      status: "already_applied",
      moves: [
        {
          id: "move-1",
          src: devNull,
          dst: args.dst,
          payload_sha256: payloadSha256,
          payload_bytes: args.payload.length,
          source_range: null,
          target_range: alreadyApplied.range,
          insert_index: alreadyApplied.insertIndex
        }
      ],
      patch: renderedPatch
    };
  }

  const target = findTargetSelection(original, args.targetBefore, args.targetAfter, args.dst, {
    phase: "target",
    anchor: targetAnchorName(args)
  });
  const renderedPatch = options.diff ? renderInsertionPatch(args, original, target, payloadSha256) : undefined;
  await selfCheckRenderedPatch(renderedPatch, [{ path: args.dst, bytes: original }]);
  const writeSuppressed = dryRun || options.diff === true;
  const next = Buffer.concat([
    original.subarray(0, target.insertIndex),
    args.payload,
    original.subarray(target.insertIndex)
  ]);
  const changed = next.equals(original) ? [] : [args.dst];

  if (!writeSuppressed && changed.length > 0) {
    await writeAtomic(dstPath, next);
  }

  return {
    changed,
    affected: [args.dst],
    written: !writeSuppressed && changed.length > 0,
    noop: changed.length === 0,
    status: changed.length === 0 ? "noop" : "applied",
    moves: [
      {
        id: "move-1",
        src: devNull,
        dst: args.dst,
        payload_sha256: payloadSha256,
        payload_bytes: args.payload.length,
        source_range: null,
        target_range: target.range,
        insert_index: target.insertIndex
      }
    ],
    patch: renderedPatch
  };
}

function verifyExpectedPayloadHash(args: MoveBlockArgs, payloadSha256: string): void {
  if (args.expected_payload_sha256 !== undefined && args.expected_payload_sha256 !== payloadSha256) {
    fail("hash_mismatch", "expected_payload_sha256 does not match selected source payload", {
      field: "expected_payload_sha256",
      phase: "payload",
      anchor: "expected_payload_sha256"
    });
  }
}

function findAlreadyAppliedTarget(
  file: Buffer,
  args: NormalizedInsertionArgs,
  dstLabel: string
): TargetSelection | undefined {
  const alreadyApplied = Buffer.concat([args.targetBefore, args.payload, args.targetAfter]);
  const matches = indexesOf(file, alreadyApplied);

  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    const ranges = boundedRanges(matches.map((start) => ({ start, end: start + alreadyApplied.length })));
    fail("target_ambiguous", `Already-applied target is ambiguous in ${dstLabel}; matched ${matches.length} locations`, {
      path: dstLabel,
      phase: "target",
      anchor: "target_before+payload+target_after",
      matches: matches.length,
      ranges,
      line_ranges: boundedLineRanges(file, ranges)
    });
  }

  const start = matches[0];
  return {
    range: { start, end: start + alreadyApplied.length },
    insertIndex: start + args.targetBefore.length
  };
}

async function deletePayload(
  args: NormalizedDeletionArgs,
  validated: MoveBlockArgs,
  cwd: string,
  dryRun: boolean,
  options: MoveBlockOptions
): Promise<MoveBlockResult> {
  const srcPath = resolvePath(cwd, args.src, "source path");
  const original = await readFileChecked(srcPath, "source file");
  const source = findSource(original, args);
  const payload = Buffer.from(original.subarray(source.start, source.end));
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  verifyExpectedPayloadHash(validated, payloadSha256);

  const renderedPatch = options.diff ? renderDeletionPatch(args, original, source, payload, payloadSha256) : undefined;
  await selfCheckRenderedPatch(renderedPatch, [{ path: args.src, bytes: original }]);
  const writeSuppressed = dryRun || options.diff === true;
  const next = Buffer.concat([original.subarray(0, source.start), original.subarray(source.end)]);
  const changed = next.equals(original) ? [] : [args.src];

  if (!writeSuppressed && changed.length > 0) {
    await writeAtomic(srcPath, next);
  }

  return {
    changed,
    affected: [args.src],
    written: !writeSuppressed && changed.length > 0,
    noop: changed.length === 0,
    status: changed.length === 0 ? "noop" : "applied",
    moves: [
      {
        id: "move-1",
        src: args.src,
        dst: devNull,
        payload_sha256: payloadSha256,
        payload_bytes: payload.length,
        source_range: source,
        target_range: null,
        insert_index: null
      }
    ],
    patch: renderedPatch
  };
}

function findSource(file: Buffer, args: NormalizedRelocationArgs | NormalizedDeletionArgs): ByteRange {
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
    fail("source_not_found", `Source delimiters were not found in ${args.src}`, {
      path: args.src,
      phase: "source",
      anchor: "src_start/src_end",
      matches: 0
    });
  }
  if (ranges.length > 1) {
    fail("source_ambiguous", `Source delimiters are ambiguous in ${args.src}; matched ${ranges.length} locations`, {
      path: args.src,
      phase: "source",
      anchor: "src_start/src_end",
      matches: ranges.length,
      ranges: boundedRanges(ranges),
      line_ranges: boundedLineRanges(file, ranges)
    });
  }

  return ranges[0];
}

function targetAnchorName(args: NormalizedRelocationArgs | NormalizedInsertionArgs): string {
  if (args.targetBefore.length > 0 && args.targetAfter.length > 0) {
    return "target_before+target_after";
  }
  return args.targetBefore.length > 0 ? "target_before" : "target_after";
}

function samePatchPath(left: string, right: string): boolean {
  return posix.normalize(left) === posix.normalize(right);
}

async function selfCheckRenderedPatch(
  patch: string | undefined,
  files: readonly InMemoryPatchFile[]
): Promise<void> {
  if (patch === undefined) {
    return;
  }
  checkPatchBytesInMemory(Buffer.from(patch, "utf8"), files);
}

function pairedSelfCheckFiles(
  srcLabel: string,
  dstLabel: string,
  srcOriginal: Buffer,
  dstOriginal: Buffer,
  sameFile: boolean
): InMemoryPatchFile[] {
  const identity = sameFile ? "move-file" : undefined;
  const files: InMemoryPatchFile[] = [{ path: srcLabel, bytes: srcOriginal, identity }];
  if (dstLabel !== srcLabel) {
    files.push({ path: dstLabel, bytes: dstOriginal, identity });
  }
  return files;
}

function renderMovePatch(
  args: NormalizedRelocationArgs,
  srcOriginal: Buffer,
  dstOriginal: Buffer,
  selection: MoveSelection,
  sameFile: boolean,
  payloadSha256: string
): string {
  const id = "move-1";
  const { source, target, payload } = selection;
  const sourceBefore = adjacentLineBefore(srcOriginal, source.start);
  const sourceAfter = adjacentLineAfter(srcOriginal, source.end);
  const targetBefore =
    args.targetBefore.length === 0
      ? adjacentLineBefore(dstOriginal, target.range.start)
      : args.targetBefore;
  const targetAfter =
    args.targetAfter.length === 0
      ? adjacentLineAfter(dstOriginal, target.range.end)
      : args.targetAfter;
  const payloadLines = countLines(payload);

  const sourceHunkStart = source.start - sourceBefore.length;
  const sourceOldStart = lineNumberAt(srcOriginal, sourceHunkStart);
  const sourceOldCount = countLines(sourceBefore) + payloadLines + countLines(sourceAfter);
  const sourceNewStart =
    sameFile && target.insertIndex <= sourceHunkStart
      ? sourceOldStart + payloadLines
      : sourceOldStart;
  const sourceNewCount = sourceOldCount - payloadLines;

  const targetHunkStart = target.insertIndex - targetBefore.length;
  const targetOldStart = lineNumberAt(dstOriginal, targetHunkStart);
  const targetOldCount = countLines(targetBefore) + countLines(targetAfter);
  const targetNewStart =
    sameFile && source.end <= targetHunkStart ? targetOldStart - payloadLines : targetOldStart;
  const targetNewCount = targetOldCount + payloadLines;

  const sourceBody = joinPatchChunks([
    renderHunkBytes(sourceBefore, " "),
    renderHunkBytes(payload, "-"),
    renderHunkBytes(sourceAfter, " ")
  ]);
  const targetBody = joinPatchChunks([
    renderHunkBytes(targetBefore, " "),
    renderHunkBytes(payload, "+"),
    renderHunkBytes(targetAfter, " ")
  ]);

  const sourceHunkHeader =
    `@@ -${sourceOldStart},${sourceOldCount} +${sourceNewStart},${sourceNewCount} @@ blockpatch-source id=${id}`;
  const targetHunkHeader =
    `@@ -${targetOldStart},${targetOldCount} +${targetNewStart},${targetNewCount} @@ blockpatch-target id=${id}`;

  if (!sameFile) {
    return [
      `diff --blockpatch a/${args.src} b/${args.src}`,
      "blockpatch version 1",
      `blockpatch move id=${id} role=source payload-sha256=${payloadSha256}`,
      `--- a/${args.src}`,
      `+++ b/${args.src}`,
      "",
      sourceHunkHeader,
      sourceBody,
      "",
      `diff --blockpatch a/${args.dst} b/${args.dst}`,
      "blockpatch version 1",
      `blockpatch move id=${id} role=target payload-sha256=${payloadSha256}`,
      `--- a/${args.dst}`,
      `+++ b/${args.dst}`,
      "",
      targetHunkHeader,
      targetBody
    ].join("\n") + "\n";
  }

  return [
    `diff --blockpatch a/${args.src} b/${args.dst}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha256}`,
    `--- a/${args.src}`,
    `+++ b/${args.dst}`,
    "",
    sourceHunkHeader,
    sourceBody,
    targetHunkHeader,
    targetBody
  ].join("\n") + "\n";
}

function renderInsertionPatch(
  args: NormalizedInsertionArgs,
  dstOriginal: Buffer,
  target: TargetSelection,
  payloadSha256: string
): string {
  const id = "move-1";
  const targetBefore =
    args.targetBefore.length === 0
      ? adjacentLineBefore(dstOriginal, target.range.start)
      : args.targetBefore;
  const targetAfter =
    args.targetAfter.length === 0
      ? adjacentLineAfter(dstOriginal, target.range.end)
      : args.targetAfter;
  const payloadLines = countLines(args.payload);
  const targetHunkStart = target.insertIndex - targetBefore.length;
  const targetOldStart = lineNumberAt(dstOriginal, targetHunkStart);
  const targetOldCount = countLines(targetBefore) + countLines(targetAfter);
  const targetNewCount = targetOldCount + payloadLines;
  const targetBody = joinPatchChunks([
    renderHunkBytes(targetBefore, " "),
    renderHunkBytes(args.payload, "+"),
    renderHunkBytes(targetAfter, " ")
  ]);

  return [
    `diff --blockpatch a/${args.dst} b/${args.dst}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha256}`,
    `--- a/${args.dst}`,
    `+++ b/${args.dst}`,
    "",
    `@@ -${targetOldStart},${targetOldCount} +${targetOldStart},${targetNewCount} @@ blockpatch-target id=${id}`,
    targetBody
  ].join("\n") + "\n";
}

function renderDeletionPatch(
  args: NormalizedDeletionArgs,
  srcOriginal: Buffer,
  source: ByteRange,
  payload: Buffer,
  payloadSha256: string
): string {
  const id = "move-1";
  const sourceBefore = adjacentLineBefore(srcOriginal, source.start);
  const sourceAfter = adjacentLineAfter(srcOriginal, source.end);
  const payloadLines = countLines(payload);
  const sourceHunkStart = source.start - sourceBefore.length;
  const sourceOldStart = lineNumberAt(srcOriginal, sourceHunkStart);
  const sourceOldCount = countLines(sourceBefore) + payloadLines + countLines(sourceAfter);
  const sourceNewCount = sourceOldCount - payloadLines;
  const sourceBody = joinPatchChunks([
    renderHunkBytes(sourceBefore, " "),
    renderHunkBytes(payload, "-"),
    renderHunkBytes(sourceAfter, " ")
  ]);

  return [
    `diff --blockpatch a/${args.src} b/${args.src}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha256}`,
    `--- a/${args.src}`,
    `+++ b/${args.src}`,
    "",
    `@@ -${sourceOldStart},${sourceOldCount} +${sourceOldStart},${sourceNewCount} @@ blockpatch-source id=${id}`,
    sourceBody
  ].join("\n") + "\n";
}

function renderFileCreationPatch(args: NormalizedFileCreationArgs, payloadSha256: string): string {
  const id = "move-1";
  const payloadLines = countLines(args.payload);
  const targetBody = renderHunkBytes(args.payload, "+");

  return [
    `diff --blockpatch ${devNull} b/${args.dst}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha256}`,
    `--- ${devNull}`,
    `+++ b/${args.dst}`,
    "",
    `@@ -0,0 +${payloadLines === 0 ? "0,0" : `1,${payloadLines}`} @@ blockpatch-target id=${id}`,
    targetBody
  ].join("\n") + "\n";
}

function renderFileRemovalPatch(
  args: NormalizedFileRemovalArgs,
  payload: Buffer,
  payloadSha256: string
): string {
  const id = "move-1";
  const payloadLines = countLines(payload);
  const sourceBody = renderHunkBytes(payload, "-");

  return [
    `diff --blockpatch a/${args.src} ${devNull}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha256}`,
    `--- a/${args.src}`,
    `+++ ${devNull}`,
    "",
    `@@ -${payloadLines === 0 ? "0,0" : `1,${payloadLines}`} +0,0 @@ blockpatch-source id=${id}`,
    sourceBody
  ].join("\n") + "\n";
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
  const text = decodeUtf8(bytes);
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

function decodeUtf8(bytes: Buffer): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    fail("invalid_utf8", "move --diff cannot render invalid UTF-8 bytes", {
      phase: "render",
      anchor: "move --diff"
    });
  }
}
