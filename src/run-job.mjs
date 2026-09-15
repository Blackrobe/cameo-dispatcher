import path from "node:path";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  assertPathWithin,
  atomicWriteJson,
  buildWorkerPrompt,
  mapWorkerResultState,
  readJson,
  validateConfig,
  validateJob
} from "./lib.mjs";
import { acquireRunnerLock, releaseRunnerLock } from "./runner-lock.mjs";
import { waitForChildWithTimeout } from "./process-timeout.mjs";
import { findActiveSessionFile } from "./session-registry.mjs";
import { codexExecutionArgs } from "./codex-policy.mjs";
import { ensureTemporaryArtifactIgnore, publishCandidate, reviewCandidate } from "./candidate-controller.mjs";
import { startGhReadBroker } from "./gh-read-broker.mjs";
import { sanitizeWorkerEnvironment } from "./worker-service-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const resultSchemaPath = path.join(projectRoot, "schemas", "result.schema.json");

function runGit(repoRoot, args, gitBin = "git") {
  const result = spawnSync(gitBin, ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);

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

async function runCodex(config, job, worktreePath, prompt, eventPath, diagnosticPath, finalPath) {
  const broker = await startGhReadBroker({
    config, job, worktreePath,
    auditPath: path.join(path.dirname(eventPath), "gh-broker-audit.jsonl"),
    phase: "implementation"
  });
  try {
    const eventStream = createWriteStream(eventPath, { flags: "wx" });
    const diagnosticStream = createWriteStream(diagnosticPath, { flags: "wx" });
    const args = codexExecutionArgs(job, worktreePath, resultSchemaPath, finalPath);
    args.push(prompt);
    const child = spawn(config.codexBin, args, {
      cwd: worktreePath,
      env: broker.environment(sanitizeWorkerEnvironment(process.env)),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.pipe(eventStream);
    child.stderr.pipe(diagnosticStream);
    const execution = await waitForChildWithTimeout(child, config.maxJobMinutes * 60 * 1000);
    await Promise.all([finished(eventStream), finished(diagnosticStream)]);
    return execution;
  } finally {
    await broker.stop();
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

async function main() {
  const [configArgument, jobArgument] = process.argv.slice(2);
  if (!configArgument || !jobArgument)
    throw new Error("usage: node src/run-job.mjs <config.json> <job.json>");

  const configPath = path.resolve(configArgument);
  const jobPath = path.resolve(jobArgument);
  const config = validateConfig(await readJson(configPath));
  const job = validateJob(await readJson(jobPath));

  const jobsRoot = path.join(config.stateRoot, "jobs");
  const jobStateRoot = path.join(jobsRoot, job.requestId);
  const worktreePath = path.join(config.worktreeRoot, job.requestId);
  assertPathWithin(jobsRoot, jobStateRoot, "job state path");
  assertPathWithin(config.worktreeRoot, worktreePath, "worktree path");

  await mkdir(config.stateRoot, { recursive: true });
  await mkdir(jobsRoot, { recursive: true });
  await mkdir(config.worktreeRoot, { recursive: true });

  const lockPath = path.join(config.stateRoot, "runner.lock");
  const lockHandle = await acquireRunnerLock(lockPath);

  const statusPath = path.join(jobStateRoot, "status.json");
  try {
    if (await exists(statusPath)) {
      const existingStatus = await readFile(statusPath, "utf8");
      process.stdout.write(existingStatus);
      return;
    }

    await mkdir(jobStateRoot, { recursive: false });
    const baseCommit = runGit(config.repoRoot, ["rev-parse", "--verify", `${config.baseRef}^{commit}`], config.gitBin);

    await atomicWriteJson(statusPath, {
      requestId: job.requestId,
      state: "preparing",
      baseRef: config.baseRef,
      baseCommit,
      worktreePath,
      createdAt: new Date().toISOString()
    });

    if (await exists(worktreePath))
      throw new Error(`worktree path already exists without a completed job record: ${worktreePath}`);

    ensureTemporaryArtifactIgnore(config.repoRoot, config.gitBin);
    runGit(config.repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommit], config.gitBin);

    const eventPath = path.join(jobStateRoot, "events.jsonl");
    const diagnosticPath = path.join(jobStateRoot, "diagnostics.log");
    const finalPath = path.join(jobStateRoot, "final.json");
    const prompt = buildWorkerPrompt(job, baseCommit);

    await atomicWriteJson(statusPath, {
      requestId: job.requestId,
      state: "running",
      baseRef: config.baseRef,
      baseCommit,
      worktreePath,
      finalPath,
      executionMode: job.executionMode,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      modelSource: job.modelSource,
      startedAt: new Date().toISOString()
    });

    const execution = await runCodex(config, job, worktreePath, prompt, eventPath, diagnosticPath, finalPath);
    const { exitCode, timedOut } = execution;
    let gitStatus = runGit(worktreePath, ["status", "--short"], config.gitBin);
    let finalExists = await exists(finalPath);
    let finalResult = finalExists ? await readJson(finalPath) : null;

    let state = "failed";
    let resultMappingError = null;
    if (timedOut) {
      state = "needs_attention";
      finalResult = {
        status: "needs_attention",
        summary: `The owner-controlled ${config.maxJobMinutes}-minute job limit expired. The retained worktree and diagnostics require review before any retry.`,
        changedFiles: gitStatus === "" ? [] : gitStatus.split(/\r?\n/),
        validation: [],
        risks: ["The interrupted Codex run may have incomplete local reasoning or file operations."],
        nextAction: "Review the retained worktree and diagnostics, then submit a new job only if safe."
      };
      await atomicWriteJson(finalPath, finalResult);
      finalExists = true;
    } else if (exitCode === 0 && finalResult !== null) {
      try {
        state = mapWorkerResultState(finalResult);
      } catch (error) {
        resultMappingError = error.message;
      }
    }
    const codexThreadId = await extractCodexThreadId(eventPath);
    const sessionFilePath = codexThreadId ? await findActiveSessionFile(codexThreadId, undefined, worktreePath) : null;
    await atomicWriteJson(path.join(jobStateRoot, "execution-provenance.json"), {
      codexThreadId, sessionFilePath, eventPath, diagnosticPath, finalPath,
      exitCode, timedOut, model: job.model, reasoningEffort: job.reasoningEffort,
      modelSource: job.modelSource, recordedAt: new Date().toISOString()
    });
    let reviewer = null;
    let publication = null;
    if (state === "ready_for_review" && job.executionMode === "read_only" && gitStatus) {
      state = "needs_attention";
      finalResult = {
        status: "needs_attention",
        summary: "The read-only job changed the isolated worktree.",
        changedFiles: gitStatus.split(/\r?\n/), validation: [],
        risks: ["No publication was attempted."],
        nextAction: "Review the retained worktree and diagnostics."
      };
      await atomicWriteJson(finalPath, finalResult);
    } else if (state === "ready_for_review" && job.executionMode === "draft_pr") {
      try {
        const reviewed = await reviewCandidate({
          config, job, worktreePath, stateRoot: jobStateRoot, expectedHead: baseCommit, environment: sanitizeWorkerEnvironment(process.env)
        });
        reviewer = reviewed.review;
        if (reviewed.candidate.paths.length > 0) {
          publication = await publishCandidate({ config, job, worktreePath, rootStateRoot: jobStateRoot, expectedHead: baseCommit, candidate: reviewed.candidate });
          finalResult.nextAction = `Review the draft PR: ${publication.prUrl}`;
          await atomicWriteJson(finalPath, finalResult);
        }
        gitStatus = runGit(worktreePath, ["status", "--short"], config.gitBin);
      } catch (error) {
        state = "needs_attention";
        resultMappingError = error.message;
        finalResult = {
          status: "needs_attention",
          summary: `The edit candidate was retained but not safely published: ${error.message}`,
          changedFiles: gitStatus ? gitStatus.split(/\r?\n/) : [],
          validation: [], risks: ["No merge was attempted."],
          nextAction: "Inspect the retained candidate, review artifacts, and publication state."
        };
        await atomicWriteJson(finalPath, finalResult);
      }
    }
    const completedStatus = {
      requestId: job.requestId,
      state,
      baseRef: config.baseRef,
      baseCommit,
      headAfter: runGit(worktreePath, ["rev-parse", "HEAD"], config.gitBin),
      worktreePath,
      exitCode,
      timedOut,
      codexThreadId,
      sessionFilePath,
      gitStatus: gitStatus === "" ? [] : gitStatus.split(/\r?\n/),
      eventPath,
      diagnosticPath,
      finalPath: finalExists ? finalPath : null,
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
    if (await exists(jobStateRoot)) {
      await atomicWriteJson(statusPath, {
        requestId: job.requestId,
        state: "failed",
        error: error.message,
        failedAt: new Date().toISOString()
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
