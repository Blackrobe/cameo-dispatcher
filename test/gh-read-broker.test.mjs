import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { startGhReadBroker, translateGhReadCommand } from "../src/gh-read-broker.mjs";

function run(commandInterpreter, command, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandInterpreter, ["/d", "/s", "/c", command], {
      env: environment, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", exitCode => resolve({ exitCode, stdout, stderr }));
  });
}

test("translates only the fixed-repository cached read command families", () => {
  assert.deepEqual(translateGhReadCommand(["pr", "diff", "400", "--name-only"]), {
    kind: "pr_diff_names", number: "400",
    args: ["pr", "diff", "400", "--repo", "cameo-mod/Cameo-mod", "--name-only"],
    outputLimit: 2 * 1024 * 1024
  });
  assert.equal(translateGhReadCommand(["pr", "view", "400"]).kind, "pr_view");
  assert.equal(translateGhReadCommand(["pr", "checks", "400"]).kind, "pr_checks");
  assert.equal(translateGhReadCommand(["issue", "view", "123"]).kind, "issue_view");
  for (const argv of [
    ["pr", "merge", "400"], ["pr", "comment", "400"], ["auth", "status", "1"],
    ["api", "repos/cameo-mod/Cameo-mod", "1"], ["pr", "view", "400", "--web"],
    ["pr", "view", "400", "--repo", "foreign/repo"], ["pr", "view", "400", "--jq", ".state"],
    ["pr", "diff", "400", "--patch"], ["pr", "diff", "400", "--color", "always"]
  ])
    assert.throws(() => translateGhReadCommand(argv));
});

test("the shell shim serves immutable cached PR and issue reads without credentials or IPC", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-gh-cache-"));
  const auditPath = path.join(root, "audit.jsonl");
  const calls = [];
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const config = {
    ghBin: "C:\\trusted\\gh.exe", codexBin: "C:\\trusted\\codex.exe",
    publication: { repository: "cameo-mod/Cameo-mod" }
  };
  const broker = await startGhReadBroker({
    config,
    job: {
      requestId: "cache-test", runRevision: 2,
      objective: "Inspect PR #400 and issue #123.", acceptanceCriteria: []
    },
    worktreePath: path.join(root, "worktree"), auditPath, phase: "test"
  }, {
    execute(bin, args, options) {
      calls.push({ bin, args, options });
      if (args[0] === "pr" && args[1] === "view")
        return { status: 0, stdout: JSON.stringify({ number: 400, state: "OPEN", isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: head, baseRefOid: base, title: "Cached PR" }), stderr: "" };
      if (args[0] === "pr" && args[1] === "diff")
        return { status: 0, stdout: args.includes("--name-only") ? "mods/cameo/rules.yaml\n" : "diff --git a/mods/cameo/rules.yaml b/mods/cameo/rules.yaml\n", stderr: "" };
      if (args[0] === "pr" && args[1] === "checks")
        return { status: 0, stdout: "[]\n", stderr: "" };
      if (args[0] === "issue" && args[1] === "view")
        return { status: 0, stdout: JSON.stringify({ number: 123, state: "OPEN", title: "Cached issue" }), stderr: "" };
      throw new Error(`unexpected prefetch: ${args.join(" ")}`);
    }
  });
  try {
    const environment = broker.environment({ ...process.env, PATH: "wrong-path", Path: process.env.PATH, GH_TOKEN: "must-not-leak", GITHUB_TOKEN: "must-not-leak" });
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.CAMEO_GH_CACHE_SOURCE, "trusted_controller_cached_github_read");
    const pathKeys = Object.keys(environment).filter(name => name.toLowerCase() === "path");
    assert.equal(pathKeys.length, 1);
    assert.match(environment[pathKeys[0]], /Windows\\system32/i);
    const commandInterpreter = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";

    const view = await run(commandInterpreter, "gh pr view 400 --json state,mergeable,headRefOid", environment);
    assert.equal(view.exitCode, 0, view.stderr);
    assert.deepEqual(JSON.parse(view.stdout), { state: "OPEN", mergeable: "MERGEABLE", headRefOid: head });
    const diff = await run(commandInterpreter, "gh pr diff 400", environment);
    assert.equal(diff.exitCode, 0, diff.stderr);
    assert.match(diff.stdout, /diff --git/);
    const names = await run(commandInterpreter, "gh pr diff 400 --name-only", environment);
    assert.match(names.stdout, /rules\.yaml/);
    const issue = await run(commandInterpreter, "gh issue view 123 --json state,title", environment);
    assert.deepEqual(JSON.parse(issue.stdout), { state: "OPEN", title: "Cached issue" });

    const prefetchCount = calls.length;
    const rejected = await run(commandInterpreter, "gh pr merge 400", environment);
    assert.equal(rejected.exitCode, 2);
    assert.match(rejected.stderr, /supports only/);
    assert.equal(calls.length, prefetchCount);
    const missing = await run(commandInterpreter, "gh pr view 401", environment);
    assert.equal(missing.exitCode, 2);
    assert.match(missing.stderr, /No cached/);

    const manifest = JSON.parse(readFileSync(broker.manifestPath, "utf8"));
    assert.equal(manifest.source, "trusted_controller_cached_github_read");
    assert.equal(manifest.runRevision, 2);
    assert.equal(manifest.entries["pr_view:400"].exitCode, 0);
    assert.match(readFileSync(auditPath, "utf8"), /"cache":true/);
  } finally {
    const brokerRoot = broker.brokerRoot;
    await broker.stop();
    assert.equal(existsSync(brokerRoot), false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a moving PR produces an explicit unavailable cache instead of stale data", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-gh-moving-"));
  let views = 0;
  const broker = await startGhReadBroker({
    config: {
      ghBin: "C:\\trusted\\gh.exe", codexBin: "C:\\trusted\\codex.exe",
      publication: { repository: "cameo-mod/Cameo-mod" }
    },
    job: { requestId: "moving-test", objective: "Inspect PR #400.", acceptanceCriteria: [] },
    worktreePath: path.join(root, "worktree"), auditPath: path.join(root, "audit.jsonl")
  }, {
    execute(bin, args) {
      if (args[1] === "view") {
        views += 1;
        return { status: 0, stdout: JSON.stringify({ headRefOid: views === 1 ? "a".repeat(40) : "c".repeat(40), baseRefOid: "b".repeat(40) }), stderr: "" };
      }
      return { status: 0, stdout: args[1] === "checks" ? "[]" : "cached", stderr: "" };
    }
  });
  try {
    const manifest = JSON.parse(readFileSync(broker.manifestPath, "utf8"));
    assert.equal(manifest.entries["pr_view:400"].exitCode, 2);
    assert.match(manifest.entries["pr_view:400"].stderr, /moved/);
    assert.equal(manifest.entries["pr_diff:400"], undefined);
  } finally {
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
