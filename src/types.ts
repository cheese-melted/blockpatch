import type { Buffer } from "node:buffer";
import type { BlockPatchErrorCode } from "./errors";

export type Endpoint = { kind: "file"; path: string } | { kind: "null" };

export interface BlockPatch {
  type: "move";
  id: string;
  src: Endpoint;
  dst: Endpoint;
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
  payload_lines: number;
  payload_hash_verified: true;
  source_range: ByteRangeResult | null;
  source_line_range: ByteRangeResult | null;
  target_range: ByteRangeResult | null;
  target_line_range: ByteRangeResult | null;
  insert_index: number | null;
  insert_line: number | null;
}

export interface MoveWarning {
  code: "adjacent_bytes";
  message: string;
  path: string;
  phase: "target";
  boundary: "target_before+payload" | "payload+target_after";
  suggested_action: string;
}

export type ApplyStatus = "applied" | "noop" | "already_applied";

export interface ApplyResult {
  changed: string[];
  affected: string[];
  written: boolean;
  noop: boolean;
  status: ApplyStatus;
  patch_sha256?: string;
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
  insert_before?: string;
  insert_after?: string;
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
  warnings?: MoveWarning[];
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
    matches_truncated?: boolean;
    ranges?: ByteRangeResult[];
    line_ranges?: ByteRangeResult[];
    src_start_matches?: number;
    src_start_matches_truncated?: boolean;
    src_start_ranges?: ByteRangeResult[];
    src_start_line_ranges?: ByteRangeResult[];
    src_end_matches?: number;
    src_end_matches_truncated?: boolean;
    src_end_ranges?: ByteRangeResult[];
    src_end_line_ranges?: ByteRangeResult[];
    src_end_matches_after_start?: number;
    src_end_matches_after_start_truncated?: boolean;
    source_range?: ByteRangeResult;
    target_range?: ByteRangeResult;
    payload_sha256?: string;
    suggested_action?: string;
  };
}
