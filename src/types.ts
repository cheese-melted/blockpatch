export type TargetKind = "before" | "after";

export interface BlockPatch {
  type: "move";
  id: string;
  path: string;
  payloadSha256: string;
  sourceBefore: Buffer;
  sourcePayload: Buffer;
  sourceAfter: Buffer;
  target: TargetAnchor;
}

export interface TargetAnchor {
  kind: TargetKind;
  anchor: Buffer;
}

export interface ApplyOptions {
  cwd?: string;
  dryRun?: boolean;
}

export interface ApplyResult {
  changed: string[];
}
