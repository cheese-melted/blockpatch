#!/usr/bin/env node

import { createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const experimentRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(experimentRoot);
const taskRoot = join(experimentRoot, "tasks");
const runsRoot = resolve(process.env.BLOCKPATCH_EXPERIMENT_RUNS ?? join(projectRoot, "..", ".blockpatch-experiment-runs"));
const arms = new Set(["baseline", "blockpatch"]);

main().catch((error) => {
  process.stderr.write(`experiment: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const [command = "help", taskId, arm, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "list") {
    await listTasks();
    return;
  }
  if (command === "doctor") {
    await doctor(taskId);
    return;
  }
  if (taskId === undefined) {
    throw new Error(`${command} requires a task id; run: npm run experiment -- list`);
  }

  const task = await loadTask(taskId);
  if (command === "setup") {
    await setupTask(task, options.force);
    return;
  }
  if (command === "run") {
    requireArm(arm);
    await runArm(task, arm, options);
    return;
  }
  if (command === "run-all") {
    await runArm(task, "baseline", options);
    await runArm(task, "blockpatch", options);
    await compareTask(task);
    return;
  }
  if (command === "evaluate") {
    if (arm === undefined) {
      for (const candidate of arms) {
        await evaluateExistingArm(task, candidate);
      }
    } else {
      requireArm(arm);
      await evaluateExistingArm(task, arm);
    }
    return;
  }
  if (command === "compare") {
    await compareTask(task);
    return;
  }
  if (command === "clean") {
    await cleanTask(task);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

function parseOptions(args) {
  const options = { agent: "codex", force: false, model: undefined, reasoning: undefined, timeout: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--agent" || arg === "--model" || arg === "--reasoning" || arg === "--timeout") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--agent") {
        if (value !== "codex" && value !== "pi") throw new Error("agent must be codex or pi");
        options.agent = value;
      } else if (arg === "--model") {
        options.model = value;
      } else if (arg === "--reasoning") {
        options.reasoning = value;
      } else {
        options.timeout = positiveInteger(value, "timeout");
      }
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function listTasks() {
  const entries = (await readdir(taskRoot)).filter((entry) => entry.endsWith(".json")).sort();
  for (const entry of entries) {
    const task = await loadTask(entry.slice(0, -5));
    process.stdout.write(`${task.id}\t${task.description}\n`);
  }
}

async function loadTask(taskId) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(taskId)) {
    throw new Error(`invalid task id: ${taskId}`);
  }
  const path = join(taskRoot, `${taskId}.json`);
  let task;
  try {
    task = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`unknown task: ${taskId}`);
    }
    throw error;
  }
  for (const key of ["id", "description", "repository", "base", "reference", "test_command", "prompt"]) {
    if (typeof task[key] !== "string" || task[key].length === 0) {
      throw new Error(`${path}: ${key} must be a non-empty string`);
    }
  }
  if (task.id !== taskId) {
    throw new Error(`${path}: id must match its filename`);
  }
  if (task.setup_command !== undefined && typeof task.setup_command !== "string") {
    throw new Error(`${path}: setup_command must be a string`);
  }
  if (task.evaluation_command !== undefined && typeof task.evaluation_command !== "string") {
    throw new Error(`${path}: evaluation_command must be a string`);
  }
  task.timeout_seconds = positiveInteger(task.timeout_seconds ?? 900, "timeout_seconds");
  task.repositoryPath = resolve(projectRoot, task.repository);
  task.runPath = join(runsRoot, task.id);
  return task;
}

async function doctor(taskId) {
  const checks = [
    commandCheck("git", ["--version"]),
    commandCheck("node", ["--version"]),
    commandCheck("bun", ["--version"]),
    commandCheck("codex", ["--version"]),
    commandCheck("pi", ["--version"])
  ];
  const blockpatchCli = join(projectRoot, "dist", "cli.js");
  checks.push({ label: "blockpatch build", ok: existsSync(blockpatchCli), detail: blockpatchCli });

  if (taskId !== undefined) {
    const task = await loadTask(taskId);
    checks.push({
      label: "source repository",
      ok: isGitRepository(task.repositoryPath),
      detail: task.repositoryPath
    });
    checks.push(refCheck(task.repositoryPath, task.base, "base ref"));
    checks.push(refCheck(task.repositoryPath, task.reference, "reference ref"));
  }

  for (const check of checks) {
    process.stdout.write(`${check.ok ? "ok" : "FAIL"}\t${check.label}\t${check.detail}\n`);
  }
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

function commandCheck(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const detail = (result.stdout || result.stderr || "not found").trim().split("\n")[0];
  return { label: command, ok: result.status === 0, detail };
}

function refCheck(repository, ref, label) {
  const result = spawnSync("git", ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8"
  });
  return { label, ok: result.status === 0, detail: result.status === 0 ? result.stdout.trim() : ref };
}

function isGitRepository(path) {
  return spawnSync("git", ["-C", path, "rev-parse", "--git-dir"], { stdio: "ignore" }).status === 0;
}

async function setupTask(task, force) {
  await assertTaskSource(task);
  if (existsSync(task.runPath)) {
    if (!force) {
      throw new Error(`run already exists: ${task.runPath}; use --force or clean it first`);
    }
    await rm(task.runPath, { recursive: true, force: true });
  }
  await mkdir(task.runPath, { recursive: true });
  const resolvedBase = gitText(task.repositoryPath, ["rev-parse", `${task.base}^{commit}`]);
  const resolvedReference = gitText(task.repositoryPath, ["rev-parse", `${task.reference}^{commit}`]);

  for (const arm of arms) {
    const armPath = join(task.runPath, arm);
    const workspace = join(armPath, "workspace");
    await mkdir(workspace, { recursive: true });
    process.stdout.write(`Preparing ${task.id}/${arm} from ${resolvedBase.slice(0, 12)}\n`);
    await exportSnapshot(task.repositoryPath, resolvedBase, armPath, workspace);
    runChecked("git", ["init", "--quiet"], workspace);
    runChecked("git", ["config", "user.name", "blockpatch experiment"], workspace);
    runChecked("git", ["config", "user.email", "experiment@localhost"], workspace);
    await mkdir(join(workspace, ".git", "info"), { recursive: true });
    await writeFile(join(workspace, ".git", "info", "exclude"), ".blockpatch-artifacts/\n", "utf8");
    runChecked("git", ["add", "-A"], workspace);
    runChecked("git", ["commit", "--quiet", "-m", "experiment baseline"], workspace);
    if (task.setup_command) {
      const setupLog = join(armPath, "setup.log");
      const result = await runShell(task.setup_command, workspace, setupLog, task.timeout_seconds);
      if (result.exitCode !== 0) {
        throw new Error(`setup failed for ${arm}; see ${setupLog}`);
      }
    }
    await writeJson(join(armPath, "setup.json"), {
      task: task.id,
      arm,
      source_repository: task.repositoryPath,
      base: resolvedBase,
      reference: resolvedReference,
      created_at: new Date().toISOString()
    });
  }
  process.stdout.write(`Ready: ${task.runPath}\n`);
}

async function assertTaskSource(task) {
  if (!isGitRepository(task.repositoryPath)) {
    throw new Error(`not a Git repository: ${task.repositoryPath}`);
  }
  refCheckOrThrow(task.repositoryPath, task.base);
  refCheckOrThrow(task.repositoryPath, task.reference);
  const blockpatchCli = join(projectRoot, "dist", "cli.js");
  if (!existsSync(blockpatchCli)) {
    throw new Error(`blockpatch is not built; run: bun run build`);
  }
}

function refCheckOrThrow(repository, ref) {
  const result = spawnSync("git", ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`], {
    stdio: "ignore"
  });
  if (result.status !== 0) {
    throw new Error(`Git ref does not exist in ${repository}: ${ref}`);
  }
}

async function exportSnapshot(repository, commit, armPath, workspace) {
  const archive = join(armPath, "snapshot.tar");
  runChecked("git", ["-C", repository, "archive", "--format=tar", `--output=${archive}`, commit], projectRoot);
  runChecked("tar", ["-xf", archive, "-C", workspace], projectRoot);
  await rm(archive, { force: true });
}

async function runArm(task, arm, options) {
  requireArm(arm);
  const armPath = join(task.runPath, arm);
  const workspace = join(armPath, "workspace");
  if (!existsSync(join(workspace, ".git"))) {
    throw new Error(`task is not set up; run: npm run experiment -- setup ${task.id}`);
  }
  if (existsSync(join(armPath, "result.json")) && !options.force) {
    throw new Error(`${task.id}/${arm} already ran; use --force to rerun after setup`);
  }
  if (options.force) {
    runChecked("git", ["reset", "--hard", "HEAD"], workspace);
    runChecked("git", ["clean", "-fd", "-e", "node_modules"], workspace);
    await rm(join(workspace, ".blockpatch-artifacts"), { recursive: true, force: true });
  }

  const prompt = buildPrompt(task, arm, options.agent);
  await writeFile(join(armPath, "prompt.md"), prompt, "utf8");
  if (arm === "blockpatch") {
    await mkdir(join(workspace, ".blockpatch-artifacts"), { recursive: true });
  }

  const timeoutSeconds = options.timeout ?? task.timeout_seconds;
  const eventLog = join(armPath, `${options.agent}.jsonl`);
  const finalMessage = join(armPath, "last-message.md");

  process.stdout.write(`Running ${task.id}/${arm} with ${options.agent} (timeout ${timeoutSeconds}s)\n`);
  const startedAt = Date.now();
  const agentResult = options.agent === "pi"
    ? await runPiAgent({ arm, eventLog, prompt, workspace, timeoutSeconds, options, armPath })
    : await runCodexAgent({ eventLog, finalMessage, prompt, workspace, timeoutSeconds, options, armPath });
  if (options.agent === "pi") {
    await writeFile(finalMessage, await lastPiMessage(eventLog), "utf8");
  }
  const testLog = join(armPath, "test.log");
  process.stdout.write(`Testing ${task.id}/${arm}\n`);
  const testResult = await runShell(task.test_command, workspace, testLog, timeoutSeconds);
  const hiddenResult = await runHiddenEvaluation(task, workspace, armPath, timeoutSeconds);
  const evaluation = await captureEvaluation(task, armPath, workspace);
  const eventMetrics = await readAgentEventMetrics(eventLog, options.agent);
  const result = {
    task: task.id,
    arm,
    agent: options.agent,
    event_log: `${options.agent}.jsonl`,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    agent_exit_code: agentResult.exitCode,
    agent_timed_out: agentResult.timedOut,
    codex_exit_code: options.agent === "codex" ? agentResult.exitCode : undefined,
    codex_timed_out: options.agent === "codex" ? agentResult.timedOut : undefined,
    test_exit_code: testResult.exitCode,
    test_timed_out: testResult.timedOut,
    hidden_test_exit_code: hiddenResult?.exitCode ?? null,
    hidden_test_timed_out: hiddenResult?.timedOut ?? false,
    requested_model: options.model ?? null,
    requested_reasoning_effort: options.reasoning ?? null,
    usage: eventMetrics.usage,
    blockpatch_commands: eventMetrics.blockpatchCommands,
    blockpatch_plans: eventMetrics.blockpatchPlans,
    blockpatch_applies: eventMetrics.blockpatchApplies,
    ...evaluation
  };
  await writeJson(join(armPath, "result.json"), result);
  process.stdout.write(`${arm}: ${options.agent}=${result.agent_exit_code} tests=${result.test_exit_code} exact_reference=${result.exact_reference}\n`);
}

async function runCodexAgent({ eventLog, finalMessage, prompt, workspace, timeoutSeconds, options, armPath }) {
  const args = [
    "exec",
    "--cd", workspace,
    "--sandbox", "workspace-write",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    "--color", "never",
    "--output-last-message", finalMessage
  ];
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.reasoning !== undefined) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(options.reasoning)}`);
  }
  args.push("-");
  return runProcess("codex", args, {
    cwd: workspace,
    stdin: prompt,
    logPath: eventLog,
    stderrLogPath: join(armPath, "codex.stderr.log"),
    timeoutSeconds
  });
}

async function runPiAgent({ arm, eventLog, prompt, workspace, timeoutSeconds, options, armPath }) {
  const allowedReasoning = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
  if (options.reasoning !== undefined && !allowedReasoning.has(options.reasoning)) {
    throw new Error(`Pi reasoning must be one of ${[...allowedReasoning].join(", ")}; ${options.reasoning} is not supported`);
  }
  const args = [
    "--mode", "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--approve",
    "--tools", arm === "blockpatch" ? "read,bash,edit,write,blockpatch" : "read,bash,edit,write"
  ];
  if (arm === "blockpatch") {
    args.push("--extension", join(projectRoot, "dist", "pi", "index.js"));
  }
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.reasoning !== undefined) args.push("--thinking", options.reasoning);
  args.push(prompt);
  return runProcess("pi", args, {
    cwd: workspace,
    logPath: eventLog,
    stderrLogPath: join(armPath, "pi.stderr.log"),
    timeoutSeconds
  });
}

async function runHiddenEvaluation(task, workspace, armPath, timeoutSeconds) {
  if (!task.evaluation_command) {
    return null;
  }
  process.stdout.write(`Evaluating hidden acceptance checks\n`);
  const command = task.evaluation_command
    .replaceAll("{experiment_root}", shellQuote(experimentRoot))
    .replaceAll("{workspace}", shellQuote(workspace));
  return runShell(command, workspace, join(armPath, "hidden-test.log"), timeoutSeconds);
}

async function evaluateExistingArm(task, arm) {
  const armPath = join(task.runPath, arm);
  const workspace = join(armPath, "workspace");
  const resultPath = join(armPath, "result.json");
  if (!existsSync(resultPath) || !existsSync(join(workspace, ".git"))) {
    throw new Error(`missing completed run for ${task.id}/${arm}`);
  }
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  const hidden = await runHiddenEvaluation(task, workspace, armPath, task.timeout_seconds);
  const agent = result.agent ?? "codex";
  const eventMetrics = await readAgentEventMetrics(join(armPath, result.event_log ?? "codex.jsonl"), agent);
  result.hidden_test_exit_code = hidden?.exitCode ?? null;
  result.hidden_test_timed_out = hidden?.timedOut ?? false;
  result.usage = eventMetrics.usage;
  result.blockpatch_commands = eventMetrics.blockpatchCommands;
  result.blockpatch_plans = eventMetrics.blockpatchPlans;
  result.blockpatch_applies = eventMetrics.blockpatchApplies;
  await writeJson(resultPath, result);
  process.stdout.write(`${arm}: hidden acceptance=${result.hidden_test_exit_code === 0 ? "pass" : "fail"}\n`);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildPrompt(task, arm, agent) {
  const common = [
    "You are working in an isolated experiment copy of a real repository.",
    "Complete the task below autonomously. You may inspect the current files and run tests.",
    "Do not inspect parent directories, sibling repositories, remotes, reflogs, or external commit history for a completed solution.",
    "Use ordinary editing tools as needed. Do not commit the result.",
    "",
    "Task:",
    task.prompt
  ];
  if (arm === "baseline") {
    return `${common.join("\n")}\n`;
  }
  if (agent === "pi") {
    return `${[
      ...common.slice(0, 4),
      "For byte-exact movement of existing blocks, use the native blockpatch tool when it is genuinely suitable; use edit/write for imports, transformations, and other changes.",
      "Call blockpatch with action=plan, review the returned patch, then call action=apply with the returned artifact path.",
      "Keep every file under .blockpatch-artifacts/ for experiment review; they are ignored by Git and must not be deleted or hand-edited.",
      ...common.slice(4)
    ].join("\n")}\n`;
  }
  const blockpatchCli = join(projectRoot, "dist", "cli.js");
  return `${[
    ...common.slice(0, 4),
    `For byte-exact movement of existing blocks, blockpatch is available as: node ${blockpatchCli}`,
    "Use it when it is genuinely suitable; ordinary editing remains available for imports, call sites, transformations, and other changes.",
    "When using blockpatch, plan a reviewable artifact under .blockpatch-artifacts/, dry-run it, inspect it, and then apply that artifact.",
    "Keep every file under .blockpatch-artifacts/ for experiment review; they are ignored by Git and must not be deleted.",
    "Do not use blockpatch merely to satisfy the experiment, and do not edit generated .blockpatch files by hand.",
    ...common.slice(4)
  ].join("\n")}\n`;
}

async function runShell(command, cwd, logPath, timeoutSeconds) {
  return runProcess("bash", ["-lc", command], { cwd, logPath, timeoutSeconds });
}

async function runProcess(command, args, options) {
  await mkdir(dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: "w" });
  const stderrLog = options.stderrLogPath
    ? createWriteStream(options.stderrLogPath, { flags: "w" })
    : log;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    let timedOut = false;
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(stderrLog, { end: false });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        child.kill("SIGTERM");
      } else {
        process.kill(-child.pid, "SIGTERM");
      }
    }, options.timeoutSeconds * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      log.end();
      if (stderrLog !== log) stderrLog.end();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let remaining = stderrLog === log ? 1 : 2;
      const finished = () => {
        remaining -= 1;
        if (remaining === 0) resolvePromise({ exitCode: code ?? 1, timedOut });
      };
      log.end(finished);
      if (stderrLog !== log) stderrLog.end(finished);
    });
  });
}

async function captureEvaluation(task, armPath, workspace) {
  const setup = JSON.parse(await readFile(join(armPath, "setup.json"), "utf8"));
  const indexPath = join(armPath, "evaluation.index");
  await rm(indexPath, { force: true });
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  runChecked("git", ["read-tree", "HEAD"], workspace, env);
  runChecked("git", ["add", "-A"], workspace, env);
  const resultTree = runText("git", ["write-tree"], workspace, env);
  const referenceTree = gitText(task.repositoryPath, ["rev-parse", `${setup.reference}^{tree}`]);
  const diff = runText("git", ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"], workspace, env);
  const statText = runText("git", ["diff", "--cached", "--shortstat", "HEAD"], workspace, env).trim();
  const nameStatus = runText("git", ["diff", "--cached", "--name-status", "HEAD"], workspace, env).trim();
  await writeFile(join(armPath, "result.patch"), diff, "utf8");
  await writeFile(join(armPath, "files.txt"), nameStatus ? `${nameStatus}\n` : "", "utf8");
  await rm(indexPath, { force: true });
  return {
    result_tree: resultTree.trim(),
    reference_tree: referenceTree,
    exact_reference: resultTree.trim() === referenceTree,
    changed_files: nameStatus ? nameStatus.split("\n").length : 0,
    diff_stat: statText,
    blockpatch_artifacts: await countFiles(join(workspace, ".blockpatch-artifacts"), ".blockpatch")
  };
}

async function countFiles(root, suffix) {
  if (!existsSync(root)) {
    return 0;
  }
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(path, suffix);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      count += 1;
    }
  }
  return count;
}

async function readAgentEventMetrics(path, agent) {
  let inputTokens = null;
  let outputTokens = null;
  let blockpatchCommands = 0;
  let blockpatchPlans = 0;
  let blockpatchApplies = 0;
  try {
    const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = event.usage ?? event.data?.usage ?? event.item?.usage ?? event.message?.usage;
      if (agent === "pi" && event.type === "message_end" && event.message?.role === "assistant" && usage) {
        const currentInput = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        inputTokens = (inputTokens ?? 0) + currentInput;
        outputTokens = (outputTokens ?? 0) + (usage.output ?? 0);
      } else if (usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) {
        inputTokens = usage.input_tokens;
        outputTokens = usage.output_tokens;
      }
      if (agent === "pi" && event.type === "tool_execution_start" && event.toolName === "blockpatch") {
        blockpatchCommands += 1;
        if (event.args?.action === "plan") blockpatchPlans += 1;
        if (event.args?.action === "apply") blockpatchApplies += 1;
      } else if (event.type === "item.completed" && event.item?.type === "command_execution") {
        const command = event.item.command ?? "";
        if (command.includes("blockpatch/dist/cli.js")) {
          blockpatchCommands += 1;
          if (/dist\/cli\.js move\b.*--diff\b/u.test(command)) blockpatchPlans += 1;
          if (/dist\/cli\.js apply\b/u.test(command)) blockpatchApplies += 1;
        }
      }
    }
  } catch {
    // Missing logs remain explicit null/zero measurements.
  }
  return {
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    blockpatchCommands,
    blockpatchPlans,
    blockpatchApplies
  };
}

async function lastPiMessage(path) {
  let text = "";
  try {
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
      const content = event.message.content ?? [];
      const messageText = content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (messageText) text = messageText;
    }
  } catch {
    return text;
  }
  return text;
}

async function compareTask(task) {
  const rows = [];
  for (const arm of arms) {
    const path = join(task.runPath, arm, "result.json");
    if (!existsSync(path)) {
      throw new Error(`missing result for ${arm}; run both arms first`);
    }
    rows.push(JSON.parse(await readFile(path, "utf8")));
  }
  const lines = [
    `# Experiment report: ${task.description}`,
    "",
    "| Arm | Project tests | Hidden acceptance | Duration | Changed files | BP plans/applies | Artifacts kept | Tokens (in/out) |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const row of rows) {
    const tests = row.test_exit_code === 0 ? "pass" : row.test_timed_out ? "timeout" : "fail";
    const hidden = row.hidden_test_exit_code === null || row.hidden_test_exit_code === undefined
      ? "n/a"
      : row.hidden_test_exit_code === 0 ? "pass" : row.hidden_test_timed_out ? "timeout" : "fail";
    const tokens = row.usage?.input_tokens === null ? "n/a" : `${row.usage.input_tokens}/${row.usage.output_tokens}`;
    lines.push(`| ${row.arm} | ${tests} | ${hidden} | ${row.duration_seconds}s | ${row.changed_files} | ${row.blockpatch_plans ?? 0}/${row.blockpatch_applies ?? 0} | ${row.blockpatch_artifacts} | ${tokens} |`);
  }
  const baseline = rows.find((row) => row.arm === "baseline");
  const treatment = rows.find((row) => row.arm === "blockpatch");
  const identicalTrees = rows.length > 0 && rows.every((row) => row.result_tree === rows[0].result_tree);
  lines.push(
    "",
    `Final result trees identical across arms: ${identicalTrees ? "yes" : "no"}.`,
    baseline && treatment
      ? `Treatment overhead: ${formatDelta(treatment.duration_seconds, baseline.duration_seconds)} duration, ${formatDelta(treatment.usage?.input_tokens, baseline.usage?.input_tokens)} input tokens, ${formatDelta(treatment.usage?.output_tokens, baseline.usage?.output_tokens)} output tokens.`
      : "Treatment overhead: unavailable.",
    "Hidden acceptance, project tests, and human review remain the primary evaluation; exact historical equality is only supporting evidence.",
    "",
    "## Diff summaries",
    ""
  );
  for (const row of rows) {
    lines.push(`- ${row.arm}: ${row.diff_stat || "no changes"}`);
  }
  lines.push("");
  const report = `${lines.join("\n")}\n`;
  await writeFile(join(task.runPath, "report.md"), report, "utf8");
  process.stdout.write(report);
  process.stdout.write(`Artifacts: ${task.runPath}\n`);
}

function formatDelta(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) {
    return "n/a";
  }
  const percent = ((value - baseline) / baseline) * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

async function cleanTask(task) {
  if (!existsSync(task.runPath)) {
    process.stdout.write(`Already clean: ${task.runPath}\n`);
    return;
  }
  const resolved = resolve(task.runPath);
  const relativePath = relative(resolve(runsRoot), resolved);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`refusing to remove unsafe path: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
  process.stdout.write(`Removed ${resolved}\n`);
}

function requireArm(arm) {
  if (!arms.has(arm)) {
    throw new Error(`arm must be baseline or blockpatch`);
  }
}

function runChecked(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

function runText(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function gitText(repository, args) {
  return runText("git", args, repository).trim();
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function printHelp() {
  process.stdout.write(`blockpatch real-world experiment harness

Usage:
  npm run experiment -- list
  npm run experiment -- doctor [task]
  npm run experiment -- setup <task> [--force]
  npm run experiment -- run <task> <baseline|blockpatch> [--agent <codex|pi>] [--model <model>] [--reasoning <effort>] [--timeout <seconds>]
  npm run experiment -- run-all <task> [--agent <codex|pi>] [--model <model>] [--reasoning <effort>] [--timeout <seconds>]
  npm run experiment -- evaluate <task> [baseline|blockpatch]
  npm run experiment -- compare <task>
  npm run experiment -- clean <task>

Each arm receives a fresh source snapshot in a sibling .blockpatch-experiment-runs directory. The source
repository is read but never checked out, reset, cleaned, or modified.
`);
}
