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

// Value-taking flag tables are shared by normal parsing and error-path JSON-output recovery.
const OUTPUT_FLAGS = new Set(["--json-output", "--explain"]);
const CWD_VALUE_FLAGS = new Set(["--cwd", "--directory", "-d"]);
const PATCH_INPUT_VALUE_FLAGS = new Set(["-i", "--input"]);
const STRIP_VALUE_FLAGS = new Set(["-p", "--strip"]);
const PATCH_VALUE_FLAGS = new Set([...CWD_VALUE_FLAGS, ...PATCH_INPUT_VALUE_FLAGS, ...STRIP_VALUE_FLAGS]);
const MOVE_JSON_VALUE_FLAGS = new Set(["--json"]);
const MOVE_KEY_BY_FLAG = {
  "--src": "src",
  "--src-start": "src_start",
  "--src-end": "src_end",
  "--dst": "dst",
  "--payload": "payload",
  "--target-before": "target_before",
  "--target-after": "target_after",
  "--expected-payload-sha256": "expected_payload_sha256"
} as const satisfies Partial<Record<string, keyof MoveBlockArgs>>;
const MOVE_ARG_VALUE_FLAGS = new Set(Object.keys(MOVE_KEY_BY_FLAG));
const MOVE_VALUE_FLAGS = new Set([...CWD_VALUE_FLAGS, ...MOVE_JSON_VALUE_FLAGS, ...MOVE_ARG_VALUE_FLAGS]);

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
  const inputPatchPath = patchPath === "-" ? patchPath : resolve(patchPath);

  if (options.command === "check") {
    return patchPath === "-"
      ? checkPatchBytes(await readStdin(), {
          cwd: options.cwd,
          reverse: options.reverse,
          stripComponents: options.stripComponents
        })
      : checkPatchFile(inputPatchPath, {
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
    : applyPatchFile(inputPatchPath, {
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
      : await readFileChecked(resolve(options.moveJsonPath), "move JSON file");

  try {
    const parsed = JSON.parse(jsonBytes.toString("utf8")) as unknown;
    if (isEmptyObject(parsed)) {
      throw new BlockPatchError(
        "invalid_move_args",
        "Move JSON cannot be empty; provide src plus source selectors or payload and target anchors",
        {
          field: "src",
          suggested_action:
            "Use fields like src, src_start, src_end, dst, target_before, target_after, payload, or run blockpatch help"
        }
      );
    }
    return parsed as MoveBlockArgs;
  } catch (error) {
    if (error instanceof BlockPatchError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new BlockPatchError("invalid_json", `Invalid move JSON: ${message}`);
  }
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
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
      if (isOutputFlag(arg)) {
        options.jsonOutput = true;
        continue;
      }
      if (arg.startsWith("-")) {
        throw new BlockPatchError("unknown_option", `Unknown option: ${arg}`);
      }
      throw new BlockPatchError("too_many_args", `Unexpected argument: ${arg}`);
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
    const arg = args.shift() as string;
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
    if (isValueFlag(arg, CWD_VALUE_FLAGS)) {
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
    if (isValueFlag(arg, PATCH_INPUT_VALUE_FLAGS)) {
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
    const arg = args.shift() as string;
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
    if (isValueFlag(arg, CWD_VALUE_FLAGS)) {
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
    if (isValueFlag(arg, MOVE_JSON_VALUE_FLAGS)) {
      options.moveJsonPath = requireValue(args, arg, false);
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

function argToMoveKey(arg: string): keyof MoveBlockArgs | undefined {
  return MOVE_KEY_BY_FLAG[arg as keyof typeof MOVE_KEY_BY_FLAG];
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

function parseStripOption(arg: string, args: string[]): number | undefined {
  if (isValueFlag(arg, STRIP_VALUE_FLAGS)) {
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

  while (isOutputFlag(args[0])) {
    const arg = args.shift() as string;
    jsonOutput = true;
    explain = explain || arg === "--explain";
  }

  return { jsonOutput, explain };
}

function takeOutputFlag(options: CliOptions, arg: string): boolean {
  if (arg === "--explain") {
    options.jsonOutput = true;
    if (options.command === "apply" || options.command === "move" || options.command === "plan") {
      options.dryRun = true;
    }
    return true;
  }
  if (arg === "--json-output") {
    options.jsonOutput = true;
    return true;
  }
  return false;
}

function isOutputFlag(arg: string | undefined): boolean {
  return arg !== undefined && OUTPUT_FLAGS.has(arg);
}

function isValueFlag(arg: string | undefined, flags: ReadonlySet<string>): boolean {
  return arg !== undefined && flags.has(arg);
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

Move JSON fields:
  src, dst, src_start, src_end, payload, target_before, target_after,
  expected_payload_sha256, mode, dry_run

Move selection:
  src_start/src_end are byte-exact, newline-sensitive delimiters. The selected
  payload starts at src_start and ends after the first following src_end.

Target anchors:
  target_before is the exact context immediately before the insertion point,
  so insertion occurs after it. target_after is the exact context immediately
  after the insertion point, so insertion occurs before it. With both anchors,
  insertion occurs between them.

Newlines:
  blockpatch never adds separators. Include every intended newline in
  src_start/src_end, payload, target_before, or target_after.

Examples:
  blockpatch move --json - --diff <<'JSON'
  {"src":"src/a.ts","src_start":"function x() {\\n","src_end":"}\\n","dst":"src/b.ts","target_before":"class B {\\n"}
  JSON
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
  return args.some(isOutputFlag);
}

function hasPatchJsonOutputFlag(args: string[]): boolean {
  return hasJsonOutputAfterValueFlags(args, PATCH_VALUE_FLAGS);
}

function hasMoveJsonOutputFlag(args: string[]): boolean {
  return hasJsonOutputAfterValueFlags(args, MOVE_VALUE_FLAGS);
}

function hasJsonOutputAfterValueFlags(args: string[], valueFlags: ReadonlySet<string>): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (isOutputFlag(arg)) {
      return true;
    }
    if (isValueFlag(arg, valueFlags)) {
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
