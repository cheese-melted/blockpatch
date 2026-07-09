import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { BlockPatchError, fail } from "./errors";
import { assertRegularFile, failFileSystem, readFileSnapshot } from "./files";
import type { Stats } from "node:fs";
import type { FileSnapshot, FileStatSnapshot } from "./files";

export type AtomicPathExpectation =
  | { kind: "file"; label: string; snapshot: FileSnapshot }
  | { kind: "missing"; label: string; bytesIfExists?: Buffer };

export interface AtomicWriteOptions {
  create?: boolean;
  expected?: AtomicPathExpectation;
  label?: string;
}

export interface AtomicWriteRequest {
  path: string;
  bytes: Buffer;
  create?: boolean;
  expected?: AtomicPathExpectation;
  label?: string;
}

export interface AtomicDeleteRequest {
  path: string;
  expected?: AtomicPathExpectation;
  label?: string;
}

interface CreatedDirectoryChain {
  first: string;
  target: string;
}

interface StagedAtomicWrite {
  path: string;
  temp: string;
  request: AtomicWriteRequest;
  createdDirectory: CreatedDirectoryChain | undefined;
}

type StagedWriteDecision = "rename" | "skip";

export async function writeAtomic(
  path: string,
  bytes: Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await writeAtomically([{ path, bytes, create: options.create, expected: options.expected, label: options.label }]);
}

export async function writeAtomically(
  writes: readonly AtomicWriteRequest[],
  deletes: readonly AtomicDeleteRequest[] = []
): Promise<void> {
  const staged: StagedAtomicWrite[] = [];

  try {
    for (const write of writes) {
      if (write.expected?.kind === "file") {
        await assertExpectedRegularFile(write.path, write.expected.label, write.expected.snapshot);
      }
      staged.push(await stageAtomicWrite(write));
    }

    for (const deletion of deletes) {
      await verifyAtomicDelete(deletion);
    }

    const writeDecisions = new Map<StagedAtomicWrite, StagedWriteDecision>();
    for (const write of staged) {
      writeDecisions.set(write, await verifyStagedWrite(write));
    }

    for (const write of staged) {
      const decision = writeDecisions.get(write);
      if (decision === "rename") {
        await rename(write.temp, write.path);
      } else {
        await cleanupStagedWrite(write);
      }
    }

    for (const deletion of deletes) {
      await unlink(deletion.path);
    }
  } catch (error) {
    await cleanupStagedWrites(staged);
    if (error instanceof BlockPatchError) {
      throw error;
    }
    failFileSystem(error, writes[0]?.label ?? deletes[0]?.label ?? "unknown", "Could not write file", "write");
  }
}

async function verifyStagedWrite(write: StagedAtomicWrite): Promise<StagedWriteDecision> {
  const expected = write.request.expected;
  if (expected === undefined) {
    return "rename";
  }

  const live = await readFileSnapshotOptional(write.path, expected.label);
  if (expected.kind === "missing") {
    if (live === undefined) {
      return "rename";
    }
    if (expected.bytesIfExists !== undefined && live.bytes.equals(expected.bytesIfExists)) {
      return "skip";
    }
    failConcurrentModification(expected.label);
  }

  if (live === undefined || !sameFileSnapshot(live, expected.snapshot)) {
    failConcurrentModification(expected.label);
  }
  return "rename";
}

async function verifyAtomicDelete(deletion: AtomicDeleteRequest): Promise<void> {
  const expected = deletion.expected;
  if (expected === undefined) {
    return;
  }

  const live = await readFileSnapshotOptional(deletion.path, expected.label);
  if (expected.kind === "missing") {
    if (live === undefined) {
      return;
    }
    failConcurrentModification(expected.label);
  }

  if (live === undefined || !sameFileSnapshot(live, expected.snapshot)) {
    failConcurrentModification(expected.label);
  }
}

async function readFileSnapshotOptional(path: string, label: string): Promise<FileSnapshot | undefined> {
  try {
    return await readFileSnapshot(path, label);
  } catch (error) {
    if (error instanceof BlockPatchError && error.code === "file_not_found") {
      return undefined;
    }
    if (error instanceof BlockPatchError && error.code === "not_regular_file") {
      failConcurrentModification(label);
    }
    throw error;
  }
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.bytes.equals(right.bytes) && sameStatSnapshot(left.stat, right.stat);
}

function sameStatSnapshot(left: FileStatSnapshot, right: FileStatSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function failConcurrentModification(label: string): never {
  fail("concurrent_modification", `File changed after blockpatch verification: ${label}`, {
    path: label,
    phase: "write"
  });
}

async function stageAtomicWrite(write: AtomicWriteRequest): Promise<StagedAtomicWrite> {
  const directory = dirname(write.path);
  const name = basename(write.path);
  let createdDirectory: CreatedDirectoryChain | undefined;

  try {
    createdDirectory = await ensureParentDirectory(directory);
    await assertSafeOutputParentDirectory(directory, write.path);
    const temp = join(directory, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temp, write.bytes, { flag: "wx", mode: 0o644 });

    const stat = await lstat(temp);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      await unlink(temp).catch(() => undefined);
      fail("not_regular_file", `Temporary output path is not a regular file: ${write.label ?? write.path}`, {
        path: write.label ?? write.path,
        phase: "write"
      });
    }

    // Explicit mode avoids process umask differences for newly-created files.
    await chmod(temp, 0o644);
    return {
      path: write.path,
      temp,
      request: write,
      createdDirectory
    };
  } catch (error) {
    await cleanupCreatedDirectoryChain(createdDirectory);
    if (error instanceof BlockPatchError) {
      throw error;
    }
    failFileSystem(error, write.label ?? write.path, "Could not stage file write", "write");
  }
}

async function ensureParentDirectory(directory: string): Promise<CreatedDirectoryChain | undefined> {
  try {
    await mkdir(directory, { recursive: false });
    return { first: directory, target: directory };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EEXIST") {
      return undefined;
    }
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const parent = dirname(directory);
  const createdParent = await ensureParentDirectory(parent);
  try {
    await mkdir(directory, { recursive: false });
    return {
      first: createdParent?.first ?? directory,
      target: directory
    };
  } catch (error) {
    await cleanupCreatedDirectoryChain(createdParent);
    throw error;
  }
}

async function assertSafeOutputParentDirectory(dir: string, outputPath: string): Promise<void> {
  let current = resolve(dir);
  const root = parse(current).root;
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      // macOS temp paths commonly begin under /var, which is a top-level
      // platform symlink to /private/var. Operation-path resolution already
      // rejects symlinks inside the target tree; this guard catches deeper
      // output parents without rejecting OS-level path aliases.
      if (dirname(current) === root) {
        return;
      }
      fail("symlink_path", `Output path must not contain symbolic links: ${outputPath}`, {
        path: outputPath,
        phase: "write"
      });
    }
    if (current === root) {
      return;
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function cleanupStagedWrites(staged: StagedAtomicWrite[]): Promise<void> {
  for (const write of staged.reverse()) {
    await cleanupStagedWrite(write);
  }
}

async function cleanupStagedWrite(write: Pick<StagedAtomicWrite, "temp" | "createdDirectory">): Promise<void> {
  await unlink(write.temp).catch(() => undefined);
  await cleanupCreatedDirectoryChain(write.createdDirectory);
}

async function cleanupCreatedDirectoryChain(chain: CreatedDirectoryChain | undefined): Promise<void> {
  if (chain === undefined) {
    return;
  }

  let current = chain.target;
  while (isSameOrChildPath(current, chain.first)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    if (current === chain.first) {
      return;
    }
    current = dirname(current);
  }
}

function isSameOrChildPath(child: string, parent: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

async function assertExpectedRegularFile(
  path: string,
  label: string,
  snapshot: FileSnapshot
): Promise<void> {
  let info: Stats;
  try {
    info = await stat(path);
    assertRegularFile(info, path, label, "write");
  } catch (error) {
    if (error instanceof BlockPatchError && error.code === "not_regular_file") {
      failConcurrentModification(label);
    }
    throw error;
  }
  if (!sameStatSnapshot(statSnapshot(info), snapshot.stat)) {
    failConcurrentModification(label);
  }
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
