import { spawnSync } from "node:child_process";
import path from "node:path";

const prUrlPattern = /https:\/\/github\.com\/cameo-mod\/Cameo-mod\/pull\/(\d+)(?![A-Za-z0-9])/gi;
const shortPrPattern = /(?:\bPR\s*)?#(\d{1,7})\b/gi;
const anyUrlPattern = /https?:\/\/[^\s<>()]+/gi;

export function extractReferencedPullRequests(job, maximum = 3) {
  const text = [job.objective, ...(job.acceptanceCriteria ?? [])].join("\n");
  const numbers = [];
  prUrlPattern.lastIndex = 0;
  for (const match of text.matchAll(prUrlPattern)) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0 && !numbers.includes(number))
      numbers.push(number);
    if (numbers.length >= maximum)
      return numbers;
  }
  const textWithoutUrls = text.replace(anyUrlPattern, " ").replace(/\bissue\s+#?\d{1,7}\b/gi, " ");
  shortPrPattern.lastIndex = 0;
  for (const match of textWithoutUrls.matchAll(shortPrPattern)) {
      const number = Number(match[1]);
      if (Number.isInteger(number) && number > 0 && !numbers.includes(number))
        numbers.push(number);
      if (numbers.length >= maximum)
        return numbers;
  }
  return numbers;
}

function runGh(config, number, execute) {
  const fields = "url,number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefOid,updatedAt,files,statusCheckRollup";
  return execute(config.ghBin, [
    "pr", "view", String(number), "--repo", config.publication.repository,
    "--json", fields
  ], {
    cwd: path.dirname(config.codexBin), encoding: "utf8", windowsHide: true,
    shell: false, timeout: 30000,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
  });
}

function compactChecks(checks) {
  return Array.isArray(checks) ? checks.slice(0, 10).map(check => ({
    name: String(check.name ?? check.context ?? "unknown").slice(0, 100),
    status: String(check.status ?? "unknown").slice(0, 50),
    conclusion: String(check.conclusion ?? "").slice(0, 50)
  })) : [];
}

function serializeSnapshot(snapshot, maximum = 7800) {
  let serialized = JSON.stringify(snapshot);
  if (serialized.length <= maximum)
    return serialized;
  const reduced = {
    ...snapshot,
    title: String(snapshot.title ?? "").slice(0, 120),
    checks: [],
    checksTruncated: true,
    contextTruncated: true
  };
  serialized = JSON.stringify(reduced);
  if (serialized.length > maximum)
    throw new Error("bounded GitHub snapshot unexpectedly exceeded its final limit");
  return serialized;
}

export function buildGithubContext(config, job, execute = spawnSync, capturedAt = new Date().toISOString()) {
  const snapshots = [];
  const references = Array.isArray(job.githubReferences) && job.githubReferences.length
    ? job.githubReferences.filter(number => Number.isInteger(number) && number > 0 && number <= 9_999_999).slice(0, 3)
    : extractReferencedPullRequests(job);
  for (const number of references) {
    try {
      const first = runGh(config, number, execute);
      if (first.status !== 0) {
        snapshots.push(`GitHub controller snapshot ${capturedAt}: PR #${number} could not be retrieved from ${config.publication.repository}; live state is unavailable.`);
        continue;
      }
      const second = runGh(config, number, execute);
      if (second.status !== 0) {
        snapshots.push(`GitHub controller snapshot ${capturedAt}: PR #${number} verification failed; do not treat the first response as stable.`);
        continue;
      }
      const initial = JSON.parse(first.stdout);
      const verified = JSON.parse(second.stdout);
      if (initial.headRefOid !== verified.headRefOid || initial.baseRefOid !== verified.baseRefOid) {
        snapshots.push(`GitHub controller snapshot ${capturedAt}: PR #${number} moved during retrieval; refresh before drawing a conclusion.`);
        continue;
      }
      const files = Array.isArray(verified.files) ? verified.files : [];
      const snapshot = {
      source: "trusted_controller_github_read",
      capturedAt,
      repository: config.publication.repository,
      number,
      url: verified.url,
      title: String(verified.title ?? "").slice(0, 300),
      state: verified.state,
      isDraft: Boolean(verified.isDraft),
      mergeable: verified.mergeable,
      mergeStateStatus: verified.mergeStateStatus,
      reviewDecision: verified.reviewDecision || null,
      headRefOid: verified.headRefOid,
      baseRefOid: verified.baseRefOid,
      updatedAt: verified.updatedAt,
      changedFileCount: files.length,
      filesTruncated: files.length >= 100,
      checks: compactChecks(verified.statusCheckRollup),
        checksTruncated: Array.isArray(verified.statusCheckRollup) && verified.statusCheckRollup.length > 10
      };
      snapshots.push(serializeSnapshot(snapshot));
    } catch {
      snapshots.push(`GitHub controller snapshot ${capturedAt}: PR #${number} returned invalid or oversized metadata; live state is unavailable.`);
    }
  }
  return snapshots;
}
