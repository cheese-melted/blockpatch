import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { BlockPatchError, fail, type BlockPatchErrorCode } from "./errors";

export interface FileStatSnapshot {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface FileSnapshot {
  bytes: Buffer;
  sha256: string;
  stat: FileStatSnapshot;
}

export async function readFileChecked(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    failFileSystem(error, path, `Could not read ${label}`);
  }
}

export async function readFileSnapshot(path: string, label: string): Promise<FileSnapshot> {
  const bytes = await readFileChecked(path, label);
  const info = await statChecked(path, label);
  assertRegularFile(info, path, label);
  return fileSnapshot(bytes, info);
}

export function fileSnapshot(bytes: Buffer, info: Stats): FileSnapshot {
  return {
    bytes,
    sha256: hashBytes(bytes),
    stat: statSnapshot(info)
  };
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function statChecked(path: string, label: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (error) {
    failFileSystem(error, path, `Could not stat ${label}`);
  }
}

export function lstatSyncChecked(path: string, label: string, userPath: string = path): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    failFileSystem(error, userPath, `Could not stat ${label}`, "path");
  }
}

export function realpathSyncChecked(path: string, label: string, userPath: string = path): string {
  try {
    return realpathSync(path);
  } catch (error) {
    failFileSystem(error, userPath, `Could not resolve ${label}`, "path");
  }
}

export function assertRegularFile(info: Stats, path: string, label: string, phase = "io"): void {
  if (!info.isFile()) {
    fail("not_regular_file", `${label} must be a regular file: ${path}`, { path, phase });
  }
}

export function failFileSystem(error: unknown, path: string, action: string, phase = "io"): never {
  if (error instanceof BlockPatchError) {
    throw error;
  }

  const message = error instanceof Error ? `${action}: ${error.message}` : `${action}: ${path}`;
  fail(fileSystemErrorCode(error), message, { path, phase });
}

function statSnapshot(info: Stats): FileStatSnapshot {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs
  };
}

function fileSystemErrorCode(error: unknown): BlockPatchErrorCode {
  switch ((error as { code?: string }).code) {
    case "ENOENT":
    case "ENOTDIR":
      return "file_not_found";
    case "EISDIR":
      return "not_regular_file";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    default:
      return "io_error";
  }
}
