import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const terminalStates = new Set(["ready_for_review", "needs_attention", "failed", "cancelled"]);
const requestIdPattern = /^[a-z0-9][a-z0-9._-]{2,127}$/i;
const branchNamePattern = /^(?!\/)(?!.*\.\.)(?!.*[~^:?*\[\\\s])(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,200}$/;

function extractTaskPrNumbers(text, maximum = 3) {
  const numbers = [];
  const add = raw => {
    const number = Number(raw);
    if (Number.isInteger(number) && number > 0 && number <= 9_999_999 && !numbers.includes(number) && numbers.length < maximum)
      numbers.push(number);
  };
  for (const match of String(text ?? "").matchAll(/https:\/\/github\.com\/cameo-mod\/Cameo-mod\/pull\/(\d+)(?![A-Za-z0-9])/gi))
    add(match[1]);
  const withoutUrls = String(text ?? "").replace(/https?:\/\/[^\s<>()]+/gi, " ");
  for (const match of withoutUrls.matchAll(/\bPR\s*#?\s*(\d{1,7})\b/gi))
    add(match[1]);
  return numbers;
}

function now() {
  return new Date().toISOString();
}

function leaseDeadline(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function parseJob(row) {
  if (!row)
    return null;

  return {
    id: row.id,
    parentJobId: row.parent_job_id ?? null,
    runKind: row.parent_job_id ? "followup" : "root",
    rootRequestId: row.root_request_id ?? row.request_id,
    runRevision: row.run_revision ?? 1,
    resumeSessionId: row.resume_session_id ?? null,
    executionMode: row.execution_mode ?? "read_only",
    model: row.model ?? "gpt-5.6-sol",
    reasoningEffort: row.reasoning_effort ?? "high",
    modelSource: row.model_source ?? "legacy_default",
    nextModel: row.next_model ?? null,
    nextReasoningEffort: row.next_reasoning_effort ?? null,
    requestId: row.request_id,
    requesterDiscordId: row.requester_discord_id,
    requesterName: row.requester_name,
    objective: row.objective,
    acceptanceCriteria: JSON.parse(row.acceptance_json),
    scope: JSON.parse(row.scope_json),
    state: row.state,
    discordThreadId: row.discord_thread_id,
    runnerId: row.runner_id,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    completedAt: row.completed_at,
    deliveryState: row.delivery_state,
    deliveryRevision: row.delivery_revision,
    deliveryAttempts: row.delivery_attempts,
    deliveryLastError: row.delivery_last_error,
    deliveryNextAt: row.delivery_next_at,
    discordMessageId: row.discord_message_id,
    discordAcknowledgementId: row.discord_ack_message_id,
    source: row.source_message_id ? {
      kind: row.source_kind,
      guildId: row.source_guild_id,
      channelId: row.source_channel_id,
      messageId: row.source_message_id
    } : null
  };
}

function parseGithubAction(row) {
  if (!row)
    return null;
  return {
    id: row.id,
    runKind: "github_action",
    interactionId: row.interaction_id,
    rootJobId: row.root_job_id ?? null,
    requesterDiscordId: row.requester_discord_id,
    requesterName: row.requester_name,
    action: row.action,
    repository: row.repository,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    expectedHeadSha: row.expected_head_sha,
    headOwner: row.head_owner,
    headBranch: row.head_branch,
    baseBranch: row.base_branch,
    title: row.title,
    draft: Boolean(row.draft),
    mergeMethod: row.merge_method,
    state: row.state,
    discordThreadId: row.discord_thread_id,
    runnerId: row.runner_id,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    completedAt: row.completed_at,
    deliveryState: row.delivery_state,
    deliveryRevision: row.delivery_revision,
    deliveryAttempts: row.delivery_attempts,
    deliveryLastError: row.delivery_last_error,
    deliveryNextAt: row.delivery_next_at,
    discordMessageId: row.discord_message_id
  };
}

function validateCreateInput(input) {
  if (!requestIdPattern.test(input.requestId ?? ""))
    throw new Error("requestId is invalid");
  if (typeof input.requesterDiscordId !== "string" || !/^\d{5,30}$/.test(input.requesterDiscordId))
    throw new Error("requesterDiscordId is invalid");
  if (typeof input.requesterName !== "string" || !input.requesterName.trim() || input.requesterName.length > 100)
    throw new Error("requesterName is invalid");
  if (typeof input.objective !== "string" || !input.objective.trim() || input.objective.length > 4000)
    throw new Error("objective is invalid");
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length < 1 || input.acceptanceCriteria.length > 20)
    throw new Error("acceptanceCriteria must contain between 1 and 20 entries");
  if (input.acceptanceCriteria.some(value => typeof value !== "string" || !value.trim() || value.length > 1000))
    throw new Error("acceptanceCriteria contains an invalid entry");
  if (!Array.isArray(input.scope) || input.scope.length > 100)
    throw new Error("scope is invalid");
  if (input.scope.some(value => typeof value !== "string" || !value.trim() || value.includes("..") || path.isAbsolute(value)))
    throw new Error("scope must contain safe repository-relative paths");
  if (input.source !== undefined && input.source !== null) {
    if (typeof input.source !== "object" || Array.isArray(input.source))
      throw new Error("source is invalid");
    if (!new Set(["slash", "mention", "followup"]).has(input.source.kind))
      throw new Error("source.kind is invalid");
    for (const field of ["guildId", "channelId", "messageId"]) {
      if (typeof input.source[field] !== "string" || !/^\d{5,30}$/.test(input.source[field]))
        throw new Error(`source.${field} is invalid`);
    }
  }
  if (!new Set(["read_only", "draft_pr"]).has(input.executionMode ?? "read_only"))
    throw new Error("executionMode is invalid");
  if (!new Set(["gpt-5.6-sol", "gpt-6-astra"]).has(input.model ?? "gpt-5.6-sol"))
    throw new Error("model is invalid");
  if (!new Set(["high", "max"]).has(input.reasoningEffort ?? "high"))
    throw new Error("reasoningEffort is invalid");
}

export class AdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdmissionError";
    this.code = code;
  }
}

export class JobStore {
  constructor(databasePath) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        requester_discord_id TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        objective TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        state TEXT NOT NULL,
        discord_thread_id TEXT,
        runner_id TEXT,
        heartbeat_at TEXT,
        lease_expires_at TEXT,
        result_json TEXT,
        error TEXT,
        delivery_state TEXT NOT NULL DEFAULT 'not_ready',
        delivery_revision INTEGER NOT NULL DEFAULT 0,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        delivery_last_error TEXT,
        delivery_next_at TEXT,
        discord_message_id TEXT,
        discord_ack_message_id TEXT,
        source_kind TEXT,
        source_guild_id TEXT,
        source_channel_id TEXT,
        source_message_id TEXT,
        parent_job_id TEXT REFERENCES jobs(id),
        root_request_id TEXT,
        run_revision INTEGER NOT NULL DEFAULT 1,
        resume_session_id TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'read_only',
        model TEXT NOT NULL DEFAULT 'gpt-5.6-sol',
        reasoning_effort TEXT NOT NULL DEFAULT 'high',
        model_source TEXT NOT NULL DEFAULT 'legacy_default',
        next_model TEXT,
        next_reasoning_effort TEXT,
        provisioning_claim TEXT,
        provisioning_claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_state_created_idx ON jobs(state, created_at);
      CREATE TABLE IF NOT EXISTS control_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        paused INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_presence (
        runner_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        current_job_id TEXT,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limit_notices (
        requester_discord_id TEXT PRIMARY KEY,
        last_notified_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_actions (
        id TEXT PRIMARY KEY,
        interaction_id TEXT NOT NULL UNIQUE,
        root_job_id TEXT REFERENCES jobs(id),
        requester_discord_id TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        action TEXT NOT NULL,
        repository TEXT NOT NULL,
        pr_number INTEGER,
        pr_url TEXT,
        expected_head_sha TEXT,
        head_owner TEXT,
        head_branch TEXT,
        base_branch TEXT,
        title TEXT,
        draft INTEGER NOT NULL DEFAULT 1,
        merge_method TEXT,
        state TEXT NOT NULL,
        discord_thread_id TEXT NOT NULL,
        runner_id TEXT,
        lease_expires_at TEXT,
        result_json TEXT,
        error TEXT,
        delivery_state TEXT NOT NULL DEFAULT 'not_ready',
        delivery_revision INTEGER NOT NULL DEFAULT 0,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        delivery_last_error TEXT,
        delivery_next_at TEXT,
        discord_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS github_actions_state_created_idx ON github_actions(state, created_at);
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO control_state (id, paused, updated_at, updated_by)
      VALUES (1, 0, ?, 'bootstrap')
    `).run(now());

    const jobColumns = new Set(this.db.prepare("PRAGMA table_info(jobs)").all().map(row => row.name));
    for (const [name, definition] of [
      ["source_kind", "TEXT"],
      ["source_guild_id", "TEXT"],
      ["source_channel_id", "TEXT"],
      ["source_message_id", "TEXT"],
      ["parent_job_id", "TEXT"],
      ["root_request_id", "TEXT"],
      ["run_revision", "INTEGER NOT NULL DEFAULT 1"],
      ["resume_session_id", "TEXT"],
      ["execution_mode", "TEXT NOT NULL DEFAULT 'read_only'"],
      ["model", "TEXT NOT NULL DEFAULT 'gpt-5.6-sol'"],
      ["reasoning_effort", "TEXT NOT NULL DEFAULT 'high'"],
      ["model_source", "TEXT NOT NULL DEFAULT 'legacy_default'"],
      ["next_model", "TEXT"],
      ["next_reasoning_effort", "TEXT"],
      ["discord_ack_message_id", "TEXT"],
      ["provisioning_claim", "TEXT"],
      ["provisioning_claimed_at", "TEXT"]
    ]) {
      if (!jobColumns.has(name))
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_followup_revision_idx
        ON jobs(parent_job_id, run_revision) WHERE parent_job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_discord_thread_idx ON jobs(discord_thread_id);
    `);
    const actionColumns = new Set(this.db.prepare("PRAGMA table_info(github_actions)").all().map(row => row.name));
    if (!actionColumns.has("head_owner"))
      this.db.exec("ALTER TABLE github_actions ADD COLUMN head_owner TEXT");
  }

  createGithubAction(input) {
    if (!/^[0-9]{5,30}$/.test(input.interactionId ?? ""))
      throw new Error("GitHub action interaction ID is invalid");
    if (!/^[0-9]{5,30}$/.test(input.requesterDiscordId ?? "") || typeof input.requesterName !== "string" || !input.requesterName.trim())
      throw new Error("GitHub action requester is invalid");
    if (!new Set(["open", "close", "merge"]).has(input.action))
      throw new Error("GitHub action is invalid");
    if (input.repository !== "cameo-mod/Cameo-mod")
      throw new Error("GitHub action repository is not allowlisted");
    if (typeof input.discordThreadId !== "string" || !/^[0-9]{5,30}$/.test(input.discordThreadId))
      throw new Error("GitHub action Discord destination is invalid");
    const existingInteraction = this.getGithubActionByInteractionId(input.interactionId);
    if (existingInteraction)
      return { ...existingInteraction, createDisposition: "existing" };

    let resolved = { ...input };
    if (input.rootJobId) {
      const root = this.get(input.rootJobId);
      if (!root || root.parentJobId)
        throw new Error("GitHub action root job is unavailable");
      const published = this.getLatestRun(root.id);
      const publication = published?.result?.provenance?.publication;
      if (!published || !new Set(["ready_for_review", "needs_attention"]).has(published.state) || published.deliveryState !== "delivered")
        throw new Error("The latest task run must be completed and delivered before controlling its PR");
      const publicationMatch = String(publication?.prUrl ?? "").match(/^https:\/\/github\.com\/cameo-mod\/Cameo-mod\/pull\/(\d+)$/i);
      const publicationIsBound = publicationMatch && /^[0-9a-f]{40}$/i.test(publication.lastCommit ?? "")
        && branchNamePattern.test(publication.branch ?? "");
      const rootReferences = extractTaskPrNumbers(root.objective);
      const requested = input.requestedPrNumber;
      if (requested !== undefined && requested !== null && (!Number.isInteger(requested) || requested < 1 || requested > 9_999_999))
        throw new AdmissionError("github_pr_invalid", "The requested PR number is invalid.");
      if (publicationIsBound && requested !== undefined && requested !== null && requested !== Number(publicationMatch[1]))
        throw new AdmissionError("github_pr_mismatch", `This task thread owns PR #${publicationMatch[1]}, not PR #${requested}.`);
      if (!publicationIsBound && requested !== undefined && requested !== null
        && rootReferences.length === 1 && requested !== rootReferences[0])
        throw new AdmissionError("github_pr_mismatch", `This task thread references PR #${rootReferences[0]}, not PR #${requested}.`);
      if (!publicationIsBound && (requested === undefined || requested === null) && rootReferences.length !== 1)
        throw new AdmissionError("github_pr_ambiguous", "Name one PR number because this task thread does not own exactly one published PR.");
      const prNumber = publicationIsBound ? Number(publicationMatch[1]) : requested ?? rootReferences[0];
      resolved = publicationIsBound ? {
        ...resolved,
        prNumber,
        prUrl: publication.prUrl,
        expectedHeadSha: publication.lastCommit,
        headOwner: "Blackrobe",
        headBranch: publication.branch,
        baseBranch: "master",
        discordThreadId: root.discordThreadId
      } : {
        ...resolved,
        prNumber,
        prUrl: `https://github.com/cameo-mod/Cameo-mod/pull/${prNumber}`,
        expectedHeadSha: null,
        headOwner: null,
        headBranch: null,
        baseBranch: null,
        discordThreadId: root.discordThreadId
      };
    }

    if (["close", "merge"].includes(resolved.action)) {
      if (!Number.isInteger(resolved.prNumber) || resolved.prNumber < 1 || resolved.prNumber > 9_999_999)
        throw new Error("GitHub action PR number is invalid");
      const identitySupplied = [resolved.expectedHeadSha, resolved.headOwner, resolved.headBranch, resolved.baseBranch].some(Boolean);
      if (identitySupplied && (!/^[0-9a-f]{40}$/i.test(resolved.expectedHeadSha ?? "")
        || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(resolved.headOwner ?? "")
        || !branchNamePattern.test(resolved.headBranch ?? "") || !branchNamePattern.test(resolved.baseBranch ?? "")))
        throw new Error("GitHub action expected PR identity is invalid");
      if (!identitySupplied && !resolved.rootJobId)
        throw new Error("Generic GitHub actions require an exact expected PR identity");
    }
    if (resolved.action === "merge" && !new Set(["merge", "squash", "rebase"]).has(resolved.mergeMethod ?? "merge"))
      throw new Error("GitHub merge method is invalid");
    if (resolved.action === "open") {
      if (!branchNamePattern.test(resolved.headBranch ?? "") || !branchNamePattern.test(resolved.baseBranch ?? "") || resolved.headBranch === resolved.baseBranch)
        throw new Error("GitHub action branches are invalid");
      if (typeof resolved.title !== "string" || !resolved.title.trim() || resolved.title.length > 200)
        throw new Error("GitHub action title is invalid");
    }

    const conflicting = resolved.action === "open"
      ? this.db.prepare("SELECT id FROM github_actions WHERE repository = ? AND head_branch = ? AND base_branch = ? AND state IN ('queued', 'running') LIMIT 1")
        .get(resolved.repository, resolved.headBranch, resolved.baseBranch)
      : this.db.prepare("SELECT id FROM github_actions WHERE repository = ? AND pr_number = ? AND state IN ('queued', 'running') LIMIT 1")
        .get(resolved.repository, resolved.prNumber);
    if (conflicting)
      throw new Error(`A GitHub control for the same target is already active: ${conflicting.id}`);

    const timestamp = now();
    const id = `CGA-${timestamp.slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    try {
      this.db.prepare(`
        INSERT INTO github_actions (
          id, interaction_id, root_job_id, requester_discord_id, requester_name,
          action, repository, pr_number, pr_url, expected_head_sha, head_owner, head_branch,
          base_branch, title, draft, merge_method, state, discord_thread_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(
        id, resolved.interactionId, resolved.rootJobId ?? null,
        resolved.requesterDiscordId, resolved.requesterName.trim(), resolved.action,
        resolved.repository, resolved.prNumber ?? null, resolved.prUrl ?? null,
        resolved.expectedHeadSha ?? null, resolved.headOwner ?? null, resolved.headBranch ?? null,
        resolved.baseBranch ?? null, resolved.title?.trim() ?? null,
        resolved.draft === false ? 0 : 1, resolved.mergeMethod ?? "merge",
        resolved.discordThreadId, timestamp, timestamp
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed: github_actions.interaction_id"))
        return { ...this.getGithubActionByInteractionId(resolved.interactionId), createDisposition: "existing" };
      throw error;
    }
    return { ...this.getGithubAction(id), createDisposition: "new" };
  }

  getGithubAction(id) {
    return parseGithubAction(this.db.prepare("SELECT * FROM github_actions WHERE id = ?").get(id));
  }

  getGithubActionByInteractionId(interactionId) {
    return parseGithubAction(this.db.prepare("SELECT * FROM github_actions WHERE interaction_id = ?").get(interactionId));
  }

  claimGithubAction(runnerId, leaseSeconds = 300) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const runningJob = this.db.prepare("SELECT id FROM jobs WHERE state = 'running' LIMIT 1").get();
      if (runningJob) {
        this.db.exec("COMMIT");
        return null;
      }
      const running = this.db.prepare("SELECT * FROM github_actions WHERE state = 'running' ORDER BY claimed_at LIMIT 1").get();
      if (running) {
        const parsed = parseGithubAction(running);
        if (parsed.leaseExpiresAt && parsed.leaseExpiresAt <= now()) {
          const timestamp = now();
          this.db.prepare(`UPDATE github_actions SET state = 'needs_attention', error = ?, completed_at = ?, updated_at = ?, delivery_state = 'pending', delivery_revision = delivery_revision + 1, delivery_next_at = ? WHERE id = ? AND state = 'running'`)
            .run("Runner lease expired; reconcile GitHub state before retrying this action.", timestamp, timestamp, timestamp, parsed.id);
          this.db.exec("COMMIT");
          return null;
        }
        this.db.exec("COMMIT");
        return { ...parsed, claimDisposition: "existing_running" };
      }
      if (this.getControlState().paused) {
        this.db.exec("COMMIT");
        return null;
      }
      const row = this.db.prepare("SELECT id FROM github_actions WHERE state = 'queued' ORDER BY created_at LIMIT 1").get();
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const timestamp = now();
      this.db.prepare("UPDATE github_actions SET state = 'running', runner_id = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
        .run(runnerId, timestamp, leaseDeadline(leaseSeconds), timestamp, row.id);
      this.db.exec("COMMIT");
      return { ...this.getGithubAction(row.id), claimDisposition: "new" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeGithubAction(id, runnerId, state, result, error = null) {
    if (!new Set(["ready_for_review", "needs_attention", "failed"]).has(state))
      throw new Error("GitHub action result state is invalid");
    const action = this.getGithubAction(id);
    if (!action)
      return null;
    const recoverableExpiredClaim = action.state === "needs_attention" && action.result === null && action.runnerId === runnerId;
    if (["ready_for_review", "needs_attention", "failed"].includes(action.state) && action.runnerId === runnerId) {
      if (!recoverableExpiredClaim)
        return { ...action, completionDisposition: "existing" };
    }
    if (!recoverableExpiredClaim && (action.state !== "running" || action.runnerId !== runnerId))
      throw new Error("GitHub action is not owned by this runner");
    const timestamp = now();
    this.db.prepare(`UPDATE github_actions SET state = ?, result_json = ?, error = ?, completed_at = ?, updated_at = ?, delivery_state = 'pending', delivery_revision = delivery_revision + 1, delivery_attempts = 0, delivery_next_at = ?, delivery_last_error = NULL WHERE id = ?`)
      .run(state, result === null ? null : JSON.stringify(result), error, timestamp, timestamp, timestamp, id);
    return { ...this.getGithubAction(id), completionDisposition: "new" };
  }

  listPendingGithubActionDeliveries(limit = 10) {
    return this.db.prepare(`SELECT * FROM github_actions WHERE delivery_state IN ('pending', 'failed') AND (delivery_next_at IS NULL OR delivery_next_at <= ?) ORDER BY updated_at LIMIT ?`)
      .all(now(), limit).map(parseGithubAction);
  }

  markGithubActionDelivered(id, revision, messageId) {
    this.db.prepare("UPDATE github_actions SET delivery_state = 'delivered', discord_message_id = ?, delivery_last_error = NULL, delivery_next_at = NULL, updated_at = ? WHERE id = ? AND delivery_revision = ?")
      .run(messageId ?? null, now(), id, revision);
    return this.getGithubAction(id);
  }

  markGithubActionDeliveryFailed(id, revision, error, retryAfterMs = 10000) {
    const next = new Date(Date.now() + Math.max(1000, retryAfterMs)).toISOString();
    this.db.prepare("UPDATE github_actions SET delivery_state = 'failed', delivery_attempts = delivery_attempts + 1, delivery_last_error = ?, delivery_next_at = ?, updated_at = ? WHERE id = ? AND delivery_revision = ?")
      .run(String(error), next, now(), id, revision);
    return this.getGithubAction(id);
  }

  getControlState() {
    const row = this.db.prepare("SELECT paused, updated_at, updated_by FROM control_state WHERE id = 1").get();
    return {
      paused: Boolean(row.paused),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by
    };
  }

  setPaused(paused, updatedBy) {
    if (typeof paused !== "boolean")
      throw new Error("paused must be boolean");
    if (typeof updatedBy !== "string" || !updatedBy.trim())
      throw new Error("updatedBy is required");
    this.db.prepare("UPDATE control_state SET paused = ?, updated_at = ?, updated_by = ? WHERE id = 1")
      .run(paused ? 1 : 0, now(), updatedBy.trim());
    return this.getControlState();
  }

  recordRunnerPresence(runnerId, state, currentJobId = null) {
    if (typeof runnerId !== "string" || !runnerId.trim())
      throw new Error("runnerId is required");
    if (!new Set(["idle", "busy"]).has(state))
      throw new Error("runner presence state is invalid");
    this.db.prepare(`
      INSERT INTO runner_presence (runner_id, state, current_job_id, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(runner_id) DO UPDATE SET
        state = excluded.state,
        current_job_id = excluded.current_job_id,
        last_seen_at = excluded.last_seen_at
    `).run(runnerId.trim(), state, currentJobId, now());
    return this.getRunnerStatus(runnerId);
  }

  getRunnerStatus(runnerId, onlineWindowSeconds = 45) {
    const row = this.db.prepare("SELECT state, current_job_id, last_seen_at FROM runner_presence WHERE runner_id = ?")
      .get(runnerId);
    if (!row)
      return { online: false, state: "offline", currentJobId: null, lastSeenAt: null };
    const lastSeen = Date.parse(row.last_seen_at);
    const online = Number.isFinite(lastSeen) && Date.now() - lastSeen <= onlineWindowSeconds * 1000;
    if (!online && row.state === "busy" && row.current_job_id) {
      const active = this.db.prepare("SELECT lease_expires_at FROM jobs WHERE id = ? AND state = 'running'").get(row.current_job_id);
      if (active?.lease_expires_at && active.lease_expires_at > now())
        return {
          online: false, isolated: true, state: "busy-isolated",
          currentJobId: row.current_job_id, lastSeenAt: row.last_seen_at,
          leaseExpiresAt: active.lease_expires_at
        };
    }
    return {
      online,
      state: online ? row.state : "offline",
      currentJobId: row.current_job_id,
      lastSeenAt: row.last_seen_at
    };
  }

  allowRateLimitNotice(requesterDiscordId, windowSeconds = 60) {
    const row = this.db.prepare("SELECT last_notified_at FROM rate_limit_notices WHERE requester_discord_id = ?")
      .get(requesterDiscordId);
    const lastNotified = row ? Date.parse(row.last_notified_at) : Number.NaN;
    if (Number.isFinite(lastNotified) && Date.now() - lastNotified < windowSeconds * 1000)
      return false;
    this.db.prepare(`
      INSERT INTO rate_limit_notices (requester_discord_id, last_notified_at)
      VALUES (?, ?)
      ON CONFLICT(requester_discord_id) DO UPDATE SET last_notified_at = excluded.last_notified_at
    `).run(requesterDiscordId, now());
    return true;
  }

  create({
    requestId,
    requesterDiscordId,
    requesterName,
    objective,
    acceptanceCriteria = [],
    scope = [],
    source = null,
    parentJobId = null,
    rootRequestId = null,
    runRevision = 1,
    resumeSessionId = null,
    discordThreadId = null,
    executionMode = "read_only",
    model = "gpt-5.6-sol",
    reasoningEffort = "high",
    modelSource = "legacy_default"
  }) {
    validateCreateInput({ requestId, requesterDiscordId, requesterName, objective, acceptanceCriteria, scope, source, executionMode, model, reasoningEffort });
    const timestamp = now();
    const id = `CAM-${timestamp.slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const statement = this.db.prepare(`
      INSERT INTO jobs (
        id, request_id, requester_discord_id, requester_name, objective,
        acceptance_json, scope_json, state, source_kind, source_guild_id,
        source_channel_id, source_message_id, parent_job_id, root_request_id,
        run_revision, resume_session_id, execution_mode, model, reasoning_effort,
        model_source, discord_thread_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      statement.run(
        id,
        requestId,
        requesterDiscordId,
        requesterName,
        objective,
        JSON.stringify(acceptanceCriteria),
        JSON.stringify(scope),
        source?.kind ?? null,
        source?.guildId ?? null,
        source?.channelId ?? null,
        source?.messageId ?? null,
        parentJobId,
        rootRequestId ?? requestId,
        runRevision,
        resumeSessionId,
        executionMode,
        model,
        reasoningEffort,
        modelSource,
        discordThreadId,
        timestamp,
        timestamp
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed: jobs.request_id"))
        return { ...this.getByRequestId(requestId), createDisposition: "existing" };
      throw error;
    }

    return { ...this.get(id), createDisposition: "new" };
  }

  createConversational(input, policy = {}) {
    const limits = {
      globalOutstanding: policy.globalOutstanding ?? 5,
      perUserOutstanding: policy.perUserOutstanding ?? 2,
      perUserWindow: policy.perUserWindow ?? 3,
      windowSeconds: policy.windowSeconds ?? 600
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getByRequestId(input.requestId);
      if (existing) {
        this.db.exec("COMMIT");
        return { ...existing, createDisposition: "existing" };
      }

      const activeStates = ["provisioning", "queued", "running"];
      const placeholders = activeStates.map(() => "?").join(",");
      const globalOutstanding = this.db.prepare(`SELECT count(*) count FROM jobs WHERE state IN (${placeholders})`)
        .get(...activeStates).count;
      if (globalOutstanding >= limits.globalOutstanding)
        throw new AdmissionError("global_queue_full", "The dispatcher queue is full; try again after an existing job finishes.");

      const perUserOutstanding = this.db.prepare(`
        SELECT count(*) count FROM jobs
        WHERE requester_discord_id = ? AND state IN (${placeholders})
      `).get(input.requesterDiscordId, ...activeStates).count;
      if (perUserOutstanding >= limits.perUserOutstanding)
        throw new AdmissionError("user_queue_full", "You already have the maximum number of outstanding jobs.");

      const windowStart = new Date(Date.now() - limits.windowSeconds * 1000).toISOString();
      const recent = this.db.prepare("SELECT count(*) count FROM jobs WHERE requester_discord_id = ? AND created_at >= ?")
        .get(input.requesterDiscordId, windowStart).count;
      if (recent >= limits.perUserWindow)
        throw new AdmissionError("user_rate_limited", "You have submitted too many jobs recently; try again later.");

      const job = this.create(input);
      this.db.exec("COMMIT");
      return job;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRootByThreadId(threadId) {
    return parseJob(this.db.prepare(`
      SELECT * FROM jobs
      WHERE parent_job_id IS NULL AND discord_thread_id = ?
      ORDER BY created_at LIMIT 1
    `).get(threadId));
  }

  getLatestRun(rootJobId) {
    const followup = this.db.prepare(`
      SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY run_revision DESC LIMIT 1
    `).get(rootJobId);
    return followup ? parseJob(followup) : this.get(rootJobId);
  }

  getStatusRun(jobId) {
    const requested = this.get(jobId);
    if (!requested)
      return null;
    const rootId = requested.parentJobId ?? requested.id;
    return this.getLatestRun(rootId);
  }

  createFollowup(input, policy = {}) {
    const limits = {
      globalOutstanding: policy.globalOutstanding ?? 5,
      perUserOutstanding: policy.perUserOutstanding ?? 2,
      perUserWindow: policy.perUserWindow ?? 3,
      windowSeconds: policy.windowSeconds ?? 600,
      perJobQueued: policy.perJobQueued ?? 2
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getByRequestId(input.requestId);
      if (existing) {
        this.db.exec("COMMIT");
        return { ...existing, createDisposition: "existing" };
      }

      const root = this.get(input.parentJobId);
      if (!root || root.parentJobId)
        throw new AdmissionError("followup_job_missing", "The registered root job is unavailable.");
      const sessionId = root.result?.provenance?.codexThreadId;
      if (!["ready_for_review", "needs_attention"].includes(root.state)
        || root.deliveryState !== "delivered" || typeof sessionId !== "string")
        throw new AdmissionError("followup_not_ready", "The original job has no delivered resumable result yet.");

      const latest = this.getLatestRun(root.id);
      const failedPredecessor = this.db.prepare(`
        SELECT id FROM jobs
        WHERE (id = ? OR parent_job_id = ?) AND state = 'failed'
        ORDER BY run_revision LIMIT 1
      `).get(root.id, root.id);
      if (failedPredecessor)
        throw new AdmissionError("followup_blocked", "A failed earlier run must be reconciled before another continuation.");
      if (latest.id !== root.id && latest.state === "failed")
        throw new AdmissionError("followup_blocked", "The latest follow-up requires attention before another continuation.");
      if (latest.id !== root.id && ["ready_for_review", "needs_attention"].includes(latest.state)
        && latest.deliveryState !== "delivered")
        throw new AdmissionError("followup_delivery_pending", "The latest follow-up result must be delivered before another continuation.");

      const activeStates = ["provisioning", "queued", "running"];
      const placeholders = activeStates.map(() => "?").join(",");
      const globalOutstanding = this.db.prepare(`SELECT count(*) count FROM jobs WHERE state IN (${placeholders})`)
        .get(...activeStates).count;
      if (globalOutstanding >= limits.globalOutstanding)
        throw new AdmissionError("global_queue_full", "The dispatcher queue is full; try again after an existing run finishes.");
      const perUserOutstanding = this.db.prepare(`
        SELECT count(*) count FROM jobs
        WHERE requester_discord_id = ? AND state IN (${placeholders})
      `).get(input.requesterDiscordId, ...activeStates).count;
      if (perUserOutstanding >= limits.perUserOutstanding)
        throw new AdmissionError("user_queue_full", "You already have the maximum number of outstanding runs.");
      const perJobQueued = this.db.prepare(`
        SELECT count(*) count FROM jobs
        WHERE parent_job_id = ? AND state IN ('provisioning', 'queued')
      `).get(root.id).count;
      if (perJobQueued >= limits.perJobQueued)
        throw new AdmissionError("followup_queue_full", "This job already has the maximum queued follow-ups.");
      const windowStart = new Date(Date.now() - limits.windowSeconds * 1000).toISOString();
      const recent = this.db.prepare("SELECT count(*) count FROM jobs WHERE requester_discord_id = ? AND created_at >= ?")
        .get(input.requesterDiscordId, windowStart).count;
      if (recent >= limits.perUserWindow)
        throw new AdmissionError("user_rate_limited", "You have submitted too many runs recently; try again later.");

      const revision = this.db.prepare("SELECT COALESCE(MAX(run_revision), 1) + 1 revision FROM jobs WHERE id = ? OR parent_job_id = ?")
        .get(root.id, root.id).revision;
      const model = root.nextModel ?? input.model ?? root.model;
      const reasoningEffort = root.nextReasoningEffort ?? input.reasoningEffort ?? root.reasoningEffort;
      const modelSource = root.nextModel || root.nextReasoningEffort ? "owner_next_turn" : input.modelSource ?? "followup_route";
      const followup = this.create({
        ...input,
        parentJobId: root.id,
        rootRequestId: root.requestId,
        runRevision: revision,
        resumeSessionId: sessionId,
        discordThreadId: root.discordThreadId,
        executionMode: root.executionMode,
        model,
        reasoningEffort,
        modelSource
      });
      if (root.nextModel || root.nextReasoningEffort)
        this.db.prepare("UPDATE jobs SET next_model = NULL, next_reasoning_effort = NULL, updated_at = ? WHERE id = ?")
          .run(now(), root.id);
      this.db.exec("COMMIT");
      return followup;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setNextRunModel(rootJobId, model, reasoningEffort) {
    if (!new Set(["gpt-5.6-sol", "gpt-6-astra"]).has(model))
      throw new Error("model is not owner-allowlisted");
    if (!new Set(["high", "max"]).has(reasoningEffort))
      throw new Error("reasoning effort is not owner-allowlisted");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const requested = this.get(rootJobId);
      if (!requested) {
        this.db.exec("COMMIT");
        return null;
      }
      const root = requested.parentJobId ? this.get(requested.parentJobId) : requested;
      const queued = this.db.prepare(`
        SELECT id FROM jobs WHERE parent_job_id = ? AND state IN ('provisioning', 'queued')
        ORDER BY run_revision LIMIT 1
      `).get(root.id);
      if (queued) {
        const updated = this.db.prepare(`
          UPDATE jobs SET model = ?, reasoning_effort = ?, model_source = 'owner_queued_override', updated_at = ?
          WHERE id = ? AND state IN ('provisioning', 'queued')
        `).run(model, reasoningEffort, now(), queued.id);
        if (updated.changes !== 1)
          throw new Error("queued run was claimed while its model was being selected");
        this.db.exec("COMMIT");
        return { ...this.get(queued.id), modelTarget: "queued_run" };
      }
      this.db.prepare("UPDATE jobs SET next_model = ?, next_reasoning_effort = ?, updated_at = ? WHERE id = ?")
        .run(model, reasoningEffort, now(), root.id);
      this.db.exec("COMMIT");
      return { ...this.get(root.id), modelTarget: "future_followup" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimProvisioning(id, claimToken, leaseSeconds = 120) {
    if (typeof claimToken !== "string" || !claimToken)
      throw new Error("claimToken is required");
    const timestamp = now();
    const staleBefore = new Date(Date.now() - leaseSeconds * 1000).toISOString();
    const result = this.db.prepare(`
      UPDATE jobs SET provisioning_claim = ?, provisioning_claimed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'provisioning'
        AND (discord_thread_id IS NULL OR source_kind = 'followup')
        AND (provisioning_claim IS NULL OR provisioning_claimed_at < ?)
    `).run(claimToken, timestamp, timestamp, id, staleBefore);
    return result.changes === 1;
  }

  listRecoverableProvisioning(staleSeconds = 120, limit = 10) {
    const staleBefore = new Date(Date.now() - staleSeconds * 1000).toISOString();
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE state = 'provisioning' AND source_kind IN ('mention', 'followup')
        AND (discord_thread_id IS NULL OR source_kind = 'followup')
        AND (provisioning_claim IS NULL OR provisioning_claimed_at < ?)
      ORDER BY created_at
      LIMIT ?
    `).all(staleBefore, limit).map(parseJob);
  }

  get(id) {
    return parseJob(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  }

  getByRequestId(requestId) {
    return parseJob(this.db.prepare("SELECT * FROM jobs WHERE request_id = ?").get(requestId));
  }

  setDiscordThread(id, threadId, claimToken = null) {
    const result = claimToken
      ? this.db.prepare(`
        UPDATE jobs SET discord_thread_id = ?, state = 'queued', updated_at = ?
        WHERE id = ? AND state = 'provisioning' AND provisioning_claim = ?
      `).run(threadId, now(), id, claimToken)
      : this.db.prepare("UPDATE jobs SET discord_thread_id = ?, state = 'queued', updated_at = ? WHERE id = ? AND state = 'provisioning'")
        .run(threadId, now(), id);
    if (result.changes !== 1)
      throw new Error("provisioning claim was lost before the Discord thread was recorded");
    return this.get(id);
  }

  setDiscordAcknowledgement(id, messageId, claimToken) {
    const result = this.db.prepare(`
      UPDATE jobs SET discord_ack_message_id = ?, updated_at = ?
      WHERE id = ? AND state = 'provisioning'
        AND (discord_thread_id IS NULL OR source_kind = 'followup')
        AND provisioning_claim = ?
    `).run(messageId, now(), id, claimToken);
    if (result.changes !== 1)
      throw new Error("provisioning claim was lost before the acknowledgement was recorded");
    return this.get(id);
  }

  setFollowupQueued(id, claimToken) {
    const result = this.db.prepare(`
      UPDATE jobs SET state = 'queued', updated_at = ?
      WHERE id = ? AND parent_job_id IS NOT NULL AND source_kind = 'followup'
        AND state = 'provisioning' AND provisioning_claim = ?
    `).run(now(), id, claimToken);
    if (result.changes !== 1)
      throw new Error("provisioning claim was lost before the follow-up was queued");
    return this.get(id);
  }

  blockDependentFollowups(job, reason, timestamp = now()) {
    if (!job?.parentJobId)
      return 0;
    const result = this.db.prepare(`
      UPDATE jobs SET state = 'needs_attention',
        error = ?, completed_at = ?, updated_at = ?, delivery_state = 'pending',
        delivery_revision = delivery_revision + 1, delivery_attempts = 0,
        delivery_next_at = ?, delivery_last_error = NULL
      WHERE parent_job_id = ? AND run_revision > ? AND state IN ('provisioning', 'queued')
    `).run(reason, timestamp, timestamp, timestamp, job.parentJobId, job.runRevision);
    return result.changes;
  }

  failProvisioning(id, error, claimToken = null) {
    const timestamp = now();
    const job = this.get(id);
    let update;
    if (claimToken) {
      update = this.db.prepare(`
        UPDATE jobs SET state = 'failed', error = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'provisioning' AND provisioning_claim = ?
      `).run(String(error), timestamp, timestamp, id, claimToken);
    } else {
      update = this.db.prepare(`
        UPDATE jobs SET state = 'failed', error = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'provisioning'
      `).run(String(error), timestamp, timestamp, id);
    }
    if (update.changes === 1 && job?.parentJobId) {
      this.db.prepare(`
        UPDATE jobs SET delivery_state = 'pending', delivery_revision = delivery_revision + 1,
          delivery_attempts = 0, delivery_next_at = ?, delivery_last_error = NULL
        WHERE id = ?
      `).run(timestamp, id);
      this.blockDependentFollowups(
        job,
        `Blocked because follow-up run ${job.runRevision} failed during provisioning.`,
        timestamp
      );
    }
    return this.get(id);
  }

  claim(runnerId, leaseSeconds = 300) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const runningAction = this.db.prepare("SELECT id FROM github_actions WHERE state = 'running' LIMIT 1").get();
      if (runningAction) {
        this.db.exec("COMMIT");
        return null;
      }
      const running = this.db.prepare("SELECT * FROM jobs WHERE state = 'running' ORDER BY claimed_at LIMIT 1").get();
      if (running) {
        const parsed = parseJob(running);
        if (parsed.leaseExpiresAt && parsed.leaseExpiresAt <= now()) {
          const timestamp = now();
          this.db.prepare(`
            UPDATE jobs SET state = 'needs_attention',
              error = 'Runner lease expired; reconcile the retained local job before retrying.',
              completed_at = ?, updated_at = ?, delivery_state = 'pending',
              delivery_revision = delivery_revision + 1, delivery_attempts = 0,
              delivery_next_at = ?, delivery_last_error = NULL
            WHERE id = ? AND state = 'running'
          `).run(timestamp, timestamp, timestamp, parsed.id);
          if (parsed.parentJobId)
            this.blockDependentFollowups(
              parsed,
              `Blocked because follow-up run ${parsed.runRevision} lost its runner lease.`,
              timestamp
            );
          this.db.exec("COMMIT");
          return { ...this.get(parsed.id), claimDisposition: "expired_needs_attention" };
        }

        this.db.exec("COMMIT");
        return { ...parsed, claimDisposition: "existing_running" };
      }

      if (this.getControlState().paused) {
        this.db.exec("COMMIT");
        return null;
      }

      const row = this.db.prepare(`
        SELECT candidate.id FROM jobs candidate
        WHERE candidate.state = 'queued'
          AND (
            candidate.parent_job_id IS NULL
            OR (
              EXISTS (
                SELECT 1 FROM jobs root
                WHERE root.id = candidate.parent_job_id
                  AND root.state IN ('ready_for_review', 'needs_attention')
                  AND root.delivery_state = 'delivered'
              )
              AND NOT EXISTS (
                SELECT 1 FROM jobs previous
                WHERE previous.parent_job_id = candidate.parent_job_id
                  AND previous.run_revision < candidate.run_revision
                  AND NOT (
                    (previous.state IN ('ready_for_review', 'needs_attention') AND previous.delivery_state = 'delivered')
                    OR previous.state = 'cancelled'
                  )
              )
            )
          )
        ORDER BY candidate.created_at
        LIMIT 1
      `).get();
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      const timestamp = now();
      this.db.prepare(`
        UPDATE jobs SET state = 'running', runner_id = ?, claimed_at = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(runnerId, timestamp, timestamp, leaseDeadline(leaseSeconds), timestamp, row.id);
      this.db.exec("COMMIT");
      return { ...this.get(row.id), claimDisposition: "new" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(id, runnerId, leaseSeconds = 300) {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND state = 'running' AND runner_id = ?
    `).run(timestamp, leaseDeadline(leaseSeconds), timestamp, id, runnerId);
    if (result.changes !== 1)
      throw new Error("job is not actively owned by this runner");
    return this.get(id);
  }

  complete(id, runnerId, state, result, error = null) {
    if (!terminalStates.has(state) || state === "cancelled")
      throw new Error("worker result state must be ready_for_review, needs_attention, or failed");

    const job = this.get(id);
    if (!job)
      return null;
    const recoverableExpiredClaim = job.state === "needs_attention" && job.result === null && job.runnerId === runnerId;
    if (terminalStates.has(job.state) && job.runnerId === runnerId) {
      if (!recoverableExpiredClaim)
        return { ...job, completionDisposition: "existing" };
    }
    if (!recoverableExpiredClaim && (job.state !== "running" || job.runnerId !== runnerId))
      throw new Error("job is not owned by this runner");

    const timestamp = now();
    this.db.prepare(`
      UPDATE jobs SET state = ?, result_json = ?, error = ?, completed_at = ?, updated_at = ?,
        delivery_state = 'pending', delivery_revision = delivery_revision + 1,
        delivery_attempts = 0, delivery_next_at = ?, delivery_last_error = NULL
      WHERE id = ?
    `).run(state, result === null ? null : JSON.stringify(result), error, timestamp, timestamp, timestamp, id);
    if (job.parentJobId && ["failed", "needs_attention"].includes(state))
      this.blockDependentFollowups(job, `Blocked because follow-up run ${job.runRevision} ended in ${state}.`, timestamp);
    return { ...this.get(id), completionDisposition: "new" };
  }

  cancel(id, requesterDiscordId) {
    const job = this.get(id);
    if (!job)
      return null;
    if (job.requesterDiscordId !== requesterDiscordId)
      throw new Error("only the submitting user can cancel this job");
    if (job.state !== "queued")
      throw new Error("only queued jobs can be cancelled in this prototype");

    const timestamp = now();
    this.db.prepare("UPDATE jobs SET state = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, id);
    return this.get(id);
  }

  cancelCurrent(rootJobId, requesterDiscordId, isAdmin = false) {
    const requested = this.get(rootJobId);
    if (!requested)
      return null;
    const root = requested.parentJobId ? this.get(requested.parentJobId) : requested;
    const current = this.getLatestRun(root.id);
    if (!current)
      return null;
    if (!isAdmin && requesterDiscordId !== root.requesterDiscordId && requesterDiscordId !== current.requesterDiscordId)
      throw new Error("only the original requester, run requester, or dispatcher owner can cancel this run");
    if (current.state !== "queued")
      throw new Error("only queued runs can be cancelled in this prototype");
    const timestamp = now();
    this.db.prepare("UPDATE jobs SET state = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, current.id);
    return this.get(current.id);
  }

  listPendingDeliveries(limit = 10) {
    const rows = this.db.prepare(`
      SELECT * FROM jobs
      WHERE discord_thread_id IS NOT NULL
        AND delivery_state IN ('pending', 'failed')
        AND (delivery_next_at IS NULL OR delivery_next_at <= ?)
      ORDER BY updated_at
      LIMIT ?
    `).all(now(), limit);
    return rows.map(parseJob);
  }

  markDelivered(id, revision, messageId) {
    this.db.prepare(`
      UPDATE jobs SET delivery_state = 'delivered', discord_message_id = ?,
        delivery_last_error = NULL, delivery_next_at = NULL, updated_at = ?
      WHERE id = ? AND delivery_revision = ?
    `).run(messageId ?? null, now(), id, revision);
    return this.get(id);
  }

  markDeliveryFailed(id, revision, error, retryAfterMs = 10000) {
    const next = new Date(Date.now() + Math.max(1000, retryAfterMs)).toISOString();
    this.db.prepare(`
      UPDATE jobs SET delivery_state = 'failed', delivery_attempts = delivery_attempts + 1,
        delivery_last_error = ?, delivery_next_at = ?, updated_at = ?
      WHERE id = ? AND delivery_revision = ?
    `).run(String(error), next, now(), id, revision);
    return this.get(id);
  }

  close() {
    this.db.close();
  }
}
