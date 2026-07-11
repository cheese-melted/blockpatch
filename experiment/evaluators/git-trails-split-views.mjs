#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspace = resolve(process.argv[2] ?? "");
if (process.argv[2] === undefined) {
  fail("usage: node git-trails-split-views.mjs <workspace>");
}

const fixture = mkdtempSync(join(tmpdir(), "blockpatch-hidden-eval-"));
try {
  git(["init", "--quiet"]);
  git(["config", "user.name", "hidden evaluator"]);
  git(["config", "user.email", "evaluator@localhost"]);
  writeFileSync(join(fixture, "old.txt"), "alpha line\nbeta line\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "base"]);
  rmSync(join(fixture, "old.txt"));
  writeFileSync(join(fixture, "new.txt"), "alpha line\nbeta line\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "move"]);
  const commit = git(["rev-parse", "HEAD"]).trim();

  const content = cli(["content", commit, "--cwd", fixture]);
  assertSuccess(content, "content command");
  assertIncludes(content.stdout, "old.txt", "content source");
  assertIncludes(content.stdout, "new.txt", "content destination");

  const identity = cli(["identity", commit, "--cwd", fixture]);
  assertSuccess(identity, "existing identity command");
  assertIncludes(identity.stdout, "old.txt", "identity source");
  assertIncludes(identity.stdout, "new.txt", "identity destination");

  for (const direction of ["identity-from", "identity-to"]) {
    const result = cli([direction, commit, "--cwd", fixture]);
    assertSuccess(result, `${direction} command`);
    assertIncludes(result.stdout, "old.txt", `${direction} source`);
    assertIncludes(result.stdout, "new.txt", `${direction} destination`);
    assertIncludes(result.stdout, "100%", `${direction} percentage`);
  }

  const removed = cli(["identity-summary", commit, "--cwd", fixture]);
  if (removed.status === 0) {
    fail("identity-summary should have been replaced");
  }

  const exportsCheck = spawnSync(
    "bun",
    [
      "-e",
      'import * as api from "./src/index.ts"; for (const name of ["renderContent", "renderIdentity", "renderIdentityFrom", "renderIdentityTo", "identityFlows"]) { if (typeof api[name] !== "function") throw new Error(`missing export: ${name}`); }'
    ],
    { cwd: workspace, encoding: "utf8" }
  );
  assertSuccess(exportsCheck, "public view exports");
  process.stdout.write("hidden evaluator: pass\n");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function cli(args) {
  return spawnSync("bun", [join(workspace, "src", "cli.ts"), ...args], {
    cwd: workspace,
    encoding: "utf8"
  });
}

function git(args) {
  const result = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
  assertSuccess(result, `git ${args[0]}`);
  return result.stdout;
}

function assertSuccess(result, label) {
  if (result.status !== 0) {
    fail(`${label} failed: ${(result.stderr || result.stdout || "no output").trim()}`);
  }
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    fail(`${label} did not include ${JSON.stringify(expected)}: ${JSON.stringify(value)}`);
  }
}

function fail(message) {
  process.stderr.write(`hidden evaluator: ${message}\n`);
  process.exit(1);
}
