import path from "node:path";
import { access, mkdir, readdir } from "node:fs/promises";

import { assertPathWithin, atomicWriteJson, readJson } from "./lib.mjs";
import { acquireRunnerLock, releaseRunnerLock } from "./runner-lock.mjs";

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

export function githubActionPaths(localConfig, actionId) {
  if (!/^CGA-[0-9]{8}-[A-Z0-9]{8}$/.test(actionId ?? ""))
    throw new Error("GitHub action ID is invalid");
  const root = path.join(localConfig.stateRoot, "github-actions");
  const actionRoot = path.join(root, actionId);
  assertPathWithin(root, actionRoot, "GitHub action state path");
  return {
    root, actionRoot,
    intentPath: path.join(actionRoot, "intent.json"),
    resolvedPath: path.join(actionRoot, "resolved.json"),
    outcomePath: path.join(actionRoot, "outcome.json"),
    deliveredPath: path.join(actionRoot, "delivered.json")
  };
}

export function githubActionIntent(action) {
  return {
    id: action.id,
    interactionId: action.interactionId,
    rootJobId: action.rootJobId ?? null,
    requesterDiscordId: action.requesterDiscordId,
    action: action.action,
    repository: action.repository,
    prNumber: action.prNumber ?? null,
    prUrl: action.prUrl ?? null,
    expectedHeadSha: action.expectedHeadSha ?? null,
    proposalIdentityDigest: action.proposalIdentityDigest ?? null,
    headOwner: action.headOwner ?? null,
    headBranch: action.headBranch ?? null,
    baseBranch: action.baseBranch ?? null,
    title: action.title ?? null,
    draft: action.draft ?? true,
    mergeMethod: action.mergeMethod ?? null
  };
}

export async function runJournaledGithubAction(localConfig, action, executeAction) {
  const paths = githubActionPaths(localConfig, action.id);
  await mkdir(paths.actionRoot, { recursive: true });
  const intent = githubActionIntent(action);
  if (await exists(paths.intentPath)) {
    const retained = await readJson(paths.intentPath);
    if (JSON.stringify(retained) !== JSON.stringify(intent))
      throw new Error("retained GitHub action intent differs from the server claim");
  } else {
    await atomicWriteJson(paths.intentPath, intent);
  }
  if (await exists(paths.outcomePath))
    return readJson(paths.outcomePath);
  let outcome;
  try {
    outcome = { state: "ready_for_review", result: await executeAction(action), error: null };
  } catch (error) {
    outcome = {
      state: "needs_attention",
      result: {
        status: "needs_attention",
        summary: `GitHub controller action stopped: ${String(error.message).slice(0, 4000)}`,
        changedFiles: [], validation: [],
        risks: ["GitHub remains authoritative; inspect the PR before retrying because a remote acknowledgement may have been interrupted."],
        nextAction: action.prUrl ?? (action.prNumber ? `https://github.com/cameo-mod/Cameo-mod/pull/${action.prNumber}` : null)
      },
      error: String(error.message).slice(0, 4000)
    };
  }
  await atomicWriteJson(paths.outcomePath, outcome);
  return outcome;
}

export async function runLockedJournaledGithubAction(localConfig, action, executeAction, resolveAction = async value => value) {
  return runJournaledGithubAction(localConfig, action, async retainedAction => {
    const lockPath = path.join(localConfig.stateRoot, "runner.lock");
    const lockHandle = await acquireRunnerLock(lockPath);
    try {
      const paths = githubActionPaths(localConfig, retainedAction.id);
      if (await exists(paths.resolvedPath))
        throw new Error("GitHub action identity was resolved before an interrupted run; inspect GitHub state instead of replaying the mutation");
      const resolved = await resolveAction(retainedAction);
      if (resolved.id !== retainedAction.id || resolved.action !== retainedAction.action
        || resolved.repository !== retainedAction.repository || resolved.prNumber !== retainedAction.prNumber)
        throw new Error("resolved GitHub action differs from the owner-authorized target");
      await atomicWriteJson(paths.resolvedPath, githubActionIntent(resolved));
      return await executeAction(resolved);
    } finally {
      await releaseRunnerLock(lockHandle, lockPath);
    }
  });
}

export async function reconcileGithubActionOutcomes(localConfig, postOutcome, onlyAction = null) {
  const root = path.join(localConfig.stateRoot, "github-actions");
  if (!await exists(root))
    return false;
  const ids = onlyAction ? [onlyAction.id] : (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^CGA-[0-9]{8}-[A-Z0-9]{8}$/.test(entry.name))
    .map(entry => entry.name);
  let reconciled = false;
  for (const id of ids) {
    const paths = githubActionPaths(localConfig, id);
    if (!await exists(paths.outcomePath) || await exists(paths.deliveredPath))
      continue;
    const intent = await readJson(paths.intentPath);
    const outcome = await readJson(paths.outcomePath);
    await postOutcome({ ...intent, id }, outcome);
    await atomicWriteJson(paths.deliveredPath, { deliveredAt: new Date().toISOString() });
    reconciled = true;
  }
  return reconciled;
}
