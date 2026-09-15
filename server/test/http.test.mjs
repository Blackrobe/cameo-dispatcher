import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { JobStore } from "../src/db.mjs";
import { createApiServer } from "../src/http.mjs";

async function withApi(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-dispatcher-api-"));
  const store = new JobStore(path.join(root, "jobs.sqlite"));
  let completionSignals = 0;
  const config = { runnerToken: "owner-controlled-token", runnerId: "blackrobe-windows-1" };
  const server = createApiServer({ config, store, onCompletionReady: () => completionSignals++ });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const request = (pathname, options = {}) => fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${config.runnerToken}`,
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });

  try {
    await run({ store, request, getCompletionSignals: () => completionSignals });
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("worker API derives identity from its credential and accepts idempotent completion", async () => withApi(async ({ store, request, getCompletionSignals }) => {
  const provisioning = store.create({
    requestId: "discord-123456789",
    requesterDiscordId: "12345",
    requesterName: "Aedis",
    objective: "Inspect active YAML.",
    acceptanceCriteria: ["Report findings."],
    scope: []
  });
  const queued = store.setDiscordThread(provisioning.id, "thread-1");

  const claimResponse = await request("/v1/worker/claim", {
    method: "POST",
    body: JSON.stringify({ runnerId: "attacker-selected-runner" })
  });
  assert.equal(claimResponse.status, 200);
  const claimed = (await claimResponse.json()).job;
  assert.equal(claimed.id, queued.id);
  assert.equal(claimed.runnerId, "blackrobe-windows-1");

  const controlResponse = await request("/v1/control");
  assert.equal(controlResponse.status, 200);
  const initialControl = await controlResponse.json();
  assert.equal(initialControl.control.paused, false);
  assert.equal(initialControl.runner.online, true);
  assert.equal(initialControl.runner.state, "busy");
  assert.equal(initialControl.runner.currentJobId, queued.id);

  const heartbeat = await request(`/v1/jobs/${queued.id}/heartbeat`, { method: "POST", body: "{}" });
  assert.equal(heartbeat.status, 200);

  const completionBody = JSON.stringify({
    runnerId: "attacker-selected-runner",
    state: "ready_for_review",
    result: { summary: "Done", validation: ["Clean diff"], risks: [], nextAction: null }
  });
  const firstCompletion = await request(`/v1/jobs/${queued.id}/result`, { method: "POST", body: completionBody });
  assert.equal(firstCompletion.status, 200);
  assert.equal((await firstCompletion.json()).job.completionDisposition, "new");
  assert.equal(getCompletionSignals(), 1);

  const retryCompletion = await request(`/v1/jobs/${queued.id}/result`, { method: "POST", body: completionBody });
  assert.equal(retryCompletion.status, 200);
  assert.equal((await retryCompletion.json()).job.completionDisposition, "existing");
  assert.equal(getCompletionSignals(), 2);
  assert.equal(store.get(queued.id).deliveryState, "pending");

  const completedControl = await (await request("/v1/control")).json();
  assert.equal(completedControl.runner.state, "idle");
  assert.equal(completedControl.runner.currentJobId, null);
}));

test("worker API rejects an invalid bearer token", async () => withApi(async ({ request }) => {
  const response = await request("/v1/worker/claim", {
    method: "POST",
    body: "{}",
    headers: { authorization: "Bearer wrong-token" }
  });
  assert.equal(response.status, 401);
}));

test("paused control state keeps jobs queued while recording an idle runner", async () => withApi(async ({ store, request }) => {
  const provisioning = store.create({
    requestId: "discord-paused",
    requesterDiscordId: "12345",
    requesterName: "Aedis",
    objective: "Inspect active YAML.",
    acceptanceCriteria: ["Report findings."],
    scope: []
  });
  const queued = store.setDiscordThread(provisioning.id, "thread-paused");
  store.setPaused(true, "owner-1");

  const response = await request("/v1/worker/claim", { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.job, null);
  assert.equal(body.control.paused, true);
  assert.equal(body.runner.state, "idle");
  assert.equal(store.get(queued.id).state, "queued");
}));

test("worker API claims and completes an exact-session follow-up as a separate revision", async () => withApi(async ({ store, request }) => {
  const provisioning = store.create({
    requestId: "discord-root-followup-api",
    requesterDiscordId: "12345",
    requesterName: "Aedis",
    objective: "Initial audit.",
    acceptanceCriteria: ["Report findings."],
    scope: []
  });
  let root = store.setDiscordThread(provisioning.id, "thread-followup-api");
  store.claim("blackrobe-windows-1");
  root = store.complete(root.id, "blackrobe-windows-1", "ready_for_review", {
    status: "completed",
    summary: "Initial result",
    provenance: {
      codexThreadId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6",
      baseCommit: "abc123"
    }
  });
  root = store.markDelivered(root.id, root.deliveryRevision, "root-result-message");

  let followup = store.createFollowup({
    requestId: "discord-followup-api",
    requesterDiscordId: "12345",
    requesterName: "Aedis",
    objective: "Recheck the conclusion.",
    acceptanceCriteria: ["Report changes."],
    scope: [],
    parentJobId: root.id,
    source: {
      kind: "followup",
      guildId: "1234567890",
      channelId: "1234567891",
      messageId: "1234567892"
    }
  });
  assert.equal(store.claimProvisioning(followup.id, "followup-api-claim"), true);
  store.setDiscordAcknowledgement(followup.id, "followup-ack", "followup-api-claim");
  followup = store.setFollowupQueued(followup.id, "followup-api-claim");

  const claimResponse = await request("/v1/worker/claim", { method: "POST", body: "{}" });
  const claimed = (await claimResponse.json()).job;
  assert.equal(claimed.id, followup.id);
  assert.equal(claimed.parentJobId, root.id);
  assert.equal(claimed.runRevision, 2);
  assert.equal(claimed.resumeSessionId, "01a0a275-a2f1-73f1-89ae-f94d4b983fd6");

  assert.equal((await request(`/v1/jobs/${followup.id}/heartbeat`, { method: "POST", body: "{}" })).status, 200);
  const completeResponse = await request(`/v1/jobs/${followup.id}/result`, {
    method: "POST",
    body: JSON.stringify({
      state: "ready_for_review",
      result: {
        status: "completed",
        summary: "Follow-up result",
        provenance: {
          codexThreadId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6",
          runRevision: 2
        }
      }
    })
  });
  assert.equal(completeResponse.status, 200);
  const completed = (await completeResponse.json()).job;
  assert.equal(completed.deliveryState, "pending");
  assert.equal(completed.runRevision, 2);
}));

test("worker API claims and completes owner GitHub controls separately from Codex jobs", async () => withApi(async ({ store, request, getCompletionSignals }) => {
  const action = store.createGithubAction({
    interactionId: "1549500000000000001",
    requesterDiscordId: "900000000000000001",
    requesterName: "Blackrobe",
    action: "close",
    repository: "cameo-mod/Cameo-mod",
    prNumber: 400,
    expectedHeadSha: "a".repeat(40),
    headOwner: "Blackrobe",
    headBranch: "feature",
    baseBranch: "master",
    discordThreadId: "1549500000000000999"
  });
  const claim = await request("/v1/worker/claim", { method: "POST", body: "{}" });
  const claimed = (await claim.json()).job;
  assert.equal(claimed.id, action.id);
  assert.equal(claimed.runKind, "github_action");
  const completion = await request(`/v1/github-actions/${action.id}/result`, {
    method: "POST",
    body: JSON.stringify({
      state: "ready_for_review",
      result: { status: "completed", summary: "Closed upstream PR #400." }
    })
  });
  assert.equal(completion.status, 200);
  assert.equal((await completion.json()).job.deliveryState, "pending");
  assert.equal(getCompletionSignals(), 1);
}));
