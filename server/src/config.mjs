function required(name) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required`);
  return value;
}

function parseCsv(value) {
  return new Set((value ?? "").split(",").map(item => item.trim()).filter(Boolean));
}

function parseIdentity(value) {
  const identity = JSON.parse(value);
  for (const field of ["owner", "provider", "tool", "displayName"])
    if (typeof identity[field] !== "string" || identity[field].trim() === "")
      throw new Error(`RUNNER_IDENTITY_JSON.${field} is required`);

  const color = Number(identity.color ?? 0x3498db);
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff)
    throw new Error("RUNNER_IDENTITY_JSON.color must be a Discord RGB integer");

  return Object.freeze({
    owner: identity.owner.trim(),
    provider: identity.provider.trim(),
    tool: identity.tool.trim(),
    displayName: identity.displayName.trim(),
    avatarUrl: typeof identity.avatarUrl === "string" ? identity.avatarUrl.trim() : "",
    color
  });
}

export function loadConfig() {
  const port = Number(process.env.LISTEN_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("LISTEN_PORT must be a valid TCP port");
  const jobLeaseSeconds = Number(process.env.JOB_LEASE_SECONDS ?? 14400);
  if (!Number.isInteger(jobLeaseSeconds) || jobLeaseSeconds < 600 || jobLeaseSeconds > 14400)
    throw new Error("JOB_LEASE_SECONDS must be an integer between 600 and 14400");

  const allowedUserIds = parseCsv(process.env.DISCORD_ALLOWED_USER_IDS);
  if (allowedUserIds.size === 0)
    throw new Error("DISCORD_ALLOWED_USER_IDS must contain at least one Discord user ID");
  const adminUserIds = parseCsv(process.env.DISCORD_ADMIN_USER_IDS);
  if (adminUserIds.size === 0)
    throw new Error("DISCORD_ADMIN_USER_IDS must contain at least one Discord user ID");
  if ([...adminUserIds].some(id => !allowedUserIds.has(id)))
    throw new Error("DISCORD_ADMIN_USER_IDS must be a subset of DISCORD_ALLOWED_USER_IDS");

  return Object.freeze({
    discordToken: required("DISCORD_TOKEN"),
    applicationId: required("DISCORD_APPLICATION_ID"),
    guildId: required("DISCORD_GUILD_ID"),
    channelId: required("DISCORD_CHANNEL_ID"),
    allowedUserIds,
    adminUserIds,
    agentWebhookUrl: process.env.DISCORD_AGENT_WEBHOOK_URL?.trim() || null,
    runnerToken: required("RUNNER_TOKEN"),
    runnerId: process.env.RUNNER_ID?.trim() || "blackrobe-windows-1",
    runnerIdentity: parseIdentity(required("RUNNER_IDENTITY_JSON")),
    databasePath: process.env.DATABASE_PATH?.trim() || "/data/dispatcher.sqlite",
    listenHost: process.env.LISTEN_HOST?.trim() || "0.0.0.0",
    listenPort: port,
    jobLeaseSeconds
  });
}
