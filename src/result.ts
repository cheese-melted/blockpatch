import { devNull } from "./parser";
import { byteRangeToLineRange, countLines, lineNumberAt } from "./locations";
import type { ByteRange, MoveSelection, TargetSelection } from "./matcher";
import type { ApplyResult, BlockPatch, MoveResultDetails } from "./types";

export type PatchMutation =
  | { kind: "write"; label: string; bytes: Buffer; create?: boolean }
  | { kind: "delete"; label: string };

export function oneSidedResult(args: {
  patch: BlockPatch;
  src: string;
  dst: string;
  changed: string[];
  status: "applied" | "noop" | "already_applied";
  sourceRange: ByteRange | null;
  targetRange: ByteRange | null;
  insertIndex: number | null;
  sourceFile?: Buffer;
  targetFile?: Buffer;
}): ApplyResult {
  return {
    changed: args.changed,
    affected: unique([args.src, args.dst]),
    written: false,
    noop: args.status !== "applied" || args.changed.length === 0,
    status: args.status,
    moves: [
      {
        id: args.patch.id,
        src: args.src,
        dst: args.dst,
        payload_sha256: args.patch.payloadSha256,
        payload_bytes: args.patch.sourcePayload.length,
        payload_lines: countLines(args.patch.sourcePayload),
        payload_hash_verified: true,
        source_range: args.sourceRange,
        source_line_range: byteRangeToLineRange(args.sourceFile, args.sourceRange),
        target_range: args.targetRange,
        target_line_range: byteRangeToLineRange(args.targetFile, args.targetRange),
        insert_index: args.insertIndex,
        insert_line: lineNumberOrNull(args.targetFile, args.insertIndex)
      }
    ]
  };
}

export function nullSourceResult(
  patch: BlockPatch,
  dstLabel: string,
  status: "applied" | "already_applied",
  targetRange: ByteRange,
  insertIndex: number,
  targetFile: Buffer
): ApplyResult {
  const applied = status === "applied";
  return {
    changed: applied ? [dstLabel] : [],
    affected: [dstLabel],
    written: false,
    noop: !applied,
    status,
    moves: [
      {
        id: patch.id,
        src: devNull,
        dst: dstLabel,
        payload_sha256: patch.payloadSha256,
        payload_bytes: patch.sourcePayload.length,
        payload_lines: countLines(patch.sourcePayload),
        payload_hash_verified: true,
        source_range: null,
        source_line_range: null,
        target_range: targetRange,
        target_line_range: byteRangeToLineRange(targetFile, targetRange),
        insert_index: insertIndex,
        insert_line: lineNumberOrNull(targetFile, insertIndex)
      }
    ]
  };
}

export function nullTargetResult(
  patch: BlockPatch,
  srcLabel: string,
  status: "applied" | "already_applied",
  sourceRange: ByteRange | null,
  sourceFile?: Buffer
): ApplyResult {
  const applied = status === "applied";
  return {
    changed: applied ? [srcLabel] : [],
    affected: [srcLabel],
    written: false,
    noop: !applied,
    status,
    moves: [
      {
        id: patch.id,
        src: srcLabel,
        dst: devNull,
        payload_sha256: patch.payloadSha256,
        payload_bytes: patch.sourcePayload.length,
        payload_lines: countLines(patch.sourcePayload),
        payload_hash_verified: true,
        source_range: sourceRange,
        source_line_range: byteRangeToLineRange(sourceFile, sourceRange),
        target_range: null,
        target_line_range: null,
        insert_index: null,
        insert_line: null
      }
    ]
  };
}

export function moveResultDetails(args: {
  id: string;
  src: string;
  dst: string;
  payloadSha256: string;
  selection: MoveSelection;
  srcFile: Buffer;
  dstFile: Buffer;
}): MoveResultDetails {
  return {
    id: args.id,
    src: args.src,
    dst: args.dst,
    payload_sha256: args.payloadSha256,
    payload_bytes: args.selection.payload.length,
    payload_lines: countLines(args.selection.payload),
    payload_hash_verified: true,
    source_range: args.selection.source,
    source_line_range: byteRangeToLineRange(args.srcFile, args.selection.source),
    target_range: args.selection.target.range,
    target_line_range: byteRangeToLineRange(args.dstFile, args.selection.target.range),
    insert_index: args.selection.target.insertIndex,
    insert_line: lineNumberOrNull(args.dstFile, args.selection.target.insertIndex)
  };
}

export function alreadyAppliedMoveResultDetails(args: {
  id: string;
  src: string;
  dst: string;
  payloadSha256: string;
  payload: Buffer;
  target: TargetSelection;
  dstFile: Buffer;
}): MoveResultDetails {
  return {
    id: args.id,
    src: args.src,
    dst: args.dst,
    payload_sha256: args.payloadSha256,
    payload_bytes: args.payload.length,
    payload_lines: countLines(args.payload),
    payload_hash_verified: true,
    source_range: null,
    source_line_range: null,
    target_range: args.target.range,
    target_line_range: byteRangeToLineRange(args.dstFile, args.target.range),
    insert_index: args.target.insertIndex,
    insert_line: lineNumberOrNull(args.dstFile, args.target.insertIndex)
  };
}

export function lineNumberOrNull(file: Buffer | undefined, byteIndex: number | null): number | null {
  if (file === undefined || byteIndex === null) {
    return null;
  }
  return lineNumberAt(file, clamp(byteIndex, 0, file.length));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function changedMoveLabels(
  srcLabel: string,
  dstLabel: string,
  sameFile: boolean,
  srcOriginal: Buffer,
  dstOriginal: Buffer,
  next: { src: Buffer; dst: Buffer }
): string[] {
  const srcChanged = !next.src.equals(srcOriginal);
  const dstChanged = !sameFile && !next.dst.equals(dstOriginal);
  const sameFileAlias = sameFile && srcLabel !== dstLabel;
  const changed: string[] = [];
  if (srcChanged) {
    changed.push(srcLabel);
    if (sameFileAlias) {
      changed.push(dstLabel);
    }
  }
  if (dstChanged) {
    changed.push(dstLabel);
  }
  return unique(changed);
}

export function moveMutations(
  srcLabel: string,
  dstLabel: string,
  sameFile: boolean,
  srcOriginal: Buffer,
  dstOriginal: Buffer,
  next: { src: Buffer; dst: Buffer }
): PatchMutation[] {
  const srcChanged = !next.src.equals(srcOriginal);
  const dstChanged = !sameFile && !next.dst.equals(dstOriginal);
  const sameFileAlias = sameFile && srcLabel !== dstLabel;
  const mutations: PatchMutation[] = [];

  if (dstChanged || (sameFileAlias && srcChanged)) {
    mutations.push({ kind: "write", label: dstLabel, bytes: next.dst });
  }
  if (srcChanged) {
    mutations.push({ kind: "write", label: srcLabel, bytes: next.src });
  }
  return mutations;
}
