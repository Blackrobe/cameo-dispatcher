import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { codexExecutionArgs } from "../src/codex-policy.mjs";
import { startGhReadBroker } from "../src/gh-read-broker.mjs";
import { readJson, validateConfig } from "../src/lib.mjs";
import { sanitizeWorkerEnvironment } from "../src/worker-service-lib.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptRoot, "..");
const configPath = path.resolve(process.argv[2] ?? path.join(projectRoot, "config.json"));
const prNumber = String(process.argv[3] ?? "400");
const executionMode = process.argv[4] ?? "read_only";
if (!/^\d{1,7}$/.test(prNumber))
  throw new Error("pull request number must be numeric");
if (!new Set(["read_only", "draft_pr"]).has(executionMode))
  throw new Error("execution mode must be read_only or draft_pr");

const config = validateConfig(await readJson(configPath));
const stateRoot = await mkdtemp(path.join(os.tmpdir(), "cameo-gh-sandbox-smoke-"));
const finalPath = path.join(stateRoot, "final.json");
const auditPath = path.join(stateRoot, "audit.jsonl");
const schemaPath = path.join(projectRoot, "schemas", "result.schema.json");
const job = {
  requestId: `gh-sandbox-smoke-${Date.now()}`,
  runRevision: 1,
  objective: `Inspect Cameo PR #${prNumber}.`,
  acceptanceCriteria: ["Read cached PR metadata and the actual diff."],
  executionMode,
  model: "gpt-5.6-sol",
  reasoningEffort: "high"
};
const broker = await startGhReadBroker({
  config, job, worktreePath: config.repoRoot, auditPath, phase: "sandbox-smoke"
});

try {
  const args = codexExecutionArgs(job, config.repoRoot, schemaPath, finalPath);
  args.push(`Perform a read-only GitHub broker smoke test for Cameo PR #${prNumber}. Run all five commands exactly: gh pr view ${prNumber} --json state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefOid,changedFiles; gh pr diff ${prNumber} --name-only; gh pr diff ${prNumber}; git --version; rg --version. Do not edit any file. Return completed only if both GitHub metadata and the actual diff were read and git plus rg remained available. Put concise command evidence in validation, changedFiles must be empty, and note that no GitHub write was attempted.`);
  const child = spawn(config.codexBin, args, {
    cwd: config.repoRoot,
    env: broker.environment(sanitizeWorkerEnvironment(process.env)),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-8000); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const result = JSON.parse(await readFile(finalPath, "utf8"));
  const auditText = await readFile(auditPath, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
  const audit = auditText.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  process.stdout.write(`${JSON.stringify({
    exitCode,
    result,
    brokerCommands: audit.filter(entry => entry.command).map(entry => ({ command: entry.command, exitCode: entry.exitCode, outputBytes: entry.outputBytes })),
    diagnostics: diagnostics.trim()
  }, null, 2)}\n`);
  if (exitCode !== 0 || result.status !== "completed" || audit.filter(entry => entry.command).length < 3)
    process.exitCode = 1;
} finally {
  await broker.stop();
  await rm(stateRoot, { recursive: true, force: true });
}
