import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { acceptGithubProposal, commands, createMentionHandler, createSlashJob, fetchGithubProposal, githubProposalCustomId, parseGithubProposalCustomId, recoverMentionProvisioning, resultFields } from "../src/discord.mjs";
import { AdmissionError, JobStore } from "../src/db.mjs";
import { defaultMentionAcceptance } from "../src/mention-intake.mjs";

const botId = "900000000000000001";
const blackrobeId = "900000000000000002";
const aedisId = "900000000000000003";
const guildId = "900000000000000004";
const channelId = "900000000000000005";

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-mention-handler-"));
  const store = new JobStore(path.join(root, "jobs.sqlite"));
  const config = {
    guildId,
    channelId,
    runnerId: "blackrobe-windows-1",
    runnerToken: "proposal-signing-test-token",
    githubProposalFetcher: async prNumber => ({
      prNumber, prUrl: `https://github.com/cameo-mod/Cameo-mod/pull/${prNumber}`,
      state: "open", draft: true, expectedHeadSha: "a".repeat(40),
      headOwner: "Blackrobe", headBranch: "codex/dispatcher-test", baseBranch: "master"
    }),
    allowedUserIds: new Set([blackrobeId, aedisId]),
    adminUserIds: new Set([blackrobeId])
  };
  let recoveryChannel = null;
  const client = {
    user: { id: botId },
    channels: {
      async fetch(id) {
        assert.equal(id, channelId);
        assert.ok(recoveryChannel);
        return recoveryChannel;
      }
    }
  };
  return {
    config,
    client,
    store,
    handler: createMentionHandler(config, store, client),
    setRecoveryChannel(channel) {
      recoveryChannel = channel;
    },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function fakeMessage({
  id = "1549200000000000001",
  authorId = blackrobeId,
  content = `<@${botId}> inspect active YAML`,
  messageGuildId = guildId,
  messageChannelId = channelId,
  bot = false,
  webhookId = null,
  applicationId = null,
  system = false,
  editedTimestamp = null,
  snapshotCount = 0,
  attachmentCount = 0,
  isThread = false,
  threadParentId = channelId,
  existingThread = false,
  replyError = null,
  threadSendError = null,
  botRoleMention = false
} = {}) {
  const replies = [];
  const threadMessages = [];
  const threadId = String(BigInt(id) + 1000n);
  const thread = {
    id: threadId,
    parentId: channelId,
    isThread() {
      return true;
    },
    async send(threadPayload) {
      if (threadSendError)
        throw threadSendError;
      threadMessages.push(threadPayload);
    }
  };
  const acknowledgement = {
    id: String(BigInt(id) + 500n),
    hasThread: existingThread,
    thread: existingThread ? thread : null,
    async startThread() {
      return thread;
    }
  };
  const storedMessages = new Map([[acknowledgement.id, acknowledgement]]);
  const message = {
    id,
    guildId: messageGuildId,
    channelId: messageChannelId,
    content,
    webhookId,
    applicationId,
    system,
    editedTimestamp,
    messageSnapshots: { size: snapshotCount },
    attachments: { size: attachmentCount },
    mentions: {
      roles: {
        find(callback) {
          const role = { id: "1549095647293079553", tags: { botId } };
          return botRoleMention && callback(role) ? role : undefined;
        }
      }
    },
    channel: {
      parentId: threadParentId,
      isThread() {
        return isThread;
      },
      messages: {
        async fetch(messageId) {
          const stored = storedMessages.get(messageId);
          if (!stored)
            throw new Error("Unknown Message");
          return stored;
        }
      }
    },
    author: { id: authorId, bot, globalName: authorId === aedisId ? "Aedis" : "Blackrobe", username: "user" },
    member: { displayName: authorId === aedisId ? "AedisToru" : "Blackrobe" },
    replies,
    threadMessages,
    async reply(payload) {
      if (replyError)
        throw replyError;
      replies.push(payload);
      return acknowledgement;
    }
  };
  storedMessages.set(id, message);
  return message;
}

async function createDeliveredRoot(fixture, { id = "1549300000000000001", authorId = aedisId, publication = null } = {}) {
  const source = fakeMessage({ id, authorId, content: `<@${botId}> inspect active YAML` });
  await fixture.handler(source);
  let root = fixture.store.getByRequestId(`discord-message-${id}`);
  fixture.store.claim("blackrobe-windows-1");
  root = fixture.store.complete(root.id, "blackrobe-windows-1", "ready_for_review", {
    status: "completed",
    summary: "Initial result",
    changedFiles: [],
    validation: ["Clean"],
    risks: [],
    nextAction: null,
    provenance: {
      codexThreadId: "01a0a275-a2f1-73f1-89ae-f94d4b983fd6",
      baseCommit: "a3a1c214a2fd3d91a42014a5d6f16e30014ec9f2",
      publication
    }
  });
  root = fixture.store.markDelivered(root.id, root.deliveryRevision, "discord-result-1");
  return { root, source };
}

test("valid Blackrobe and Aedis mentions create one sourced job each with owner defaults", async () => {
  const fixture = createFixture();
  try {
    const blackrobe = fakeMessage();
    const aedis = fakeMessage({ id: "1549200000000000002", authorId: aedisId, content: `<@${botId}> check PR #392` });
    await fixture.handler(blackrobe);
    await fixture.handler(aedis);

    const first = fixture.store.getByRequestId(`discord-message-${blackrobe.id}`);
    const second = fixture.store.getByRequestId(`discord-message-${aedis.id}`);
    assert.equal(first.state, "queued");
    assert.equal(first.requesterDiscordId, blackrobeId);
    assert.equal(first.executionMode, "draft_pr");
    assert.equal(first.model, "gpt-5.6-sol");
    assert.equal(first.reasoningEffort, "high");
    assert.deepEqual(first.acceptanceCriteria, defaultMentionAcceptance);
    assert.deepEqual(first.source, { kind: "mention", guildId, channelId, messageId: blackrobe.id });
    assert.equal(second.requesterDiscordId, aedisId);
    assert.equal(second.requesterName, "AedisToru");
    assert.equal(blackrobe.replies.length, 1);
    assert.equal(blackrobe.replies[0].nonce, blackrobe.id);
    assert.equal(blackrobe.replies[0].enforceNonce, true);
    assert.ok(first.discordAcknowledgementId);
    assert.equal(blackrobe.threadMessages.length, 1);
    assert.equal(blackrobe.threadMessages[0].embeds[0].data.title, "Worker offline; task queued");
  } finally {
    fixture.close();
  }
});

test("a redacted integration-role mention gets visible slash guidance instead of silence", async () => {
  const fixture = createFixture();
  try {
    const redacted = fakeMessage({ content: "", botRoleMention: true });
    await fixture.handler(redacted);
    assert.match(redacted.replies[0].content, /redacted/);
    assert.match(redacted.replies[0].content, /cameo-mod merge/);
    assert.equal(fixture.store.db.prepare("SELECT count(*) count FROM jobs").get().count, 0);

    fixture.store.db.exec("DELETE FROM rate_limit_notices");
    const roleMention = fakeMessage({
      id: "1549200000000000002",
      content: "<@&1549095647293079553> inspect active YAML",
      botRoleMention: true
    });
    await fixture.handler(roleMention);
    assert.ok(fixture.store.getByRequestId(`discord-message-${roleMention.id}`));
  } finally {
    fixture.close();
  }
});

test("rejects unauthorized context, ordinary text, edits, bots, webhooks, and attachments", async () => {
  const fixture = createFixture();
  try {
    const messages = [
      fakeMessage({ authorId: "999999999999999999" }),
      fakeMessage({ messageGuildId: "999999999999999998" }),
      fakeMessage({ messageChannelId: "999999999999999997" }),
      fakeMessage({ messageChannelId: "1549200000000000999" }),
      fakeMessage({ content: "ordinary conversation" }),
      fakeMessage({ content: `hello <@${botId}> inspect YAML` }),
      fakeMessage({ editedTimestamp: Date.now() }),
      fakeMessage({ bot: true }),
      fakeMessage({ webhookId: "1549200000000000888" }),
      fakeMessage({ applicationId: "1549200000000000777" }),
      fakeMessage({ system: true }),
      fakeMessage({ snapshotCount: 1 })
    ];
    for (const message of messages)
      await fixture.handler(message);
    assert.equal(fixture.store.db.prepare("SELECT count(*) count FROM jobs").get().count, 0);
    assert.equal(messages.flatMap(message => message.replies).length, 0);

    const attachment = fakeMessage({ attachmentCount: 1 });
    await fixture.handler(attachment);
    assert.equal(fixture.store.db.prepare("SELECT count(*) count FROM jobs").get().count, 0);
    assert.match(attachment.replies[0].content, /Attachment ingestion is not enabled/);
  } finally {
    fixture.close();
  }
});

test("duplicate create events reuse the durable job and never create a second thread", async () => {
  const fixture = createFixture();
  try {
    const message = fakeMessage();
    await Promise.all([fixture.handler(message), fixture.handler(message)]);
    await fixture.handler(message);

    assert.equal(fixture.store.db.prepare("SELECT count(*) count FROM jobs").get().count, 1);
    assert.equal(message.replies.length, 1);
    assert.equal(message.threadMessages.length, 1);
    const job = fixture.store.getByRequestId(`discord-message-${message.id}`);
    assert.equal(job.state, "queued");
    assert.ok(job.discordThreadId);

    // Deleting or editing the original message later does not mutate the accepted snapshot.
    assert.equal(job.objective, "inspect active YAML");
  } finally {
    fixture.close();
  }
});

test("startup recovery reuses an existing acknowledgement thread without reposting", async () => {
  const fixture = createFixture();
  try {
    const message = fakeMessage({ id: "1549200000000000051", existingThread: true });
    const job = fixture.store.createConversational({
      requestId: `discord-message-${message.id}`,
      requesterDiscordId: blackrobeId,
      requesterName: "Blackrobe",
      objective: "inspect active YAML",
      acceptanceCriteria: [...defaultMentionAcceptance],
      scope: [],
      source: { kind: "mention", guildId, channelId, messageId: message.id }
    });
    assert.equal(fixture.store.claimProvisioning(job.id, "crashed-handler"), true);
    fixture.store.setDiscordAcknowledgement(job.id, String(BigInt(message.id) + 500n), "crashed-handler");
    fixture.store.db.prepare("UPDATE jobs SET provisioning_claimed_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", job.id);
    fixture.setRecoveryChannel(message.channel);

    await recoverMentionProvisioning(fixture.config, fixture.store, fixture.client);
    assert.equal(message.replies.length, 0);
    assert.equal(message.threadMessages.length, 1);
    assert.equal(fixture.store.get(job.id).state, "queued");
  } finally {
    fixture.close();
  }
});

test("help and exact status or cancel phrases never invoke a task", async () => {
  const fixture = createFixture();
  try {
    const empty = fakeMessage({ content: `<@${botId}>` });
    const help = fakeMessage({ id: "1549200000000000002", content: `<@${botId}> help` });
    const status = fakeMessage({ id: "1549200000000000003", content: `<@${botId}> status CAM-20260914-1234ABCD` });
    const cancel = fakeMessage({ id: "1549200000000000004", content: `<@${botId}> cancel CAM-20260914-1234ABCD` });
    for (const message of [empty, help, status, cancel]) {
      fixture.store.db.exec("DELETE FROM rate_limit_notices");
      await fixture.handler(message);
    }

    assert.equal(fixture.store.db.prepare("SELECT count(*) count FROM jobs").get().count, 0);
    assert.match(empty.replies[0].content, /Usage:/);
    assert.match(help.replies[0].content, /Attachments are not ingested/);
    assert.match(status.replies[0].content, /\/cameo-status/);
    assert.match(cancel.replies[0].content, /\/cameo-cancel/);
  } finally {
    fixture.close();
  }
});

test("informational reply deletion and queued-notification failure resolve without false acceptance", async () => {
  const fixture = createFixture();
  try {
    const deletedHelp = fakeMessage({
      content: `<@${botId}> help`,
      replyError: new Error("Unknown Message")
    });
    await assert.doesNotReject(() => fixture.handler(deletedHelp));
    assert.equal(fixture.store.db.prepare("SELECT count(*) count FROM jobs").get().count, 0);

    fixture.store.db.exec("DELETE FROM rate_limit_notices");
    const notificationFailure = fakeMessage({
      id: "1549200000000000061",
      threadSendError: new Error("Discord unavailable")
    });
    await fixture.handler(notificationFailure);
    const job = fixture.store.getByRequestId(`discord-message-${notificationFailure.id}`);
    assert.equal(job.state, "failed");
    assert.equal(job.discordThreadId, null);
    assert.equal(notificationFailure.replies.length, 2);
    assert.match(notificationFailure.replies[1].content, /No job was confirmed/);
  } finally {
    fixture.close();
  }
});

test("informational mention replies are bounded per user", async () => {
  const fixture = createFixture();
  try {
    const first = fakeMessage({ content: `<@${botId}> help` });
    const second = fakeMessage({ id: "1549200000000000072", content: `<@${botId}> help` });
    await fixture.handler(first);
    await fixture.handler(second);
    assert.equal(first.replies.length, 1);
    assert.equal(second.replies.length, 0);
  } finally {
    fixture.close();
  }
});

test("persistent admission limits bound outstanding work and rate-limit rejection replies", async () => {
  const fixture = createFixture();
  try {
    const first = fakeMessage({ id: "1549200000000000011" });
    const second = fakeMessage({ id: "1549200000000000012" });
    const third = fakeMessage({ id: "1549200000000000013" });
    const fourth = fakeMessage({ id: "1549200000000000014" });
    await fixture.handler(first);
    await fixture.handler(second);
    await fixture.handler(third);
    await fixture.handler(fourth);

    assert.equal(fixture.store.db.prepare("SELECT count(*) count FROM jobs").get().count, 2);
    assert.match(third.replies[0].content, /maximum number of outstanding jobs/);
    assert.equal(fourth.replies.length, 0);
  } finally {
    fixture.close();
  }
});

test("existing slash commands remain registered", () => {
  const names = commands.map(command => command.name);
  for (const name of ["cameo-task", "cameo-status", "cameo-cancel", "cameo-worker", "cameo-model", "cameo-mod", "cameo-pause", "cameo-resume"])
    assert.ok(names.includes(name));
  assert.equal(names.includes("cameo-github"), false);
  const github = commands.find(command => command.name === "cameo-mod");
  const merge = github.options.find(option => option.name === "merge");
  const close = github.options.find(option => option.name === "close");
  assert.deepEqual(merge.options.map(option => option.name), ["pr", "method"]);
  assert.deepEqual(close.options.map(option => option.name), ["pr"]);
});

test("GitHub proposals use a validated public PR identity", async () => {
  const proposal = await fetchGithubProposal(400, async () => ({
    ok: true,
    async json() {
      return {
        number: 400, html_url: "https://github.com/cameo-mod/Cameo-mod/pull/400",
        state: "open", draft: true,
        head: { sha: "a".repeat(40), ref: "feature", repo: { owner: { login: "Blackrobe" } } },
        base: { ref: "master", repo: { full_name: "cameo-mod/Cameo-mod" } }
      };
    }
  }));
  assert.equal(proposal.expectedHeadSha, "a".repeat(40));
  assert.equal(proposal.baseBranch, "master");
  await assert.rejects(() => fetchGithubProposal(400, async () => ({
    ok: true,
    async json() {
      return {
        number: 400,
        head: { sha: "a".repeat(40), ref: "feature", repo: { owner: { login: "Blackrobe" } } },
        base: { ref: "master", repo: { full_name: "foreign/repo" } }
      };
    }
  })), /invalid PR identity/);
});

test("natural merge language proposes an action and only a trusted button acceptance queues it", async () => {
  const fixture = createFixture();
  try {
    const { root } = await createDeliveredRoot(fixture, {
      id: "1549300000000000090",
      publication: {
        state: "published",
        prUrl: "https://github.com/cameo-mod/Cameo-mod/pull/400",
        lastCommit: "a".repeat(40),
        branch: "codex/dispatcher-test"
      }
    });
    const aedis = fakeMessage({
      id: "1549300000000000091", authorId: aedisId,
      content: `<@${botId}> please merge PR #400`,
      messageChannelId: root.discordThreadId, isThread: true
    });
    await fixture.handler(aedis);
    assert.equal(fixture.store.getGithubActionByInteractionId(aedis.id), null);
    const followup = fixture.store.getByRequestId(`discord-followup-${aedis.id}`);
    assert.equal(followup.state, "queued");
    assert.match(aedis.replies[0].content, /Nothing will change on GitHub unless/);
    assert.equal(aedis.replies[0].components.length, 1);
    const proposal = {
      action: "merge", prNumber: 400, rootJobId: root.id,
      sourceMessageId: aedis.id, discordThreadId: root.discordThreadId,
      expectedHeadSha: "a".repeat(40), headOwner: "Blackrobe",
      headBranch: "codex/dispatcher-test", baseBranch: "master"
    };
    const customId = githubProposalCustomId(fixture.config, proposal);
    assert.ok(customId.length <= 100);
    const parsedProposal = parseGithubProposalCustomId(fixture.config, customId);
    assert.equal(parsedProposal.action, "merge");
    assert.equal(parsedProposal.prNumber, 400);
    assert.equal(parsedProposal.sourceMessageId, aedis.id);
    assert.match(parsedProposal.proposalIdentityDigest, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(parseGithubProposalCustomId(fixture.config, `${customId.slice(0, -1)}x`), null);
    const action = acceptGithubProposal(fixture.config, fixture.store, {
      id: aedisId, globalName: "Aedis", username: "aedis"
    }, { ...proposal, expectedHeadSha: undefined, proposalIdentityDigest: parsedProposal.proposalIdentityDigest });
    assert.equal(action.action, "merge");
    assert.equal(action.prNumber, 400);
    assert.equal(action.expectedHeadSha, null);
    assert.equal(action.proposalIdentityDigest, parsedProposal.proposalIdentityDigest);
    assert.equal(action.requesterDiscordId, aedisId);
    assert.equal(action.state, "queued");
    assert.equal(fixture.store.getByRequestId(`discord-followup-${aedis.id}`).state, "cancelled");
    assert.throws(() => acceptGithubProposal(fixture.config, fixture.store, {
      id: "900000000000009999", username: "intruder"
    }, { ...proposal, sourceMessageId: "1549300000000000092" }), /trusted developer/);

    const mismatch = fakeMessage({
      id: "1549300000000000093", authorId: blackrobeId,
      content: `<@${botId}> merge PR 401`,
      messageChannelId: root.discordThreadId, isThread: true
    });
    await fixture.handler(mismatch);
    assert.match(mismatch.replies[0].content, /owns PR #400, not PR #401/);
    assert.equal(fixture.store.getGithubActionByInteractionId(mismatch.id), null);
  } finally {
    fixture.close();
  }
});

test("worker result fields always display the effective model and effort", () => {
  const fields = resultFields({
    id: "CAM-20260915-MODEL001", runRevision: 2, state: "ready_for_review",
    model: "gpt-5.6-sol", reasoningEffort: "high",
    result: { provenance: { model: "gpt-6-astra", reasoningEffort: "max" } }
  });
  assert.equal(fields.find(field => field.name === "Model").value, "gpt-6-astra · max");
});

test("visual mention routes the run to Astra max", async () => {
  const fixture = createFixture();
  try {
    const message = fakeMessage({ content: `<@${botId}> fix incorrect magenta player color in TKM sprites` });
    await fixture.handler(message);
    const job = fixture.store.getByRequestId(`discord-message-${message.id}`);
    assert.equal(job.model, "gpt-6-astra");
    assert.equal(job.reasoningEffort, "max");
    assert.equal(job.modelSource, "visual_route");
  } finally {
    fixture.close();
  }
});

test("structured slash task creation uses the same persistent admission limits", () => {
  const fixture = createFixture();
  try {
    const interaction = index => ({
      id: `15492000000000001${index}`,
      guildId,
      channelId,
      user: { id: blackrobeId, globalName: "Blackrobe", username: "blackrobe" }
    });
    createSlashJob(fixture.store, interaction(1), "First", ["Done"]);
    createSlashJob(fixture.store, interaction(2), "Second", ["Done"]);
    assert.throws(
      () => createSlashJob(fixture.store, interaction(3), "Third", ["Done"]),
      error => error instanceof AdmissionError && error.code === "user_queue_full"
    );
  } finally {
    fixture.close();
  }
});

test("registered-thread mention creates one exact-session follow-up run", async () => {
  const fixture = createFixture();
  try {
    const { root } = await createDeliveredRoot(fixture);
    const followupMessage = fakeMessage({
      id: "1549300000000000011",
      authorId: aedisId,
      content: `<@${botId}> recheck the conclusion against the current files`,
      messageChannelId: root.discordThreadId,
      isThread: true
    });
    await Promise.all([fixture.handler(followupMessage), fixture.handler(followupMessage)]);

    const followup = fixture.store.getByRequestId(`discord-followup-${followupMessage.id}`);
    assert.equal(followup.parentJobId, root.id);
    assert.equal(followup.rootRequestId, root.requestId);
    assert.equal(followup.runKind, "followup");
    assert.equal(followup.runRevision, 2);
    assert.equal(followup.resumeSessionId, root.result.provenance.codexThreadId);
    assert.equal(followup.discordThreadId, root.discordThreadId);
    assert.equal(followup.state, "queued");
    assert.equal(followupMessage.replies.length, 1);
  } finally {
    fixture.close();
  }
});

test("a delivered needs-attention result accepts a corrective thread mention", async () => {
  const fixture = createFixture();
  try {
    const { root } = await createDeliveredRoot(fixture, { id: "1549300000000000015" });
    fixture.store.db.prepare("UPDATE jobs SET state = 'needs_attention' WHERE id = ?").run(root.id);
    const correction = fakeMessage({
      id: "1549300000000000016",
      authorId: aedisId,
      content: `<@${botId}> use the reported limitation and continue with a corrective check`,
      messageChannelId: root.discordThreadId,
      isThread: true
    });
    await fixture.handler(correction);
    const followup = fixture.store.getByRequestId(`discord-followup-${correction.id}`);
    assert.equal(followup.state, "queued");
    assert.equal(followup.resumeSessionId, root.result.provenance.codexThreadId);
    assert.equal(fixture.store.claim("blackrobe-windows-1").id, followup.id);
  } finally {
    fixture.close();
  }
});

test("manual threads are rejected while either trusted developer may continue a registered job", async () => {
  const fixture = createFixture();
  try {
    const manual = fakeMessage({
      id: "1549300000000000021",
      authorId: aedisId,
      messageChannelId: "1549300000000099999",
      isThread: true
    });
    await fixture.handler(manual);
    assert.match(manual.replies[0].content, /not a registered/);

    fixture.store.db.exec("DELETE FROM rate_limit_notices");
    const { root } = await createDeliveredRoot(fixture, { id: "1549300000000000022", authorId: blackrobeId });
    const trustedPeer = fakeMessage({
      id: "1549300000000000023",
      authorId: aedisId,
      messageChannelId: root.discordThreadId,
      isThread: true
    });
    await fixture.handler(trustedPeer);
    const followup = fixture.store.getByRequestId(`discord-followup-${trustedPeer.id}`);
    assert.equal(followup.requesterDiscordId, aedisId);
    assert.equal(followup.parentJobId, root.id);
    assert.equal(followup.state, "queued");
  } finally {
    fixture.close();
  }
});

test("queued follow-ups serialize behind prior delivery", async () => {
  const fixture = createFixture();
  try {
    const { root } = await createDeliveredRoot(fixture, { id: "1549300000000000031" });
    const firstMessage = fakeMessage({
      id: "1549300000000000032",
      authorId: aedisId,
      messageChannelId: root.discordThreadId,
      isThread: true,
      content: `<@${botId}> first correction`
    });
    const secondMessage = fakeMessage({
      id: "1549300000000000033",
      authorId: aedisId,
      messageChannelId: root.discordThreadId,
      isThread: true,
      content: `<@${botId}> second correction`
    });
    await fixture.handler(firstMessage);
    await fixture.handler(secondMessage);
    const first = fixture.store.getByRequestId(`discord-followup-${firstMessage.id}`);
    const second = fixture.store.getByRequestId(`discord-followup-${secondMessage.id}`);
    assert.equal(first.runRevision, 2);
    assert.equal(second.runRevision, 3);

    const claimedFirst = fixture.store.claim("blackrobe-windows-1");
    assert.equal(claimedFirst.id, first.id);
    assert.equal(fixture.store.claim("blackrobe-windows-1").id, first.id);
    let completedFirst = fixture.store.complete(first.id, "blackrobe-windows-1", "ready_for_review", {
      status: "completed",
      summary: "First follow-up",
      changedFiles: [], validation: [], risks: [], nextAction: null
    });
    assert.equal(fixture.store.claim("blackrobe-windows-1"), null);
    completedFirst = fixture.store.markDelivered(first.id, completedFirst.deliveryRevision, "discord-followup-result-1");
    assert.equal(completedFirst.deliveryState, "delivered");
    assert.equal(fixture.store.claim("blackrobe-windows-1").id, second.id);
  } finally {
    fixture.close();
  }
});

test("cancelled follow-ups are skipped and do not strand later revisions", async () => {
  const fixture = createFixture();
  try {
    const { root } = await createDeliveredRoot(fixture, { id: "1549300000000000041" });
    const firstMessage = fakeMessage({
      id: "1549300000000000042", authorId: aedisId,
      messageChannelId: root.discordThreadId, isThread: true,
      content: `<@${botId}> obsolete correction`
    });
    const secondMessage = fakeMessage({
      id: "1549300000000000043", authorId: aedisId,
      messageChannelId: root.discordThreadId, isThread: true,
      content: `<@${botId}> replacement correction`
    });
    await fixture.handler(firstMessage);
    await fixture.handler(secondMessage);
    const first = fixture.store.getByRequestId(`discord-followup-${firstMessage.id}`);
    const second = fixture.store.getByRequestId(`discord-followup-${secondMessage.id}`);
    assert.equal(fixture.store.cancel(first.id, aedisId).state, "cancelled");
    assert.equal(fixture.store.claim("blackrobe-windows-1").id, second.id);
  } finally {
    fixture.close();
  }
});

test("failed follow-up marks dependent queued revisions needs_attention", async () => {
  const fixture = createFixture();
  try {
    const { root } = await createDeliveredRoot(fixture, { id: "1549300000000000051" });
    const firstMessage = fakeMessage({
      id: "1549300000000000052", authorId: aedisId,
      messageChannelId: root.discordThreadId, isThread: true,
      content: `<@${botId}> first correction`
    });
    const secondMessage = fakeMessage({
      id: "1549300000000000053", authorId: aedisId,
      messageChannelId: root.discordThreadId, isThread: true,
      content: `<@${botId}> dependent correction`
    });
    await fixture.handler(firstMessage);
    await fixture.handler(secondMessage);
    const first = fixture.store.getByRequestId(`discord-followup-${firstMessage.id}`);
    const second = fixture.store.getByRequestId(`discord-followup-${secondMessage.id}`);
    fixture.store.claim("blackrobe-windows-1");
    fixture.store.complete(first.id, "blackrobe-windows-1", "needs_attention", {
      status: "needs_attention", summary: "Blocked", changedFiles: [], validation: [], risks: [], nextAction: null
    });
    const blocked = fixture.store.get(second.id);
    assert.equal(blocked.state, "needs_attention");
    assert.equal(blocked.deliveryState, "pending");
    assert.match(blocked.error, /run 2 ended in needs_attention/);
    assert.equal(fixture.store.claim("blackrobe-windows-1"), null);
  } finally {
    fixture.close();
  }
});

test("definitive follow-up provisioning failure blocks dependent revisions visibly", async () => {
  const fixture = createFixture();
  try {
    const { root } = await createDeliveredRoot(fixture, { id: "1549300000000000061" });
    const input = (messageId, objective) => ({
      requestId: `discord-followup-${messageId}`,
      requesterDiscordId: aedisId,
      requesterName: "AedisToru",
      objective,
      acceptanceCriteria: ["Report findings."],
      scope: root.scope,
      parentJobId: root.id,
      source: { kind: "followup", guildId, channelId: root.discordThreadId, messageId }
    });
    const first = fixture.store.createFollowup(input("1549300000000000062", "first"));
    assert.equal(fixture.store.claimProvisioning(first.id, "first-provisioning"), true);
    let second = fixture.store.createFollowup(input("1549300000000000063", "second"));
    assert.equal(fixture.store.claimProvisioning(second.id, "second-provisioning"), true);
    fixture.store.setDiscordAcknowledgement(second.id, "second-ack", "second-provisioning");
    second = fixture.store.setFollowupQueued(second.id, "second-provisioning");

    const failed = fixture.store.failProvisioning(first.id, "Discord thread unavailable", "first-provisioning");
    assert.equal(failed.state, "failed");
    assert.equal(failed.deliveryState, "pending");
    const dependent = fixture.store.get(second.id);
    assert.equal(dependent.state, "needs_attention");
    assert.equal(dependent.deliveryState, "pending");
    assert.match(dependent.error, /failed during provisioning/);
    assert.equal(fixture.store.claim("blackrobe-windows-1"), null);
  } finally {
    fixture.close();
  }
});
