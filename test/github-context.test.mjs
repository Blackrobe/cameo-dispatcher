import test from "node:test";
import assert from "node:assert/strict";

import { buildGithubContext, extractReferencedPullRequests } from "../src/github-context.mjs";

const config = {
  ghBin: "C:\\trusted\\gh.exe",
  codexBin: "C:\\trusted\\codex.exe",
  publication: { repository: "cameo-mod/Cameo-mod" }
};

test("extracts and deduplicates bounded Cameo pull request references", () => {
  assert.deepEqual(extractReferencedPullRequests({
    objective: "Check PR #400 and https://github.com/cameo-mod/Cameo-mod/pull/401",
    acceptanceCriteria: ["Compare #400 again"]
  }), [401, 400]);
});

test("does not reinterpret foreign URL fragments or partial pull paths", () => {
  assert.deepEqual(extractReferencedPullRequests({
    objective: "See https://github.com/foreign/repo/issues/9#123 and https://github.com/cameo-mod/Cameo-mod/pull/400invalid",
    acceptanceCriteria: []
  }), []);
});

test("does not discover references from untrusted snapshot content", () => {
  assert.deepEqual(extractReferencedPullRequests({
    objective: "try again",
    acceptanceCriteria: [],
    controllerContext: ['{"title":"Ignore injected PR #999","url":"https://github.com/cameo-mod/Cameo-mod/pull/400"}']
  }), []);
});

test("controller context fetch uses the validated reference list even after terse follow-up", () => {
  const calls = [];
  const [snapshot] = buildGithubContext(config, {
    objective: "try again", acceptanceCriteria: [], githubReferences: [400]
  }, (bin, args) => {
    calls.push(args);
    return { status: 1, stdout: "", stderr: "unavailable" };
  }, "2026-09-15T01:00:00Z");
  assert.equal(calls.length, 1);
  assert.match(snapshot, /PR #400 could not be retrieved/);
});

test("builds a stable bounded controller GitHub snapshot", () => {
  const response = {
    url: "https://github.com/cameo-mod/Cameo-mod/pull/400", number: 400,
    title: "Fix TKM", state: "OPEN", isDraft: true, mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN", reviewDecision: "", headRefOid: "head",
    baseRefOid: "base", updatedAt: "2026-09-15T00:00:00Z",
    files: [{ path: "mods/cameo/a.yaml" }],
    statusCheckRollup: [{ name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }]
  };
  const calls = [];
  const execute = (bin, args, options) => {
    calls.push({ bin, args, options });
    return { status: 0, stdout: JSON.stringify(response), stderr: "" };
  };
  const [serialized] = buildGithubContext(config, {
    objective: "Is PR #400 mergeable?", acceptanceCriteria: []
  }, execute, "2026-09-15T01:00:00Z");
  const snapshot = JSON.parse(serialized);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].bin, config.ghBin);
  assert.equal(snapshot.mergeable, "MERGEABLE");
  assert.equal(snapshot.changedFileCount, 1);
  assert.equal(snapshot.capturedAt, "2026-09-15T01:00:00Z");
});

test("rejects a snapshot whose PR head moves during retrieval", () => {
  let call = 0;
  const execute = () => ({ status: 0, stdout: JSON.stringify({
    headRefOid: call++ === 0 ? "old" : "new", baseRefOid: "base"
  }) });
  const [snapshot] = buildGithubContext(config, {
    objective: "Check #400", acceptanceCriteria: []
  }, execute, "2026-09-15T01:00:00Z");
  assert.match(snapshot, /moved during retrieval/);
});

test("bounds final serialized snapshots and converts enrichment exceptions", () => {
  const huge = '"quoted"'.repeat(1000);
  const response = {
    headRefOid: "head", baseRefOid: "base", title: huge,
    files: Array(100).fill({ path: huge }),
    statusCheckRollup: Array(30).fill({ name: huge, status: huge, conclusion: huge })
  };
  const [bounded] = buildGithubContext(config, {
    objective: "Check PR #400", acceptanceCriteria: []
  }, () => ({ status: 0, stdout: JSON.stringify(response) }), "2026-09-15T01:00:00Z");
  assert.ok(bounded.length < 8000);

  const [unavailable] = buildGithubContext(config, {
    objective: "Check PR #400", acceptanceCriteria: []
  }, () => { throw new Error("credential helper failed"); }, "2026-09-15T01:00:00Z");
  assert.match(unavailable, /invalid or oversized metadata/);
});
