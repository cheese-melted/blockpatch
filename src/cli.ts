#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { BlockPatchError } from "./errors";
import { applyPatchBytes, applyPatchFile, checkPatchBytes, checkPatchFile } from "./engine";
import { readFileChecked } from "./files";
import { moveBlock } from "./move";
import type { BlockPatchErrorCode } from "./errors";
import type { ApplyResult, MoveBlockArgs, MoveBlockResult } from "./types";

type Command = "apply" | "check" | "move" | "plan" | "help" | "version";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

interface CliOptions {
  command: Command;
  patchPath?: string;
  cwd: string;
  dryRun: boolean;
  diff: boolean;
  jsonOutput: boolean;
  reverse: boolean;
  stripComponents: number;
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
    writeSuccess(options, { version: packageJson.version });
    return 0;
  }

  if (options.command === "move" || options.command === "plan") {
    const args = await loadMoveArgs(options);
    const result = await moveBlock(args, {
      cwd: options.cwd,
      dryRun: options.dryRun ? true : undefined,
      diff: options.diff
    });

    if (options.diff && result.patch !== undefined) {
      writeSuccess(options, result, result.patch);
      return 0;
    }

    writeChangeResult(options, result, options.dryRun || args.dry_run === true ? "would change" : "changed");
    return 0;
  }

  const result = await runPatchCommand(options);
  const verb = options.command === "check" || options.dryRun ? "would change" : "changed";
  writeChangeResult(options, result, verb);
  return 0;
}

async function runPatchCommand(options: CliOptions): Promise<ApplyResult> {
  const patchPath = options.patchPath ?? "-";

  if (options.command === "check") {
    return patchPath === "-"
      ? checkPatchBytes(await readStdin(), {
          cwd: options.cwd,
          reverse: options.reverse,
          stripComponents: options.stripComponents
        })
      : checkPatchFile(patchPath, {
          cwd: options.cwd,
          reverse: options.reverse,
          stripComponents: options.stripComponents
        });
  }

  return patchPath === "-"
    ? applyPatchBytes(await readStdin(), {
        cwd: options.cwd,
        dryRun: options.dryRun,
        reverse: options.reverse,
        stripComponents: options.stripComponents
      })
    : applyPatchFile(patchPath, {
        cwd: options.cwd,
        dryRun: options.dryRun,
        reverse: options.reverse,
        stripComponents: options.stripComponents
      });
}

async function loadMoveArgs(options: CliOptions): Promise<MoveBlockArgs> {
  if (options.moveArgs !== undefined) {
    return options.moveArgs;
  }

  if (options.moveJsonPath === undefined) {
    throw new BlockPatchError("missing_move_args", `${options.command} requires --json or --src flags`);
  }

  const jsonBytes =
    options.moveJsonPath === "-"
      ? await readStdin()
      : await readFileChecked(resolve(options.cwd, options.moveJsonPath), "move JSON file");

  try {
    return JSON.parse(jsonBytes.toString("utf8")) as MoveBlockArgs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BlockPatchError("invalid_json", `Invalid move JSON: ${message}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const outputFlags = takeLeadingOutputFlags(args);
  const first = args.shift();

  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return base("help", outputFlags.jsonOutput);
  }

  if (first === "version" || first === "--version" || first === "-v") {
    const options = base("version", outputFlags.jsonOutput);
    for (const arg of args) {
      if (arg === "--json-output" || arg === "--explain") {
        options.jsonOutput = true;
      }
    }
    return options;
  }

  if (first !== "apply" && first !== "check" && first !== "move" && first !== "plan") {
    throw new BlockPatchError("unknown_command", `Unknown command: ${first}`);
  }

  if (first === "move" || first === "plan") {
    return parseMoveArgs(first, args, first === "plan" ? true : outputFlags.jsonOutput, outputFlags.explain);
  }

  return parsePatchArgs(first, args, outputFlags.jsonOutput, outputFlags.explain);
}

function parsePatchArgs(
  command: "apply" | "check",
  args: string[],
  jsonOutput: boolean,
  explain: boolean
): CliOptions {
  const options = base(command, jsonOutput);
  if (explain && command === "apply") {
    options.dryRun = true;
  }

  while (args.length > 0) {
    const arg = args.shift();
    if (takeOutputFlag(options, arg)) {
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--reverse" || arg === "-R") {
      options.reverse = true;
      continue;
    }
    if (arg === "--cwd" || arg === "--directory" || arg === "-d") {
      options.cwd = requireValue(args, arg, true);
      continue;
    }
    if (arg?.startsWith("--cwd=")) {
      options.cwd = resolve(arg.slice("--cwd=".length));
      continue;
    }
    if (arg?.startsWith("--directory=")) {
      options.cwd = resolve(arg.slice("--directory=".length));
      continue;
    }
    if (arg === "-i" || arg === "--input") {
      setPatchPath(options, requireValue(args, arg, false));
      continue;
    }
    if (arg?.startsWith("--input=")) {
      setPatchPath(options, arg.slice("--input=".length));
      continue;
    }
    const stripComponents = parseStripOption(arg, args);
    if (stripComponents !== undefined) {
      options.stripComponents = stripComponents;
      continue;
    }
    if (arg?.startsWith("-") && arg !== "-") {
      throw new BlockPatchError("unknown_option", `Unknown option: ${arg}`);
    }
    setPatchPath(options, arg ?? "");
  }

  if (command === "check" && options.dryRun) {
    throw new BlockPatchError("invalid_option", "--dry-run is only valid with apply or move");
  }

  return options;
}

function parseMoveArgs(command: "move" | "plan", args: string[], jsonOutput: boolean, explain: boolean): CliOptions {
  const options = base(command, jsonOutput);
  if (command === "plan") {
    options.dryRun = true;
    options.diff = true;
    options.jsonOutput = true;
  }
  if (explain) {
    options.dryRun = true;
  }
  const moveArgs: Partial<MoveBlockArgs> = {};
  let sawFlagArgs = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (takeOutputFlag(options, arg)) {
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--diff") {
      options.diff = true;
      continue;
    }
    if (arg === "--cwd" || arg === "--directory" || arg === "-d") {
      options.cwd = requireValue(args, arg, true);
      continue;
    }
    if (arg?.startsWith("--cwd=")) {
      options.cwd = resolve(arg.slice("--cwd=".length));
      continue;
    }
    if (arg?.startsWith("--directory=")) {
      options.cwd = resolve(arg.slice("--directory=".length));
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
    case "--payload":
      return "payload";
    case "--target-before":
      return "target_before";
    case "--target-after":
      return "target_after";
    case "--expected-payload-sha256":
      return "expected_payload_sha256";
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
    jsonOutput,
    reverse: false,
    stripComponents: 1
  };
}

function setPatchPath(options: CliOptions, path: string): void {
  if (options.patchPath !== undefined) {
    throw new BlockPatchError("too_many_args", `Unexpected argument: ${path}`);
  }
  options.patchPath = path;
}

function parseStripOption(arg: string | undefined, args: string[]): number | undefined {
  if (arg === "-p" || arg === "--strip") {
    return parseStripComponents(requireValue(args, arg, false), arg);
  }
  if (arg?.startsWith("-p") === true && arg.length > 2) {
    return parseStripComponents(arg.slice(2), "-p");
  }
  if (arg?.startsWith("--strip=") === true) {
    return parseStripComponents(arg.slice("--strip=".length), "--strip");
  }
  return undefined;
}

function parseStripComponents(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new BlockPatchError("invalid_option", `Invalid strip count for ${option}: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BlockPatchError("invalid_option", `Invalid strip count for ${option}: ${value}`);
  }
  return parsed;
}

function takeLeadingOutputFlags(args: string[]): { jsonOutput: boolean; explain: boolean } {
  let jsonOutput = false;
  let explain = false;

  while (args[0] === "--json-output" || args[0] === "--explain") {
    const arg = args.shift();
    jsonOutput = true;
    explain = explain || arg === "--explain";
  }

  return { jsonOutput, explain };
}

function takeOutputFlag(options: CliOptions, arg: string | undefined): boolean {
  if (arg === "--json-output") {
    options.jsonOutput = true;
    return true;
  }
  if (arg === "--explain") {
    options.jsonOutput = true;
    if (options.command === "apply" || options.command === "move" || options.command === "plan") {
      options.dryRun = true;
    }
    return true;
  }
  return false;
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

  if (result.changed.length === 0) {
    for (const path of result.affected) {
      console.log(`unchanged ${path}`);
    }
  }
}

function writeSuccess(options: CliOptions, result: unknown, plainText?: string): void {
  if (options.jsonOutput) {
    console.log(JSON.stringify({ ok: true, ...objectResult(result), ...jsonSuccessMetadata(options) }));
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

function jsonSuccessMetadata(options: CliOptions): Record<string, unknown> {
  if (options.command === "apply" || options.command === "check") {
    return { strip_components: options.stripComponents };
  }
  return {};
}

function printHelp(): void {
  console.log(`blockpatch

Usage:
  blockpatch check [patch.blockpatch|-] [-d <dir>] [-pN] [-R|--reverse] [--json-output|--explain]
  blockpatch apply [patch.blockpatch|-] [-i <patch.blockpatch>] [-d <dir>] [-pN] [-R|--reverse] [--dry-run] [--json-output|--explain]
  blockpatch plan --json <path.json|-> [--cwd <dir>]
  blockpatch move --json <path.json|-> [--cwd <dir>] [--dry-run] [--diff] [--json-output|--explain]
  blockpatch move --src <path> --src-start <text> --src-end <text> --dst <path> --target-before <text> --target-after <text> [--expected-payload-sha256 <sha256>]
  blockpatch move --src /dev/null --dst <path> --payload <text> --target-before <text>
  blockpatch move --src <path> --src-start <text> --src-end <text> --dst /dev/null
  blockpatch version
`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const jsonOutput = hasJsonOutputFlag(process.argv.slice(2));
    if (error instanceof BlockPatchError) {
      writeError(error.code, error.message, jsonOutput, error.details);
      process.exitCode = 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    writeError("unexpected_error", message, jsonOutput);
    process.exitCode = 1;
  }
);

function hasJsonOutputFlag(argv: string[]): boolean {
  const args = [...argv];
  const outputFlags = takeLeadingOutputFlags(args);
  if (outputFlags.jsonOutput) {
    return true;
  }

  const command = args.shift();
  if (command === "apply" || command === "check") {
    return hasPatchJsonOutputFlag(args);
  }
  if (command === "move") {
    return hasMoveJsonOutputFlag(args);
  }
  if (command === "plan") {
    return true;
  }
  return args.includes("--json-output") || args.includes("--explain");
}

function hasPatchJsonOutputFlag(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json-output" || arg === "--explain") {
      return true;
    }
    if (arg === "--cwd" || arg === "--directory" || arg === "-d" || arg === "-i" || arg === "--input") {
      index += 1;
      continue;
    }
    if (arg === "-p" || arg === "--strip") {
      index += 1;
    }
  }
  return false;
}

function hasMoveJsonOutputFlag(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json-output" || arg === "--explain") {
      return true;
    }
    if (arg === "--cwd" || arg === "--directory" || arg === "-d" || arg === "--json" || argToMoveKey(arg) !== undefined) {
      index += 1;
    }
  }
  return false;
}

function writeError(
  code: BlockPatchErrorCode,
  message: string,
  jsonOutput: boolean,
  details: BlockPatchError["details"] = {}
): void {
  if (jsonOutput) {
    console.error(JSON.stringify({ ok: false, error: { code, message, ...details } }));
    return;
  }
  console.error(`blockpatch: ${message}`);
}
