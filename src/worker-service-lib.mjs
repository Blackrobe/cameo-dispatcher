export function normalizeServerJob(job) {
  if (job === null || typeof job !== "object" || Array.isArray(job))
    throw new Error("dispatcher returned an invalid job");

  const normalized = {
    requestId: job.requestId,
    requestedBy: {
      human: job.requesterName,
      tool: "Cameo Dispatcher"
    },
    objective: job.objective,
    acceptanceCriteria: job.acceptanceCriteria,
    scope: job.scope,
    executionMode: job.executionMode,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
    modelSource: job.modelSource
  };
  if (job.runKind === "followup") {
    normalized.runKind = "followup";
    normalized.parentJobId = job.parentJobId;
    normalized.rootRequestId = job.rootRequestId;
    normalized.runRevision = job.runRevision;
    normalized.resumeSessionId = job.resumeSessionId;
  }
  return normalized;
}

export function buildCompletion(status, finalResult) {
  if (status.state === "ready_for_review" || status.state === "needs_attention") {
    if (finalResult === null || typeof finalResult !== "object")
      throw new Error("terminal worker status is missing its final result");
    return {
      state: status.state,
      result: {
        ...finalResult,
        provenance: {
          codexThreadId: status.codexThreadId ?? null,
          baseCommit: status.baseCommit ?? null,
          runRevision: status.runRevision ?? 1,
          parentJobId: status.parentJobId ?? null
          ,executionMode: status.executionMode ?? null
          ,model: status.model ?? null
          ,reasoningEffort: status.reasoningEffort ?? null
          ,modelSource: status.modelSource ?? null
          ,reviewer: status.reviewer ?? null
          ,publication: status.publication ?? null
        }
      },
      error: status.resultMappingError ?? null
    };
  }

  return {
    state: "failed",
    result: finalResult,
    error: status.error ?? status.resultMappingError ?? `local worker ended in ${status.state}`
  };
}

export function sanitizeWorkerEnvironment(environment) {
  const sanitized = { ...environment };
  for (const name of [
    "CAMEO_RUNNER_TOKEN",
    "CAMEO_DISPATCHER_URL",
    "CAMEO_SSH_DESTINATION",
    "CAMEO_TUNNEL_LOCAL_PORT",
    "CAMEO_TUNNEL_REMOTE_HOST",
    "CAMEO_TUNNEL_REMOTE_PORT",
    "DISCORD_TOKEN",
    "DISCORD_AGENT_WEBHOOK_URL",
    "CLOUDFLARE_API_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_PAT",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AZURE_CLIENT_SECRET",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OCI_CLI_AUTH",
    "OCI_CLI_KEY_FILE",
    "NPM_TOKEN"
  ])
    delete sanitized[name];
  return sanitized;
}
