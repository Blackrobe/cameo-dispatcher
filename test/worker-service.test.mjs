import test from "node:test";
import assert from "node:assert/strict";

import { buildCompletion, buildGithubDiscoveryReferences, compactFinalResult, normalizeServerJob, sanitizeWorkerEnvironment } from "../src/worker-service-lib.mjs";

test("normalizes the server-frozen per-run execution policy", () => {
  const normalized = normalizeServerJob({
    requestId: "discord-123456789",
    requesterName: "Aedis",
    objective: "Inspect active YAML.",
    acceptanceCriteria: ["Report findings."],
    scope: ["mods/cameo/mod.yaml"],
    executionMode: "draft_pr",
    model: "gpt-6-astra",
    reasoningEffort: "max",
    modelSource: "visual_route",
    sandbox: "danger-full-access"
  });
  assert.deepEqual(normalized, {
    requestId: "discord-123456789",
    requestedBy: { human: "Aedis", tool: "Cameo Dispatcher" },
    objective: "Inspect active YAML.",
    acceptanceCriteria: ["Report findings."],
    scope: ["mods/cameo/mod.yaml"],
    executionMode: "draft_pr",
    model: "gpt-6-astra",
    reasoningEffort: "max",
    modelSource: "visual_route"
  });
});

test("adds execution provenance and preserves incomplete states", () => {
  const result = buildCompletion({
    state: "needs_attention",
    codexThreadId: "thread-1",
    baseCommit: "abc123",
    resultMappingError: null
  }, {
    status: "blocked",
    summary: "Needs a maintainer decision."
  });
  assert.equal(result.state, "needs_attention");
  assert.equal(result.result.provenance.codexThreadId, "thread-1");
});

test("normalizes exact-session follow-up metadata and records its run revision", () => {
  const normalized = normalizeServerJob({
    requestId: "discord-followup-123456789",
    requesterName: "Aedis",
    objective: "Recheck the result.",
    acceptanceCriteria: ["Report changes."],
    scope: [],
    runKind: "followup",
    parentJobId: "CAM-20260915-1234ABCD",
    rootRequestId: "discord-message-123456780",
    runRevision: 2,
    resumeSessionId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6"
  });
  assert.equal(normalized.runKind, "followup");
  assert.equal(normalized.resumeSessionId, "01a0a275-a2f1-73f1-89ae-f94d4b983fd6");

  const completion = buildCompletion({
    state: "ready_for_review",
    codexThreadId: normalized.resumeSessionId,
    baseCommit: "abc123",
    runRevision: 2,
    parentJobId: normalized.parentJobId,
    resultMappingError: null
  }, { status: "completed", summary: "Done" });
  assert.equal(completion.result.provenance.runRevision, 2);
  assert.equal(completion.result.provenance.parentJobId, normalized.parentJobId);
});

test("follow-up GitHub discovery inherits the trusted root task and retained publication", () => {
  const followup = {
    runKind: "followup",
    rootRequestId: "discord-message-1549302348159914087",
    objective: "try again",
    acceptanceCriteria: ["Report the result."]
  };
  const references = buildGithubDiscoveryReferences(followup, {
    requestId: followup.rootRequestId,
    objective: "Inspect draft PR #400 and report its current state."
  }, {
    state: "published",
    prUrl: "https://github.com/cameo-mod/Cameo-mod/pull/400"
  });
  assert.deepEqual(references, [400]);
  const rejectedForeign = buildGithubDiscoveryReferences(followup, null, {
    state: "published", prUrl: "https://github.com/foreign/repo/pull/400"
  });
  assert.deepEqual(rejectedForeign, []);
});

test("maps local failures without claiming review readiness", () => {
  const result = buildCompletion({ state: "failed", error: "worker exited" }, null);
  assert.equal(result.state, "failed");
  assert.equal(result.error, "worker exited");
});

test("removes dispatcher and provider credentials from Codex child environments", () => {
  const sanitized = sanitizeWorkerEnvironment({
    PATH: "safe-path",
    CAMEO_RUNNER_TOKEN: "runner-secret",
    DISCORD_TOKEN: "discord-secret",
    DISCORD_AGENT_WEBHOOK_URL: "webhook-secret",
    CLOUDFLARE_API_TOKEN: "cloudflare-secret",
    OPENAI_API_KEY: "openai-secret",
    CODEX_API_KEY: "codex-secret"
  });
  assert.deepEqual(sanitized, { PATH: "safe-path" });
});

test("compacts oversized model diagnostics below the dispatcher request limit", () => {
  const huge = "x".repeat(300000);
  const compact = compactFinalResult({
    status: "needs_attention", summary: huge,
    changedFiles: Array(200).fill(huge), validation: Array(40).fill(huge),
    risks: Array(40).fill(huge), nextAction: huge
  });
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 128 * 1024);
  assert.equal(compact.changedFiles.length, 100);
  assert.equal(compact.validation.length, 20);
  assert.match(compact.summary, /truncated/);
});

test("bounds multibyte result text by serialized bytes", () => {
  const multibyte = "🧪".repeat(100000);
  const completion = buildCompletion({ state: "needs_attention" }, {
    status: "needs_attention", summary: multibyte,
    changedFiles: Array(100).fill(multibyte), validation: Array(20).fill(multibyte),
    risks: Array(20).fill(multibyte), nextAction: multibyte
  });
  assert.ok(Buffer.byteLength(JSON.stringify(completion), "utf8") < 128 * 1024);
});

test("bounds reviewer and publication provenance", () => {
  const huge = "r".repeat(300000);
  const completion = buildCompletion({
    state: "ready_for_review", reviewer: { summary: huge, findings: [huge], validationGaps: [huge] },
    publication: { state: "published", branch: huge, lastCommit: huge, prUrl: huge, candidateHash: huge }
  }, { status: "completed", summary: "Done", changedFiles: [], validation: [], risks: [], nextAction: null });
  assert.ok(Buffer.byteLength(JSON.stringify(completion), "utf8") < 128 * 1024);
});

test("bounds failed-state results as well as errors", () => {
  const huge = "f".repeat(300000);
  const completion = buildCompletion({ state: "failed", error: huge }, {
    status: "needs_attention", summary: huge, changedFiles: [huge], validation: [huge], risks: [huge], nextAction: huge
  });
  assert.ok(Buffer.byteLength(JSON.stringify(completion), "utf8") < 128 * 1024);
});
