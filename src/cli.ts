#!/usr/bin/env node
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { BlockPatchError } from "./errors";
import { applyPatchBytes, applyPatchFile } from "./engine";
import { readFileChecked } from "./files";
import { moveBlock } from "./move";
import type { BlockPatchErrorCode } from "./errors";
import type { ApplyResult, MoveBlockArgs, MoveBlockResult, MoveResultDetails } from "./types";

type Command = "apply" | "move" | "plan" | "help" | "version";
type HelpTopic = "apply" | "move" | "plan" | "version";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

// Value-taking flag tables are shared by normal parsing and error-path JSON-output recovery.
const OUTPUT_FLAGS = new Set(["--json-output", "--explain"]);
const CWD_VALUE_FLAGS = new Set(["--cwd", "--directory", "-d"]);
const PATCH_INPUT_VALUE_FLAGS = new Set(["--patch"]);
const STRIP_VALUE_FLAGS = new Set(["-p", "--strip"]);
const PATCH_VALUE_FLAGS = new Set([...CWD_VALUE_FLAGS, ...PATCH_INPUT_VALUE_FLAGS, ...STRIP_VALUE_FLAGS]);
const MOVE_JSON_VALUE_FLAGS = new Set(["--json"]);
const MOVE_OUTPUT_VALUE_FLAGS = new Set(["--output"]);
const MOVE_KEY_BY_FLAG = {
  "--src": "src",
  "--src-start": "src_start",
  "--src-end": "src_end",
  "--dst": "dst",
  "--payload": "payload",
  "--target-before": "target_before",
  "--target-after": "target_after",
  "--insert-before": "insert_before",
  "--insert-after": "insert_after",
  "--expected-payload-sha256": "expected_payload_sha256"
} as const satisfies Partial<Record<string, keyof MoveBlockArgs>>;
const MOVE_ARG_VALUE_FLAGS = new Set(Object.keys(MOVE_KEY_BY_FLAG));
const MOVE_VALUE_FLAGS = new Set([
  ...CWD_VALUE_FLAGS,
  ...MOVE_JSON_VALUE_FLAGS,
  ...MOVE_OUTPUT_VALUE_FLAGS,
  ...MOVE_ARG_VALUE_FLAGS
]);

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
  outputPath?: string;
  helpTopic?: HelpTopic;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);

  if (options.command === "help") {
    printHelp(options.helpTopic);
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

    if (options.outputPath !== undefined) {
      if (!options.diff || result.patch === undefined) {
        throw new BlockPatchError("invalid_option", "--output is only valid with move --diff");
      }
      await writeOutputAtomically(options.outputPath, result.patch);
      if (options.jsonOutput) {
        writeSuccess(options, { ...result, patch: undefined, output: options.outputPath });
      }
      return 0;
    }

    if (options.diff && result.patch !== undefined) {
      writeSuccess(options, result, result.patch);
      return 0;
    }

    writeChangeResult(options, result, options.dryRun || args.dry_run === true ? "dry_run" : "apply");
    return 0;
  }

  const result = await runPatchCommand(options);
  writeChangeResult(options, result, options.dryRun ? "dry_run" : "apply");
  return 0;
}

async function runPatchCommand(options: CliOptions): Promise<ApplyResult> {
  const patchPath = options.patchPath ?? "-";
  const inputPatchPath = patchPath === "-" ? patchPath : resolve(patchPath);

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
            "Use fields like src, src_start, src_end, dst, insert_before, insert_after, payload, or run blockpatch help"
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

  if (first === undefined || first === "--help" || first === "-h") {
    return base("help", outputFlags.jsonOutput);
  }

  if (first === "help") {
    const options = base("help", outputFlags.jsonOutput);
    const topic = args.shift();
    if (topic !== undefined) {
      if (!isHelpTopic(topic)) {
        throw new BlockPatchError("unknown_command", `Unknown help topic: ${topic}`);
      }
      options.helpTopic = topic;
    }
    for (const arg of args) {
      if (isOutputFlag(arg)) {
        options.jsonOutput = true;
        continue;
      }
      throw new BlockPatchError("too_many_args", `Unexpected argument: ${arg}`);
    }
    return options;
  }

  if (first === "version" || first === "--version" || first === "-v") {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help")) {
      const help = base("help", outputFlags.jsonOutput);
      help.helpTopic = "version";
      return help;
    }

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

  if (first !== "apply" && first !== "move" && first !== "plan") {
    throw new BlockPatchError("unknown_command", `Unknown command: ${first}`);
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help")) {
    const options = base("help", outputFlags.jsonOutput);
    options.helpTopic = first;
    return options;
  }

  if (first === "move" || first === "plan") {
    return parseMoveArgs(first, args, first === "plan" ? true : outputFlags.jsonOutput, outputFlags.explain);
  }

  return parsePatchArgs(first, args, outputFlags.jsonOutput, outputFlags.explain);
}

function parsePatchArgs(
  command: "apply",
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
    if (arg?.startsWith("--patch=")) {
      setPatchPath(options, arg.slice("--patch=".length));
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
    if (isValueFlag(arg, MOVE_OUTPUT_VALUE_FLAGS)) {
      options.outputPath = requireValue(args, arg, true);
      continue;
    }
    if (arg?.startsWith("--json=")) {
      options.moveJsonPath = arg.slice("--json=".length);
      continue;
    }
    if (arg?.startsWith("--output=")) {
      options.outputPath = resolve(arg.slice("--output=".length));
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

  if (options.outputPath !== undefined && (command !== "move" || !options.diff)) {
    throw new BlockPatchError("invalid_option", "--output is only valid with move --diff");
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

function isHelpTopic(value: string): value is HelpTopic {
  return value === "apply" || value === "move" || value === "plan" || value === "version";
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

async function writeOutputAtomically(path: string, text: string): Promise<void> {
  const directory = dirname(path);
  const name = basename(path);
  const tempPath = resolve(directory, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, text, { flag: "wx" });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof BlockPatchError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new BlockPatchError("io_error", `Could not write output file: ${message}`, { path, phase: "output" });
  }
}

function writeChangeResult(
  options: CliOptions,
  result: ApplyResult | MoveBlockResult,
  mode: "apply" | "dry_run"
): void {
  if (options.jsonOutput) {
    writeSuccess(options, result);
    return;
  }

  const status = result.status === "applied" && mode === "dry_run" ? "dry-run clean" : result.status.replace("_", " ");
  for (const move of result.moves) {
    console.log(`${status}: ${formatMoveSummary(move)}`);
  }

  if (mode === "apply" && result.changed.length > 0) {
    console.log(`changed: ${result.changed.join(", ")}`);
  }
}

function formatMoveSummary(move: MoveResultDetails): string {
  return `${move.id} ${formatSourceEndpoint(move)} -> ${formatTargetEndpoint(move)}, ${formatLineCount(move.payload_lines)}`;
}

function formatSourceEndpoint(move: MoveResultDetails): string {
  return formatEndpoint(move.src, move.source_line_range?.start, move.source_line_range?.end);
}

function formatTargetEndpoint(move: MoveResultDetails): string {
  return formatEndpoint(move.dst, move.insert_line ?? move.target_line_range?.start ?? null);
}

function formatEndpoint(path: string, start: number | null | undefined, end: number | null | undefined = start): string {
  if (start === null || start === undefined) {
    return path;
  }
  if (end !== null && end !== undefined && end !== start) {
    return `${path}:${start}-${end}`;
  }
  return `${path}:${start}`;
}

function formatLineCount(lines: number): string {
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
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
  if (options.command === "apply") {
    return {
      mode: options.dryRun ? "dry_run" : "apply",
      validation: "clean",
      strip_components: options.stripComponents
    };
  }
  return {};
}

function printHelp(topic?: HelpTopic): void {
  if (topic === "apply") {
    printApplyHelp();
    return;
  }
  if (topic === "move") {
    printMoveHelp();
    return;
  }
  if (topic === "plan") {
    printPlanHelp();
    return;
  }
  if (topic === "version") {
    printVersionHelp();
    return;
  }

  console.log(`blockpatch

Usage:
  blockpatch apply [patch.blockpatch|-] [-d <dir>] [-pN] [--dry-run] [--reverse]
  blockpatch plan --json <move.json|-> [--cwd <dir>]
  blockpatch move --json <move.json|-> [--cwd <dir>] [--dry-run|--diff]
  blockpatch version

Walkthrough:
  # before: src/foo.ts
  export function keepThing() {
    return 7;
  }

  export function movedThing() {
    return 42;
  }

  # before: src/bar.ts
  export const target = "here";

  blockpatch move --json - --diff --output patch.blockpatch <<'JSON'
  {
    "src": "src/foo.ts",
    "src_start": "\\nexport function movedThing() {\\n",
    "src_end": "}\\n",
    "dst": "src/bar.ts",
    "insert_after": "export const target = \\"here\\";\\n"
  }
  JSON
  blockpatch apply patch.blockpatch --dry-run
  blockpatch apply patch.blockpatch

  # after: src/foo.ts
  export function keepThing() {
    return 7;
  }

  # after: src/bar.ts
  export const target = "here";

  export function movedThing() {
    return 42;
  }
`);
}

function printApplyHelp(): void {
  console.log(`blockpatch apply

Applies a reviewed .blockpatch to the working tree.

Use:
  blockpatch apply [patch.blockpatch|-] [--patch <patch.blockpatch|->] [-d <dir>] [-pN] [--dry-run] [--reverse] [--json-output|--explain]

Examples:
  blockpatch apply patch.blockpatch --dry-run
  blockpatch apply patch.blockpatch
  blockpatch apply --patch - --dry-run
  blockpatch apply patch.blockpatch --reverse

Notes:
  Reads from stdin when no patch path is supplied, or when the path is "-".
  --dry-run validates through the apply path without writing.
  -d/--directory sets the target tree; -pN strips patch path components.
`);
}

function printMoveHelp(): void {
  console.log(`blockpatch move

Plans or applies one exact byte-for-byte move request.

Use:
  blockpatch move --json <path.json|-> [--cwd <dir>] [--dry-run] [--diff] [--output <patch.blockpatch>] [--json-output|--explain]
  blockpatch move --src <path> --src-start <text> --src-end <text> --dst <path> --insert-before <text>
  blockpatch move --src /dev/null --dst <path> --payload <text> --insert-after <text>
  blockpatch move --src <path> --src-start <text> --src-end <text> --dst /dev/null

Choose:
  --json - --diff     Print a reviewable .blockpatch and do not write files.
  --output <path>     With --diff, write the patch atomically to a file.
  --json -            Apply the move request directly.
  --dry-run           Validate the direct move without writing.
  --json-output       Return the result as JSON; with --diff, patch is in "patch".

Recommended review flow:
  blockpatch move --json - --diff --output patch.blockpatch
  blockpatch apply patch.blockpatch --dry-run
  blockpatch apply patch.blockpatch

Example:
  blockpatch move --json - --diff --output patch.blockpatch <<'JSON'
  {
    "src": "src/foo.ts",
    "src_start": "\\nexport function movedThing() {\\n",
    "src_end": "}\\n",
    "dst": "src/bar.ts",
    "insert_after": "export const target = \\"here\\";\\n"
  }
  JSON

Notes:
  src_start/src_end and target anchors are exact and newline-sensitive.
  insert_after inserts after the exact anchor; insert_before inserts before it.
  target_before is the context before the insertion point; insertion occurs after it.
  target_after is the context after the insertion point; insertion occurs before it.
  blockpatch never adds separators; include every intended newline in JSON fields.
`);
}

function printPlanHelp(): void {
  console.log(`blockpatch plan

Validates one move JSON request and returns a JSON envelope with a reviewable
.blockpatch in the "patch" field. It never writes files.

Use:
  blockpatch plan --json <path.json|-> [--cwd <dir>] [--json-output|--explain]

Equivalent intent:
  blockpatch move --json - --diff --json-output

Choose plan when an agent or script wants metadata and patch text together.
Choose move --json - --diff --output when a human wants a saved .blockpatch artifact directly.

Example:
  blockpatch plan --json - <<'JSON' > plan.json
  {
    "src": "src/foo.ts",
    "src_start": "\\nexport function movedThing() {\\n",
    "src_end": "}\\n",
    "dst": "src/bar.ts",
    "insert_after": "export const target = \\"here\\";\\n"
  }
  JSON
  jq -r .patch plan.json > patch.blockpatch
  blockpatch apply patch.blockpatch --dry-run
  blockpatch apply patch.blockpatch

The JSON envelope includes ok, changed, affected, status, move byte ranges,
and patch. apply accepts only the extracted .blockpatch, not the envelope.
`);
}

function printVersionHelp(): void {
  console.log(`blockpatch version

Prints the CLI version.

Use:
  blockpatch version [--json-output]
  blockpatch --version [--json-output]
  blockpatch -v [--json-output]
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
  if (command === "apply") {
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
