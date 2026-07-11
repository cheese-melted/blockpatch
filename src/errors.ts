import type { Buffer } from "node:buffer";

export interface BlockPatchErrorRange {
  start: number;
  end: number;
}

export type BlockPatchErrorCode =
  | "parse_error"
  | "invalid_path"
  | "path_outside_cwd"
  | "symlink_path"
  | "file_not_found"
  | "not_regular_file"
  | "permission_denied"
  | "io_error"
  | "source_not_found"
  | "source_ambiguous"
  | "target_not_found"
  | "target_ambiguous"
  | "destination_exists"
  | "concurrent_modification"
  | "partial_applied_duplicate"
  | "payload_mismatch"
  | "hash_mismatch"
  | "invalid_utf8"
  | "target_overlaps_source"
  | "invalid_move_args"
  | "invalid_json"
  | "missing_move_args"
  | "unknown_command"
  | "unknown_option"
  | "invalid_option"
  | "missing_option_value"
  | "too_many_args"
  | "unexpected_error";

export interface BlockPatchErrorDetails {
  field?: string;
  path?: string;
  phase?: string;
  anchor?: string;
  matches?: number;
  matches_truncated?: boolean;
  ranges?: BlockPatchErrorRange[];
  line_ranges?: BlockPatchErrorRange[];
  src_start_matches?: number;
  src_start_matches_truncated?: boolean;
  src_start_ranges?: BlockPatchErrorRange[];
  src_start_line_ranges?: BlockPatchErrorRange[];
  src_end_matches?: number;
  src_end_matches_truncated?: boolean;
  src_end_ranges?: BlockPatchErrorRange[];
  src_end_line_ranges?: BlockPatchErrorRange[];
  src_end_matches_after_start?: number;
  src_end_matches_after_start_truncated?: boolean;
  source_range?: BlockPatchErrorRange;
  target_range?: BlockPatchErrorRange;
  payload_sha256?: string;
  expected_sha256?: string;
  actual_sha256?: string;
  suggested_action?: string;
}

const maxErrorRanges = 10;

export class BlockPatchError extends Error {
  readonly code: BlockPatchErrorCode;
  readonly details: BlockPatchErrorDetails;

  constructor(code: BlockPatchErrorCode, message: string, details: BlockPatchErrorDetails = {}) {
    super(message);
    this.name = "BlockPatchError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code: BlockPatchErrorCode, message: string, details?: BlockPatchErrorDetails): never {
  throw new BlockPatchError(code, message, details);
}

export function matchedLocations(count: number, truncated: boolean): string {
  return `matched ${truncated ? "at least " : ""}${count} locations`;
}

export function matchCountDetails(
  count: number,
  truncated: boolean
): Pick<BlockPatchErrorDetails, "matches" | "matches_truncated"> {
  return truncated ? { matches: count, matches_truncated: true } : { matches: count };
}

export function boundedMatchRanges(matches: Iterable<number>, byteLength: number): BlockPatchErrorRange[] {
  const ranges: BlockPatchErrorRange[] = [];
  for (const start of matches) {
    if (ranges.length >= maxErrorRanges) {
      break;
    }
    ranges.push({ start, end: start + byteLength });
  }
  return ranges;
}

export function boundedRanges(matches: Iterable<BlockPatchErrorRange>): BlockPatchErrorRange[] {
  const ranges: BlockPatchErrorRange[] = [];
  for (const range of matches) {
    if (ranges.length >= maxErrorRanges) {
      break;
    }
    ranges.push({ start: range.start, end: range.end });
  }
  return ranges;
}

export function boundedMatchLineRanges(
  file: Buffer,
  matches: Iterable<number>,
  byteLength: number
): BlockPatchErrorRange[] {
  const lineRanges: BlockPatchErrorRange[] = [];
  for (const start of matches) {
    if (lineRanges.length >= maxErrorRanges) {
      break;
    }
    lineRanges.push(byteRangeToLineRange(file, { start, end: start + byteLength }));
  }
  return lineRanges;
}

export function boundedLineRanges(
  file: Buffer,
  ranges: Iterable<BlockPatchErrorRange>
): BlockPatchErrorRange[] {
  return boundedRanges(ranges).map((range) => byteRangeToLineRange(file, range));
}

function byteRangeToLineRange(file: Buffer, range: BlockPatchErrorRange): BlockPatchErrorRange {
  const start = clamp(range.start, 0, file.length);
  const end = clamp(range.end, start, file.length);
  const endByte = end > start ? end - 1 : start;
  return {
    start: lineNumberAt(file, start),
    end: lineNumberAt(file, endByte)
  };
}

function lineNumberAt(file: Buffer, byteIndex: number): number {
  let line = 1;
  const end = Math.min(byteIndex, file.length);
  for (let index = 0; index < end; index += 1) {
    if (file[index] === 0x0a) {
      line += 1;
    }
  }
  return line;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
