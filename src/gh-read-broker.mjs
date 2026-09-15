import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";

import { extractReferencedPullRequests } from "./github-context.mjs";

const prViewFields = new Set([
  "additions", "author", "baseRefName", "baseRefOid", "body", "changedFiles",
  "closed", "comments", "commits", "createdAt", "deletions", "files",
  "headRefName", "headRefOid", "isDraft", "labels", "mergeable",
  "mergeStateStatus", "mergedAt", "number", "reviewDecision", "reviews",
  "state", "statusCheckRollup", "title", "updatedAt", "url"
]);
const issueViewFields = new Set([
  "assignees", "author", "body", "closed", "closedAt", "comments", "createdAt",
  "labels", "milestone", "number", "projectCards", "reactionGroups", "state",
  "stateReason", "title", "updatedAt", "url"
]);
const checkFields = new Set([
  "bucket", "completedAt", "description", "event", "link", "name", "startedAt",
  "state", "workflow"
]);
const prFields = [...prViewFields].join(",");
const issueFields = [...issueViewFields].join(",");
const checksFields = [...checkFields].join(",");

function parseNumber(value) {
  if (!/^\d{1,7}$/.test(value ?? ""))
    throw new Error("a numeric pull request or issue number is required");
  return String(Number(value));
}

function parseReadFlags(args, allowedFields, allowedFlags = new Set()) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--repo" || value === "-R")
      throw new Error("repository overrides are not allowed; the cache is fixed to Cameo");
    if (value === "--json") {
      const requested = String(args[++index] ?? "").split(",").filter(Boolean);
      if (!requested.length || requested.some(field => !allowedFields.has(field)))
        throw new Error("one or more requested JSON fields are not allowlisted");
      output.push("--json", requested.join(","));
      continue;
    }
    if (allowedFlags.has(value)) {
      output.push(value);
      continue;
    }
    throw new Error(`flag is not available through the cached read-only GitHub interface: ${value}`);
  }
  return output;
}

export function translateGhReadCommand(argv, repository = "cameo-mod/Cameo-mod") {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string" || value.length > 500) || argv.length > 20)
    throw new Error("invalid GitHub CLI argument list");
  const [group, command, rawNumber, ...flags] = argv;
  const number = parseNumber(rawNumber);
  if (group === "pr" && command === "view") {
    const parsed = parseReadFlags(flags, prViewFields);
    return { kind: "pr_view", number, args: ["pr", "view", number, "--repo", repository, ...parsed], outputLimit: 512 * 1024 };
  }
  if (group === "pr" && command === "diff") {
    const parsed = parseReadFlags(flags, new Set(), new Set(["--name-only"]));
    return { kind: parsed.includes("--name-only") ? "pr_diff_names" : "pr_diff", number, args: ["pr", "diff", number, "--repo", repository, ...parsed], outputLimit: 2 * 1024 * 1024 };
  }
  if (group === "pr" && command === "checks") {
    const parsed = parseReadFlags(flags, checkFields, new Set(["--required"]));
    return { kind: parsed.includes("--required") ? "pr_checks_required" : "pr_checks", number, args: ["pr", "checks", number, "--repo", repository, ...parsed], outputLimit: 512 * 1024 };
  }
  if (group === "issue" && command === "view") {
    const parsed = parseReadFlags(flags, issueViewFields);
    return { kind: "issue_view", number, args: ["issue", "view", number, "--repo", repository, ...parsed], outputLimit: 1024 * 1024 };
  }
  throw new Error("cached read-only interface supports only: gh pr view, gh pr diff, gh pr checks, gh issue view");
}

function referencedIssues(job, maximum = 3) {
  const text = [job.objective, ...(job.acceptanceCriteria ?? [])].join("\n");
  return [...text.matchAll(/\bissue\s+#?(\d{1,7})\b/gi)]
    .map(match => Number(match[1])).filter((number, index, all) => number > 0 && all.indexOf(number) === index).slice(0, maximum);
}

function executeGh(config, args, outputLimit, execute) {
  const result = execute(config.ghBin, args, {
    cwd: path.dirname(config.codexBin), encoding: "utf8", windowsHide: true,
    shell: false, timeout: 30000, maxBuffer: outputLimit,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
  });
  if (result.error?.code === "ENOBUFS")
    return { exitCode: 2, stdout: "", stderr: "Cached GitHub response exceeded its output limit; use a narrower command.\n", truncated: true };
  if (result.error)
    return { exitCode: 2, stdout: "", stderr: `${result.error.message}\n` };
  return { exitCode: Number.isInteger(result.status) ? result.status : 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function clientSource(manifestPath) {
  return `import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(${JSON.stringify(manifestPath)}, "utf8"));
const args = process.argv.slice(2);
const [group, command, rawNumber, ...flags] = args;
if (!/^\\d{1,7}$/.test(rawNumber ?? "")) { console.error("A numeric cached PR or issue number is required."); process.exit(2); }
const number = String(Number(rawNumber));
let kind;
let fields = null;
for (let index = 0; index < flags.length; index += 1) {
  const flag = flags[index];
  if (flag === "--repo" || flag === "-R") { console.error("Repository overrides are not allowed; cached data is fixed to " + manifest.repository + "."); process.exit(2); }
  if (flag === "--json") { fields = String(flags[++index] ?? "").split(",").filter(Boolean); continue; }
  if (group === "pr" && command === "diff" && flag === "--name-only") { kind = "pr_diff_names"; continue; }
  if (group === "pr" && command === "checks" && flag === "--required") { kind = "pr_checks_required"; continue; }
  console.error("Flag is not available through the cached read-only GitHub interface: " + flag); process.exit(2);
}
if (group === "pr" && command === "view") kind = "pr_view";
else if (group === "pr" && command === "diff") kind ??= "pr_diff";
else if (group === "pr" && command === "checks") kind ??= "pr_checks";
else if (group === "issue" && command === "view") kind = "issue_view";
else { console.error("Cached read-only interface supports only gh pr view/diff/checks and gh issue view."); process.exit(2); }
const entry = manifest.entries[kind + ":" + number];
if (!entry) { console.error("No cached " + kind + " result exists for #" + number + "; mention the exact PR or issue in the request so the controller can fetch it before the next turn."); process.exit(2); }
if (fields && entry.exitCode === 0) {
  let value;
  try { value = JSON.parse(entry.stdout); } catch { console.error("Cached GitHub JSON is invalid."); process.exit(2); }
  const allowed = new Set(kind.startsWith("pr_checks") ? ${JSON.stringify([...checkFields])} : kind === "issue_view" ? ${JSON.stringify([...issueViewFields])} : ${JSON.stringify([...prViewFields])});
  if (!fields.length || fields.some(field => !allowed.has(field))) { console.error("One or more requested JSON fields are not allowlisted."); process.exit(2); }
  const selected = Array.isArray(value) ? value.map(item => Object.fromEntries(fields.map(field => [field, item[field]]))) : Object.fromEntries(fields.map(field => [field, value[field]]));
  process.stdout.write(JSON.stringify(selected) + "\\n");
  process.exit(0);
}
if (entry.stdout) process.stdout.write(entry.stdout);
if (entry.stderr) process.stderr.write(entry.stderr);
process.exit(entry.exitCode);
`;
}

export async function startGhReadBroker({ config, job, worktreePath, auditPath, phase = "worker" }, dependencies = {}) {
  const execute = dependencies.execute ?? spawnSync;
  const runId = randomUUID();
  const capturedAt = new Date().toISOString();
  const brokerRoot = path.join(worktreePath, ".cameo-dispatcher-tmp", `gh-cache-${runId}`);
  const binRoot = path.join(brokerRoot, "bin");
  await mkdir(binRoot, { recursive: true });
  const entries = {};
  const audit = [];

  const pullRequests = Array.isArray(job.githubReferences) && job.githubReferences.length
    ? job.githubReferences
    : extractReferencedPullRequests(job);
  for (const number of pullRequests.slice(0, 3)) {
    const viewArgs = ["pr", "view", String(number), "--repo", config.publication.repository, "--json", prFields];
    const first = executeGh(config, viewArgs, 2 * 1024 * 1024, execute);
    if (first.exitCode !== 0) {
      entries[`pr_view:${number}`] = first;
      continue;
    }
    const view = JSON.parse(first.stdout);
    const commands = [
      ["pr_diff", ["pr", "diff", String(number), "--repo", config.publication.repository], 2 * 1024 * 1024],
      ["pr_diff_names", ["pr", "diff", String(number), "--repo", config.publication.repository, "--name-only"], 512 * 1024],
      ["pr_checks", ["pr", "checks", String(number), "--repo", config.publication.repository, "--json", checksFields], 512 * 1024],
      ["pr_checks_required", ["pr", "checks", String(number), "--repo", config.publication.repository, "--required", "--json", checksFields], 512 * 1024]
    ];
    const fetched = commands.map(([kind, args, limit]) => [kind, args, executeGh(config, args, limit, execute)]);
    const second = executeGh(config, viewArgs, 2 * 1024 * 1024, execute);
    if (second.exitCode !== 0) {
      entries[`pr_view:${number}`] = { exitCode: 2, stdout: "", stderr: "Cached PR verification failed; refresh on the next turn.\n" };
      continue;
    }
    const verified = JSON.parse(second.stdout);
    if (view.headRefOid !== verified.headRefOid || view.baseRefOid !== verified.baseRefOid) {
      entries[`pr_view:${number}`] = { exitCode: 2, stdout: "", stderr: "PR head or base moved while the cache was being built; refresh on the next turn.\n" };
      continue;
    }
    entries[`pr_view:${number}`] = second;
    for (const [kind, args, response] of fetched) {
      entries[`${kind}:${number}`] = response;
      audit.push({ command: ["gh", ...args], exitCode: response.exitCode, outputBytes: Buffer.byteLength(response.stdout) + Buffer.byteLength(response.stderr) });
    }
    audit.push({ command: ["gh", ...viewArgs], exitCode: second.exitCode, outputBytes: Buffer.byteLength(second.stdout) + Buffer.byteLength(second.stderr), headRefOid: verified.headRefOid, baseRefOid: verified.baseRefOid });
  }

  for (const number of referencedIssues(job)) {
    const args = ["issue", "view", String(number), "--repo", config.publication.repository, "--json", issueFields];
    const response = executeGh(config, args, 1024 * 1024, execute);
    entries[`issue_view:${number}`] = response;
    audit.push({ command: ["gh", ...args], exitCode: response.exitCode, outputBytes: Buffer.byteLength(response.stdout) + Buffer.byteLength(response.stderr) });
  }

  const manifestPath = path.join(brokerRoot, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    protocol: 1, source: "trusted_controller_cached_github_read", capturedAt,
    job: job.requestId, runRevision: job.runRevision ?? 1,
    repository: config.publication.repository, entries
  }), { encoding: "utf8", flag: "wx" });
  const clientPath = path.join(binRoot, "gh-client.mjs");
  const shimPath = path.join(binRoot, process.platform === "win32" ? "gh.cmd" : "gh");
  await writeFile(clientPath, clientSource(manifestPath), { encoding: "utf8", flag: "wx" });
  await writeFile(shimPath, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${clientPath}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${clientPath}" "$@"\n`,
  { encoding: "utf8", mode: 0o700, flag: "wx" });
  for (const entry of audit)
    await appendFile(auditPath, `${JSON.stringify({ at: capturedAt, job: job.requestId, runRevision: job.runRevision ?? 1, phase, cache: true, ...entry })}\n`, "utf8");

  let stopped = false;
  return {
    environment(environment) {
      const isolated = { ...environment };
      const pathKeys = Object.keys(isolated).filter(name => name.toLowerCase() === "path");
      const preferredPathKey = process.platform === "win32" && pathKeys.includes("Path") ? "Path" : pathKeys[0];
      const existingPath = preferredPathKey ? isolated[preferredPathKey] ?? "" : "";
      for (const name of pathKeys)
        delete isolated[name];
      isolated[process.platform === "win32" ? "Path" : "PATH"] = `${binRoot}${path.delimiter}${existingPath}`;
      for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_PAT", "GH_ENTERPRISE_TOKEN"])
        delete isolated[name];
      isolated.CAMEO_GH_CACHE_SOURCE = "trusted_controller_cached_github_read";
      isolated.CAMEO_GH_CACHE_CAPTURED_AT = capturedAt;
      return isolated;
    },
    async stop() {
      if (stopped)
        return;
      stopped = true;
      await rm(brokerRoot, { recursive: true, force: true });
    },
    brokerRoot,
    manifestPath,
    auditPath
  };
}
