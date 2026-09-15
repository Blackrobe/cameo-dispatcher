import path from "node:path";
import { readFile } from "node:fs/promises";

import { atomicWriteJson, readJson, validateConfig, validateFollowupJob, validateJob } from "./lib.mjs";
import { publishCandidate } from "./candidate-controller.mjs";
import { acquireRunnerLock, releaseRunnerLock } from "./runner-lock.mjs";

async function main() {
  const [configArgument, jobArgument, statusArgument] = process.argv.slice(2);
  if (!configArgument || !jobArgument || !statusArgument)
    throw new Error("usage: node src/recover-publication.mjs <config.json> <job.json> <status.json>");
  const config = validateConfig(await readJson(path.resolve(configArgument)));
  const rawJob = await readJson(path.resolve(jobArgument));
  const job = rawJob.runKind === "followup" ? validateFollowupJob(rawJob) : validateJob(rawJob);
  const lockPath = path.join(config.stateRoot, "runner.lock");
  const lockHandle = await acquireRunnerLock(lockPath);
  try {
    const statusPath = path.resolve(statusArgument);
    const status = await readJson(statusPath);
    if (!new Set(["running", "needs_attention"]).has(status.state))
      throw new Error("only an interrupted or transiently failed publication can be recovered");
    const rootStateRoot = job.runKind === "followup"
      ? path.join(config.stateRoot, "jobs", job.rootRequestId)
      : path.join(config.stateRoot, "jobs", job.requestId);
    const publication = await readJson(path.join(rootStateRoot, "publication.json"));
    if (!new Set(["preparing", "committed", "published"]).has(publication.state)
      || !Array.isArray(publication.paths)
      || publication.requestId !== job.requestId
      || publication.runRevision !== (job.runRevision ?? 1))
      throw new Error("publication journal does not belong to this exact run");
    const recovered = await publishCandidate({
      config, job, worktreePath: status.worktreePath, rootStateRoot,
      expectedHead: publication.expectedParent,
      candidate: { paths: publication.paths, candidateHash: publication.candidateHash }
    });
    const finalResult = JSON.parse(await readFile(status.finalPath, "utf8"));
    finalResult.nextAction = `Review the draft PR: ${recovered.prUrl}`;
    await atomicWriteJson(status.finalPath, finalResult);
    const executionRoot = job.runKind === "followup" ? path.dirname(statusPath) : rootStateRoot;
    const execution = await readJson(path.join(executionRoot, "execution-provenance.json"));
    const reviewer = await readJson(path.join(executionRoot, "review-provenance.json"));
    const completed = {
      ...status, state: "ready_for_review", headAfter: recovered.lastCommit,
      gitStatus: [], publication: recovered,
      codexThreadId: execution.codexThreadId, sessionFilePath: execution.sessionFilePath,
      eventPath: execution.eventPath, diagnosticPath: execution.diagnosticPath,
      reviewer, recoveredPublication: true, completedAt: new Date().toISOString()
    };
    await atomicWriteJson(statusPath, completed);
    process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
  } finally {
    await releaseRunnerLock(lockHandle, lockPath);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
