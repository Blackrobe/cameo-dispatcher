import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { codexExecutionArgs } from "../src/codex-policy.mjs";
import { sanitizeWorkerEnvironment } from "../src/worker-service-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerConfig = JSON.parse(readFileSync(path.join(projectRoot, "config.json"), "utf8"));
const sourceRepo = runnerConfig.repoRoot;
const proofName = `cross-model-${Date.now()}`;
const proofRoot = path.join(projectRoot, "state", proofName);
const worktree = path.join(path.parse(projectRoot).root, "Users", process.env.USERNAME, "CameoDispatcherWorktrees", proofName);
mkdirSync(proofRoot, { recursive: true });

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}
git(sourceRepo, "worktree", "add", "--detach", worktree, runnerConfig.baseRef);
const baseHead = git(worktree, "rev-parse", "HEAD");
const nonce = randomUUID();

function execute(label, job, tailArgs) {
  const finalPath = path.join(proofRoot, `${label}-final.json`);
  const args = codexExecutionArgs(job, worktree, path.join(projectRoot, "schemas", "result.schema.json"), finalPath);
  args.push(...tailArgs);
  const result = spawnSync(runnerConfig.codexBin, args, { cwd: worktree, env: sanitizeWorkerEnvironment(process.env), encoding: "utf8", windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(path.join(proofRoot, `${label}-events.jsonl`), result.stdout ?? "");
  writeFileSync(path.join(proofRoot, `${label}-diagnostics.log`), result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with ${result.status}`);
  const thread = (result.stdout ?? "").split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(event => event?.type === "thread.started")?.thread_id;
  return { thread, final: JSON.parse(readFileSync(finalPath, "utf8")) };
}

const first = execute("sol", { executionMode: "draft_pr", model: "gpt-5.6-sol", reasoningEffort: "high" }, [
  `Create sol-proof.txt containing exactly ${nonce}. Remember that nonce. Do not commit. Return completed JSON and include the nonce in summary.`
]);
if (!first.thread || first.final.status !== "completed" || !first.final.summary.includes(nonce)) throw new Error("Sol proof did not establish session context");
const second = execute("astra", { executionMode: "draft_pr", model: "gpt-6-astra", reasoningEffort: "max" }, [
  "resume", first.thread,
  "Recall the exact nonce from the prior turn, verify sol-proof.txt contains it, then create astra-proof.txt with the same nonce. Do not commit. Return completed JSON and include the nonce in summary."
]);
const pass = second.thread === first.thread && second.final.status === "completed" && second.final.summary.includes(nonce)
  && readFileSync(path.join(worktree, "astra-proof.txt"), "utf8").trim() === nonce
  && git(worktree, "rev-parse", "HEAD") === baseHead;
writeFileSync(path.join(proofRoot, "proof.json"), `${JSON.stringify({ pass, sessionId: first.thread, nonce, worktree, sol: first.final, astra: second.final }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ pass, proofRoot, sessionId: first.thread, worktree }, null, 2)}\n`);
if (!pass) process.exitCode = 1;
