export interface BlockPatchErrorRange {
  start: number;
  end: number;
}

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
  readonly code: string;
  readonly details: BlockPatchErrorDetails;

  constructor(code: string, message: string, details: BlockPatchErrorDetails = {}) {
    super(message);
    this.name = "BlockPatchError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code: string, message: string, details?: BlockPatchErrorDetails): never {
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
