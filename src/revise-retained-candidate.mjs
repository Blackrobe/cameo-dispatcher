import path from "node:path";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { atomicWriteJson, buildFollowupPrompt, readJson, validateConfig, validateJob } from "./lib.mjs";
import { codexExecutionArgs } from "./codex-policy.mjs";
import { publishCandidate, reviewCandidate } from "./candidate-controller.mjs";
import { sanitizeWorkerEnvironment } from "./worker-service-lib.mjs";
import { waitForChildWithTimeout } from "./process-timeout.mjs";

const [configArgument, jobArgument] = process.argv.slice(2);
if (!configArgument || !jobArgument)
  throw new Error("usage: node src/revise-retained-candidate.mjs <config.json> <job.json>");
const config = validateConfig(await readJson(path.resolve(configArgument)));
const rootJob = validateJob(await readJson(path.resolve(jobArgument)));
const rootState = path.join(config.stateRoot, "jobs", rootJob.requestId);
const statusPath = path.join(rootState, "status.json");
const status = await readJson(statusPath);
const review = await readJson(path.join(rootState, "review-final.json"));
if (status.state !== "needs_attention" || review.verdict !== "needs_attention" || !status.codexThreadId)
  throw new Error("retained candidate has no actionable independent review");
const revision = 2;
const revisionState = path.join(rootState, "controller-revisions", String(revision));
const eventPath = path.join(revisionState, "events.jsonl");
const diagnosticPath = path.join(revisionState, "diagnostics.log");
const finalPath = path.join(revisionState, "final.json");
await import("node:fs/promises").then(module => module.mkdir(revisionState, { recursive: true }));
const job = { ...rootJob, runKind: "followup", parentJobId: rootJob.requestId, rootRequestId: rootJob.requestId, runRevision: revision, resumeSessionId: status.codexThreadId };
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = codexExecutionArgs(job, status.worktreePath, path.join(projectRoot, "schemas", "result.schema.json"), finalPath);
const findings = [...(review.findings ?? []), ...(review.validationGaps ?? [])];
args.push("resume", status.codexThreadId, `${buildFollowupPrompt(job, status.baseCommit)}\n\nIndependent review blocked publication. Correct every supported finding below, validate the final active behavior, and preserve the existing asset work. Do not publish.\n${findings.map(value => `- ${value}`).join("\n")}`);
const events = createWriteStream(eventPath, { flags: "wx" });
const diagnostics = createWriteStream(diagnosticPath, { flags: "wx" });
const child = spawn(config.codexBin, args, { cwd: status.worktreePath, env: sanitizeWorkerEnvironment(process.env), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(events); child.stderr.pipe(diagnostics);
const execution = await waitForChildWithTimeout(child, config.maxJobMinutes * 60 * 1000);
await Promise.all([finished(events), finished(diagnostics)]);
if (execution.timedOut || execution.exitCode !== 0)
  throw new Error("corrective continuation did not complete successfully");
const emitted = (await readFile(eventPath, "utf8")).split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.type === "thread.started")?.thread_id;
if (emitted !== status.codexThreadId)
  throw new Error("corrective continuation did not preserve the exact session UUID");
const finalResult = await readJson(finalPath);
if (finalResult.status !== "completed")
  throw new Error(`corrective continuation did not complete: ${finalResult.summary}`);
const reviewed = await reviewCandidate({ config, job, worktreePath: status.worktreePath, stateRoot: revisionState, expectedHead: status.baseCommit, environment: sanitizeWorkerEnvironment(process.env) });
const publication = await publishCandidate({ config, job, worktreePath: status.worktreePath, rootStateRoot: rootState, expectedHead: status.baseCommit, candidate: reviewed.candidate });
finalResult.nextAction = `Review the draft PR and perform the listed in-game visual checks: ${publication.prUrl}`;
await atomicWriteJson(finalPath, finalResult);
await atomicWriteJson(status.finalPath, finalResult);
const completed = { ...status, state: "ready_for_review", headAfter: publication.lastCommit, gitStatus: [], finalPath: status.finalPath, reviewer: reviewed.review, publication, controllerRevision: revision, completedAt: new Date().toISOString() };
await atomicWriteJson(statusPath, completed);
process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
