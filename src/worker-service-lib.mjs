export function normalizeServerJob(job) {
  if (job === null || typeof job !== "object" || Array.isArray(job))
    throw new Error("dispatcher returned an invalid job");

  return {
    requestId: job.requestId,
    requestedBy: {
      human: job.requesterName,
      tool: "Cameo Dispatcher"
    },
    objective: job.objective,
    acceptanceCriteria: job.acceptanceCriteria,
    scope: job.scope
  };
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
          baseCommit: status.baseCommit ?? null
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
    "DISCORD_TOKEN",
    "DISCORD_AGENT_WEBHOOK_URL",
    "CLOUDFLARE_API_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY"
  ])
    delete sanitized[name];
  return sanitized;
}
