import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { assertPathWithin, mapWorkerResultState, validateConfig, validateJob } from "../src/lib.mjs";

test("accepts a bounded structured job", () => {
  const job = validateJob({
    requestId: "aedis-task-001",
    requestedBy: { human: "Aedis", tool: "Discord" },
    objective: "Inspect the active manifest.",
    acceptanceCriteria: ["Report active includes."],
    scope: ["mods/cameo/mod.yaml"]
  });

  assert.equal(job.requestId, "aedis-task-001");
  assert.deepEqual(job.scope, ["mods/cameo/mod.yaml"]);
});

test("rejects unsafe request IDs and paths", () => {
  assert.throws(() => validateJob({
    requestId: "../escape",
    objective: "Do something.",
    acceptanceCriteria: ["Done."],
    scope: ["../outside"]
  }));

  assert.throws(() => validateJob({
    requestId: "safe-task",
    objective: "Do something.",
    acceptanceCriteria: ["Done."],
    scope: ["C:\\Windows\\System32"]
  }));
});

test("limits sandbox configuration to non-bypass modes", () => {
  const base = {
    repoRoot: "C:\\repo",
    baseRef: "upstream/master",
    worktreeRoot: "C:\\worktrees",
    stateRoot: "C:\\state",
    codexBin: "codex"
  };

  const readOnly = validateConfig({ ...base, sandbox: "read-only" });
  assert.equal(readOnly.sandbox, "read-only");
  assert.equal(readOnly.maxJobMinutes, 60);
  assert.equal(validateConfig({ ...base, sandbox: "read-only", maxJobMinutes: 15 }).maxJobMinutes, 15);
  assert.throws(() => validateConfig({ ...base, sandbox: "danger-full-access" }));
  assert.throws(() => validateConfig({ ...base, sandbox: "read-only", maxJobMinutes: 0 }));
  assert.throws(() => validateConfig({ ...base, sandbox: "read-only", maxJobMinutes: 241 }));
});

test("requires generated paths to remain under their configured roots", () => {
  const root = path.resolve("C:\\dispatcher\\jobs");
  assert.doesNotThrow(() => assertPathWithin(root, path.join(root, "job-1"), "job"));
  assert.throws(() => assertPathWithin(root, path.resolve(root, "..", "escape"), "job"));
});

test("maps worker result status without overstating incomplete work", () => {
  assert.equal(mapWorkerResultState({ status: "completed" }), "ready_for_review");
  assert.equal(mapWorkerResultState({ status: "needs_attention" }), "needs_attention");
  assert.equal(mapWorkerResultState({ status: "blocked" }), "needs_attention");
  assert.throws(() => mapWorkerResultState({ status: "unknown" }));
});
