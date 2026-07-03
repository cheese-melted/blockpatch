import { isAbsolute, relative, resolve } from "node:path";
import { fail } from "./errors";

export function resolvePath(cwd: string, path: string, label: string): string {
  if (path === "" || path.includes("\0")) {
    fail("invalid_path", `Invalid ${label}: ${path}`, { path });
  }
  if (isAbsolute(path)) {
    fail("path_outside_cwd", `${label} must be relative to the working directory: ${path}`, { path });
  }

  const root = resolve(cwd);
  const resolved = resolve(root, path);

  if (!isInside(root, resolved)) {
    fail("path_outside_cwd", `${label} escapes the working directory: ${path}`, { path });
  }

  return resolved;
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}
