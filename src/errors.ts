export interface BlockPatchErrorRange {
  start: number;
  end: number;
}

export type BlockPatchErrorCode =
  | "parse_error"
  | "invalid_path"
  | "path_outside_cwd"
  | "symlink_path"
  | "source_not_found"
  | "source_ambiguous"
  | "target_not_found"
  | "target_ambiguous"
  | "payload_mismatch"
  | "hash_mismatch"
  | "target_overlaps_source"
  | "already_applied"
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
  ranges?: BlockPatchErrorRange[];
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
