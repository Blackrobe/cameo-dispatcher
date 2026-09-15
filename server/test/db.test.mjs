import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AdmissionError, JobStore } from "../src/db.mjs";

function withStore(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-dispatcher-"));
  const store = new JobStore(path.join(root, "jobs.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function createQueued(store, suffix, requesterDiscordId = "12345") {
  const job = store.create({
    requestId: `request-${suffix}`,
    requesterDiscordId,
    requesterName: "Aedis",
    objective: "Inspect one active YAML path.",
    acceptanceCriteria: ["Report findings."],
    scope: []
  });
  return store.setDiscordThread(job.id, `thread-${suffix}`);
}

test("deduplicates request IDs and serially claims jobs", () => withStore(store => {
  const input = {
    requestId: "request-1",
    requesterDiscordId: "12345",
    requesterName: "Aedis",
    objective: "Inspect one active YAML path.",
    acceptanceCriteria: ["Report findings."],
    scope: []
  };
  const firstProvisioning = store.create(input);
  const duplicate = store.create(input);
  assert.equal(duplicate.id, firstProvisioning.id);
  assert.equal(store.claim("blackrobe-windows-1"), null);
  const first = store.setDiscordThread(firstProvisioning.id, "thread-1");

  const claimed = store.claim("blackrobe-windows-1");
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.state, "running");
  assert.equal(claimed.claimDisposition, "new");
  const retry = store.claim("blackrobe-windows-1");
  assert.equal(retry.id, first.id);
  assert.equal(retry.claimDisposition, "existing_running");
}));

test("only the claiming runner can complete a job", () => withStore(store => {
  const job = createQueued(store, "2");
  store.claim("runner-1");
  assert.throws(() => store.complete(job.id, "runner-2", "ready_for_review", {}));
  const completed = store.complete(job.id, "runner-1", "ready_for_review", { summary: "Done" });
  assert.equal(completed.state, "ready_for_review");
  assert.equal(completed.result.summary, "Done");
  assert.equal(completed.deliveryState, "pending");
  assert.equal(completed.completionDisposition, "new");
  const duplicate = store.complete(job.id, "runner-1", "ready_for_review", { summary: "Ignored duplicate" });
  assert.equal(duplicate.completionDisposition, "existing");
  assert.equal(duplicate.result.summary, "Done");
}));

test("requester can cancel queued work but not another requester's job", () => withStore(store => {
  const job = createQueued(store, "3");
  assert.throws(() => store.cancel(job.id, "45678"));
  assert.equal(store.cancel(job.id, "12345").state, "cancelled");
}));

test("one running job blocks later claims and an expired lease needs attention", () => withStore(store => {
  const first = createQueued(store, "4");
  const second = createQueued(store, "5");
  store.claim("runner-1", 300);
  const busyRetry = store.claim("runner-1", 300);
  assert.equal(busyRetry.id, first.id);
  assert.equal(busyRetry.claimDisposition, "existing_running");
  assert.equal(store.get(second.id).state, "queued");

  store.db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", first.id);
  const expired = store.claim("runner-1", 300);
  assert.equal(expired.id, first.id);
  assert.equal(expired.state, "needs_attention");
  assert.equal(expired.claimDisposition, "expired_needs_attention");
  assert.equal(store.get(second.id).state, "queued");
  const recovered = store.complete(first.id, "runner-1", "ready_for_review", { summary: "Recovered local result" });
  assert.equal(recovered.state, "ready_for_review");
  assert.equal(recovered.result.summary, "Recovered local result");
}));

test("delivery outbox survives failure and records the delivered message", () => withStore(store => {
  const job = createQueued(store, "6");
  store.claim("runner-1");
  store.complete(job.id, "runner-1", "ready_for_review", { summary: "Done" });
  assert.deepEqual(store.listPendingDeliveries().map(item => item.id), [job.id]);

  const firstRevision = store.get(job.id).deliveryRevision;
  const failed = store.markDeliveryFailed(job.id, firstRevision, "Discord unavailable", 1000);
  assert.equal(failed.deliveryState, "failed");
  assert.equal(failed.deliveryAttempts, 1);
  assert.equal(store.listPendingDeliveries().length, 0);

  store.db.prepare("UPDATE jobs SET delivery_next_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", job.id);
  assert.deepEqual(store.listPendingDeliveries().map(item => item.id), [job.id]);
  const delivered = store.markDelivered(job.id, firstRevision, "discord-message-1");
  assert.equal(delivered.deliveryState, "delivered");
  assert.equal(delivered.discordMessageId, "discord-message-1");
  assert.equal(store.listPendingDeliveries().length, 0);
}));

test("an in-flight older notification cannot mark a newer result delivered", () => withStore(store => {
  const job = createQueued(store, "7");
  store.claim("runner-1");
  store.db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", job.id);
  const expired = store.claim("runner-1");
  const oldRevision = expired.deliveryRevision;
  assert.equal(expired.state, "needs_attention");

  const recovered = store.complete(job.id, "runner-1", "ready_for_review", { summary: "Recovered" });
  assert.ok(recovered.deliveryRevision > oldRevision);
  const afterLateAck = store.markDelivered(job.id, oldRevision, "old-needs-attention-message");
  assert.equal(afterLateAck.deliveryState, "pending");
  assert.equal(afterLateAck.discordMessageId, null);
  const current = store.markDelivered(job.id, recovered.deliveryRevision, "current-result-message");
  assert.equal(current.deliveryState, "delivered");
  assert.equal(current.discordMessageId, "current-result-message");
}));

test("rejects intake that a local worker could not normalize", () => withStore(store => {
  assert.throws(() => store.create({
    requestId: "request-empty-acceptance",
    requesterDiscordId: "12345",
    requesterName: "Aedis",
    objective: "Inspect one active YAML path.",
    acceptanceCriteria: [],
    scope: []
  }));
  assert.throws(() => store.create({
    requestId: "request-unsafe-scope",
    requesterDiscordId: "12345",
    requesterName: "Aedis",
    objective: "Inspect one active YAML path.",
    acceptanceCriteria: ["Report findings."],
    scope: ["../outside"]
  }));
}));

test("pause blocks new claims and runner presence fails offline", () => withStore(store => {
  const job = createQueued(store, "presence");
  const paused = store.setPaused(true, "owner-1");
  assert.equal(paused.paused, true);
  assert.equal(store.claim("runner-1"), null);
  assert.equal(store.get(job.id).state, "queued");

  store.recordRunnerPresence("runner-1", "idle");
  assert.equal(store.getRunnerStatus("runner-1").online, true);
  store.db.prepare("UPDATE runner_presence SET last_seen_at = ? WHERE runner_id = ?")
    .run("2000-01-01T00:00:00.000Z", "runner-1");
  assert.deepEqual(store.getRunnerStatus("runner-1"), {
    online: false,
    state: "offline",
    currentJobId: null,
    lastSeenAt: "2000-01-01T00:00:00.000Z"
  });

  store.setPaused(false, "owner-1");
  assert.equal(store.claim("runner-1").id, job.id);
}));

test("pause still exposes an existing running claim for reconciliation", () => withStore(store => {
  const running = createQueued(store, "running-before-pause");
  const later = createQueued(store, "queued-during-pause");
  assert.equal(store.claim("runner-1").id, running.id);
  store.setPaused(true, "owner-1");

  const retry = store.claim("runner-1");
  assert.equal(retry.id, running.id);
  assert.equal(retry.claimDisposition, "existing_running");
  assert.equal(store.get(later.id).state, "queued");
}));

test("migrates the pre-mention database in place without discarding jobs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-dispatcher-migration-"));
  const databasePath = path.join(root, "jobs.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      requester_discord_id TEXT NOT NULL, requester_name TEXT NOT NULL,
      objective TEXT NOT NULL, acceptance_json TEXT NOT NULL, scope_json TEXT NOT NULL,
      state TEXT NOT NULL, discord_thread_id TEXT, runner_id TEXT, heartbeat_at TEXT,
      lease_expires_at TEXT, result_json TEXT, error TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'not_ready', delivery_revision INTEGER NOT NULL DEFAULT 0,
      delivery_attempts INTEGER NOT NULL DEFAULT 0, delivery_last_error TEXT, delivery_next_at TEXT,
      discord_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      claimed_at TEXT, completed_at TEXT
    );
  `);
  legacy.prepare(`
    INSERT INTO jobs (
      id, request_id, requester_discord_id, requester_name, objective,
      acceptance_json, scope_json, state, discord_thread_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "CAM-LEGACY-1", "legacy-request", "12345", "Aedis", "Existing job",
    "[\"Report findings.\"]", "[]", "queued", "legacy-thread",
    "2026-09-14T00:00:00.000Z", "2026-09-14T00:00:00.000Z"
  );
  legacy.close();

  const store = new JobStore(databasePath);
  try {
    const migrated = store.get("CAM-LEGACY-1");
    assert.equal(migrated.state, "queued");
    assert.equal(migrated.discordThreadId, "legacy-thread");
    assert.equal(migrated.source, null);
    const columns = new Set(store.db.prepare("PRAGMA table_info(jobs)").all().map(row => row.name));
    for (const column of [
      "source_message_id", "provisioning_claim", "discord_ack_message_id",
      "parent_job_id", "root_request_id", "run_revision", "resume_session_id"
    ])
      assert.ok(columns.has(column));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale provisioning claims cannot overwrite the current recovery owner", () => withStore(store => {
  const job = store.create({
    requestId: "mention-fencing",
    requesterDiscordId: "12345",
    requesterName: "Aedis",
    objective: "Inspect active YAML.",
    acceptanceCriteria: ["Report findings."],
    scope: [],
    source: {
      kind: "mention",
      guildId: "1234567890",
      channelId: "1234567891",
      messageId: "1234567892"
    }
  });
  assert.equal(store.claimProvisioning(job.id, "old-claim"), true);
  store.db.prepare("UPDATE jobs SET provisioning_claimed_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", job.id);
  assert.equal(store.claimProvisioning(job.id, "new-claim"), true);

  assert.throws(() => store.setDiscordAcknowledgement(job.id, "old-ack", "old-claim"));
  assert.throws(() => store.setDiscordThread(job.id, "old-thread", "old-claim"));
  assert.equal(store.failProvisioning(job.id, "old failure", "old-claim").state, "provisioning");

  store.setDiscordAcknowledgement(job.id, "new-ack", "new-claim");
  assert.equal(store.setDiscordThread(job.id, "new-thread", "new-claim").state, "queued");
}));

test("freezes per-run policy and consumes a next-turn model override once", () => withStore(store => {
  let root = store.create({
    requestId: "model-root", requesterDiscordId: "12345", requesterName: "Aedis",
    objective: "Fix unit rules.", acceptanceCriteria: ["Done"], scope: [],
    executionMode: "draft_pr", model: "gpt-5.6-sol", reasoningEffort: "high", modelSource: "default_route"
  });
  root = store.setDiscordThread(root.id, "model-thread");
  store.claim("runner-1");
  root = store.complete(root.id, "runner-1", "ready_for_review", { provenance: { codexThreadId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6" } });
  root = store.markDelivered(root.id, root.deliveryRevision, "result-message");
  store.setNextRunModel(root.id, "gpt-6-astra", "max");
  const followup = store.createFollowup({
    requestId: "model-followup", requesterDiscordId: "12345", requesterName: "Aedis",
    objective: "Continue.", acceptanceCriteria: ["Done"], scope: [], parentJobId: root.id
  });
  assert.equal(followup.model, "gpt-6-astra");
  assert.equal(followup.reasoningEffort, "max");
  assert.equal(followup.modelSource, "owner_next_turn");
  assert.equal(store.get(root.id).nextModel, null);
  assert.equal(store.get(root.id).nextReasoningEffort, null);
}));

test("model selection updates only the earliest unclaimed queued revision", () => withStore(store => {
  let root = store.create({
    requestId: "queued-model-root", requesterDiscordId: "12345", requesterName: "Aedis",
    objective: "Fix rules.", acceptanceCriteria: ["Done"], scope: [], executionMode: "draft_pr"
  });
  root = store.setDiscordThread(root.id, "queued-model-thread");
  store.claim("runner-1");
  root = store.complete(root.id, "runner-1", "ready_for_review", { provenance: { codexThreadId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6" } });
  root = store.markDelivered(root.id, root.deliveryRevision, "root-result");
  const first = store.createFollowup({
    requestId: "queued-model-first", requesterDiscordId: "12345", requesterName: "Aedis",
    objective: "First", acceptanceCriteria: ["Done"], scope: [], parentJobId: root.id
  });
  const second = store.createFollowup({
    requestId: "queued-model-second", requesterDiscordId: "12345", requesterName: "Aedis",
    objective: "Second", acceptanceCriteria: ["Done"], scope: [], parentJobId: root.id
  });
  const selected = store.setNextRunModel(root.id, "gpt-6-astra", "max");
  assert.equal(selected.id, first.id);
  assert.equal(selected.modelTarget, "queued_run");
  assert.equal(store.get(first.id).model, "gpt-6-astra");
  assert.equal(store.get(second.id).model, "gpt-5.6-sol");
}));

test("failed predecessors block later corrective admission even when the latest run is delivered", () => withStore(store => {
  let root = createQueued(store, "failed-chain");
  store.claim("runner-1");
  root = store.complete(root.id, "runner-1", "ready_for_review", { provenance: { codexThreadId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6" } });
  root = store.markDelivered(root.id, root.deliveryRevision, "root-result");
  let failed = store.createFollowup({
    requestId: "failed-chain-run-2", requesterDiscordId: "12345", requesterName: "Aedis",
    objective: "Run 2", acceptanceCriteria: ["Done"], scope: [], parentJobId: root.id,
    source: { kind: "followup", guildId: "10001", channelId: "10002", messageId: "10003" }
  });
  store.claimProvisioning(failed.id, "failed-chain-claim");
  failed = store.setFollowupQueued(failed.id, "failed-chain-claim");
  store.claim("runner-1");
  failed = store.complete(failed.id, "runner-1", "failed", null, "execution failed");
  failed = store.markDelivered(failed.id, failed.deliveryRevision, "failed-result");
  assert.throws(() => store.createFollowup({
    requestId: "failed-chain-run-3", requesterDiscordId: "12345", requesterName: "Aedis",
    objective: "Run 3", acceptanceCriteria: ["Done"], scope: [], parentJobId: root.id
  }), error => error instanceof AdmissionError && error.code === "followup_blocked");
}));

test("lease expiry blocks already queued dependent follow-ups", () => withStore(store => {
  let root = createQueued(store, "lease-chain");
  store.claim("runner-1");
  root = store.complete(root.id, "runner-1", "ready_for_review", { provenance: { codexThreadId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6" } });
  root = store.markDelivered(root.id, root.deliveryRevision, "root-result");
  let messageId = 20000;
  const make = (id, objective) => {
    const created = store.createFollowup({
    requestId: id, requesterDiscordId: "12345", requesterName: "Aedis",
    objective, acceptanceCriteria: ["Done"], scope: [], parentJobId: root.id,
    source: { kind: "followup", guildId: "20001", channelId: "20002", messageId: String(++messageId) }
    });
    const claim = `${id}-claim`;
    store.claimProvisioning(created.id, claim);
    return store.setFollowupQueued(created.id, claim);
  };
  const run2 = make("lease-chain-run-2", "Run 2");
  const run3 = make("lease-chain-run-3", "Run 3");
  store.claim("runner-1");
  store.db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", run2.id);
  const expired = store.claim("runner-1");
  assert.equal(expired.id, run2.id);
  assert.equal(expired.state, "needs_attention");
  assert.equal(store.get(run3.id).state, "needs_attention");
  assert.equal(store.claim("runner-1"), null);
}));

test("owner GitHub controls bind a task PR to its delivered publication and serialize with jobs", () => withStore(store => {
  let root = createQueued(store, "github-control");
  store.claim("runner-1");
  root = store.complete(root.id, "runner-1", "ready_for_review", {
    status: "completed",
    provenance: {
      codexThreadId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6",
      publication: {
        state: "published",
        prUrl: "https://github.com/cameo-mod/Cameo-mod/pull/400",
        lastCommit: "a".repeat(40),
        branch: "codex/dispatcher-test"
      }
    }
  });
  root = store.markDelivered(root.id, root.deliveryRevision, "result-message");
  store.db.prepare("UPDATE jobs SET discord_thread_id = ? WHERE id = ?").run("1549400000000000998", root.id);
  root = store.get(root.id);
  const queuedJob = createQueued(store, "blocked-by-github-control");
  const input = {
    interactionId: "1549400000000000001",
    rootJobId: root.id,
    requesterDiscordId: "12345",
    requesterName: "Blackrobe",
    action: "merge",
    repository: "cameo-mod/Cameo-mod",
    mergeMethod: "merge",
    discordThreadId: root.discordThreadId
  };
  const created = store.createGithubAction(input);
  assert.equal(created.prNumber, 400);
  assert.equal(created.expectedHeadSha, "a".repeat(40));
  assert.equal(store.createGithubAction(input).id, created.id);
  const claimed = store.claimGithubAction("runner-1");
  assert.equal(claimed.id, created.id);
  assert.equal(claimed.runKind, "github_action");
  assert.equal(store.claim("runner-1"), null);
  const completed = store.completeGithubAction(created.id, "runner-1", "ready_for_review", {
    status: "completed", summary: "Merged upstream PR #400."
  });
  assert.equal(completed.deliveryState, "pending");
  assert.equal(store.listPendingGithubActionDeliveries()[0].id, created.id);
  assert.equal(store.markGithubActionDelivered(created.id, completed.deliveryRevision, "github-result").deliveryState, "delivered");
  assert.equal(store.claim("runner-1").id, queuedJob.id);
}));

test("upstream branch PR controls reject foreign repositories and unsafe branches", () => withStore(store => {
  const common = {
    interactionId: "1549400000000000002",
    requesterDiscordId: "12345",
    requesterName: "Blackrobe",
    action: "open",
    repository: "cameo-mod/Cameo-mod",
    headBranch: "feature/one",
    baseBranch: "release",
    title: "Merge feature into release",
    discordThreadId: "1549400000000000999"
  };
  assert.equal(store.createGithubAction(common).state, "queued");
  assert.throws(() => store.createGithubAction({ ...common, interactionId: "1549400000000000003", repository: "foreign/repo" }), /not allowlisted/);
  assert.throws(() => store.createGithubAction({ ...common, interactionId: "1549400000000000004", headBranch: "../master" }), /branches are invalid/);
}));

test("an expired GitHub action accepts its retained late result without replay", () => withStore(store => {
  const action = store.createGithubAction({
    interactionId: "1549400000000000010",
    requesterDiscordId: "12345",
    requesterName: "Blackrobe",
    action: "close",
    repository: "cameo-mod/Cameo-mod",
    prNumber: 400,
    expectedHeadSha: "a".repeat(40),
    headOwner: "Blackrobe",
    headBranch: "feature",
    baseBranch: "master",
    discordThreadId: "1549400000000000999"
  });
  store.claimGithubAction("runner-1");
  store.db.prepare("UPDATE github_actions SET lease_expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", action.id);
  assert.equal(store.claimGithubAction("runner-1"), null);
  assert.equal(store.getGithubAction(action.id).state, "needs_attention");
  const recovered = store.completeGithubAction(action.id, "runner-1", "ready_for_review", {
    status: "completed", summary: "Closed upstream PR #400."
  });
  assert.equal(recovered.state, "ready_for_review");
  assert.equal(recovered.result.summary, "Closed upstream PR #400.");
}));
