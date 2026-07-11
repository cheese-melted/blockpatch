#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceArg = process.argv[2];
if (workspaceArg === undefined) {
  fail("usage: node shooter-move-csv.mjs <workspace>");
}
const workspace = resolve(workspaceArg);
const indexPath = resolve(workspace, "src/game/telemetry/index.ts");
const csvPath = resolve(workspace, "src/game/telemetry/csv.ts");
const index = readFileSync(indexPath, "utf8");
const csv = readFileSync(csvPath, "utf8");

const expected = [
  {
    name: "summariesToCsv",
    marker: "export function summariesToCsv",
    bytes: 2943,
    sha256: "fa4ed6f2bc9a6120b96e2999fb9764346e615ab4e487960067bb69ca998b54eb"
  },
  {
    name: "summaryToCsvRow",
    marker: "function summaryToCsvRow",
    bytes: 4275,
    sha256: "eb18e99aeee95693f567cd71e9543e600523ca9d94452f10deb5ee1fb40f510d"
  }
];

for (const block of expected) {
  if (index.includes(block.marker)) {
    fail(`${block.name} still exists in telemetry/index.ts`);
  }
  const start = csv.indexOf(block.marker);
  if (start < 0) {
    fail(`${block.name} is missing from telemetry/csv.ts`);
  }
  const candidate = csv.slice(start, start + block.bytes);
  const digest = createHash("sha256").update(candidate).digest("hex");
  if (digest !== block.sha256) {
    fail(`${block.name} was not moved byte-for-byte`);
  }
}

if (!/export\s*\{\s*summariesToCsv\s*\}\s*from\s*["']\.\/csv["']/u.test(index)) {
  fail("telemetry/index.ts does not re-export summariesToCsv from ./csv");
}

const changed = git(["diff", "--name-only", "HEAD"]).trim().split("\n").filter(Boolean).sort();
const allowed = ["src/game/telemetry/csv.ts", "src/game/telemetry/index.ts"];
if (JSON.stringify(changed) !== JSON.stringify(allowed)) {
  fail(`unexpected changed files: ${changed.join(", ") || "none"}`);
}

process.stdout.write("hidden evaluator: pass\n");

function git(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function fail(message) {
  process.stderr.write(`hidden evaluator: ${message}\n`);
  process.exit(1);
}
