import path from "node:path";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  assertPathWithin,
  atomicWriteJson,
  buildFollowupPrompt,
  mapWorkerResultState,
  readJson,
  validateConfig,
  validateFollowupJob
} from "./lib.mjs";
import { acquireRunnerLock, releaseRunnerLock } from "./runner-lock.mjs";
import { waitForChildWithTimeout } from "./process-timeout.mjs";
import { findActiveSessionFile } from "./session-registry.mjs";
import { codexExecutionArgs } from "./codex-policy.mjs";
import { publishCandidate, reviewCandidate } from "./candidate-controller.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const resultSchemaPath = path.join(projectRoot, "schemas", "result.schema.json");

class NeedsAttentionError extends Error {}

function runGit(repoRoot, args, gitBin = "git") {
  const result = spawnSync(gitBin, ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0)
    throw new NeedsAttentionError(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function extractCodexThreadId(eventPath) {
  const contents = await readFile(eventPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim())
      continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && typeof event.thread_id === "string")
        return event.thread_id;
    } catch {
      // The complete event stream remains available for diagnostics.
    }
  }
  return null;
}

async function runCodex(config, job, worktreePath, baseCommit, eventPath, diagnosticPath, finalPath) {
  const eventStream = createWriteStream(eventPath, { flags: "wx" });
  const diagnosticStream = createWriteStream(diagnosticPath, { flags: "wx" });
  const args = codexExecutionArgs(job, worktreePath, resultSchemaPath, finalPath);
  args.push("resume", job.resumeSessionId, buildFollowupPrompt(job, baseCommit));
  const child = spawn(config.codexBin, args, {
    cwd: worktreePath,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(eventStream);
  child.stderr.pipe(diagnosticStream);
  const execution = await waitForChildWithTimeout(child, config.maxJobMinutes * 60 * 1000);
  await Promise.all([finished(eventStream), finished(diagnosticStream)]);
  return execution;
}

function needsAttentionResult(message, gitStatus = [], replacementPossible = false) {
  return {
    status: "needs_attention",
    summary: message,
    changedFiles: gitStatus,
    validation: [],
    risks: [replacementPossible
      ? "Codex emitted a different session UUID; inspect the retained diagnostics for a possible unintended session."
      : "No replacement session or worktree was created."],
    nextAction: "Review the retained dispatcher session and worktree before retrying this follow-up."
  };
}

async function main() {
  const [configArgument, jobArgument] = process.argv.slice(2);
  if (!configArgument || !jobArgument)
    throw new Error("usage: node src/run-followup.mjs <config.json> <job.json>");

  const configPath = path.resolve(configArgument);
  const jobPath = path.resolve(jobArgument);
  const config = validateConfig(await readJson(configPath));
  const job = validateFollowupJob(await readJson(jobPath));
  const jobsRoot = path.join(config.stateRoot, "jobs");
  const rootStateRoot = path.join(jobsRoot, job.rootRequestId);
  const runStateRoot = path.join(rootStateRoot, "runs", String(job.runRevision));
  const expectedWorktree = path.join(config.worktreeRoot, job.rootRequestId);
  assertPathWithin(jobsRoot, rootStateRoot, "root job state path");
  assertPathWithin(rootStateRoot, runStateRoot, "follow-up state path");
  assertPathWithin(config.worktreeRoot, expectedWorktree, "retained worktree path");

  await mkdir(path.dirname(runStateRoot), { recursive: true });
  const lockPath = path.join(config.stateRoot, "runner.lock");
  const lockHandle = await acquireRunnerLock(lockPath);
  const statusPath = path.join(runStateRoot, "status.json");
  let runRootExists = false;

  try {
    if (await exists(statusPath)) {
      process.stdout.write(await readFile(statusPath, "utf8"));
      return;
    }
    await mkdir(runStateRoot, { recursive: false });
    runRootExists = true;

    const rootStatusPath = path.join(rootStateRoot, "status.json");
    if (!await exists(rootStatusPath))
      throw new NeedsAttentionError("The dispatcher-owned root session record is missing.");
    const rootStatus = await readJson(rootStatusPath);
    if (rootStatus.state !== "ready_for_review")
      throw new NeedsAttentionError("The dispatcher-owned root run is not ready for continuation.");
    if (rootStatus.codexThreadId !== job.resumeSessionId)
      throw new NeedsAttentionError("The stored session UUID does not match the dispatcher-owned local root record.");
    const activeSessionFile = await findActiveSessionFile(job.resumeSessionId, undefined, expectedWorktree);
    if (!activeSessionFile)
      throw new NeedsAttentionError("The dispatcher-owned session is unavailable from the active Codex session store.");
    if (rootStatus.sessionFilePath && path.resolve(rootStatus.sessionFilePath) !== activeSessionFile)
      throw new NeedsAttentionError("The active session file no longer matches the dispatcher-owned local root record.");
    if (path.resolve(rootStatus.worktreePath ?? "") !== path.resolve(expectedWorktree))
      throw new NeedsAttentionError("The retained worktree path does not match the dispatcher-owned local root record.");
    if (!await exists(expectedWorktree))
      throw new NeedsAttentionError("The retained dispatcher worktree is unavailable.");

    const baseCommit = rootStatus.baseCommit;
    const continuationPath = path.join(rootStateRoot, "continuation.json");
    const continuation = await exists(continuationPath) ? await readJson(continuationPath) : null;
    const expectedHead = continuation?.expectedHead ?? baseCommit;
    const headBefore = runGit(expectedWorktree, ["rev-parse", "HEAD"], config.gitBin);
    if (headBefore !== expectedHead)
      throw new NeedsAttentionError("The retained worktree HEAD no longer matches the last controller-owned commit.");
    const initialStatus = runGit(expectedWorktree, ["status", "--short"], config.gitBin);
    if (initialStatus)
      throw new NeedsAttentionError("The retained worktree is not clean; automatic continuation is unsafe.");

    const eventPath = path.join(runStateRoot, "events.jsonl");
    const diagnosticPath = path.join(runStateRoot, "diagnostics.log");
    const finalPath = path.join(runStateRoot, "final.json");
    await atomicWriteJson(statusPath, {
      requestId: job.requestId,
      parentJobId: job.parentJobId,
      rootRequestId: job.rootRequestId,
      runRevision: job.runRevision,
      state: "running",
      baseCommit,
      worktreePath: expectedWorktree,
      codexThreadId: job.resumeSessionId,
      sessionFilePath: activeSessionFile,
      finalPath,
      executionMode: job.executionMode,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      modelSource: job.modelSource,
      startedAt: new Date().toISOString()
    });

    const { exitCode, timedOut } = await runCodex(
      config, job, expectedWorktree, baseCommit, eventPath, diagnosticPath, finalPath
    );
    const gitStatusText = runGit(expectedWorktree, ["status", "--short"], config.gitBin);
    let gitStatus = gitStatusText ? gitStatusText.split(/\r?\n/) : [];
    const headAfter = runGit(expectedWorktree, ["rev-parse", "HEAD"], config.gitBin);
    let finalResult = await exists(finalPath) ? await readJson(finalPath) : null;
    const emittedSessionId = await extractCodexThreadId(eventPath);
    let state = "failed";
    let resultMappingError = null;

    if (timedOut) {
      state = "needs_attention";
      finalResult = needsAttentionResult(`The owner-controlled ${config.maxJobMinutes}-minute follow-up limit expired.`, gitStatus);
      await atomicWriteJson(finalPath, finalResult);
    } else if (emittedSessionId !== job.resumeSessionId) {
      state = "needs_attention";
      finalResult = needsAttentionResult("Codex did not resume the exact dispatcher-owned session UUID.", gitStatus, true);
      await atomicWriteJson(finalPath, finalResult);
    } else if (job.executionMode === "read_only" && (headAfter !== headBefore || gitStatus.length > 0)) {
      state = "needs_attention";
      finalResult = needsAttentionResult("The read-only continuation changed the retained worktree state.", gitStatus);
      await atomicWriteJson(finalPath, finalResult);
    } else if (exitCode === 0 && finalResult !== null) {
      try {
        state = mapWorkerResultState(finalResult);
      } catch (error) {
        resultMappingError = error.message;
      }
    }

    await atomicWriteJson(path.join(runStateRoot, "execution-provenance.json"), {
      codexThreadId: emittedSessionId, sessionFilePath: activeSessionFile,
      eventPath, diagnosticPath, finalPath, exitCode, timedOut,
      model: job.model, reasoningEffort: job.reasoningEffort,
      modelSource: job.modelSource, recordedAt: new Date().toISOString()
    });

    let reviewer = null;
    let publication = null;
    if (state === "ready_for_review" && job.executionMode === "draft_pr") {
      try {
        const reviewed = await reviewCandidate({
          config, job, worktreePath: expectedWorktree, stateRoot: runStateRoot,
          expectedHead: headBefore, environment: process.env
        });
        reviewer = reviewed.review;
        if (reviewed.candidate.paths.length > 0) {
          publication = await publishCandidate({
            config, job, worktreePath: expectedWorktree, rootStateRoot,
            expectedHead: headBefore, candidate: reviewed.candidate
          });
          finalResult.nextAction = `Review the draft PR: ${publication.prUrl}`;
          await atomicWriteJson(finalPath, finalResult);
          const postPublicationStatus = runGit(expectedWorktree, ["status", "--short"], config.gitBin);
          gitStatus = postPublicationStatus ? postPublicationStatus.split(/\r?\n/) : [];
        }
      } catch (error) {
        state = "needs_attention";
        resultMappingError = error.message;
        finalResult = needsAttentionResult(`The continuation candidate was retained but not safely published: ${error.message}`, gitStatus);
        await atomicWriteJson(finalPath, finalResult);
      }
    }

    const completedStatus = {
      requestId: job.requestId,
      parentJobId: job.parentJobId,
      rootRequestId: job.rootRequestId,
      runRevision: job.runRevision,
      state,
      baseCommit,
      headBefore,
      headAfter: runGit(expectedWorktree, ["rev-parse", "HEAD"], config.gitBin),
      worktreePath: expectedWorktree,
      exitCode,
      timedOut,
      codexThreadId: emittedSessionId,
      sessionFilePath: activeSessionFile,
      gitStatus,
      eventPath,
      diagnosticPath,
      finalPath: await exists(finalPath) ? finalPath : null,
      resultMappingError,
      executionMode: job.executionMode,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      modelSource: job.modelSource,
      reviewer,
      publication,
      completedAt: new Date().toISOString()
    };
    await atomicWriteJson(statusPath, completedStatus);
    process.stdout.write(`${JSON.stringify(completedStatus, null, 2)}\n`);
    if (state !== "ready_for_review")
      process.exitCode = 1;
  } catch (error) {
    if (runRootExists) {
      const finalPath = path.join(runStateRoot, "final.json");
      const finalResult = needsAttentionResult(error.message);
      await atomicWriteJson(finalPath, finalResult);
      await atomicWriteJson(statusPath, {
        requestId: job.requestId,
        parentJobId: job.parentJobId,
        rootRequestId: job.rootRequestId,
        runRevision: job.runRevision,
        state: error instanceof NeedsAttentionError ? "needs_attention" : "failed",
        codexThreadId: job.resumeSessionId,
        worktreePath: expectedWorktree,
        finalPath,
        error: error.message,
        completedAt: new Date().toISOString()
      });
    }
    throw error;
  } finally {
    await releaseRunnerLock(lockHandle, lockPath);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
