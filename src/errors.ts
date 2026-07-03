export class BlockPatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BlockPatchError";
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new BlockPatchError(code, message);
}
