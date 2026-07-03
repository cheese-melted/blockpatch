#!/usr/bin/env node
import { resolve } from "node:path";
import { BlockPatchError } from "./errors";
import { applyPatchFile, checkPatchFile } from "./engine";

interface CliOptions {
  command: "apply" | "check" | "help" | "version";
  patchPath?: string;
  cwd: string;
  dryRun: boolean;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);

  if (options.command === "help") {
    printHelp();
    return 0;
  }

  if (options.command === "version") {
    console.log("blockpatch 0.2.0");
    return 0;
  }

  if (options.patchPath === undefined) {
    throw new BlockPatchError("missing_patch", "Missing patch file path");
  }

  const result =
    options.command === "check"
      ? await checkPatchFile(options.patchPath, { cwd: options.cwd })
      : await applyPatchFile(options.patchPath, {
          cwd: options.cwd,
          dryRun: options.dryRun
        });

  const verb = options.command === "check" || options.dryRun ? "would change" : "changed";
  for (const path of result.changed) {
    console.log(`${verb} ${path}`);
  }

  return 0;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const first = args.shift();

  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return { command: "help", cwd: process.cwd(), dryRun: false };
  }

  if (first === "version" || first === "--version" || first === "-v") {
    return { command: "version", cwd: process.cwd(), dryRun: false };
  }

  if (first !== "apply" && first !== "check") {
    throw new BlockPatchError("unknown_command", `Unknown command: ${first}`);
  }

  let cwd = process.cwd();
  let dryRun = false;
  let patchPath: string | undefined;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--cwd") {
      const value = args.shift();
      if (value === undefined) {
        throw new BlockPatchError("missing_cwd", "Missing value for --cwd");
      }
      cwd = resolve(value);
      continue;
    }

    if (arg?.startsWith("--cwd=")) {
      cwd = resolve(arg.slice("--cwd=".length));
      continue;
    }

    if (arg?.startsWith("-")) {
      throw new BlockPatchError("unknown_option", `Unknown option: ${arg}`);
    }

    if (patchPath !== undefined) {
      throw new BlockPatchError("too_many_args", `Unexpected argument: ${arg}`);
    }

    patchPath = arg;
  }

  if (first === "check" && dryRun) {
    throw new BlockPatchError("invalid_option", "--dry-run is only valid with apply");
  }

  return { command: first, patchPath, cwd, dryRun };
}

function printHelp(): void {
  console.log(`blockpatch

Usage:
  blockpatch check <patch.blockpatch> [--cwd <dir>]
  blockpatch apply <patch.blockpatch> [--cwd <dir>] [--dry-run]
  blockpatch version
`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof BlockPatchError) {
      console.error(`blockpatch: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    throw error;
  }
);
