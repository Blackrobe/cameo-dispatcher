import path from "node:path";
import { createWriteStream, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { atomicWriteJson, readJson } from "./lib.mjs";
import { codexExecutionArgs, reviewerSelection } from "./codex-policy.mjs";
import { waitForChildWithTimeout } from "./process-timeout.mjs";

const protectedPrefixes = Object.freeze([
  ".codex/", ".git/", ".github/workflows/", "engine/", "tools/"
]);
const protectedExact = new Set(["AGENTS.md", ".git", ".gitmodules", "mod.config"]);
const secretPattern = /(gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|DISCORD_TOKEN\s*=|RUNNER_TOKEN\s*=)/i;
const temporaryArtifactPattern = "/.cameo-dispatcher-tmp/";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8", windowsHide: true, shell: false, timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" },
    ...options
  });
}

function runGit(worktreePath, args, gitBin = "git") {
  const result = run(gitBin, ["-c", "core.hooksPath=NUL", "-C", worktreePath, ...args]);
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export function ensureTemporaryArtifactIgnore(repoRoot, gitBin = "git") {
  const reportedPath = runGit(repoRoot, ["rev-parse", "--git-path", "info/exclude"], gitBin);
  const excludePath = path.isAbsolute(reportedPath) ? reportedPath : path.resolve(repoRoot, reportedPath);
  const current = readFileSync(excludePath, "utf8");
  if (current.split(/\r?\n/).includes(temporaryArtifactPattern))
    return excludePath;
  writeFileSync(excludePath, `${current.replace(/\s*$/, "\n")}${temporaryArtifactPattern}\n`, "utf8");
  return excludePath;
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

export function changedPaths(worktreePath, gitBin = "git") {
  const tracked = runGit(worktreePath, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "--"], gitBin)
    .split(/\r?\n/).filter(Boolean);
  const untracked = runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "--"], gitBin)
    .split(/\r?\n/).filter(Boolean);
  return [...new Set([...tracked, ...untracked].map(value => value.replaceAll("\\", "/")))].sort();
}

export function validateCandidate(worktreePath, job, expectedHead, gitBin = "git") {
  const head = runGit(worktreePath, ["rev-parse", "HEAD"], gitBin);
  if (head !== expectedHead)
    throw new Error("candidate HEAD moved outside the trusted controller");
  const paths = changedPaths(worktreePath, gitBin);
  if (paths.length > 100)
    throw new Error("candidate exceeds the 100-file publication limit");
  for (const file of paths) {
    const lower = file.toLowerCase();
    if (protectedExact.has(file) || protectedPrefixes.some(prefix => lower.startsWith(prefix.toLowerCase())))
      throw new Error(`candidate touches protected path: ${file}`);
    if (job.scope.length && !job.scope.some(scope => file === scope || file.startsWith(`${scope.replace(/\/$/, "")}/`)))
      throw new Error(`candidate exceeds requested scope: ${file}`);
  }
  const check = runGit(worktreePath, ["diff", "--check", "--"], gitBin);
  if (check)
    throw new Error(`candidate fails git diff --check: ${check}`);
  let totalBytes = 0;
  const contentLimit = job.model === "gpt-6-astra" || /\b(sprite|palette|remap|tkm|shp|voxel|visual)\b/i.test(job.objective)
    ? 32 * 1024 * 1024
    : 2 * 1024 * 1024;
  const candidateRecords = [];
  for (const file of paths) {
    const absolute = path.resolve(worktreePath, file);
    if (!absolute.startsWith(`${path.resolve(worktreePath)}${path.sep}`))
      throw new Error(`candidate path escapes the worktree: ${file}`);
    try {
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink())
        throw new Error(`candidate contains a symlink: ${file}`);
      totalBytes += metadata.size;
      if (totalBytes > contentLimit)
        throw new Error(`candidate exceeds the ${contentLimit / 1024 / 1024} MiB content limit`);
      const content = runGit(worktreePath, ["hash-object", "--", file], gitBin);
      candidateRecords.push([file, content]);
      const text = readFileSync(absolute, "utf8");
      if (secretPattern.test(text))
        throw new Error(`candidate resembles a credential or private key: ${file}`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (String(error.message).includes("candidate"))
          throw error;
      }
      candidateRecords.push([file, "DELETED"]);
    }
  }
  const modes = runGit(worktreePath, ["ls-files", "-s", "--", ...paths], gitBin);
  if (/(^|\n)(120000|160000) /.test(modes))
    throw new Error("candidate contains a symlink or submodule entry");
  const candidateHash = paths.length
    ? createHash("sha256").update(JSON.stringify(candidateRecords)).digest("hex")
    : null;
  return { head, paths, candidateHash, records: candidateRecords };
}

function stagedCandidateHash(worktreePath, paths, gitBin) {
  const records = paths.map(file => {
    const result = run(gitBin, ["-C", worktreePath, "rev-parse", `:${file}`]);
    return [file, result.status === 0 ? result.stdout.trim() : "DELETED"];
  });
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

export async function reviewCandidate({ config, job, worktreePath, stateRoot, expectedHead, environment }) {
  const candidate = validateCandidate(worktreePath, job, expectedHead, config.gitBin);
  if (candidate.paths.length === 0)
    return { candidate, review: null };
  await mkdir(stateRoot, { recursive: true });
  const eventPath = path.join(stateRoot, "review-events.jsonl");
  const diagnosticPath = path.join(stateRoot, "review-diagnostics.log");
  const finalPath = path.join(stateRoot, "review-final.json");
  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas", "review.schema.json");
  const selection = reviewerSelection(job);
  const reviewerJob = { ...job, executionMode: "read_only", ...selection };
  const args = codexExecutionArgs(reviewerJob, worktreePath, schemaPath, finalPath);
  const acceptance = job.acceptanceCriteria.map(value => `- ${value}`).join("\n");
  const scope = job.scope.length ? job.scope.map(value => `- ${value}`).join("\n") : "- repository scope not further narrowed";
  args.push(`Independently review the uncommitted Cameo-mod changes for dispatcher job ${job.requestId}. Inspect the actual diff and relevant active configuration. Do not edit, commit, publish, use the network, or contact anyone. Approve only when the changes satisfy the objective and every acceptance criterion without a correctness, safety, scope, or validation defect.\n\nObjective:\n${job.objective}\n\nAcceptance criteria:\n${acceptance}\n\nAllowed scope:\n${scope}`);
  const events = createWriteStream(eventPath, { flags: "wx" });
  const diagnostics = createWriteStream(diagnosticPath, { flags: "wx" });
  const child = spawn(config.codexBin, args, { cwd: worktreePath, env: environment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(events);
  child.stderr.pipe(diagnostics);
  const execution = await waitForChildWithTimeout(child, config.maxJobMinutes * 60 * 1000);
  await Promise.all([finished(events), finished(diagnostics)]);
  if (execution.timedOut || execution.exitCode !== 0 || !await exists(finalPath))
    throw new Error("independent reviewer did not complete successfully");
  const review = await readJson(finalPath);
  if (review.verdict !== "approved")
    throw new Error(`independent reviewer requires attention: ${review.summary}`);
  const rechecked = validateCandidate(worktreePath, job, expectedHead, config.gitBin);
  if (rechecked.candidateHash !== candidate.candidateHash || JSON.stringify(rechecked.paths) !== JSON.stringify(candidate.paths))
    throw new Error("candidate changed during independent review");
  const provenance = { ...review, ...selection, eventPath, diagnosticPath, finalPath };
  await atomicWriteJson(path.join(stateRoot, "review-provenance.json"), provenance);
  return { candidate, review: provenance };
}

export function deterministicBranchName(config, rootRequestId) {
  const suffix = rootRequestId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${config.publication.branchPrefix}${suffix}`;
}

export function publicationRemoteHeadIsAllowed(existing, remoteHead) {
  const allowed = existing?.state === "committed"
    ? new Set([null, existing.expectedParent, existing.lastCommit])
    : new Set([existing?.lastCommit ?? null]);
  return allowed.has(remoteHead);
}

function runGh(config, args) {
  const result = run(config.ghBin, args, { cwd: path.dirname(config.codexBin) });
  if (result.status !== 0)
    throw new Error(`gh ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function verifyExistingDraft(config, branch, prUrl, worktreePath) {
  if (!/^https:\/\/github\.com\/cameo-mod\/Cameo-mod\/pull\/\d+$/i.test(prUrl))
    throw new Error("stored pull request URL is outside the configured Cameo repository");
  const pr = JSON.parse(runGh(config, [
    "pr", "view", prUrl, "--json", "url,isDraft,state,headRefName,baseRefName,headRepositoryOwner"
  ]));
  if (pr.url !== prUrl || pr.state !== "OPEN" || !pr.isDraft
    || pr.headRefName !== branch || pr.baseRefName !== config.publication.baseBranch
    || pr.headRepositoryOwner?.login !== config.publication.headOwner)
    throw new Error("controller pull request is no longer the expected open draft");
  return pr.url;
}

export async function publishCandidate({ config, job, worktreePath, rootStateRoot, expectedHead, candidate }) {
  if (!config.publication.enabled)
    throw new Error("draft publication is disabled in the runner configuration");
  const publicationPath = path.join(rootStateRoot, "publication.json");
  let existing = await exists(publicationPath) ? await readJson(publicationPath) : null;
  const branch = existing?.branch ?? deterministicBranchName(config, job.rootRequestId ?? job.requestId);
  const title = job.objective.replaceAll(/[\r\n]+/g, " ").trim().slice(0, 72);
  if (existing?.state === "preparing") {
    if (runGit(worktreePath, ["branch", "--show-current"], config.gitBin) !== branch)
      throw new Error("preparing publication lost its controller branch");
    let head = runGit(worktreePath, ["rev-parse", "HEAD"], config.gitBin);
    if (head === existing.expectedParent) {
      const stagedPaths = runGit(worktreePath, ["diff", "--cached", "--name-only", "--"], config.gitBin).split(/\r?\n/).filter(Boolean).sort();
      if (JSON.stringify(stagedPaths) !== JSON.stringify(existing.paths)
        || runGit(worktreePath, ["write-tree"], config.gitBin) !== existing.tree
        || stagedCandidateHash(worktreePath, stagedPaths, config.gitBin) !== existing.candidateHash)
        throw new Error("preparing publication index no longer matches its journal");
      runGit(worktreePath, ["-c", "user.name=Cameo Dispatcher", "-c", "user.email=dispatcher@users.noreply.github.com", "commit", "--no-verify", "-m", `${title} (${job.requestId})`], config.gitBin);
      head = runGit(worktreePath, ["rev-parse", "HEAD"], config.gitBin);
    } else {
      if (runGit(worktreePath, ["rev-parse", "HEAD^"], config.gitBin) !== existing.expectedParent
        || runGit(worktreePath, ["rev-parse", "HEAD^{tree}"], config.gitBin) !== existing.tree)
        throw new Error("post-commit publication state does not match its journal");
    }
    existing = { ...existing, lastCommit: head, state: "committed", updatedAt: new Date().toISOString() };
    await atomicWriteJson(publicationPath, existing);
  }
  const alreadyPublished = existing?.state === "published"
    && existing.lastCommit === runGit(worktreePath, ["rev-parse", "HEAD"], config.gitBin)
    && changedPaths(worktreePath, config.gitBin).length === 0;
  const remoteLine = runGit(worktreePath, ["remote", "get-url", "--push", config.publication.remote], config.gitBin);
  if (!/github\.com[\/:]Blackrobe\/Cameo-mod(?:\.git)?$/i.test(remoteLine))
    throw new Error("configured publication remote is not Blackrobe/Cameo-mod");
  const remoteRef = `refs/heads/${branch}`;
  const remoteResult = run(config.gitBin, ["-C", worktreePath, "ls-remote", "--heads", config.publication.remote, remoteRef]);
  if (remoteResult.status !== 0)
    throw new Error(`could not inspect publication branch: ${(remoteResult.stderr || remoteResult.stdout).trim()}`);
  const remoteHead = remoteResult.stdout.trim().split(/\s+/)[0] || null;
  if (!publicationRemoteHeadIsAllowed(existing, remoteHead))
    throw new Error("publication branch moved outside the trusted controller");
  let verifiedPrUrl = existing?.prUrl ?? null;
  if (verifiedPrUrl)
    verifiedPrUrl = verifyExistingDraft(config, branch, verifiedPrUrl, worktreePath);
  if (alreadyPublished) {
    await atomicWriteJson(path.join(rootStateRoot, "continuation.json"), {
      expectedHead: existing.lastCommit, branch, prUrl: verifiedPrUrl,
      updatedAt: new Date().toISOString()
    });
    return { ...existing, prUrl: verifiedPrUrl };
  }
  let commit;
  let tree;
  let provisional;
  if (!existing || existing.state === "published") {
    if (!existing)
      runGit(worktreePath, ["switch", "-c", branch], config.gitBin);
    else if (runGit(worktreePath, ["branch", "--show-current"], config.gitBin) !== branch || runGit(worktreePath, ["rev-parse", "HEAD"], config.gitBin) !== expectedHead)
      throw new Error("retained worktree does not match the published controller head");
    const fresh = validateCandidate(worktreePath, job, expectedHead, config.gitBin);
    if (fresh.candidateHash !== candidate.candidateHash || JSON.stringify(fresh.paths) !== JSON.stringify(candidate.paths))
      throw new Error("candidate changed after review and before staging");
    runGit(worktreePath, ["add", "--all", "--", ...candidate.paths], config.gitBin);
    const stagedPaths = runGit(worktreePath, ["diff", "--cached", "--name-only", "--"], config.gitBin).split(/\r?\n/).filter(Boolean).sort();
    if (JSON.stringify(stagedPaths) !== JSON.stringify(candidate.paths))
      throw new Error("staged publication scope differs from the verified candidate");
    if (stagedCandidateHash(worktreePath, stagedPaths, config.gitBin) !== candidate.candidateHash)
      throw new Error("staged bytes differ from the independently reviewed candidate");
    if (runGit(worktreePath, ["diff", "--name-only", "--"], config.gitBin))
      throw new Error("candidate changed after staging");
    tree = runGit(worktreePath, ["write-tree"], config.gitBin);
    provisional = {
      requestId: job.requestId, runRevision: job.runRevision ?? 1,
      branch, expectedParent: expectedHead, candidateHash: candidate.candidateHash,
      paths: candidate.paths, tree, lastCommit: null, prUrl: existing?.prUrl ?? null,
      state: "preparing", updatedAt: new Date().toISOString()
    };
    await atomicWriteJson(publicationPath, provisional);
    runGit(worktreePath, ["-c", "user.name=Cameo Dispatcher", "-c", "user.email=dispatcher@users.noreply.github.com", "commit", "--no-verify", "-m", `${title} (${job.requestId})`], config.gitBin);
    commit = runGit(worktreePath, ["rev-parse", "HEAD"], config.gitBin);
    provisional = { ...provisional, lastCommit: commit, state: "committed", updatedAt: new Date().toISOString() };
    await atomicWriteJson(publicationPath, provisional);
  } else {
    if (runGit(worktreePath, ["branch", "--show-current"], config.gitBin) !== branch || changedPaths(worktreePath, config.gitBin).length !== 0 || runGit(worktreePath, ["rev-parse", "HEAD"], config.gitBin) !== existing.lastCommit)
      throw new Error("retained committed candidate no longer matches publication recovery state");
    commit = existing.lastCommit;
    tree = existing.tree;
    provisional = existing;
  }
  if (remoteHead !== commit) {
    const push = run(config.gitBin, ["-c", "core.hooksPath=NUL", "-C", worktreePath, "push", "--porcelain", config.publication.remote, `HEAD:${remoteRef}`]);
    if (push.status !== 0) {
    const check = run(config.gitBin, ["-C", worktreePath, "ls-remote", "--heads", config.publication.remote, remoteRef]);
    const observed = check.status === 0 ? check.stdout.trim().split(/\s+/)[0] : null;
    if (observed !== commit)
      throw new Error(`draft branch push failed: ${(push.stderr || push.stdout).trim()}`);
    }
  }
  let prUrl = verifiedPrUrl ?? provisional.prUrl ?? null;
  if (!prUrl) {
    const listed = JSON.parse(runGh(config, ["pr", "list", "--repo", config.publication.repository, "--head", `${config.publication.headOwner}:${branch}`, "--state", "all", "--json", "url,isDraft,headRefName"]) || "[]");
    if (listed.length > 1)
      throw new Error("multiple pull requests already exist for the controller branch");
    if (listed.length === 1) {
      if (!listed[0].isDraft)
        throw new Error("existing controller pull request is no longer a draft");
      prUrl = listed[0].url;
    } else {
      const body = `Cameo Dispatcher job ${job.parentJobId ?? job.requestId}, run ${job.runRevision ?? 1}.\n\nRequested by ${job.requestedBy?.human ?? "unknown"}. Independent review passed. Merge remains owner-controlled.`;
      try {
        prUrl = runGh(config, ["pr", "create", "--repo", config.publication.repository, "--base", config.publication.baseBranch, "--head", `${config.publication.headOwner}:${branch}`, "--draft", "--title", title, "--body", body]);
      } catch (error) {
        const recovered = JSON.parse(runGh(config, ["pr", "list", "--repo", config.publication.repository, "--head", `${config.publication.headOwner}:${branch}`, "--state", "all", "--json", "url,isDraft"]) || "[]");
        if (recovered.length !== 1 || !recovered[0].isDraft)
          throw error;
        prUrl = recovered[0].url;
      }
    }
  }
  verifyExistingDraft(config, branch, prUrl, worktreePath);
  const completed = { ...provisional, prUrl, state: "published", updatedAt: new Date().toISOString() };
  await atomicWriteJson(publicationPath, completed);
  await atomicWriteJson(path.join(rootStateRoot, "continuation.json"), { expectedHead: commit, branch, prUrl, updatedAt: new Date().toISOString() });
  return completed;
}
