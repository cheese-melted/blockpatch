import type { Buffer } from "node:buffer";

export interface ByteRangeLike {
  start: number;
  end: number;
}

export interface LineRange {
  start: number;
  end: number;
}

export function byteRangeToLineRange(file: Buffer | undefined, range: ByteRangeLike | null): LineRange | null {
  if (file === undefined || range === null) {
    return null;
  }
  const start = clamp(range.start, 0, file.length);
  const end = clamp(range.end, start, file.length);
  const endByte = end > start ? end - 1 : start;
  return {
    start: lineNumberAt(file, start),
    end: lineNumberAt(file, endByte)
  };
}

export function lineNumberAt(file: Buffer, byteIndex: number): number {
  let line = 1;
  const end = Math.min(byteIndex, file.length);
  for (let index = 0; index < end; index += 1) {
    if (file[index] === 0x0a) {
      line += 1;
    }
  }
  return line;
}

export function countLines(bytes: Buffer): number {
  if (bytes.length === 0) {
    return 0;
  }

  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines += 1;
    }
  }
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

export function normalizedLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.trunc(limit));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
