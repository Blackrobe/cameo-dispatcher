import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const fixedRepository = "cameo-mod/Cameo-mod";
const headShaPattern = /^[0-9a-f]{40}$/i;
const branchPattern = /^(?!\/)(?!.*\.\.)(?!.*[~^:?*\[\\\s])(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,200}$/;

function runGh(config, args, execute = spawnSync) {
  const result = execute(config.ghBin, args, {
    cwd: path.dirname(config.codexBin),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
  });
  if (result.error)
    throw result.error;
  if (result.status !== 0)
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  return result.stdout.trim();
}

function viewPr(config, number, execute) {
  return JSON.parse(runGh(config, [
    "pr", "view", String(number), "--repo", fixedRepository, "--json",
    "number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefName,headRefOid,headRepositoryOwner,baseRefName,mergedAt,mergeCommit,autoMergeRequest"
  ], execute));
}

function stablePr(config, number, execute) {
  const first = viewPr(config, number, execute);
  const second = viewPr(config, number, execute);
  if (first.number !== second.number || first.url !== second.url || first.state !== second.state
    || first.headRefOid !== second.headRefOid || first.baseRefName !== second.baseRefName)
    throw new Error("pull request state moved during controller verification");
  return second;
}

function assertAction(config, action) {
  if (config.publication?.repository !== fixedRepository || action.repository !== fixedRepository)
    throw new Error("GitHub controller repository is not the fixed upstream Cameo repository");
  if (!new Set(["open", "close", "merge"]).has(action.action))
    throw new Error("unsupported GitHub controller action");
  if (["close", "merge"].includes(action.action)) {
    if (!Number.isInteger(action.prNumber) || action.prNumber < 1 || action.prNumber > 9_999_999)
      throw new Error("pull request number is invalid");
    const supplied = [action.expectedHeadSha, action.headOwner, action.headBranch, action.baseBranch].some(Boolean);
    const fullIdentity = [action.headOwner, action.headBranch, action.baseBranch].every(Boolean);
    if (supplied && !headShaPattern.test(action.expectedHeadSha ?? ""))
      throw new Error("expected pull request head SHA is invalid");
    if (supplied && !fullIdentity && !action.rootJobId && action.authorizationKind !== "trusted_slash")
      throw new Error("partial pull request identity is allowed only for a trusted task proposal");
    if (!supplied && !action.rootJobId && action.authorizationKind !== "trusted_slash")
      throw new Error("unresolved pull request identity is allowed only for an owner task-thread action");
  }
}

function result(summary, validation, nextAction = null, risks = []) {
  return {
    status: "completed",
    summary,
    changedFiles: [],
    validation,
    risks,
    nextAction
  };
}

function assertPrIdentity(pr, action) {
  if (pr.headRefOid !== action.expectedHeadSha)
    throw new Error(`pull request head moved: expected ${action.expectedHeadSha}, observed ${pr.headRefOid}`);
  if (pr.headRepositoryOwner?.login?.toLowerCase() !== action.headOwner?.toLowerCase()
    || pr.headRefName !== action.headBranch || pr.baseRefName !== action.baseBranch)
    throw new Error("pull request head repository, head branch, or base branch differs from the owner-authorized identity");
}

function proposalIdentityDigest(pr) {
  return createHash("sha256").update(JSON.stringify([
    pr.number, pr.headRefOid.toLowerCase(), pr.headRepositoryOwner.login.toLowerCase(),
    pr.headRefName, pr.baseRefName
  ])).digest("base64url").slice(0, 22);
}

export function resolveGithubAction(config, action, dependencies = {}) {
  assertAction(config, action);
  if (action.action === "open")
    return action;
  const execute = dependencies.execute ?? spawnSync;
  const observed = stablePr(config, action.prNumber, execute);
  if (action.proposalIdentityDigest && proposalIdentityDigest(observed) !== action.proposalIdentityDigest)
    throw new Error("pull request identity changed after the displayed proposal");
  const fullIdentity = [action.expectedHeadSha, action.headOwner, action.headBranch, action.baseBranch].every(Boolean);
  if (fullIdentity) {
    assertPrIdentity(observed, action);
    return action;
  }
  if (action.expectedHeadSha && observed.headRefOid !== action.expectedHeadSha)
    throw new Error(`pull request head moved after proposal: expected ${action.expectedHeadSha}, observed ${observed.headRefOid}`);
  const resolved = {
    ...action,
    prUrl: observed.url,
    expectedHeadSha: observed.headRefOid,
    headOwner: observed.headRepositoryOwner?.login,
    headBranch: observed.headRefName,
    baseBranch: observed.baseRefName
  };
  if (!/^https:\/\/github\.com\/cameo-mod\/Cameo-mod\/pull\/\d+$/i.test(resolved.prUrl ?? "")
    || !headShaPattern.test(resolved.expectedHeadSha ?? "") || !resolved.headOwner
    || !branchPattern.test(resolved.headBranch ?? "") || !branchPattern.test(resolved.baseBranch ?? ""))
    throw new Error("GitHub returned an invalid PR identity during owner-action resolution");
  return resolved;
}

function executeClose(config, action, execute) {
  const before = stablePr(config, action.prNumber, execute);
  assertPrIdentity(before, action);
  if (before.state === "MERGED" || before.mergedAt)
    throw new Error("pull request is already merged and cannot be closed");
  if (before.state === "CLOSED")
    return result(`PR #${before.number} was already closed.`, [`Head remained ${before.headRefOid}.`, "No branch was deleted and no comment was added."], before.url);
  runGh(config, ["pr", "close", String(action.prNumber), "--repo", fixedRepository], execute);
  const after = stablePr(config, action.prNumber, execute);
  assertPrIdentity(after, action);
  if (after.state !== "CLOSED" || after.mergedAt)
    throw new Error("GitHub did not confirm the expected closed, unmerged PR state");
  return result(`Closed upstream PR #${after.number}.`, [`Head matched ${after.headRefOid}.`, "No branch was deleted and no comment was added."], after.url);
}

function executeMerge(config, action, execute) {
  let before = stablePr(config, action.prNumber, execute);
  assertPrIdentity(before, action);
  if (before.state === "MERGED" && before.mergedAt)
    return result(`PR #${before.number} was already merged.`, [`Merged at ${before.mergedAt}.`, `Head matched ${before.headRefOid}.`], before.url);
  if (before.state !== "OPEN")
    throw new Error(`pull request is ${before.state.toLowerCase()}, not open`);
  if (before.mergeable === "CONFLICTING")
    throw new Error("pull request has merge conflicts");
  if (before.reviewDecision === "CHANGES_REQUESTED")
    throw new Error("pull request has changes requested");
  if (before.isDraft) {
    runGh(config, ["pr", "ready", String(action.prNumber), "--repo", fixedRepository], execute);
    before = stablePr(config, action.prNumber, execute);
    assertPrIdentity(before, action);
    if (before.isDraft)
      throw new Error("pull request could not be verified ready at the expected head");
  }
  const method = action.mergeMethod ?? "merge";
  const mergeResponse = JSON.parse(runGh(config, [
    "api", "--method", "PUT", `repos/${fixedRepository}/pulls/${action.prNumber}/merge`,
    "-f", `sha=${action.expectedHeadSha}`, "-f", `merge_method=${method}`
  ], execute));
  if (mergeResponse.merged !== true)
    throw new Error(`GitHub refused the immediate merge: ${String(mergeResponse.message ?? "requirements were not satisfied").slice(0, 500)}`);
  const after = stablePr(config, action.prNumber, execute);
  assertPrIdentity(after, action);
  if (after.state === "MERGED" && after.mergedAt)
    return result(`Merged upstream PR #${after.number} using ${method}.`, [`Head matched ${after.headRefOid}.`, `Merged at ${after.mergedAt}.`, `Base branch: ${after.baseRefName}.`], after.url);
  throw new Error("GitHub did not confirm the immediate merged state");
}

function branch(config, name, execute) {
  if (!branchPattern.test(name ?? ""))
    throw new Error("branch name is invalid");
  const encoded = name.split("/").map(encodeURIComponent).join("/");
  return JSON.parse(runGh(config, ["api", `repos/${fixedRepository}/branches/${encoded}`], execute));
}

function executeOpen(config, action, execute) {
  if (!branchPattern.test(action.headBranch ?? "") || !branchPattern.test(action.baseBranch ?? "") || action.headBranch === action.baseBranch)
    throw new Error("head and base must be distinct valid upstream branches");
  if (typeof action.title !== "string" || !action.title.trim() || action.title.length > 200)
    throw new Error("pull request title is invalid");
  const headFirst = branch(config, action.headBranch, execute);
  const baseFirst = branch(config, action.baseBranch, execute);
  const headSecond = branch(config, action.headBranch, execute);
  const baseSecond = branch(config, action.baseBranch, execute);
  if (headFirst.commit?.sha !== headSecond.commit?.sha || baseFirst.commit?.sha !== baseSecond.commit?.sha
    || !headShaPattern.test(headSecond.commit?.sha ?? "") || !headShaPattern.test(baseSecond.commit?.sha ?? ""))
    throw new Error("upstream branch moved or could not be resolved stably");
  const existing = JSON.parse(runGh(config, [
    "pr", "list", "--repo", fixedRepository, "--head", action.headBranch,
    "--base", action.baseBranch, "--state", "open", "--json",
    "number,url,state,isDraft,headRefOid,headRepositoryOwner,baseRefName"
  ], execute) || "[]");
  if (existing.length > 1)
    throw new Error("multiple open pull requests already match these upstream branches");
  let url;
  if (existing.length === 1) {
    url = existing[0].url;
  } else {
    const args = [
      "pr", "create", "--repo", fixedRepository, "--head", action.headBranch,
      "--base", action.baseBranch, "--title", action.title.trim(),
      "--body", `Owner-requested upstream branch PR via Cameo Dispatcher action ${action.id}. Merge remains separately owner-authorized.`
    ];
    if (action.draft !== false)
      args.push("--draft");
    url = runGh(config, args, execute);
  }
  if (!/^https:\/\/github\.com\/cameo-mod\/Cameo-mod\/pull\/\d+$/i.test(url))
    throw new Error("GitHub returned an unexpected pull request URL");
  const number = Number(url.match(/\/pull\/(\d+)$/)[1]);
  const verified = stablePr(config, number, execute);
  if (verified.state !== "OPEN" || verified.headRefName !== action.headBranch
    || verified.headRefOid !== headSecond.commit.sha || verified.baseRefName !== action.baseBranch
    || verified.headRepositoryOwner?.login?.toLowerCase() !== "cameo-mod")
    throw new Error("created pull request did not match the verified upstream branches");
  return result(`Opened upstream branch PR #${verified.number}${verified.isDraft ? " as a draft" : ""}.`, [`Head ${action.headBranch}: ${verified.headRefOid}.`, `Base ${action.baseBranch}: ${baseSecond.commit.sha}.`], verified.url);
}

export function executeGithubAction(config, action, dependencies = {}) {
  assertAction(config, action);
  if (["close", "merge"].includes(action.action)
    && ![action.expectedHeadSha, action.headOwner, action.headBranch, action.baseBranch].every(Boolean))
    throw new Error("GitHub action must be durably resolved before mutation");
  const execute = dependencies.execute ?? spawnSync;
  if (action.action === "close")
    return executeClose(config, action, execute);
  if (action.action === "merge")
    return executeMerge(config, action, execute);
  return executeOpen(config, action, execute);
}
