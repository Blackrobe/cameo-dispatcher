import { randomUUID } from "node:crypto";
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Options,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

import { AdmissionError } from "./db.mjs";
import { defaultMentionAcceptance, parseMentionIntake } from "./mention-intake.mjs";

export const commands = [
  new SlashCommandBuilder()
    .setName("cameo-task")
    .setDescription("Submit a scoped Cameo task to Blackrobe's dispatcher")
    .addStringOption(option => option
      .setName("objective")
      .setDescription("Concrete requested outcome")
      .setRequired(true)
      .setMaxLength(2000))
    .addStringOption(option => option
      .setName("acceptance")
      .setDescription("Semicolon-separated acceptance checks")
      .setRequired(true)
      .setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName("cameo-status")
    .setDescription("Show a submitted Cameo task")
    .addStringOption(option => option
      .setName("job")
      .setDescription("Dispatcher job ID")
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("cameo-cancel")
    .setDescription("Cancel your queued Cameo task")
    .addStringOption(option => option
      .setName("job")
      .setDescription("Dispatcher job ID")
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("cameo-worker")
    .setDescription("Show dispatcher pause and Windows worker availability"),
  new SlashCommandBuilder()
    .setName("cameo-pause")
    .setDescription("Owner only: pause new worker claims"),
  new SlashCommandBuilder()
    .setName("cameo-resume")
    .setDescription("Owner only: resume new worker claims")
].map(command => command.toJSON());

function escapeThreadName(value) {
  return value.replaceAll(/[\r\n]/g, " ").replaceAll(/\s+/g, " ").trim().slice(0, 70);
}

function systemEmbed(job, title) {
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(title)
    .setDescription(job.objective.slice(0, 4000))
    .addFields(
      { name: "Job", value: job.id, inline: true },
      { name: "State", value: job.state, inline: true },
      { name: "Requester", value: job.requesterName, inline: true }
    )
    .setFooter({ text: "via Cameo Dispatcher · GitHub remains authoritative" })
    .setTimestamp(new Date(job.updatedAt));

  if (job.result) {
    const result = job.result;
    if (typeof result.summary === "string")
      embed.setDescription(result.summary.slice(0, 1800));
    if (Array.isArray(result.validation) && result.validation.length)
      embed.addFields({ name: "Validation", value: result.validation.join("\n").slice(0, 900) });
    if (Array.isArray(result.risks) && result.risks.length)
      embed.addFields({ name: "Risks", value: result.risks.join("\n").slice(0, 700) });
    if (typeof result.nextAction === "string" && result.nextAction.trim())
      embed.addFields({ name: "Next action", value: result.nextAction.slice(0, 700) });
    if (result.provenance?.codexThreadId)
      embed.addFields({ name: "Codex run", value: String(result.provenance.codexThreadId).slice(0, 1024) });
  }

  return embed;
}

function resultSummary(job) {
  const result = job.result ?? {};
  const summary = typeof result.summary === "string" ? result.summary : job.error ?? "No result summary was provided.";
  return summary.slice(0, 1800);
}

function resultFields(job) {
  const result = job.result ?? {};
  const fields = [
    { name: "Job", value: job.id, inline: true },
    { name: "State", value: job.state, inline: true },
    { name: "Provider", value: `${job.result?.provenance?.provider ?? "OpenAI"} · ${job.result?.provenance?.tool ?? "Codex Worker"}`, inline: true }
  ];
  if (Array.isArray(result.validation) && result.validation.length)
    fields.push({ name: "Validation", value: result.validation.join("\n").slice(0, 900) });
  if (Array.isArray(result.risks) && result.risks.length)
    fields.push({ name: "Risks", value: result.risks.join("\n").slice(0, 700) });
  if (typeof result.nextAction === "string" && result.nextAction.trim())
    fields.push({ name: "Next action", value: result.nextAction.slice(0, 700) });
  if (result.provenance?.codexThreadId)
    fields.push({ name: "Codex run", value: String(result.provenance.codexThreadId).slice(0, 200) });
  return fields;
}

function controlEmbed(config, store, title) {
  const control = store.getControlState();
  const runner = store.getRunnerStatus(config.runnerId);
  const workerValue = runner.online
    ? `${runner.state}${runner.currentJobId ? ` · ${runner.currentJobId}` : ""}`
    : "offline";
  return new EmbedBuilder()
    .setColor(control.paused ? 0xe67e22 : runner.online ? 0x2ecc71 : 0x95a5a6)
    .setTitle(title)
    .addFields(
      { name: "Claims", value: control.paused ? "paused" : "enabled", inline: true },
      { name: "Windows worker", value: workerValue, inline: true },
      { name: "Runner", value: config.runnerId, inline: true }
    )
    .setFooter({ text: "via Cameo Dispatcher · GitHub remains authoritative" })
    .setTimestamp(new Date(control.updatedAt));
}

const mentionReplyOptions = Object.freeze({ allowedMentions: { parse: [] } });

async function replyWithoutMentions(message, content) {
  return message.reply({ content, ...mentionReplyOptions });
}

export function createSlashJob(store, interaction, objective, acceptanceCriteria) {
  return store.createConversational({
    requestId: `discord-${interaction.id}`,
    requesterDiscordId: interaction.user.id,
    requesterName: interaction.user.globalName || interaction.user.username,
    objective,
    acceptanceCriteria,
    scope: [],
    source: {
      kind: "slash",
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: interaction.id
    }
  });
}

async function provisionMentionJob({ config, store, client, job, claimToken, sourceMessage = null }) {
  const channel = sourceMessage?.channel ?? await client.channels.fetch(job.source.channelId);
  let acknowledgement;
  if (job.discordAcknowledgementId) {
    acknowledgement = await channel.messages.fetch(job.discordAcknowledgementId);
  } else {
    const original = sourceMessage ?? await channel.messages.fetch(job.source.messageId);
    acknowledgement = await original.reply({
      embeds: [systemEmbed(job, "Cameo conversational task provisioning")],
      nonce: job.source.messageId,
      enforceNonce: true,
      ...mentionReplyOptions
    });
    job = store.setDiscordAcknowledgement(job.id, acknowledgement.id, claimToken);
  }

  const thread = acknowledgement.hasThread
    ? acknowledgement.thread ?? await client.channels.fetch(acknowledgement.id)
    : await acknowledgement.startThread({
      name: `${job.id} · ${escapeThreadName(job.objective)}`,
      autoArchiveDuration: 1440
    });
  if (!thread || typeof thread.send !== "function"
    || (typeof thread.isThread === "function" && !thread.isThread())
    || (thread.parentId && thread.parentId !== config.channelId))
    throw new Error("the recovered Discord destination is not the configured job thread");
  const runner = store.getRunnerStatus(config.runnerId);
  await thread.send({
    embeds: [systemEmbed({ ...job, state: "queued" }, runner.online ? "Worker awaiting claim" : "Worker offline; task queued")],
    nonce: job.id,
    enforceNonce: true,
    ...mentionReplyOptions
  });
  return store.setDiscordThread(job.id, thread.id, claimToken);
}

export function createMentionHandler(config, store, client) {
  return async message => {
    if (message.guildId !== config.guildId || message.channelId !== config.channelId)
      return;
    if (!message.author || message.author.bot || message.webhookId || message.applicationId || message.system || message.editedTimestamp)
      return;
    if (!config.allowedUserIds.has(message.author.id))
      return;

    try {
      const parsed = parseMentionIntake(message.content, client.user.id);
      if (!parsed)
        return;

      if (parsed.kind === "empty") {
        if (store.allowRateLimitNotice(message.author.id, 10))
          await replyWithoutMentions(message, `Usage: <@${client.user.id}> describe the Cameo task. Use /cameo-status and /cameo-cancel for controls.`);
        return;
      }
      if (parsed.kind === "help") {
        if (store.allowRateLimitNotice(message.author.id, 10))
          await replyWithoutMentions(message, "Mention me at the start of a message followed by a natural-language Cameo request. Attachments are not ingested yet. Use /cameo-task for explicit acceptance criteria, /cameo-status for state, and /cameo-cancel to cancel your own queued job.");
        return;
      }
      if (parsed.kind === "control_hint") {
        if (store.allowRateLimitNotice(message.author.id, 10))
          await replyWithoutMentions(message, `Use /cameo-${parsed.command} job:${parsed.jobId}. Conversational messages never change dispatcher control state.`);
        return;
      }
      if ((message.attachments?.size ?? 0) > 0) {
        if (store.allowRateLimitNotice(message.author.id, 10))
          await replyWithoutMentions(message, "Attachment ingestion is not enabled. Submit a text-only task, or make the required evidence available in the repository first.");
        return;
      }

      let job = store.createConversational({
        requestId: `discord-message-${message.id}`,
        requesterDiscordId: message.author.id,
        requesterName: message.member?.displayName || message.author.globalName || message.author.username,
        objective: parsed.objective,
        acceptanceCriteria: [...defaultMentionAcceptance],
        scope: [],
        source: {
          kind: "mention",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id
        }
      });

      if (job.discordThreadId)
        return;
      const provisioningClaim = randomUUID();
      if (!store.claimProvisioning(job.id, provisioningClaim))
        return;

      try {
        job = await provisionMentionJob({ config, store, client, job, claimToken: provisioningClaim, sourceMessage: message });
      } catch (error) {
        store.failProvisioning(job.id, error.message, provisioningClaim);
        throw error;
      }
    } catch (error) {
      if (error instanceof AdmissionError) {
        if (store.allowRateLimitNotice(message.author.id))
          await replyWithoutMentions(message, error.message);
        return;
      }
      console.error(`mention intake failed: ${error.message}`);
      await replyWithoutMentions(message, "The dispatcher could not accept this request. No job was confirmed; use /cameo-worker or try again later.").catch(() => {});
    }
  };
}

export async function recoverMentionProvisioning(config, store, client) {
  for (const candidate of store.listRecoverableProvisioning()) {
    const provisioningClaim = randomUUID();
    if (!store.claimProvisioning(candidate.id, provisioningClaim))
      continue;
    try {
      const current = store.get(candidate.id);
      await provisionMentionJob({ config, store, client, job: current, claimToken: provisioningClaim });
    } catch (error) {
      console.error(`mention provisioning recovery failed for ${candidate.id}: ${error.message}`);
    }
  }
}

async function publishThroughWebhook(config, job) {
  if (!config.agentWebhookUrl || !job.discordThreadId)
    return false;

  const identity = config.runnerIdentity;
  const url = new URL(config.agentWebhookUrl);
  url.searchParams.set("wait", "true");
  url.searchParams.set("thread_id", job.discordThreadId);

  const payload = {
    username: identity.displayName,
    avatar_url: identity.avatarUrl || undefined,
    content: `[${identity.owner}/${identity.tool}] ${job.state}: ${job.id}`,
    allowed_mentions: { parse: [] },
    embeds: [{
      author: { name: identity.displayName, icon_url: identity.avatarUrl || undefined },
      color: identity.color,
      description: resultSummary(job),
      fields: resultFields(job).map(field => field.name === "Provider"
        ? { ...field, value: `${identity.provider} · ${identity.tool}` }
        : field),
      footer: { text: "via Cameo Dispatcher" },
      timestamp: new Date(job.updatedAt).toISOString()
    }]
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const error = new Error(`Discord webhook returned ${response.status}`);
    const retryHeader = response.headers.get("retry-after");
    error.retryAfterMs = retryHeader ? Math.ceil(Number(retryHeader) * 1000) : 10000;
    throw error;
  }
  const message = await response.json();
  return { delivered: true, messageId: message.id ?? null };
}

export async function startDiscord(config, store) {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: commands });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    makeCache: Options.cacheWithLimits({ MessageManager: 0 })
  });

  const mentionHandler = createMentionHandler(config, store, client);
  client.on("messageCreate", message => {
    mentionHandler(message).catch(error => {
      console.error(`unhandled mention intake failure: ${error.message}`);
    });
  });

  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand())
      return;

    const inConfiguredChannel = interaction.channelId === config.channelId
      || (interaction.channel?.isThread() && interaction.channel.parentId === config.channelId);
    const allowed = interaction.guildId === config.guildId
      && inConfiguredChannel
      && config.allowedUserIds.has(interaction.user.id);
    if (!allowed) {
      await interaction.reply({ content: "This dispatcher command is not authorized here.", ephemeral: true });
      return;
    }

    try {
      if (["cameo-pause", "cameo-resume"].includes(interaction.commandName)) {
        if (!config.adminUserIds.has(interaction.user.id)) {
          await interaction.reply({ content: "Only a dispatcher owner can change claim availability.", ephemeral: true });
          return;
        }
        const paused = interaction.commandName === "cameo-pause";
        store.setPaused(paused, interaction.user.id);
        await interaction.reply({
          embeds: [controlEmbed(config, store, paused ? "Cameo worker claims paused" : "Cameo worker claims resumed")],
          ephemeral: true,
          allowedMentions: { parse: [] }
        });
        return;
      }

      if (interaction.commandName === "cameo-worker") {
        await interaction.reply({
          embeds: [controlEmbed(config, store, "Cameo worker status")],
          ephemeral: true,
          allowedMentions: { parse: [] }
        });
        return;
      }

      if (interaction.commandName === "cameo-task") {
        if (interaction.channelId !== config.channelId) {
          await interaction.reply({ content: "Submit new jobs in #agent-office; use job threads for status and context.", ephemeral: true });
          return;
        }
        await interaction.deferReply();
        const objective = interaction.options.getString("objective", true).trim();
        const acceptance = interaction.options.getString("acceptance", true).split(";").map(value => value.trim()).filter(Boolean);
        if (acceptance.length === 0)
          throw new Error("at least one acceptance criterion is required");
        let job = createSlashJob(store, interaction, objective, acceptance);
        try {
          const message = await interaction.editReply({ embeds: [systemEmbed(job, "Cameo task provisioning")], allowedMentions: { parse: [] } });
          const thread = await message.startThread({ name: `${job.id} · ${escapeThreadName(objective)}`, autoArchiveDuration: 1440 });
          const runner = store.getRunnerStatus(config.runnerId);
          await thread.send({
            embeds: [systemEmbed({ ...job, state: "queued" }, runner.online ? "Worker awaiting claim" : "Worker offline; task queued")],
            nonce: job.id,
            enforceNonce: true,
            allowedMentions: { parse: [] }
          });
          job = store.setDiscordThread(job.id, thread.id);
        } catch (error) {
          store.failProvisioning(job.id, error.message);
          throw error;
        }
        return;
      }

      const jobId = interaction.options.getString("job", true).trim();
      const job = store.get(jobId);
      if (!job) {
        await interaction.reply({ content: "Job not found.", ephemeral: true });
        return;
      }

      if (interaction.commandName === "cameo-status") {
        await interaction.reply({ embeds: [systemEmbed(job, "Cameo task status")], ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }

      if (interaction.commandName === "cameo-cancel") {
        const cancelled = store.cancel(jobId, interaction.user.id);
        await interaction.reply({ embeds: [systemEmbed(cancelled, "Cameo task cancelled")], allowedMentions: { parse: [] } });
      }
    } catch (error) {
      const content = error instanceof AdmissionError ? error.message : `Dispatcher error: ${error.message}`;
      const payload = { content, ephemeral: true, allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied)
        await interaction.editReply(payload).catch(() => {});
      else
        await interaction.reply(payload).catch(() => {});
    }
  });

  await client.login(config.discordToken);
  await recoverMentionProvisioning(config, store, client);
  const recoveryTimer = setInterval(() => {
    recoverMentionProvisioning(config, store, client).catch(error => {
      console.error(`mention provisioning recovery scan failed: ${error.message}`);
    });
  }, 30000);
  recoveryTimer.unref();

  return {
    client,
    close() {
      clearInterval(recoveryTimer);
      client.destroy();
    },
    async publishJob(job) {
      const webhookResult = await publishThroughWebhook(config, job);
      if (webhookResult)
        return webhookResult.messageId;
      if (!job.discordThreadId)
        throw new Error("job has no Discord thread destination");
      const channel = await client.channels.fetch(job.discordThreadId);
      const message = await channel.send({
        content: `[${config.runnerIdentity.owner}/${config.runnerIdentity.tool}]`,
        embeds: [new EmbedBuilder()
          .setColor(config.runnerIdentity.color)
          .setAuthor({ name: config.runnerIdentity.displayName, iconURL: config.runnerIdentity.avatarUrl || undefined })
          .setTitle(`${job.id} · ${job.state}`)
          .setDescription(resultSummary(job))
          .addFields(resultFields(job))
          .setFooter({ text: "via Cameo Dispatcher" })
          .setTimestamp(new Date(job.updatedAt))],
        allowedMentions: { parse: [] }
      });
      return message.id;
    }
  };
}
