export interface BlockPatchErrorDetails {
  path?: string;
  matches?: number;
}

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
