import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fail } from "./errors";
import { assertRegularFile, failFileSystem, lstatSyncChecked, realpathSyncChecked, statChecked } from "./files";

export function validateOperationPath(path: string, label: string): void {
  if (path === "" || path.includes("\0")) {
    fail("invalid_path", `Invalid ${label}: ${path}`, { path, phase: "path" });
  }
  rejectUnsafeDisplayPath(path, label);
}

export function rejectUnsafeDisplayPath(path: string, label: string): void {
  if (/[\r\n\t]/.test(path)) {
    fail("invalid_path", `${label} contains unsupported control characters: ${path}`, {
      path,
      phase: "path"
    });
  }
}

export function resolvePath(cwd: string, path: string, label: string): string {
  validateOperationPath(path, label);
  if (isAbsolute(path)) {
    fail("path_outside_cwd", `${label} must be relative to the working directory: ${path}`, {
      path,
      phase: "path"
    });
  }

  const root = resolve(cwd);
  const resolved = resolve(root, path);
  const realRoot = realpathSyncChecked(root, "working directory", root);

  if (!isInside(root, resolved)) {
    fail("path_outside_cwd", `${label} escapes the working directory: ${path}`, { path, phase: "path" });
  }

  rejectSymlinkComponents(root, resolved, path, label);

  const info = lstatSyncChecked(resolved, label, path);
  assertRegularFile(info, path, label, "path");

  const realResolved = realpathSyncChecked(resolved, label, path);
  if (!isInside(realRoot, realResolved)) {
    fail("path_outside_cwd", `${label} resolves outside the working directory: ${path}`, { path, phase: "path" });
  }

  return resolved;
}

export function resolvePathAllowMissing(
  cwd: string,
  path: string,
  label: string
): { path: string; exists: boolean } {
  validateOperationPath(path, label);
  if (isAbsolute(path)) {
    fail("path_outside_cwd", `${label} must be relative to the working directory: ${path}`, {
      path,
      phase: "path"
    });
  }

  const root = resolve(cwd);
  const resolved = resolve(root, path);
  const realRoot = realpathSyncChecked(root, "working directory", root);

  if (!isInside(root, resolved)) {
    fail("path_outside_cwd", `${label} escapes the working directory: ${path}`, { path, phase: "path" });
  }

  const deepestExisting = rejectExistingSymlinkComponents(root, resolved, path, label);
  if (deepestExisting !== resolved) {
    return { path: resolved, exists: false };
  }

  const info = lstatSyncChecked(resolved, label, path);
  assertRegularFile(info, path, label, "path");

  const realResolved = realpathSyncChecked(resolved, label, path);
  if (!isInside(realRoot, realResolved)) {
    fail("path_outside_cwd", `${label} resolves outside the working directory: ${path}`, { path, phase: "path" });
  }

  return { path: resolved, exists: true };
}

export async function sameFileIdentity(left: string, right: string): Promise<boolean> {
  if (left === right) {
    return true;
  }

  const [leftInfo, rightInfo] = await Promise.all([
    statChecked(left, "source path"),
    statChecked(right, "destination path")
  ]);
  return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
}

function rejectSymlinkComponents(root: string, resolved: string, originalPath: string, label: string): void {
  const relativePath = relative(root, resolved);
  if (relativePath === "") {
    return;
  }

  let current = root;
  for (const part of relativePath.split(sep)) {
    current = join(current, part);
    if (lstatSyncChecked(current, label, originalPath).isSymbolicLink()) {
      fail("symlink_path", `${label} must not contain symbolic links: ${originalPath}`, {
        path: originalPath,
        phase: "path"
      });
    }
  }
}

// Like rejectSymlinkComponents, but tolerates missing trailing components.
// Returns the deepest component that exists (resolved itself when everything exists).
function rejectExistingSymlinkComponents(
  root: string,
  resolved: string,
  originalPath: string,
  label: string
): string {
  const relativePath = relative(root, resolved);
  if (relativePath === "") {
    return resolved;
  }

  let current = root;
  for (const part of relativePath.split(sep)) {
    const next = join(current, part);
    let info;
    try {
      info = lstatSync(next);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return current;
      }
      failFileSystem(error, originalPath, `Could not stat ${label}`, "path");
    }
    if (info.isSymbolicLink()) {
      fail("symlink_path", `${label} must not contain symbolic links: ${originalPath}`, {
        path: originalPath,
        phase: "path"
      });
    }
    current = next;
  }
  return current;
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}
