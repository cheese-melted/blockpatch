export { applyMove, applyPatchBytes, applyPatchFile, checkPatchBytes, checkPatchFile, selectMove } from "./engine";
export { BlockPatchError } from "./errors";
export { moveBlock } from "./move";
export { parseBlockPatch } from "./parser";
export type {
  ApplyOptions,
  ApplyResult,
  BlockPatch,
  MoveBlockArgs,
  MoveBlockOptions,
  MoveBlockResult,
  TargetAnchor,
  TargetKind
} from "./types";
