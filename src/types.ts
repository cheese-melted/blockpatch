export type TargetKind = "before" | "after";

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

export type TargetAnchor =
  | {
      before: Buffer;
      after: Buffer;
    }
  | {
      kind: TargetKind;
      anchor: Buffer;
    };

export interface ApplyOptions {
  cwd?: string;
  dryRun?: boolean;
}

export interface ApplyResult {
  changed: string[];
}

export interface MoveBlockArgs {
  src: string;
  src_start: string;
  src_end: string;
  dst?: string;
  dst_before?: string;
  dst_after?: string;
  insert?: TargetKind;
  dry_run?: boolean;
}

export interface MoveBlockOptions {
  cwd?: string;
  dryRun?: boolean;
  diff?: boolean;
}

export interface MoveBlockResult {
  changed: string[];
  patch?: string;
}
