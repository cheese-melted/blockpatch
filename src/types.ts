import type { Buffer } from "node:buffer";
import type { BlockPatchErrorCode } from "./errors";

export interface BlockPatch {
  type: "move";
  id: string;
  src: string | null;
  dst: string | null;
  payloadSha256: string;
  hasSourceHunk: boolean;
  sourceBefore: Buffer;
  sourcePayload: Buffer;
  sourceAfter: Buffer;
  target: TargetAnchor | null;
}

export interface TargetAnchor {
  before: Buffer;
  after: Buffer;
}

export interface ApplyOptions {
  cwd?: string;
  dryRun?: boolean;
  reverse?: boolean;
  stripComponents?: number;
}

export interface ByteRangeResult {
  start: number;
  end: number;
}

export interface MoveResultDetails {
  id: string;
  src: string;
  dst: string;
  payload_sha256: string;
  payload_bytes: number;
  source_range: ByteRangeResult | null;
  target_range: ByteRangeResult | null;
  insert_index: number | null;
}

export type ApplyStatus = "applied" | "noop" | "already_applied";

export interface ApplyResult {
  changed: string[];
  affected: string[];
  written: boolean;
  noop: boolean;
  status: ApplyStatus;
  moves: MoveResultDetails[];
}

export interface MoveBlockArgs {
  src: string;
  src_start?: string;
  src_end?: string;
  dst?: string;
  payload?: string;
  target_before?: string;
  target_after?: string;
  expected_payload_sha256?: string;
  mode?: "create_file" | "remove_file";
  dry_run?: boolean;
}

export interface MoveBlockOptions {
  cwd?: string;
  dryRun?: boolean;
  diff?: boolean;
}

export interface MoveBlockResult extends ApplyResult {
  patch?: string;
}

export interface BlockPatchJsonError {
  ok: false;
  error: {
    code: BlockPatchErrorCode;
    message: string;
    field?: string;
    path?: string;
    phase?: string;
    anchor?: string;
    matches?: number;
    ranges?: ByteRangeResult[];
    line_ranges?: ByteRangeResult[];
  };
}
