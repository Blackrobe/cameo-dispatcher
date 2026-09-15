import { extractReferencedPullRequests } from "./github-context.mjs";

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

export function buildGithubDiscoveryReferences(job, rootJob = null, publication = null, maximum = 3) {
  const references = extractReferencedPullRequests(job, maximum);
  const add = number => {
    if (Number.isInteger(number) && number > 0 && number <= 9_999_999 && !references.includes(number) && references.length < maximum)
      references.push(number);
  };
  if (job.runKind === "followup" && publication?.state === "published") {
    const match = String(publication.prUrl ?? "").match(/^https:\/\/github\.com\/cameo-mod\/Cameo-mod\/pull\/(\d+)$/i);
    if (match)
      add(Number(match[1]));
  }
  if (job.runKind === "followup" && rootJob?.requestId === job.rootRequestId && typeof rootJob.objective === "string") {
    for (const number of extractReferencedPullRequests(rootJob, maximum))
      add(number);
  }
  return references;
}

function boundedText(value, fallback, maxBytes) {
  const text = typeof value === "string" ? value : fallback;
  if (Buffer.byteLength(text, "utf8") <= maxBytes)
    return text;
  const suffix = "… [truncated]";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  let output = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget)
      break;
    output += character;
    bytes += size;
  }
  return `${output}${suffix}`;
}

function boundedList(value, maxItems, maxLength) {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map(item => boundedText(item, String(item ?? ""), maxLength))
    : [];
}

export function compactFinalResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new Error("terminal worker result is invalid");
  return {
    status: new Set(["completed", "needs_attention", "blocked"]).has(result.status) ? result.status : "needs_attention",
    summary: boundedText(result.summary, "No result summary was provided.", 8000),
    changedFiles: boundedList(result.changedFiles, 100, 300),
    validation: boundedList(result.validation, 20, 1000),
    risks: boundedList(result.risks, 20, 1000),
    nextAction: result.nextAction === null ? null : boundedText(result.nextAction, "Review the retained job evidence.", 8000)
  };
}

function compactReviewer(reviewer) {
  if (reviewer === null || typeof reviewer !== "object" || Array.isArray(reviewer))
    return null;
  return {
    verdict: boundedText(reviewer.verdict, "unknown", 100),
    summary: boundedText(reviewer.summary, "No reviewer summary.", 2000),
    findings: boundedList(reviewer.findings, 10, 500),
    validationGaps: boundedList(reviewer.validationGaps, 10, 500),
    model: boundedText(reviewer.model, "unknown", 100),
    reasoningEffort: boundedText(reviewer.reasoningEffort, "unknown", 50),
    reason: boundedText(reviewer.reason, "unknown", 200)
  };
}

function compactPublication(publication) {
  if (publication === null || typeof publication !== "object" || Array.isArray(publication))
    return null;
  return {
    state: boundedText(publication.state, "unknown", 50),
    branch: boundedText(publication.branch, "unknown", 300),
    lastCommit: boundedText(publication.lastCommit, "unknown", 100),
    prUrl: boundedText(publication.prUrl, "unknown", 500),
    candidateHash: boundedText(publication.candidateHash, "unknown", 100)
  };
}

function fitCompletionPayload(payload, maxBytes = 120 * 1024) {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= maxBytes)
    return payload;
  const result = payload.result && typeof payload.result === "object" ? payload.result : {};
  const fallback = {
    state: payload.state,
    result: {
      status: result.status ?? "needs_attention",
      summary: boundedText(result.summary, "Result exceeded the transport limit; inspect retained local evidence.", 4000),
      changedFiles: boundedList(result.changedFiles, 20, 200),
      validation: boundedList(result.validation, 10, 500),
      risks: boundedList(result.risks, 10, 500),
      nextAction: result.nextAction === null ? null : boundedText(result.nextAction, "Inspect retained local evidence.", 2000),
      provenance: result.provenance ?? null
    },
    error: payload.error ? boundedText(payload.error, "worker error", 2000) : null
  };
  if (Buffer.byteLength(JSON.stringify(fallback), "utf8") > maxBytes)
    throw new Error("completion payload could not be reduced below the transport limit");
  return fallback;
}

export function buildCompletion(status, finalResult) {
  if (status.state === "ready_for_review" || status.state === "needs_attention") {
    if (finalResult === null || typeof finalResult !== "object")
      throw new Error("terminal worker status is missing its final result");
    const compact = compactFinalResult(finalResult);
    return fitCompletionPayload({
      state: status.state,
      result: {
        ...compact,
        provenance: {
          codexThreadId: status.codexThreadId ?? null,
          baseCommit: status.baseCommit ?? null,
          runRevision: status.runRevision ?? 1,
          parentJobId: status.parentJobId ?? null,
          executionMode: status.executionMode ?? null,
          model: status.model ?? null,
          reasoningEffort: status.reasoningEffort ?? null,
          modelSource: status.modelSource ?? null,
          reviewer: compactReviewer(status.reviewer),
          publication: compactPublication(status.publication)
        }
      },
      error: status.resultMappingError ? boundedText(status.resultMappingError, "worker result mapping failed", 4000) : null
    });
  }

  return fitCompletionPayload({
    state: "failed",
    result: finalResult && typeof finalResult === "object" ? compactFinalResult(finalResult) : null,
    error: boundedText(status.error ?? status.resultMappingError ?? `local worker ended in ${status.state}`, "local worker failed", 4000)
  });
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
