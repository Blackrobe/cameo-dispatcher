import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { commands, createMentionHandler, createSlashJob, recoverMentionProvisioning } from "../src/discord.mjs";
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
    allowedUserIds: new Set([blackrobeId, aedisId])
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
  attachmentCount = 0,
  existingThread = false,
  replyError = null,
  threadSendError = null
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
    attachments: { size: attachmentCount },
    channel: {
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
      fakeMessage({ system: true })
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
  for (const name of ["cameo-task", "cameo-status", "cameo-cancel", "cameo-worker", "cameo-pause", "cameo-resume"])
    assert.ok(names.includes(name));
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
