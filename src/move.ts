import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import {
  boundedLineRanges,
  boundedMatchLineRanges,
  boundedMatchRanges,
  boundedRanges,
  fail,
  matchCountDetails,
  matchedLocations
} from "./errors";
import { readFileChecked, readFileSnapshot } from "./files";
import { byteRangeToLineRange, countLines, lineNumberAt, normalizedLimit } from "./locations";
import {
  applyPatchBytes,
  buildMoveSelection,
  commitMove,
  findTargetSelection,
  indexesOfLimited,
  moveResultDetails,
  unique,
  validatePatchBytesInMemory,
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
  targetAnchor: string;
}

interface NormalizedInsertionArgs {
  kind: "insertion";
  src: typeof devNull;
  dst: string;
  payload: Buffer;
  targetBefore: Buffer;
  targetAfter: Buffer;
  targetAnchor: string;
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

interface LimitedRanges {
  ranges: ByteRange[];
  truncated: boolean;
}

const moveArgTypes: Record<keyof MoveBlockArgs, "string" | "boolean"> = {
  src: "string",
  src_start: "string",
  src_end: "string",
  dst: "string",
  payload: "string",
  target_before: "string",
  target_after: "string",
  insert_before: "string",
  insert_after: "string",
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
  const srcSnapshot = await readFileSnapshot(srcPath, "source file");
  const dstSnapshot = sameFile ? srcSnapshot : await readFileSnapshot(dstPath, "destination file");
  const srcOriginal = srcSnapshot.bytes;
  const dstOriginal = dstSnapshot.bytes;
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
    srcSnapshot,
    dstSnapshot,
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
        selection,
        srcFile: srcOriginal,
        dstFile: dstOriginal
      })
    ],
    patch,
    warnings: insertionBoundaryWarnings(
      normalized.dst,
      normalized.targetBefore,
      selection.payload,
      normalized.targetAfter
    )
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
      targetAfter: target.after,
      targetAnchor: target.anchor
    };
  }

  if (dst === devNull) {
    if (args.payload !== undefined) {
      fail("invalid_move_args", "move to /dev/null selects payload from src_start/src_end", { field: "payload" });
    }
    if (
      args.target_before !== undefined ||
      args.target_after !== undefined ||
      args.insert_before !== undefined ||
      args.insert_after !== undefined
    ) {
      fail("invalid_move_args", "move to /dev/null must not include target anchors", {
        field: targetAnchorField(args)
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
    targetAfter: target.after,
    targetAnchor: target.anchor
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
  if (
    args.target_before !== undefined ||
    args.target_after !== undefined ||
    args.insert_before !== undefined ||
    args.insert_after !== undefined
  ) {
    fail("invalid_move_args", message, {
      field: targetAnchorField(args)
    });
  }
}

function normalizeTargetArgs(args: MoveBlockArgs): { before: Buffer; after: Buffer; anchor: string } {
  if (args.target_before !== undefined && args.insert_after !== undefined) {
    fail("invalid_move_args", "move cannot combine target_before and insert_after", { field: "insert_after" });
  }
  if (args.target_after !== undefined && args.insert_before !== undefined) {
    fail("invalid_move_args", "move cannot combine target_after and insert_before", { field: "insert_before" });
  }

  const hasTargetBefore = args.target_before !== undefined || args.insert_after !== undefined;
  const hasTargetAfter = args.target_after !== undefined || args.insert_before !== undefined;

  if (!hasTargetBefore && !hasTargetAfter) {
    fail("invalid_move_args", "move requires target_before, target_after, insert_before, or insert_after", {
      field: "target_before"
    });
  }

  const targetBefore = Buffer.from(args.target_before ?? args.insert_after ?? "", "utf8");
  const targetAfter = Buffer.from(args.target_after ?? args.insert_before ?? "", "utf8");

  if (targetBefore.length === 0 && targetAfter.length === 0) {
    fail("invalid_move_args", "move requires non-empty target context", { field: targetAnchorField(args) });
  }

  return { before: targetBefore, after: targetAfter, anchor: targetAnchorNameFromArgs(args) };
}

function targetAnchorField(args: MoveBlockArgs): keyof MoveBlockArgs {
  if (args.target_before !== undefined) {
    return "target_before";
  }
  if (args.target_after !== undefined) {
    return "target_after";
  }
  if (args.insert_before !== undefined) {
    return "insert_before";
  }
  return "insert_after";
}

function targetAnchorNameFromArgs(args: MoveBlockArgs): string {
  const before =
    args.target_before !== undefined ? "target_before" : args.insert_after !== undefined ? "insert_after" : undefined;
  const after =
    args.target_after !== undefined ? "target_after" : args.insert_before !== undefined ? "insert_before" : undefined;

  if (before !== undefined && after !== undefined) {
    return `${before}+${after}`;
  }
  return before ?? after ?? "target_before";
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
  const snapshot = await readFileSnapshot(dstPath, "destination file");
  const original = snapshot.bytes;
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
          payload_lines: countLines(args.payload),
          payload_hash_verified: true,
          source_range: null,
          source_line_range: null,
          target_range: alreadyApplied.range,
          target_line_range: byteRangeToLineRange(original, alreadyApplied.range),
          insert_index: alreadyApplied.insertIndex,
          insert_line: lineNumberAt(original, alreadyApplied.insertIndex)
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
    await writeAtomic(dstPath, next, {
      expected: { kind: "file", label: args.dst, snapshot }
    });
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
        payload_lines: countLines(args.payload),
        payload_hash_verified: true,
        source_range: null,
        source_line_range: null,
        target_range: target.range,
        target_line_range: byteRangeToLineRange(original, target.range),
        insert_index: target.insertIndex,
        insert_line: lineNumberAt(original, target.insertIndex)
      }
    ],
    patch: renderedPatch,
    warnings: insertionBoundaryWarnings(args.dst, args.targetBefore, args.payload, args.targetAfter)
  };
}

function insertionBoundaryWarnings(
  path: string,
  targetBefore: Buffer,
  payload: Buffer,
  targetAfter: Buffer
): MoveBlockResult["warnings"] {
  const warnings: MoveBlockResult["warnings"] = [];

  if (targetBefore.length > 0 && payload.length > 0 && !endsWithLf(targetBefore) && !startsWithLf(payload)) {
    warnings.push({
      code: "adjacent_bytes",
      message:
        "Insertion will place payload immediately after target_before with no newline or separator inserted by blockpatch",
      path,
      phase: "target",
      boundary: "target_before+payload",
      suggested_action: "include the intended newline in target_before or at the start of payload"
    });
  }

  if (payload.length > 0 && targetAfter.length > 0 && !endsWithLf(payload) && !startsWithLf(targetAfter)) {
    warnings.push({
      code: "adjacent_bytes",
      message:
        "Insertion will place target_after immediately after payload with no newline or separator inserted by blockpatch",
      path,
      phase: "target",
      boundary: "payload+target_after",
      suggested_action: "include the intended newline at the end of payload or at the start of target_after"
    });
  }

  return warnings.length > 0 ? warnings : undefined;
}

function startsWithLf(bytes: Buffer): boolean {
  return bytes[0] === 0x0a;
}

function endsWithLf(bytes: Buffer): boolean {
  return bytes[bytes.length - 1] === 0x0a;
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
  const matchResult = indexesOfLimited(file, alreadyApplied);
  const matches = matchResult.matches;

  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1 || matchResult.truncated) {
    const ranges = boundedRanges(matches.map((start) => ({ start, end: start + alreadyApplied.length })));
    fail("target_ambiguous", `Already-applied target is ambiguous in ${dstLabel}; ${matchedLocations(matches.length, matchResult.truncated)}`, {
      path: dstLabel,
      phase: "target",
      anchor: "target_before+payload+target_after",
      ...matchCountDetails(matches.length, matchResult.truncated),
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
  const snapshot = await readFileSnapshot(srcPath, "source file");
  const original = snapshot.bytes;
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
    await writeAtomic(srcPath, next, {
      expected: { kind: "file", label: args.src, snapshot }
    });
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
        payload_lines: countLines(payload),
        payload_hash_verified: true,
        source_range: source,
        source_line_range: byteRangeToLineRange(original, source),
        target_range: null,
        target_line_range: null,
        insert_index: null,
        insert_line: null
      }
    ],
    patch: renderedPatch
  };
}

function findSource(file: Buffer, args: NormalizedRelocationArgs | NormalizedDeletionArgs): ByteRange {
  const result = findDelimitedRanges(file, args.srcStart, args.srcEnd);
  const ranges = result.ranges;

  if (ranges.length === 0) {
    fail("source_not_found", sourceNotFoundMessage(file, args), {
      path: args.src,
      phase: "source",
      anchor: "src_start/src_end",
      matches: 0,
      ...sourceNotFoundDetails(file, args)
    });
  }
  if (ranges.length > 1 || result.truncated) {
    fail("source_ambiguous", `Source delimiters are ambiguous in ${args.src}; ${matchedLocations(ranges.length, result.truncated)}`, {
      path: args.src,
      phase: "source",
      anchor: "src_start/src_end",
      ...matchCountDetails(ranges.length, result.truncated),
      ranges: boundedRanges(ranges),
      line_ranges: boundedLineRanges(file, ranges)
    });
  }

  return ranges[0];
}

function sourceNotFoundMessage(file: Buffer, args: NormalizedRelocationArgs | NormalizedDeletionArgs): string {
  const startMatches = indexesOfLimited(file, args.srcStart);
  if (startMatches.matches.length === 0) {
    const endMatches = indexesOfLimited(file, args.srcEnd);
    return `Source delimiters were not found in ${args.src}; src_start matched 0 locations and src_end matched ${matchPhrase(
      endMatches.matches.length,
      endMatches.truncated
    )}`;
  }

  const endAfterStart = countEndMatchesAfterStarts(file, args.srcStart, args.srcEnd, startMatches.matches);
  return `Source delimiters were not found in ${args.src}; src_start matched ${matchPhrase(
    startMatches.matches.length,
    startMatches.truncated
  )}, but src_end matched ${matchPhrase(endAfterStart.matches, endAfterStart.truncated)} after those starts`;
}

function sourceNotFoundDetails(
  file: Buffer,
  args: NormalizedRelocationArgs | NormalizedDeletionArgs
): Record<string, unknown> {
  const startMatches = indexesOfLimited(file, args.srcStart);
  const endMatches = indexesOfLimited(file, args.srcEnd);
  const endAfterStart = countEndMatchesAfterStarts(file, args.srcStart, args.srcEnd, startMatches.matches);

  return {
    src_start_matches: startMatches.matches.length,
    ...(startMatches.truncated ? { src_start_matches_truncated: true } : {}),
    src_start_ranges: boundedMatchRanges(startMatches.matches, args.srcStart.length),
    src_start_line_ranges: boundedMatchLineRanges(file, startMatches.matches, args.srcStart.length),
    src_end_matches: endMatches.matches.length,
    ...(endMatches.truncated ? { src_end_matches_truncated: true } : {}),
    src_end_ranges: boundedMatchRanges(endMatches.matches, args.srcEnd.length),
    src_end_line_ranges: boundedMatchLineRanges(file, endMatches.matches, args.srcEnd.length),
    src_end_matches_after_start: endAfterStart.matches,
    ...(endAfterStart.truncated ? { src_end_matches_after_start_truncated: true } : {}),
    suggested_action:
      startMatches.matches.length === 0
        ? "tighten src_start to exact bytes present in the source file"
        : "tighten src_end so it appears after the selected src_start"
  };
}

function countEndMatchesAfterStarts(
  file: Buffer,
  startNeedle: Buffer,
  endNeedle: Buffer,
  starts: readonly number[],
  limit = 11
): { matches: number; truncated: boolean } {
  const maxMatches = normalizedLimit(limit);
  let matches = 0;

  for (const start of starts) {
    const searchFrom = start + startNeedle.length;
    let endStart = file.indexOf(endNeedle, searchFrom);
    while (endStart !== -1) {
      if (matches >= maxMatches) {
        return { matches, truncated: true };
      }
      matches += 1;
      endStart = file.indexOf(endNeedle, endStart + 1);
    }
  }

  return { matches, truncated: false };
}

function matchPhrase(count: number, truncated: boolean): string {
  return `${truncated ? "at least " : ""}${count} ${count === 1 ? "location" : "locations"}`;
}

function findDelimitedRanges(file: Buffer, startNeedle: Buffer, endNeedle: Buffer, limit = 11): LimitedRanges {
  if (startNeedle.length === 0) {
    return { ranges: [], truncated: false };
  }

  const maxMatches = normalizedLimit(limit);
  const ranges: ByteRange[] = [];
  let start = file.indexOf(startNeedle);
  while (start !== -1) {
    const searchFrom = start + startNeedle.length;
    const endStart = file.indexOf(endNeedle, searchFrom);
    if (endStart !== -1) {
      if (ranges.length >= maxMatches) {
        return { ranges, truncated: true };
      }
      ranges.push({ start, end: endStart + endNeedle.length });
    }
    start = file.indexOf(startNeedle, start + 1);
  }

  return { ranges, truncated: false };
}

function targetAnchorName(args: NormalizedRelocationArgs | NormalizedInsertionArgs): string {
  return args.targetAnchor;
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
  validatePatchBytesInMemory(Buffer.from(patch, "utf8"), files);
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
