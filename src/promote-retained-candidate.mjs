import path from "node:path";

import { atomicWriteJson, readJson, validateConfig, validateJob } from "./lib.mjs";
import { publishCandidate, reviewCandidate } from "./candidate-controller.mjs";
import { sanitizeWorkerEnvironment } from "./worker-service-lib.mjs";

const [configArgument, jobArgument] = process.argv.slice(2);
if (!configArgument || !jobArgument)
  throw new Error("usage: node src/promote-retained-candidate.mjs <config.json> <job.json>");
const config = validateConfig(await readJson(path.resolve(configArgument)));
const job = validateJob(await readJson(path.resolve(jobArgument)));
const rootStateRoot = path.join(config.stateRoot, "jobs", job.requestId);
const statusPath = path.join(rootStateRoot, "status.json");
const status = await readJson(statusPath);
const finalResult = await readJson(status.finalPath);
if (status.state !== "needs_attention" || status.headAfter !== status.baseCommit || status.publication)
  throw new Error("retained candidate is not eligible for bounded promotion");
const reviewed = await reviewCandidate({
  config, job, worktreePath: status.worktreePath, stateRoot: rootStateRoot,
  expectedHead: status.baseCommit, environment: sanitizeWorkerEnvironment(process.env)
});
if (reviewed.candidate.paths.length === 0)
  throw new Error("retained candidate has no publishable changes");
const reported = [...new Set(finalResult.changedFiles ?? [])].sort();
if (JSON.stringify(reported) !== JSON.stringify(reviewed.candidate.paths))
  throw new Error("retained candidate differs from the model-reported changed files");
const publication = await publishCandidate({
  config, job, worktreePath: status.worktreePath, rootStateRoot,
  expectedHead: status.baseCommit, candidate: reviewed.candidate
});
finalResult.status = "completed";
finalResult.risks = (finalResult.risks ?? []).filter(value => !/cleanup|temporary audit/i.test(value));
finalResult.validation = [...(finalResult.validation ?? []), "Trusted controller excluded the verified untracked audit directory and independent Astra review approved the final candidate."];
finalResult.nextAction = `Review the draft PR and perform the listed in-game visual checks: ${publication.prUrl}`;
await atomicWriteJson(status.finalPath, finalResult);
const completed = {
  ...status,
  state: "ready_for_review",
  headAfter: publication.lastCommit,
  gitStatus: [],
  resultMappingError: null,
  reviewer: reviewed.review,
  publication,
  controllerPromotion: true,
  completedAt: new Date().toISOString()
};
await atomicWriteJson(statusPath, completed);
process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
