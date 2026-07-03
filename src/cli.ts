#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BlockPatchError } from "./errors";
import { applyPatchBytes, applyPatchFile, checkPatchBytes, checkPatchFile } from "./engine";
import { moveBlock } from "./move";
import type { ApplyResult, MoveBlockArgs, MoveBlockResult } from "./types";

type Command = "apply" | "check" | "move" | "help" | "version";

interface CliOptions {
  command: Command;
  patchPath?: string;
  cwd: string;
  dryRun: boolean;
  diff: boolean;
  jsonOutput: boolean;
  moveArgs?: MoveBlockArgs;
  moveJsonPath?: string;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);

  if (options.command === "help") {
    printHelp();
    return 0;
  }

  if (options.command === "version") {
    writeSuccess(options, { version: "0.3.0" });
    return 0;
  }

  if (options.command === "move") {
    const args = await loadMoveArgs(options);
    const result = await moveBlock(args, {
      cwd: options.cwd,
      dryRun: options.dryRun,
      diff: options.diff
    });

    if (options.diff && result.patch !== undefined) {
      writeSuccess(options, result, result.patch);
      return 0;
    }

    writeChangeResult(options, result, options.dryRun ? "would change" : "changed");
    return 0;
  }

  if (options.patchPath === undefined) {
    throw new BlockPatchError("missing_patch", "Missing patch file path");
  }

  const result = await runPatchCommand(options);
  const verb = options.command === "check" || options.dryRun ? "would change" : "changed";
  writeChangeResult(options, result, verb);
  return 0;
}

async function runPatchCommand(options: CliOptions): Promise<ApplyResult> {
  const patchPath = options.patchPath;
  if (patchPath === undefined) {
    throw new BlockPatchError("missing_patch", "Missing patch file path");
  }

  if (options.command === "check") {
    return patchPath === "-"
      ? checkPatchBytes(await readStdin(), { cwd: options.cwd })
      : checkPatchFile(patchPath, { cwd: options.cwd });
  }

  return patchPath === "-"
    ? applyPatchBytes(await readStdin(), { cwd: options.cwd, dryRun: options.dryRun })
    : applyPatchFile(patchPath, { cwd: options.cwd, dryRun: options.dryRun });
}

async function loadMoveArgs(options: CliOptions): Promise<MoveBlockArgs> {
  if (options.moveArgs !== undefined) {
    return options.moveArgs;
  }

  if (options.moveJsonPath === undefined) {
    throw new BlockPatchError("missing_move_args", "move requires --json or --src flags");
  }

  const jsonBytes =
    options.moveJsonPath === "-"
      ? await readStdin()
      : await readFile(resolve(options.cwd, options.moveJsonPath));

  try {
    return JSON.parse(jsonBytes.toString("utf8")) as MoveBlockArgs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BlockPatchError("invalid_json", `Invalid move JSON: ${message}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const first = args.shift();
  const jsonOutput = takeFlag(args, "--json-output");

  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return base("help", jsonOutput);
  }

  if (first === "version" || first === "--version" || first === "-v") {
    return base("version", jsonOutput);
  }

  if (first !== "apply" && first !== "check" && first !== "move") {
    throw new BlockPatchError("unknown_command", `Unknown command: ${first}`);
  }

  if (first === "move") {
    return parseMoveArgs(args, jsonOutput);
  }

  return parsePatchArgs(first, args, jsonOutput);
}

function parsePatchArgs(command: "apply" | "check", args: string[], jsonOutput: boolean): CliOptions {
  const options = base(command, jsonOutput);

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = requireValue(args, "--cwd", true);
      continue;
    }
    if (arg?.startsWith("--cwd=")) {
      options.cwd = resolve(arg.slice("--cwd=".length));
      continue;
    }
    if (arg?.startsWith("-") && arg !== "-") {
      throw new BlockPatchError("unknown_option", `Unknown option: ${arg}`);
    }
    if (options.patchPath !== undefined) {
      throw new BlockPatchError("too_many_args", `Unexpected argument: ${arg}`);
    }
    options.patchPath = arg;
  }

  if (command === "check" && options.dryRun) {
    throw new BlockPatchError("invalid_option", "--dry-run is only valid with apply or move");
  }

  return options;
}

function parseMoveArgs(args: string[], jsonOutput: boolean): CliOptions {
  const options = base("move", jsonOutput);
  const moveArgs: Partial<MoveBlockArgs> = {};
  let sawFlagArgs = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--diff") {
      options.diff = true;
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = requireValue(args, "--cwd", true);
      continue;
    }
    if (arg?.startsWith("--cwd=")) {
      options.cwd = resolve(arg.slice("--cwd=".length));
      continue;
    }
    if (arg === "--json") {
      options.moveJsonPath = requireValue(args, "--json", false);
      continue;
    }
    if (arg?.startsWith("--json=")) {
      options.moveJsonPath = arg.slice("--json=".length);
      continue;
    }

    const key = argToMoveKey(arg);
    if (key !== undefined) {
      moveArgs[key] = requireValue(args, arg ?? "", false) as never;
      sawFlagArgs = true;
      continue;
    }

    throw new BlockPatchError("unknown_option", `Unknown option: ${String(arg)}`);
  }

  if (options.moveJsonPath !== undefined && sawFlagArgs) {
    throw new BlockPatchError("invalid_option", "move cannot combine --json with --src flags");
  }

  if (sawFlagArgs) {
    options.moveArgs = moveArgs as MoveBlockArgs;
  }

  return options;
}

function argToMoveKey(arg: string | undefined): keyof MoveBlockArgs | undefined {
  switch (arg) {
    case "--src":
      return "src";
    case "--src-start":
      return "src_start";
    case "--src-end":
      return "src_end";
    case "--dst":
      return "dst";
    case "--dst-before":
      return "dst_before";
    case "--dst-after":
      return "dst_after";
    case "--insert":
      return "insert";
    default:
      return undefined;
  }
}

function base(command: Command, jsonOutput: boolean): CliOptions {
  return {
    command,
    cwd: process.cwd(),
    dryRun: false,
    diff: false,
    jsonOutput
  };
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function requireValue(args: string[], option: string, pathValue: boolean): string {
  const value = args.shift();
  if (value === undefined) {
    throw new BlockPatchError("missing_option_value", `Missing value for ${option}`);
  }
  return pathValue ? resolve(value) : value;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeChangeResult(
  options: CliOptions,
  result: ApplyResult | MoveBlockResult,
  verb: "changed" | "would change"
): void {
  if (options.jsonOutput) {
    writeSuccess(options, result);
    return;
  }

  for (const path of result.changed) {
    console.log(`${verb} ${path}`);
  }
}

function writeSuccess(options: CliOptions, result: unknown, plainText?: string): void {
  if (options.jsonOutput) {
    console.log(JSON.stringify({ ok: true, ...objectResult(result) }));
    return;
  }

  if (plainText !== undefined) {
    console.log(plainText);
    return;
  }

  if (typeof result === "object" && result !== null && "version" in result) {
    console.log(`blockpatch ${(result as { version: string }).version}`);
  }
}

function objectResult(result: unknown): Record<string, unknown> {
  return typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
}

function printHelp(): void {
  console.log(`blockpatch

Usage:
  blockpatch check <patch.blockpatch|-> [--cwd <dir>] [--json-output]
  blockpatch apply <patch.blockpatch|-> [--cwd <dir>] [--dry-run] [--json-output]
  blockpatch move --json <path.json|-> [--cwd <dir>] [--dry-run] [--diff] [--json-output]
  blockpatch move --src <path> --src-start <text> --src-end <text> --dst <path> --dst-after <text>
  blockpatch version
`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const jsonOutput = process.argv.includes("--json-output");
    if (error instanceof BlockPatchError) {
      writeError(error.code, error.message, jsonOutput);
      process.exitCode = 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    writeError("unexpected_error", message, jsonOutput);
    process.exitCode = 1;
  }
);

function writeError(code: string, message: string, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.error(JSON.stringify({ ok: false, error: { code, message } }));
    return;
  }
  console.error(`blockpatch: ${message}`);
}
