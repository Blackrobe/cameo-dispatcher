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
