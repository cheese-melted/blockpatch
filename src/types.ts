export interface BlockPatch {
  type: "move";
  id: string;
  src: string;
  dst: string;
  payloadSha256: string;
  sourceBefore: Buffer;
  sourcePayload: Buffer;
  sourceAfter: Buffer;
  target: TargetAnchor;
}

export interface TargetAnchor {
  before: Buffer;
  after: Buffer;
}

export interface ApplyOptions {
  cwd?: string;
  dryRun?: boolean;
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
  source_range: ByteRangeResult;
  target_range: ByteRangeResult;
  insert_index: number;
}

export interface ApplyResult {
  changed: string[];
  affected: string[];
  noop: boolean;
  moves: MoveResultDetails[];
}

export interface MoveBlockArgs {
  src: string;
  src_start: string;
  src_end: string;
  dst?: string;
  target_before?: string;
  target_after?: string;
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
    code: string;
    message: string;
    path?: string;
    matches?: number;
  };
}
