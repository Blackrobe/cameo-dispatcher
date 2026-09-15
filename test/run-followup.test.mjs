import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");

test("missing dispatcher root session fails closed without creating a replacement worktree", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-followup-missing-"));
  const stateRoot = path.join(root, "state");
  const worktreeRoot = path.join(root, "worktrees");
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const configPath = path.join(root, "config.json");
  const jobPath = path.join(root, "job.json");
  writeFileSync(configPath, JSON.stringify({
    repoRoot: root,
    baseRef: "HEAD",
    worktreeRoot,
    stateRoot,
    codexBin: "C:\\trusted\\codex.exe", ghBin: "C:\\trusted\\gh.exe",
    gitBin: "C:\\trusted\\git.exe", sshBin: "C:\\trusted\\ssh.exe",
    sandbox: "read-only",
    maxJobMinutes: 1
  }));
  writeFileSync(jobPath, JSON.stringify({
    requestId: "discord-followup-missing-root",
    requestedBy: { human: "Aedis", tool: "Cameo Dispatcher" },
    objective: "Continue the missing job.",
    acceptanceCriteria: ["Fail closed."],
    scope: [],
    runKind: "followup",
    parentJobId: "CAM-20260915-1234ABCD",
    rootRequestId: "discord-message-missing-root",
    runRevision: 2,
    resumeSessionId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6"
  }));

  try {
    const result = spawnSync(process.execPath, [path.join(projectRoot, "src", "run-followup.mjs"), configPath, jobPath], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(result.status, 0);
    const statusPath = path.join(stateRoot, "jobs", "discord-message-missing-root", "runs", "2", "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    assert.equal(status.state, "needs_attention");
    assert.equal(status.codexThreadId, "01a0a275-a2f1-73f1-89ae-f94d4b983fd6");
    assert.equal(existsSync(path.join(worktreeRoot, "discord-message-missing-root")), false);
    assert.equal(existsSync(path.join(stateRoot, "runner.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing active Codex session fails before resume and creates no replacement", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-followup-session-"));
  const stateRoot = path.join(root, "state");
  const worktreeRoot = path.join(root, "worktrees");
  const rootRequestId = "discord-message-missing-session";
  const expectedWorktree = path.join(worktreeRoot, rootRequestId);
  const rootState = path.join(stateRoot, "jobs", rootRequestId);
  mkdirSync(rootState, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const configPath = path.join(root, "config.json");
  const jobPath = path.join(root, "job.json");
  const sessionId = "01a0a275-a2f1-73f1-89ae-f94d4b983fd6";
  writeFileSync(configPath, JSON.stringify({
    repoRoot: root, baseRef: "HEAD", worktreeRoot, stateRoot,
    codexBin: "C:\\trusted\\codex.exe", ghBin: "C:\\trusted\\gh.exe",
    gitBin: "C:\\trusted\\git.exe", sshBin: "C:\\trusted\\ssh.exe",
    sandbox: "read-only", maxJobMinutes: 1
  }));
  writeFileSync(path.join(rootState, "status.json"), JSON.stringify({
    requestId: rootRequestId,
    state: "ready_for_review",
    baseCommit: "abc123",
    worktreePath: expectedWorktree,
    codexThreadId: sessionId
  }));
  writeFileSync(jobPath, JSON.stringify({
    requestId: "discord-followup-missing-session",
    requestedBy: { human: "Aedis", tool: "Cameo Dispatcher" },
    objective: "Continue the missing session.",
    acceptanceCriteria: ["Fail closed."],
    scope: [], runKind: "followup", parentJobId: "CAM-20260915-1234ABCD",
    rootRequestId, runRevision: 2, resumeSessionId: sessionId
  }));

  try {
    const result = spawnSync(process.execPath, [path.join(projectRoot, "src", "run-followup.mjs"), configPath, jobPath], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: path.join(root, "codex-home") }
    });
    assert.notEqual(result.status, 0);
    const status = JSON.parse(readFileSync(path.join(rootState, "runs", "2", "status.json"), "utf8"));
    assert.equal(status.state, "needs_attention");
    assert.match(status.error, /unavailable from the active Codex session store/);
    assert.equal(existsSync(expectedWorktree), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
