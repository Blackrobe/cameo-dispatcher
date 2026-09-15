import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { executeGithubAction, resolveGithubAction } from "../src/github-action-controller.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const config = {
  ghBin: "C:\\trusted\\gh.exe",
  codexBin: "C:\\trusted\\codex.exe",
  publication: { repository: "cameo-mod/Cameo-mod" }
};

function response(stdout, status = 0, stderr = "") {
  return { status, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr };
}

function proposalDigest(baseBranch = "master") {
  return createHash("sha256").update(JSON.stringify([
    400, head, "blackrobe", "feature", baseBranch
  ])).digest("base64url").slice(0, 22);
}

test("owner merge readies a draft, pins the head SHA, and never bypasses protection", () => {
  let state = "OPEN";
  let draft = true;
  const calls = [];
  const execute = (bin, args) => {
    calls.push({ bin, args });
    if (args[0] === "pr" && args[1] === "view")
      return response({
        number: 400, url: "https://github.com/cameo-mod/Cameo-mod/pull/400",
        state, isDraft: draft, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED", headRefName: "feature", headRefOid: head,
        headRepositoryOwner: { login: "Blackrobe" }, baseRefName: "master",
        mergedAt: state === "MERGED" ? "2026-09-15T10:00:00Z" : null,
        mergeCommit: state === "MERGED" ? { oid: "c".repeat(40) } : null,
        autoMergeRequest: null
      });
    if (args[0] === "pr" && args[1] === "ready") {
      draft = false;
      return response("");
    }
    if (args[0] === "api" && args.includes("--method") && args.includes("PUT")) {
      state = "MERGED";
      return response({ merged: true, sha: "c".repeat(40), message: "Pull Request successfully merged" });
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  const result = executeGithubAction(config, {
    id: "CGA-TEST", action: "merge", repository: "cameo-mod/Cameo-mod",
    prNumber: 400, expectedHeadSha: head, headOwner: "Blackrobe",
    headBranch: "feature", baseBranch: "master", mergeMethod: "merge"
  }, { execute });
  assert.match(result.summary, /Merged upstream PR #400/);
  const merge = calls.find(call => call.args[0] === "api" && call.args.includes("PUT"));
  assert.ok(merge.args.includes(`sha=${head}`));
  assert.ok(merge.args.includes("merge_method=merge"));
  assert.equal(calls.flatMap(call => call.args).includes("--admin"), false);
  assert.equal(calls.flatMap(call => call.args).includes("--auto"), false);
  assert.equal(calls.flatMap(call => call.args).includes("--delete-branch"), false);
});

test("close verifies the exact head and does not delete or comment", () => {
  let state = "OPEN";
  const calls = [];
  const execute = (bin, args) => {
    calls.push(args);
    if (args[1] === "view")
      return response({
        number: 401, url: "https://github.com/cameo-mod/Cameo-mod/pull/401",
        state, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        reviewDecision: null, headRefName: "feature", headRefOid: head,
        headRepositoryOwner: { login: "Blackrobe" }, baseRefName: "master",
        mergedAt: null, mergeCommit: null, autoMergeRequest: null
      });
    if (args[1] === "close") {
      state = "CLOSED";
      return response("");
    }
    throw new Error("unexpected invocation");
  };
  const result = executeGithubAction(config, {
    id: "CGA-CLOSE", action: "close", repository: "cameo-mod/Cameo-mod",
    prNumber: 401, expectedHeadSha: head, headOwner: "Blackrobe",
    headBranch: "feature", baseBranch: "master"
  }, { execute });
  assert.match(result.summary, /Closed upstream PR #401/);
  assert.equal(calls.flat().includes("--delete-branch"), false);
  assert.equal(calls.flat().includes("--comment"), false);
});

test("opening a branch PR resolves both exact upstream branches and verifies ownership", () => {
  const calls = [];
  const execute = (bin, args) => {
    calls.push(args);
    if (args[0] === "api")
      return response({ commit: { sha: args[1].endsWith("feature") ? head : base } });
    if (args[0] === "pr" && args[1] === "list")
      return response([]);
    if (args[0] === "pr" && args[1] === "create")
      return response("https://github.com/cameo-mod/Cameo-mod/pull/402\n");
    if (args[0] === "pr" && args[1] === "view")
      return response({
        number: 402, url: "https://github.com/cameo-mod/Cameo-mod/pull/402",
        state: "OPEN", isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        reviewDecision: null, headRefName: "feature", headRefOid: head,
        headRepositoryOwner: { login: "cameo-mod" }, baseRefName: "release",
        mergedAt: null, mergeCommit: null, autoMergeRequest: null
      });
    throw new Error(`unexpected invocation ${args.join(" ")}`);
  };
  const result = executeGithubAction(config, {
    id: "CGA-OPEN", action: "open", repository: "cameo-mod/Cameo-mod",
    headBranch: "feature", baseBranch: "release", title: "Merge feature into release", draft: true
  }, { execute });
  assert.match(result.summary, /Opened upstream branch PR #402 as a draft/);
  const create = calls.find(args => args[1] === "create");
  assert.ok(create.includes("--draft"));
  assert.deepEqual(create.slice(0, 8), ["pr", "create", "--repo", "cameo-mod/Cameo-mod", "--head", "feature", "--base", "release"]);
});

test("merge refuses head drift before invoking a write", () => {
  const calls = [];
  assert.throws(() => executeGithubAction(config, {
    id: "CGA-DRIFT", action: "merge", repository: "cameo-mod/Cameo-mod",
    prNumber: 403, expectedHeadSha: head, headOwner: "Blackrobe",
    headBranch: "feature", baseBranch: "master", mergeMethod: "squash"
  }, {
    execute(bin, args) {
      calls.push(args);
      return response({
        number: 403, url: "https://github.com/cameo-mod/Cameo-mod/pull/403",
        state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED", headRefName: "feature", headRefOid: "d".repeat(40),
        headRepositoryOwner: { login: "Blackrobe" }, baseRefName: "master",
        mergedAt: null, mergeCommit: null, autoMergeRequest: null
      });
    }
  }), /head moved/);
  assert.equal(calls.some(args => args[0] === "api" && args.includes("PUT")), false);
});

test("task-thread PR control resolves and pins live identity before mutation", () => {
  const calls = [];
  const unresolved = {
    id: "CGA-RESOLVE", rootJobId: "CAM-20260915-ABCDEF12",
    action: "merge", repository: "cameo-mod/Cameo-mod",
    prNumber: 400, expectedHeadSha: null, headOwner: null,
    headBranch: null, baseBranch: null, mergeMethod: "merge"
  };
  const execute = (bin, args) => {
    calls.push(args);
    return response({
      number: 400, url: "https://github.com/cameo-mod/Cameo-mod/pull/400",
      state: "OPEN", isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      reviewDecision: null, headRefName: "feature", headRefOid: head,
      headRepositoryOwner: { login: "Blackrobe" }, baseRefName: "master",
      mergedAt: null, mergeCommit: null, autoMergeRequest: null
    });
  };
  const resolved = resolveGithubAction(config, unresolved, { execute });
  assert.equal(resolved.expectedHeadSha, head);
  assert.equal(resolved.headOwner, "Blackrobe");
  assert.equal(resolved.headBranch, "feature");
  assert.equal(resolved.baseBranch, "master");
  assert.equal(calls.length, 2);
  assert.throws(() => executeGithubAction(config, unresolved, { execute }), /durably resolved/);
  assert.throws(() => resolveGithubAction(config, {
    ...unresolved, expectedHeadSha: "e".repeat(40)
  }, { execute }), /head moved after proposal/);
  assert.equal(resolveGithubAction(config, {
    ...unresolved, proposalIdentityDigest: proposalDigest()
  }, { execute }).baseBranch, "master");
  assert.throws(() => resolveGithubAction(config, {
    ...unresolved, proposalIdentityDigest: proposalDigest("release")
  }, { execute }), /identity changed after the displayed proposal/);
});
