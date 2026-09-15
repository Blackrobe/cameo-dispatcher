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
import { chooseRunPolicy, MODELS } from "./run-policy.mjs";

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
      .setMaxLength(1000))
    .addStringOption(option => option
      .setName("model")
      .setDescription("Owner override; otherwise routed by task")
      .addChoices(
        { name: "GPT-5.6 Sol", value: MODELS.sol },
        { name: "GPT-6 Astra", value: MODELS.astra }
      ))
    .addStringOption(option => option
      .setName("effort")
      .setDescription("Owner override for reasoning effort")
      .addChoices(
        { name: "High", value: "high" },
        { name: "Max", value: "max" }
      ))
    .addStringOption(option => option
      .setName("mode")
      .setDescription("Owner override; draft PR is the normal execution lane")
      .addChoices(
        { name: "Edit and draft PR", value: "draft_pr" },
        { name: "Read only", value: "read_only" }
      )),
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
    .setName("cameo-model")
    .setDescription("Owner only: choose the model for the next turn in this job thread")
    .addStringOption(option => option
      .setName("model")
      .setDescription("Model for the next follow-up")
      .setRequired(true)
      .addChoices(
        { name: "GPT-5.6 Sol", value: MODELS.sol },
        { name: "GPT-6 Astra", value: MODELS.astra }
      ))
    .addStringOption(option => option
      .setName("effort")
      .setDescription("Reasoning effort for the next follow-up")
      .setRequired(true)
      .addChoices(
        { name: "High", value: "high" },
        { name: "Max", value: "max" }
      )),
  new SlashCommandBuilder()
    .setName("cameo-github")
    .setDescription("Trusted developers: control upstream Cameo pull requests")
    .addSubcommand(subcommand => subcommand
      .setName("open")
      .setDescription("Open a PR between two existing upstream branches")
      .addStringOption(option => option.setName("head").setDescription("Upstream source branch").setRequired(true))
      .addStringOption(option => option.setName("base").setDescription("Upstream target branch").setRequired(true))
      .addStringOption(option => option.setName("title").setDescription("Pull request title").setRequired(true).setMaxLength(200))
      .addBooleanOption(option => option.setName("draft").setDescription("Open as draft; defaults to yes")))
    .addSubcommand(subcommand => subcommand
      .setName("merge")
      .setDescription("Merge an upstream PR only at an exact head commit")
      .addIntegerOption(option => option.setName("pr").setDescription("Upstream PR number").setRequired(true).setMinValue(1))
      .addStringOption(option => option.setName("expected-head").setDescription("Exact 40-character PR head commit").setRequired(true).setMinLength(40).setMaxLength(40))
      .addStringOption(option => option.setName("head-owner").setDescription("Expected PR head repository owner").setRequired(true).setMaxLength(40))
      .addStringOption(option => option.setName("head-branch").setDescription("Expected PR head branch").setRequired(true).setMaxLength(200))
      .addStringOption(option => option.setName("base-branch").setDescription("Expected upstream target branch").setRequired(true).setMaxLength(200))
      .addStringOption(option => option.setName("method").setDescription("GitHub merge method").addChoices(
        { name: "Merge commit", value: "merge" },
        { name: "Squash", value: "squash" },
        { name: "Rebase", value: "rebase" }
      )))
    .addSubcommand(subcommand => subcommand
      .setName("close")
      .setDescription("Close an upstream PR without deleting its branch")
      .addIntegerOption(option => option.setName("pr").setDescription("Upstream PR number").setRequired(true).setMinValue(1))
      .addStringOption(option => option.setName("expected-head").setDescription("Exact 40-character PR head commit").setRequired(true).setMinLength(40).setMaxLength(40))
      .addStringOption(option => option.setName("head-owner").setDescription("Expected PR head repository owner").setRequired(true).setMaxLength(40))
      .addStringOption(option => option.setName("head-branch").setDescription("Expected PR head branch").setRequired(true).setMaxLength(200))
      .addStringOption(option => option.setName("base-branch").setDescription("Expected upstream target branch").setRequired(true).setMaxLength(200))),
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
      { name: "Job", value: job.parentJobId ?? job.id, inline: true },
      { name: "Run", value: String(job.runRevision ?? 1), inline: true },
      { name: "State", value: job.state, inline: true },
      { name: "Requester", value: job.requesterName, inline: true },
      { name: "Execution", value: job.executionMode === "draft_pr" ? "edit + draft PR" : "read only", inline: true },
      { name: "Model", value: `${job.model ?? MODELS.sol} · ${job.reasoningEffort ?? "high"}`, inline: true }
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

export function resultFields(job) {
  const result = job.result ?? {};
  const fields = [
    { name: "Job", value: job.parentJobId ?? job.id, inline: true },
    { name: "Run", value: String(job.runRevision ?? 1), inline: true },
    { name: "State", value: job.state, inline: true },
    { name: "Provider", value: `${job.result?.provenance?.provider ?? "OpenAI"} · ${job.result?.provenance?.tool ?? "Codex Worker"}`, inline: true },
    {
      name: "Model",
      value: `${job.result?.provenance?.model ?? job.model ?? "unknown"} · ${job.result?.provenance?.reasoningEffort ?? job.reasoningEffort ?? "unknown"}`,
      inline: true
    }
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
  const workerValue = runner.isolated
    ? `busy · isolated model phase · ${runner.currentJobId}`
    : runner.online
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

function githubActionEmbed(action, title) {
  const description = action.result?.summary ?? `${action.action} request accepted for the fixed upstream repository.`;
  const fields = [
    { name: "Action", value: action.action, inline: true },
    { name: "Control ID", value: action.id, inline: true },
    { name: "State", value: action.state, inline: true }
  ];
  if (action.prNumber)
    fields.push({ name: "PR", value: `#${action.prNumber}`, inline: true });
  if (action.expectedHeadSha)
    fields.push({ name: "Expected head", value: action.expectedHeadSha, inline: false });
  if (action.headBranch)
    fields.push({ name: "Branches", value: `${action.headBranch} → ${action.baseBranch}`, inline: false });
  if (Array.isArray(action.result?.validation) && action.result.validation.length)
    fields.push({ name: "Validation", value: action.result.validation.join("\n").slice(0, 900) });
  if (Array.isArray(action.result?.risks) && action.result.risks.length)
    fields.push({ name: "Risks", value: action.result.risks.join("\n").slice(0, 700) });
  if (action.result?.nextAction)
    fields.push({ name: "GitHub", value: String(action.result.nextAction).slice(0, 700) });
  return new EmbedBuilder()
    .setColor(action.state === "ready_for_review" ? 0x2ecc71 : action.state === "queued" ? 0x3498db : 0xe67e22)
    .setTitle(title)
    .setDescription(String(description).slice(0, 1800))
    .addFields(fields)
    .setFooter({ text: "via Cameo Dispatcher · trusted-developer GitHub control" })
    .setTimestamp(new Date(action.updatedAt));
}

const mentionReplyOptions = Object.freeze({ allowedMentions: { parse: [] } });

async function replyWithoutMentions(message, content) {
  return message.reply({ content, ...mentionReplyOptions });
}

export function createSlashJob(store, interaction, objective, acceptanceCriteria, runPolicy = chooseRunPolicy(objective)) {
  return store.createConversational({
    requestId: `discord-${interaction.id}`,
    requesterDiscordId: interaction.user.id,
    requesterName: interaction.user.globalName || interaction.user.username,
    objective,
    acceptanceCriteria,
    scope: [],
    ...runPolicy,
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

async function provisionFollowupJob({ store, client, job, claimToken, sourceMessage = null }) {
  const channel = sourceMessage?.channel ?? await client.channels.fetch(job.source.channelId);
  let acknowledgement;
  if (job.discordAcknowledgementId) {
    acknowledgement = await channel.messages.fetch(job.discordAcknowledgementId);
  } else {
    const original = sourceMessage ?? await channel.messages.fetch(job.source.messageId);
    acknowledgement = await original.reply({
      embeds: [systemEmbed(job, "Cameo follow-up provisioning")],
      nonce: job.source.messageId,
      enforceNonce: true,
      ...mentionReplyOptions
    });
    job = store.setDiscordAcknowledgement(job.id, acknowledgement.id, claimToken);
  }
  return store.setFollowupQueued(job.id, claimToken);
}

export function createMentionHandler(config, store, client) {
  return async message => {
    const inBaseChannel = message.channelId === config.channelId;
    const inCandidateThread = Boolean(message.channel?.isThread?.() && message.channel.parentId === config.channelId);
    if (message.guildId !== config.guildId || (!inBaseChannel && !inCandidateThread))
      return;
    if (!message.author || message.author.bot || message.webhookId || message.applicationId || message.system
      || message.editedTimestamp || (message.messageSnapshots?.size ?? 0) > 0)
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
      if (parsed.kind === "github_task_control" && !inCandidateThread) {
        if (store.allowRateLimitNotice(message.author.id, 10))
          await replyWithoutMentions(message, "Use this trusted-developer control inside the registered task thread whose PR should be changed.");
        return;
      }
      if ((message.attachments?.size ?? 0) > 0) {
        if (store.allowRateLimitNotice(message.author.id, 10))
          await replyWithoutMentions(message, "Attachment ingestion is not enabled. Submit a text-only task, or make the required evidence available in the repository first.");
        return;
      }

      if (inCandidateThread) {
        const root = store.getRootByThreadId(message.channelId);
        if (!root) {
          if (store.allowRateLimitNotice(message.author.id, 10))
            await replyWithoutMentions(message, "This is not a registered Cameo Dispatcher job thread. Start unrelated work in #agent-office.");
          return;
        }
        if (parsed.kind === "github_task_control") {
          const action = store.createGithubAction({
            interactionId: message.id,
            rootJobId: root.id,
            requesterDiscordId: message.author.id,
            requesterName: message.member?.displayName || message.author.globalName || message.author.username,
            action: parsed.action,
            requestedPrNumber: parsed.requestedPrNumber,
            repository: "cameo-mod/Cameo-mod",
            mergeMethod: "merge",
            discordThreadId: message.channelId
          });
          if (action.createDisposition === "new")
            await message.reply({ embeds: [githubActionEmbed(action, "Trusted GitHub control queued")], ...mentionReplyOptions });
          return;
        }

        let followup = store.createFollowup({
          requestId: `discord-followup-${message.id}`,
          requesterDiscordId: message.author.id,
          requesterName: message.member?.displayName || message.author.globalName || message.author.username,
          objective: parsed.objective,
          acceptanceCriteria: [...defaultMentionAcceptance],
          scope: root.scope,
          ...chooseRunPolicy(parsed.objective),
          parentJobId: root.id,
          source: {
            kind: "followup",
            guildId: message.guildId,
            channelId: message.channelId,
            messageId: message.id
          }
        });
        if (followup.state !== "provisioning")
          return;
        const followupClaim = randomUUID();
        if (!store.claimProvisioning(followup.id, followupClaim))
          return;
        try {
          followup = await provisionFollowupJob({ store, client, job: followup, claimToken: followupClaim, sourceMessage: message });
        } catch (error) {
          store.failProvisioning(followup.id, error.message, followupClaim);
          throw error;
        }
        return;
      }

      let job = store.createConversational({
        requestId: `discord-message-${message.id}`,
        requesterDiscordId: message.author.id,
        requesterName: message.member?.displayName || message.author.globalName || message.author.username,
        objective: parsed.objective,
        acceptanceCriteria: [...defaultMentionAcceptance],
        scope: [],
        ...chooseRunPolicy(parsed.objective),
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
      if (current.source?.kind === "followup")
        await provisionFollowupJob({ store, client, job: current, claimToken: provisioningClaim });
      else
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
    content: `[${identity.owner}/${identity.tool}] ${job.state}: ${job.parentJobId ?? job.id} · run ${job.runRevision ?? 1}`,
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

      if (interaction.commandName === "cameo-model") {
        if (!config.adminUserIds.has(interaction.user.id)) {
          await interaction.reply({ content: "Only a dispatcher owner can select a model explicitly.", ephemeral: true });
          return;
        }
        if (!interaction.channel?.isThread() || interaction.channel.parentId !== config.channelId) {
          await interaction.reply({ content: "Use /cameo-model inside a registered Cameo job thread.", ephemeral: true });
          return;
        }
        const root = store.getRootByThreadId(interaction.channelId);
        if (!root) {
          await interaction.reply({ content: "This is not a registered Cameo Dispatcher job thread.", ephemeral: true });
          return;
        }
        const model = interaction.options.getString("model", true);
        const effort = interaction.options.getString("effort", true);
        const updated = store.setNextRunModel(root.id, model, effort);
        const target = updated.modelTarget === "queued_run"
          ? `queued run ${updated.runRevision}`
          : "the next submitted follow-up";
        await interaction.reply({
          content: `${target}: ${model} at ${effort} effort. An already-running turn is unchanged.`,
          ephemeral: true,
          allowedMentions: { parse: [] }
        });
        return;
      }

      if (interaction.commandName === "cameo-github") {
        const subcommand = interaction.options.getSubcommand(true);
        const common = {
          interactionId: interaction.id,
          requesterDiscordId: interaction.user.id,
          requesterName: interaction.user.globalName || interaction.user.username,
          action: subcommand,
          repository: "cameo-mod/Cameo-mod",
          discordThreadId: interaction.channelId
        };
        const action = subcommand === "open"
          ? store.createGithubAction({
            ...common,
            headBranch: interaction.options.getString("head", true),
            baseBranch: interaction.options.getString("base", true),
            title: interaction.options.getString("title", true),
            draft: interaction.options.getBoolean("draft") ?? true
          })
          : store.createGithubAction({
            ...common,
            prNumber: interaction.options.getInteger("pr", true),
            expectedHeadSha: interaction.options.getString("expected-head", true),
            headOwner: interaction.options.getString("head-owner", true),
            headBranch: interaction.options.getString("head-branch", true),
            baseBranch: interaction.options.getString("base-branch", true),
            mergeMethod: subcommand === "merge" ? interaction.options.getString("method") ?? "merge" : null
          });
        await interaction.reply({ embeds: [githubActionEmbed(action, "Trusted GitHub control queued")], ephemeral: true, allowedMentions: { parse: [] } });
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
        const explicitModel = interaction.options.getString("model");
        const explicitEffort = interaction.options.getString("effort");
        const explicitMode = interaction.options.getString("mode");
        if ((explicitModel || explicitEffort || explicitMode) && !config.adminUserIds.has(interaction.user.id))
          throw new AdmissionError("owner_policy_only", "Only a dispatcher owner can override model, effort, or execution mode.");
        const runPolicy = chooseRunPolicy(objective, {
          model: explicitModel ?? undefined,
          effort: explicitEffort ?? undefined,
          executionMode: explicitMode ?? undefined
        });
        let job = createSlashJob(store, interaction, objective, acceptance, runPolicy);
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
      const job = store.getStatusRun(jobId);
      if (!job) {
        await interaction.reply({ content: "Job not found.", ephemeral: true });
        return;
      }

      if (interaction.commandName === "cameo-status") {
        await interaction.reply({ embeds: [systemEmbed(job, "Cameo task status")], ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }

      if (interaction.commandName === "cameo-cancel") {
        const cancelled = store.cancelCurrent(jobId, interaction.user.id, true);
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
          .setTitle(`${job.parentJobId ?? job.id} · run ${job.runRevision ?? 1} · ${job.state}`)
          .setDescription(resultSummary(job))
          .addFields(resultFields(job))
          .setFooter({ text: "via Cameo Dispatcher" })
          .setTimestamp(new Date(job.updatedAt))],
        allowedMentions: { parse: [] }
      });
      return message.id;
    },
    async publishGithubAction(action) {
      const channel = await client.channels.fetch(action.discordThreadId);
      const message = await channel.send({
        embeds: [githubActionEmbed(action, `GitHub control ${action.state}`)],
        allowedMentions: { parse: [] }
      });
      return message.id;
    }
  };
}
