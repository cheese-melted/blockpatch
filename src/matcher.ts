import {
  boundedMatchLineRanges,
  boundedMatchRanges,
  fail,
  matchCountDetails,
  matchedLocations
} from "./errors";

export interface ByteRange {
  start: number;
  end: number;
}

export interface LimitedMatches {
  matches: number[];
  truncated: boolean;
}

export interface TargetSelection {
  range: ByteRange;
  insertIndex: number;
}

export interface MoveSelection {
  source: ByteRange;
  target: TargetSelection;
  payload: Buffer;
}

export function buildMoveSelection(
  srcFile: Buffer,
  source: ByteRange,
  target: TargetSelection,
  sameFile: boolean,
  dstLabel: string
): MoveSelection {
  if (sameFile && rangesOverlap(source, target.range)) {
    fail("target_overlaps_source", `Target anchor for ${dstLabel} overlaps the source block`, {
      path: dstLabel,
      phase: "target",
      anchor: "blockpatch-target"
    });
  }

  return {
    source,
    target,
    payload: Buffer.from(srcFile.subarray(source.start, source.end))
  };
}

export function findTargetSelection(
  file: Buffer,
  before: Buffer,
  after: Buffer,
  dstLabel: string,
  details: { phase?: string; anchor?: string } = {}
): TargetSelection {
  const anchor = Buffer.concat([before, after]);
  const matchResult = indexesOfLimited(file, anchor);
  const matches = matchResult.matches;

  if (matches.length === 0) {
    fail("target_not_found", `Target anchor was not found in ${dstLabel}`, {
      path: dstLabel,
      ...details,
      matches: 0
    });
  }

  if (matches.length > 1 || matchResult.truncated) {
    fail("target_ambiguous", `Target anchor is ambiguous in ${dstLabel}; ${matchedLocations(matches.length, matchResult.truncated)}`, {
      path: dstLabel,
      ...details,
      ...matchCountDetails(matches.length, matchResult.truncated),
      ranges: boundedMatchRanges(matches, anchor.length),
      line_ranges: boundedMatchLineRanges(file, matches, anchor.length)
    });
  }

  const start = matches[0];
  return {
    range: { start, end: start + anchor.length },
    insertIndex: start + before.length
  };
}

export function indexesOfLimited(haystack: Buffer, needle: Buffer, limit = 11): LimitedMatches {
  if (needle.length === 0) {
    return { matches: [], truncated: false };
  }

  const maxMatches = normalizedLimit(limit);
  const matches: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (matches.length >= maxMatches) {
      return { matches, truncated: true };
    }
    matches.push(index);
    index = haystack.indexOf(needle, index + 1);
  }

  return { matches, truncated: false };
}

export function indexesOfLimitedWhere(
  haystack: Buffer,
  needle: Buffer,
  predicate: (start: number) => boolean,
  limit = 11
): LimitedMatches {
  if (needle.length === 0) {
    return { matches: [], truncated: false };
  }

  const maxMatches = normalizedLimit(limit);
  const matches: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (predicate(index)) {
      if (matches.length >= maxMatches) {
        return { matches, truncated: true };
      }
      matches.push(index);
    }
    index = haystack.indexOf(needle, index + 1);
  }

  return { matches, truncated: false };
}

function normalizedLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.trunc(limit));
}

export function rangesOverlap(left: ByteRange, right: ByteRange): boolean {
  return left.start < right.end && right.start < left.end;
}
