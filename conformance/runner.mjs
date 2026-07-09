#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const conformanceRoot = dirname(fileURLToPath(import.meta.url));
const casesRoot = join(conformanceRoot, "cases");
const invocationCwd = process.cwd();
const keepTemp = process.env.BLOCKPATCH_CONFORMANCE_KEEP === "1";
const implementationArgv = process.argv.slice(2);

if (implementationArgv.length === 0 || implementationArgv[0] === "--help" || implementationArgv[0] === "-h") {
  printUsage();
  process.exit(implementationArgv.length === 0 ? 2 : 0);
}

const implementation = normalizeImplementation(implementationArgv);
const tempRoot = await mkdtemp(join(tmpdir(), "blockpatch-conformance-"));

try {
  const caseNames = await readCaseNames();
  for (const caseName of caseNames) {
    await runCase(caseName);
    console.log(`ok ${caseName}`);
  }
  console.log(`ok ${caseNames.length} conformance cases`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (keepTemp) {
    console.error(`kept temp directory: ${tempRoot}`);
  }
  process.exitCode = 1;
} finally {
  if (!keepTemp) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function printUsage() {
  console.error("Usage: blockpatch-conformance <blockpatch-command> [args...]");
  console.error("");
  console.error("Examples:");
  console.error("  blockpatch-conformance blockpatch");
  console.error("  blockpatch-conformance node dist/cli.js");
}

function normalizeImplementation(argv) {
  const [command, ...args] = argv;
  const resolvedCommand = looksPathLike(command) ? resolve(invocationCwd, command) : command;
  return { command: resolvedCommand, args };
}

function looksPathLike(command) {
  return command.startsWith(".") || command.includes("/") || command.includes("\\") || isAbsolute(command);
}

async function readCaseNames() {
  const entries = await readdir(casesRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function runCase(caseName) {
  const caseDefinition = JSON.parse(await readFile(join(casesRoot, caseName, "case.json"), "utf8"));
  const caseRoot = join(tempRoot, caseName);
  const workRoot = join(caseRoot, "work");
  const patchPath = join(caseRoot, "patch.blockpatch");
  await mkdir(workRoot, { recursive: true });
  await writeCaseFiles(workRoot, caseDefinition.files ?? {});
  await writeFile(patchPath, Buffer.from(requiredString(caseDefinition.patch, caseName, "patch"), "utf8"));

  const initialFiles = caseDefinition.files ?? {};
  const expectedFiles = caseDefinition.expected_files ?? initialFiles;
  const expectedAbsent = caseDefinition.expected_absent ?? [];
  const expect = caseDefinition.expect ?? "pass";

  if (expect === "pass") {
    await expectSuccess(caseName, "check", [patchPath, "--cwd", workRoot]);
    await expectTree(caseName, workRoot, initialFiles, []);
    await expectSuccess(caseName, "apply", [patchPath, "--cwd", workRoot]);
    await expectTree(caseName, workRoot, expectedFiles, expectedAbsent);
    await expectSuccess(caseName, "retry", [patchPath, "--cwd", workRoot]);
    await expectTree(caseName, workRoot, expectedFiles, expectedAbsent);
    await expectSuccess(caseName, "reverse", [patchPath, "--cwd", workRoot, "--reverse"]);
    await expectTree(caseName, workRoot, initialFiles, []);
    return;
  }

  if (expect === "fail") {
    await expectFailure(caseName, "check", [patchPath, "--cwd", workRoot], caseDefinition.error_code);
    await expectTree(caseName, workRoot, initialFiles, []);
    await expectFailure(caseName, "apply", [patchPath, "--cwd", workRoot], caseDefinition.error_code);
    await expectTree(caseName, workRoot, initialFiles, []);
    return;
  }

  throw new Error(`${caseName}: unknown expect value ${JSON.stringify(expect)}`);
}

async function expectSuccess(caseName, label, args) {
  const result = runBlockpatch(commandArgs(label, args));
  if (result.status !== 0) {
    throw commandError(caseName, label, result);
  }
  const json = parseJson(caseName, label, result.stdout);
  if (json.ok !== true) {
    throw new Error(`${caseName}: ${label} returned non-ok JSON ${JSON.stringify(json)}`);
  }
}

async function expectFailure(caseName, label, args, errorCode) {
  const result = runBlockpatch(commandArgs(label, args));
  if (result.status === 0) {
    throw new Error(`${caseName}: ${label} succeeded but expected failure`);
  }
  const json = parseJson(caseName, label, result.stderr || result.stdout);
  if (json.ok !== false) {
    throw new Error(`${caseName}: ${label} failure returned non-error JSON ${JSON.stringify(json)}`);
  }
  if (errorCode !== undefined && json.error?.code !== errorCode) {
    throw new Error(`${caseName}: ${label} expected error ${errorCode}, got ${String(json.error?.code)}`);
  }
}

function commandArgs(label, args) {
  return [label === "check" ? "check" : "apply", ...args];
}

function runBlockpatch(args) {
  return spawnSync(implementation.command, [...implementation.args, ...args, "--json-output"], {
    cwd: invocationCwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: process.platform === "win32"
  });
}

function commandError(caseName, label, result) {
  if (result.error !== undefined) {
    return result.error;
  }
  return new Error(
    `${caseName}: ${label} failed\n` +
      `exit: ${String(result.status)}\n` +
      `stdout:\n${result.stdout}\n` +
      `stderr:\n${result.stderr}`
  );
}

function parseJson(caseName, label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${caseName}: ${label} did not return JSON: ${text.trim()}\n${String(error)}`);
  }
}

async function writeCaseFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(requiredString(text, path, "file text"), "utf8"));
  }
}

async function expectTree(caseName, root, expectedFiles, expectedAbsent) {
  const actualPaths = await listFiles(root);
  const expectedPaths = Object.keys(expectedFiles).sort();
  assertEqual(caseName, "file list", actualPaths, expectedPaths);

  for (const [path, text] of Object.entries(expectedFiles)) {
    const expected = Buffer.from(requiredString(text, path, "expected file text"), "utf8");
    const actual = await readFile(join(root, path));
    if (!actual.equals(expected)) {
      throw new Error(`${caseName}: ${path} bytes differ`);
    }
  }

  for (const path of expectedAbsent) {
    try {
      await access(join(root, path), constants.F_OK);
    } catch {
      continue;
    }
    throw new Error(`${caseName}: expected ${path} to be absent`);
  }
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...await listFiles(root, path));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths.sort();
}

function requiredString(value, label, field) {
  if (typeof value !== "string") {
    throw new Error(`${label}: ${field} must be a string`);
  }
  return value;
}

function assertEqual(caseName, label, actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${caseName}: ${label} expected ${expectedJson}, got ${actualJson}`);
  }
}
