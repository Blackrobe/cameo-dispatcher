import test from "node:test";
import assert from "node:assert/strict";

import { buildCompletion, normalizeServerJob, sanitizeWorkerEnvironment } from "../src/worker-service-lib.mjs";

test("normalizes a dispatcher job without accepting policy fields", () => {
  const normalized = normalizeServerJob({
    requestId: "discord-123456789",
    requesterName: "Aedis",
    objective: "Inspect active YAML.",
    acceptanceCriteria: ["Report findings."],
    scope: ["mods/cameo/mod.yaml"],
    model: "attacker-selected-model",
    sandbox: "danger-full-access"
  });
  assert.deepEqual(normalized, {
    requestId: "discord-123456789",
    requestedBy: { human: "Aedis", tool: "Cameo Dispatcher" },
    objective: "Inspect active YAML.",
    acceptanceCriteria: ["Report findings."],
    scope: ["mods/cameo/mod.yaml"]
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
