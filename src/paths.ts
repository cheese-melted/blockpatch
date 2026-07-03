import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fail } from "./errors";

export function resolvePath(cwd: string, path: string, label: string): string {
  if (path === "" || path.includes("\0")) {
    fail("invalid_path", `Invalid ${label}: ${path}`, { path, phase: "path" });
  }
  if (isAbsolute(path)) {
    fail("path_outside_cwd", `${label} must be relative to the working directory: ${path}`, {
      path,
      phase: "path"
    });
  }

  const root = resolve(cwd);
  const resolved = resolve(root, path);
  const realRoot = realpathSync(root);

  if (!isInside(root, resolved)) {
    fail("path_outside_cwd", `${label} escapes the working directory: ${path}`, { path, phase: "path" });
  }

  rejectSymlinkComponents(root, resolved, path, label);

  const realResolved = realpathSync(resolved);
  if (!isInside(realRoot, realResolved)) {
    fail("path_outside_cwd", `${label} resolves outside the working directory: ${path}`, { path, phase: "path" });
  }

  return resolved;
}

function rejectSymlinkComponents(root: string, resolved: string, originalPath: string, label: string): void {
  const relativePath = relative(root, resolved);
  if (relativePath === "") {
    return;
  }

  let current = root;
  for (const part of relativePath.split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      fail("symlink_path", `${label} must not contain symbolic links: ${originalPath}`, {
        path: originalPath,
        phase: "path"
      });
    }
  }
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}
